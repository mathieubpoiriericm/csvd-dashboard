"""Tests for pipeline.export.publish -- atomic staged publish with rollback.

The first two tests come straight from the plan (brief Step 1, verbatim).
The rest exercise the rollback path more thoroughly: a brand-new file with
no previous generation, a rollback that itself fails, a stale backup
directory left over from an earlier crash, and files outside the staged
set that must be left alone.
"""

import shutil
from pathlib import Path

import pytest

from pipeline.export.publish import publish_atomically


def test_publish_moves_every_staged_file(tmp_path: Path) -> None:
    staging, target = tmp_path / "stage", tmp_path / "data"
    staging.mkdir()
    target.mkdir()
    for name in ("a.json", "b.json"):
        (staging / name).write_text("[]\n")
    publish_atomically({n: staging / n for n in ("a.json", "b.json")}, target)
    assert (target / "a.json").read_text() == "[]\n"
    assert (target / "b.json").read_text() == "[]\n"


def test_a_failed_publish_restores_the_previous_generation(tmp_path: Path) -> None:
    """A partial publish must not leave a half-old, half-new data directory."""
    staging, target = tmp_path / "stage", tmp_path / "data"
    staging.mkdir()
    target.mkdir()
    (target / "a.json").write_text("OLD\n")
    (target / "b.json").write_text("OLD\n")
    (staging / "a.json").write_text("NEW\n")
    # b.json is staged but missing on disk, so the second rename fails.
    with pytest.raises(RuntimeError, match="Could not publish"):
        publish_atomically(
            {"a.json": staging / "a.json", "b.json": staging / "b.json"}, target
        )
    assert (target / "a.json").read_text() == "OLD\n"
    assert (target / "b.json").read_text() == "OLD\n"


def test_publish_with_empty_staged_set_is_a_noop(tmp_path: Path) -> None:
    target = tmp_path / "data"
    target.mkdir()
    (target / "untouched.json").write_text("here\n")

    publish_atomically({}, target)

    assert (target / "untouched.json").read_text() == "here\n"
    assert not (target / ".previous-export").exists()


def test_rollback_removes_a_brand_new_file_that_had_no_previous_version(
    tmp_path: Path,
) -> None:
    """A file with no prior generation must be deleted on rollback, not
    left behind as an orphaned half-published artifact.
    """
    staging, target = tmp_path / "stage", tmp_path / "data"
    staging.mkdir()
    target.mkdir()
    (target / "a.json").write_text("OLD\n")
    (staging / "a.json").write_text("NEW\n")
    (staging / "c.json").write_text("BRAND-NEW\n")
    # b.json is staged but missing on disk: a.json and c.json rename
    # successfully first, then b.json fails.
    with pytest.raises(RuntimeError, match="Could not publish"):
        publish_atomically(
            {
                "a.json": staging / "a.json",
                "c.json": staging / "c.json",
                "b.json": staging / "b.json",
            },
            target,
        )

    assert (target / "a.json").read_text() == "OLD\n"
    assert not (target / "c.json").exists()
    assert not (target / "b.json").exists()


