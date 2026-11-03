"""Shared setup for the scripts tests.

The scripts import the pipeline, which loads .env at import, and this tree has
no `_isolate_credentials` fixture of its own -- so without this, every test
here ran with the developer's production database credentials in
`os.environ`. See tests/hermetic_env.py.
"""

from tests.hermetic_env import shut_out_dotenv_database_credentials

shut_out_dotenv_database_credentials()
