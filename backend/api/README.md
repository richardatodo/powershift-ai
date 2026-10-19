# FastAPI service

M5 implements the reviewed `/api` contract with PostgreSQL persistence and RS256
bearer JWT authentication. Only `GET /api/status` is public. Scanning returns
unavailable; no upload/provider calls are performed.

## Install and configure

Use the existing Python virtual environment, or create one if needed. From the
repository root (Python 3.13 was verified):

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r backend/requirements.txt -c backend/constraints.txt
```

The constraints file pins the verified transitive resolution without installing
test-only packages for runtime. Install `backend/requirements-dev.txt` for tests.

Apply migrations on PostgreSQL 17+ using a separate privileged deployment
connection. Install the pinned TEMP Node driver from the
[migration guide](../../tools/db/README.md), set `POWERSHIFT_PG_ROOT` and
`POWERSHIFT_MIGRATION_DATABASE_URL`, and run:

```powershell
node tools/db/migrate-postgres.cjs
```

The API never migrates automatically. New migration 0003 adds a restricted
`resolve_identity(issuer, subject)` helper and a migration-owner identity-table
policy for its security-definer execution. Original migrations remain unchanged.
Only verified JWT issuer/subject reach this helper; the application receives
EXECUTE, not arbitrary user-table writes or migration privileges.

An administrator provisions a dedicated runtime login:

```sql
CREATE ROLE powershift_backend LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS
    NOCREATEDB NOCREATEROLE;
