"""The camelCase base every published Pydantic model extends.

The dashboard's wire format is camelCase -- `pipeline/export/writer.py`'s
`to_camel()` derives table keys from display column names, and
`read_pipeline_status()` hand-writes `runTimestamp`. A model that
serialises itself has to agree, or `lib/types.ts` would need two
conventions.

Kept in its own module so `run_errors`, `steps`, `api_telemetry` and
`run_report` can all extend it without importing each other.
"""

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class WireModel(BaseModel):
    """A model whose JSON keys are camelCase.

    ``populate_by_name`` keeps the Python field names usable when
    constructing one, so call sites read as Python while the output reads
    as the wire contract. Dump with ``by_alias=True``.
    """

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
