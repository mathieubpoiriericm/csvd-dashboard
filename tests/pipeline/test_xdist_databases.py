"""The names a pytest-xdist worker's throwaway database and container take."""

import pytest
from tests.xdist_databases import container_name, worker_database_name


def test_a_worker_database_is_the_base_name_with_the_worker_suffix() -> None:
    assert worker_database_name("csvd_ci", "gw0") == "csvd_ci_gw0"
    assert worker_database_name("csvd_ci", "gw11") == "csvd_ci_gw11"


@pytest.mark.parametrize("worker", ["gw", "0", "gw0;", 'gw0" OR 1', "../gw0", ""])
def test_a_worker_id_that_is_not_gw_digits_is_refused(worker: str) -> None:
    with pytest.raises(ValueError, match="xdist worker"):
        worker_database_name("csvd_ci", worker)


def test_a_serial_run_keeps_the_container_name() -> None:
    assert container_name("csvd-pg-pytest", None) == "csvd-pg-pytest"
    assert container_name("csvd-pg-pytest", "gw3") == "csvd-pg-pytest-gw3"
    with pytest.raises(ValueError, match="xdist worker"):
        container_name("csvd-pg-pytest", "x")
