"""Bounded PostgreSQL pool; role/context are local to each transaction."""
from decimal import Decimal
import json

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import set_json_loads
from psycopg_pool import ConnectionPool

from .errors import APIError


class Database:
    def __init__(self, settings):
        self.pool = ConnectionPool(settings.database_url, min_size=1, max_size=settings.pool_size,
                                   timeout=5, open=False, configure=self._configure,
                                   kwargs={"autocommit": True, "row_factory": dict_row,
                                           "connect_timeout": 5}, name="powershift-api")

    @staticmethod
    def _configure(conn):
        # Fail closed when a deployment accidentally supplies administrative credentials.
        privileged = conn.execute("""SELECT EXISTS (
            SELECT 1 FROM pg_roles r WHERE pg_has_role(session_user, r.oid, 'SET')
            AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb
                OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname='powershift'))
        ) AS unsafe""").fetchone()["unsafe"]
        if privileged:
            raise ValueError("The API requires a restricted database login.")
        with conn.transaction():
            conn.execute("SET LOCAL ROLE powershift_app")
            conn.execute("SELECT powershift.current_owner_id()")
        set_json_loads(lambda value: json.loads(value, parse_float=Decimal), conn)

    def open(self):
        self.pool.open(wait=True, timeout=5)

    def close(self):
        self.pool.close()

    def run(self, principal, request_id, operation, isolation="READ COMMITTED"):
        if isolation not in ("READ COMMITTED", "REPEATABLE READ"):
            raise ValueError("Unsupported isolation level")
        # Identity mapping runs after token verification, outside the resource snapshot.
        with self.pool.connection() as conn:
            with conn.transaction():
                conn.execute("SET LOCAL ROLE powershift_app")
                conn.execute("SET LOCAL statement_timeout = '5s'")
                owner = conn.execute("SELECT powershift.resolve_identity(%s,%s) AS id",
                                     (principal.issuer, principal.subject)).fetchone()["id"]
        for attempt in range(3):
            try:
                with self.pool.connection() as conn:
                    with conn.transaction():
                        conn.execute("SET TRANSACTION ISOLATION LEVEL " + isolation)
                        conn.execute("SET LOCAL ROLE powershift_app")
                        conn.execute("SET LOCAL statement_timeout = '5s'")
                        conn.execute("SET LOCAL lock_timeout = '2s'")
                        conn.execute("SELECT set_config('powershift.owner_id',%s,true), "
                                     "set_config('powershift.request_id',%s,true), "
                                     "set_config('powershift.confirmed','false',true)", (str(owner), request_id))
                        return operation(conn)
            except (psycopg.errors.SerializationFailure, psycopg.errors.DeadlockDetected,
                    psycopg.errors.UniqueViolation, psycopg.errors.CheckViolation):
                if attempt == 2:
                    raise APIError(503, "SERVICE_UNAVAILABLE", "The service is temporarily unavailable.") from None
        raise AssertionError("Unreachable")
