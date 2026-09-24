"""Atomic publication of the generated export.

Renames are atomic per file but not across the set, so the previous
generation is snapshotted first and restored if any rename fails. A failed
publish must never leave the dashboard serving a mixed generation.
"""

import shutil
from pathlib import Path


def publish_atomically(staged: dict[str, Path], target_dir: Path) -> None:
    """Move every staged file into place, rolling back on any failure."""
    backup_dir = target_dir / ".previous-export"
    had_previous = {name: (target_dir / name).exists() for name in staged}
    # The files whose rename has actually run. The rollback is keyed on
    # this, not on had_previous: a failure during the backup copies leaves
    # a truncated backup and an intact original, and restoring "every file
    # that had a previous generation" copied the truncated backup over it.
    replaced: list[str] = []
    try:
        # A stale .previous-export left by an earlier crash is normally a
        # directory (see below), but a permission error, a full disk, or
        # a stale path that is a plain file instead all raise OSError
        # here too. This has to be inside the try: raising past it would
        # surface a raw OSError instead of the documented
        # "Could not publish the export: ..." contract, and nothing in
        # target_dir has been touched yet, so the rollback below is a
        # correct (if vacuous) no-op for a failure at this point.
        if backup_dir.exists():
            shutil.rmtree(backup_dir)
        backup_dir.mkdir()

        for name, existed in had_previous.items():
            if existed:
                shutil.copy2(target_dir / name, backup_dir / name)

        for name, source in staged.items():
            source.replace(target_dir / name)
            replaced.append(name)
    except OSError as exc:
        failures: list[str] = []
        for name in replaced:
            final = target_dir / name
            if had_previous[name]:
                try:
                    shutil.copy2(backup_dir / name, final)
                except OSError:
                    failures.append(name)
            else:
                final.unlink(missing_ok=True)
        if failures:
            detail = f" Rollback also failed for: {', '.join(failures)}."
        elif replaced:
            detail = " The previous export was restored."
        else:
            detail = " Nothing in the data directory was touched."
        raise RuntimeError(f"Could not publish the export: {exc}.{detail}") from exc
    finally:
        shutil.rmtree(backup_dir, ignore_errors=True)