def test_rollback_failure_is_reported_in_the_error_message(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The R source's equivalent branch: if the restore copy itself fails,
    say so explicitly rather than claiming a clean rollback that didn't
    happen.
    """
    staging, target = tmp_path / "stage", tmp_path / "data"
    staging.mkdir()
    target.mkdir()
    (target / "a.json").write_text("OLD\n")
    (staging / "a.json").write_text("NEW\n")
    # b.json is staged but missing on disk, forcing the publish to fail.

    real_copy2 = shutil.copy2

    def flaky_copy2(src, dst, *args, **kwargs):
        # Let the pre-publish backup (copying INTO .previous-export)
        # succeed; fail only the restore call, which copies back OUT of
        # it and into target_dir.
        if Path(dst).parent == target:
            raise OSError("simulated disk failure during rollback")
        return real_copy2(src, dst, *args, **kwargs)

    monkeypatch.setattr(shutil, "copy2", flaky_copy2)

    with pytest.raises(RuntimeError, match="Rollback also failed for: a.json"):
        publish_atomically(
            {"a.json": staging / "a.json", "b.json": staging / "b.json"}, target
        )


def test_a_failure_while_backing_up_leaves_the_original_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The rollback was keyed on which files *had* a previous generation,
    not on which renames had actually run. A disk that fills during the
    backup copies leaves a truncated file in .previous-export and nothing
    in target_dir replaced -- and the rollback then copied the truncated
    backup over the intact original, while the message said the previous
    export had been restored.
    """
    staging, target = tmp_path / "stage", tmp_path / "data"
    staging.mkdir()
    target.mkdir()
    (target / "a.json").write_text("OLD, and long enough to truncate\n")
    (staging / "a.json").write_text("NEW\n")

    def truncating_copy2(src, dst, *args, **kwargs):
        Path(dst).write_text("OLD")
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(shutil, "copy2", truncating_copy2)

    with pytest.raises(RuntimeError, match="Could not publish") as excinfo:
        publish_atomically({"a.json": staging / "a.json"}, target)

    assert (target / "a.json").read_text() == "OLD, and long enough to truncate\n"
    assert (staging / "a.json").read_text() == "NEW\n"
    assert "restored" not in str(excinfo.value)


def test_backup_dir_does_not_survive_a_successful_publish(tmp_path: Path) -> None:
    staging, target = tmp_path / "stage", tmp_path / "data"
    staging.mkdir()
    target.mkdir()
    (target / "a.json").write_text("OLD\n")
    (staging / "a.json").write_text("NEW\n")

    publish_atomically({"a.json": staging / "a.json"}, target)

    assert not (target / ".previous-export").exists()


def test_a_stale_backup_dir_from_a_previous_crash_is_cleared_first(
    tmp_path: Path,
) -> None:
    """.previous-export can be left behind if a prior run crashed before
    its own cleanup ran. mkdir() on an existing directory would raise
    FileExistsError, so it must be swept away first.
    """
    staging, target = tmp_path / "stage", tmp_path / "data"
    staging.mkdir()
    target.mkdir()
    backup_dir = target / ".previous-export"
    backup_dir.mkdir()
    (backup_dir / "leftover.json").write_text("stale\n")
    (staging / "a.json").write_text("NEW\n")

    publish_atomically({"a.json": staging / "a.json"}, target)

    assert (target / "a.json").read_text() == "NEW\n"
    assert not backup_dir.exists()


def test_a_stale_backup_path_that_is_a_file_reports_the_documented_error(
    tmp_path: Path,
) -> None:
    """.previous-export is always created as a directory by this function,
    but if something else ever leaves a plain FILE at that path, mkdir()
    can't just clear it the way it clears a stale directory: shutil.rmtree()
    refuses to touch a non-directory and raises NotADirectoryError. That
    has to surface as the documented "Could not publish the export: ..."
    RuntimeError, not a raw OSError leaking the internal contract -- and
    since this happens before anything in target_dir is touched, the
    pre-existing file must be left exactly as it was.
    """
    staging, target = tmp_path / "stage", tmp_path / "data"
    staging.mkdir()
    target.mkdir()
    (target / "a.json").write_text("OLD\n")
    (target / ".previous-export").write_text("not a directory\n")
    (staging / "a.json").write_text("NEW\n")

    with pytest.raises(RuntimeError, match="Could not publish"):
        publish_atomically({"a.json": staging / "a.json"}, target)

    assert (target / "a.json").read_text() == "OLD\n"


def test_files_outside_the_staged_set_are_left_untouched(tmp_path: Path) -> None:
    staging, target = tmp_path / "stage", tmp_path / "data"
    staging.mkdir()
    target.mkdir()
    (target / "unrelated.json").write_text("UNRELATED\n")
    (staging / "a.json").write_text("NEW\n")

    publish_atomically({"a.json": staging / "a.json"}, target)

    assert (target / "unrelated.json").read_text() == "UNRELATED\n"