-- Set its password securely with psql's \password powershift_backend.
GRANT powershift_app TO powershift_backend;
```

Grant database CONNECT if default access was revoked. Startup rejects a login
that can SET ROLE to a superuser, BYPASSRLS, role/database creator or domain schema
owner. SQL credentials belong exclusively to the trusted backend: arbitrary SQL
access can assert owner context. Do not use the migration login for requests.

Set environment variables through your configuration/secret mechanism.
[`settings.env.example`](settings.env.example) contains placeholders only; the
app does not automatically load an env file.

| Variable | Meaning |
| --- | --- |
| `POWERSHIFT_DATABASE_URL` | Restricted runtime PostgreSQL login |
| `POWERSHIFT_AUTH_ISSUER` | Exact trusted HTTPS issuer, including trailing slash |
| `POWERSHIFT_AUTH_AUDIENCE` | Audience registered for this API |
| `POWERSHIFT_AUTH_JWKS_URL` | Explicit trusted HTTPS public-key endpoint |
| `POWERSHIFT_MAX_BODY_BYTES` | Default 262144; allowed 1024 through 1048576 |
| `POWERSHIFT_REQUESTS_PER_MINUTE` | Per-process/socket-peer IP budget; default 120, allowed 1 through 10000 |
| `POWERSHIFT_POOL_SIZE` | Maximum runtime connections; default 4, allowed 1 through 20 |

```powershell
.venv/Scripts/python.exe -m uvicorn backend.api.app:create_app --factory --host 127.0.0.1 --port 8000 --no-proxy-headers
```

## Authentication and behavior

Use a managed identity provider issuing RS256 access tokens for the configured
API audience. No vendor, hosted account, sign-in UI, local password store,
registration endpoint or development auth bypass is selected. JWT verification
checks signature, kid, issuer, audience, expiry, issued-at, subject and optional
not-before. Dates must be numbers; RSA keys must be at least 2048 bits. Token key
URLs are ignored. Configured HTTPS JWKS retrieval has a 3-second timeout, 64 KiB
decoded response limit and at most 32 keys. Keys cache for five minutes;
unknown-kid refresh has a five-second cooldown. Failures fail closed with safe
errors. No real-time revocation/introspection flow is implemented; valid tokens
remain accepted until expiry.

The [tracked OpenAPI document](openapi.json) declares private bearer security
and is available through `app.openapi()`. Public Swagger/Redoc/OpenAPI HTTP routes
are disabled by default.

- Profiles: list, create/replay and retrieve an owned profile with appliances.
- Appliances: confirmed manual/document/associated-scan creation, version-checked
  edit/reconfirmation and deletion, with server-composed provenance.
- Calculations: authenticated strict JSON passed to the unchanged M3 engine.
- Reports: compute from one REPEATABLE READ owned snapshot, save exact inputs
  and output, retrieve immutable history and export that history as CSV.
- Scan: authenticate, validate request/profile scope and return
  `503 SCANNER_UNAVAILABLE` until separate integration gates are approved.

Unknown/server-owned fields, duplicate JSON keys, numeric strings, boolean
numbers and nonfinite numbers are rejected. Exact Decimal values reach
PostgreSQL/M3 without float conversion. Integral numeric spellings such as `1.0`
are accepted; null required estimate inputs remain incomplete.
JSON nesting is bounded at 64 levels. Strings must be UTF-8 representable and
cannot contain NUL, which PostgreSQL text cannot store.

Resource queries include owner predicates and use RLS. Missing/cross-owner IDs
both return 404. Verified issuer/subject map atomically to a local owner; an
`owner_id` claim does not override the subject. Role/context/confirmation expire
on transaction end, including rollback. Pool acquisition, statement and lock
timeouts are bounded. Creation fingerprints preserve exact equivalent numeric
values independently of object order/decimal context. Three bounded attempts
handle serialization/deadlock/key races, rolling back before retry. A deleted
appliance's matching key returns 404 without recreation; changed payloads under
that key return 409. Report snapshots survive edits/deletion. CSV includes
excluded rows and assumptions, leaves unknown cells empty, escapes spreadsheet
formula prefixes and uses M3 for per-row cost from the saved snapshot.

Every application response has a new server request ID, contract version and
`Cache-Control: no-store`. Safe errors never expose exception text, SQL, tokens,
credentials or rejected payloads. Application error logs include request ID and
safe category only. Auth errors include `WWW-Authenticate: Bearer`; availability/
rate errors include Retry-After. Added codes cover `REQUEST_TOO_LARGE` (413),
`AUTHENTICATION_UNAVAILABLE`/`SERVICE_UNAVAILABLE` (503), and safe method/request
errors. Both declared and received body bytes are bounded.

The local IP budget is not a distributed quota. Proxy trust, TLS termination,
infrastructure logging and shared rate limits require deployment design. No
credentialed CORS/cookies, account purge, retention worker or public deployment
is configured. Existing retention/privacy gates remain in force.

## Automated tests

```powershell
.venv/Scripts/python.exe -m pip install -r backend/requirements-dev.txt -c backend/constraints.txt
.venv/Scripts/python.exe -B -m pytest -q -p no:cacheprovider tests/test_api.py tests/test_calculations.py
```

Without native configuration, 20 native API cases skip explicitly. To run all
cases, set `POWERSHIFT_TEST_DATABASE_URL` to an explicitly disposable PostgreSQL
cluster, `POWERSHIFT_NATIVE_TESTS=1`, and `POWERSHIFT_PG_ROOT` for the pinned
migration driver. Never use a cluster containing valuable records. Fixtures
generate a database/restricted login, refuse pre-existing reserved roles, and
clean up their generated database/login/application role. Test admin rights are
separate from runtime credentials. Verify all three migrations with:

```powershell
node --test tests/persistence.test.cjs
```

Verified: 149 Python tests (68 API/security + 81 calculation), no native skips,
and 73 native persistence tests on PostgreSQL 17.11. JWTs use ephemeral test RSA
keys and mocked JWKS HTTP responses; live identity onboarding was not tested.
Starlette TestClient emits one httpx adapter deprecation warning; tests pass and
the runtime JWKS client is unaffected.

M6 adds authenticated `GET /api/profiles` for browser profile selection. It
returns `{profiles: ProfileRead[], next_cursor: UUID | null}` with owner-scoped
UUID keyset pagination, optional `after` cursor and a `limit` from 1 to 100
(default 50). Unknown/duplicate query fields are rejected. The M6 API regression
run passed 151 Python tests (70 API/security + 81 calculation); M5's migration
verification above records its earlier native persistence run.
