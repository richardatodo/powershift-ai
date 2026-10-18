# Database migration tooling

`migrate.cjs` exports two dependency-free Node functions:

```js
const { loadMigrations, migrate } = require('./tools/db/migrate.cjs');
const migrations = loadMigrations('./backend/persistence/migrations');
await migrate(db, { direction: 'up', migrations });
await migrate(db, { direction: 'down', migrations }); // One migration by default.
```

The adapter must implement `query(sql, parameters)` returning an object with a
`rows` array, and `exec(sql)` accepting raw multi-statement SQL. The caller supplies
a dedicated privileged connection with no open transaction. The tooling does not
select a production database driver, open a network connection, read credentials,
or expose an application endpoint. Use one dedicated, idle connection for the
whole invocation; migration SQL must exclude transaction-control statements.

Files follow `<positive-bigint>_<name>.up.sql` and the matching `.down.sql`.
Migrations run in numeric order. `steps` limits the number applied or reverted;
up defaults to all pending migrations and down defaults to one. Reverting a
migration without a down file is refused. Down migrations remove data: use them
only on a disposable database or under a separately reviewed recovery plan.

Each invocation executes one transaction: acquire a transaction-scoped advisory
lock, create/check `powershift_meta.schema_migrations`, validate the applied
history, apply SQL, update the journal, and commit. Errors trigger rollback,
including DDL and journal changes. Migration SQL must not contain its own
transaction-control statements. SHA256 covers both exact UTF-8 SQL file contents,
with explicit byte lengths and a marker for a missing down file. Changed applied
migrations, unknown history, and applied histories that are not a prefix of the
local ordered catalog are refused. Add a new migration to change an applied
schema; preserve previous files byte-for-byte.

The domain down migration retains the separate journal schema. The runner owns
this journal; application roles must not own it or receive write access to it.
Run migrations through an administrative deployment identity, separately from
the restricted application identity.

## Isolated PostgreSQL migration tests

The integration suite uses the actual PostgreSQL engine compiled to WASM in
`@electric-sql/pglite@0.5.10`. This is a development/test dependency installed in
TEMP, not the application persistence adapter or a production database choice.

In PowerShell from the repository root:

```powershell
$m4RuntimeRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'powershift-ai-m4-pglite-0.5.10'
npm.cmd install --prefix $m4RuntimeRoot --cache (Join-Path $m4RuntimeRoot 'npm-cache') --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund --save-exact --fetch-retries=0 --fetch-timeout=15000 @electric-sql/pglite@0.5.10
$env:POWERSHIFT_PGLITE_ROOT = $m4RuntimeRoot
node --test tests/persistence.test.cjs
```

Restricted environments may require approval for the registry download. In WASM
mode the suite rejects a different runtime version, creates fresh in-memory
databases, and never connects to an external database. It validates migration
transactions, constraints, trigger behavior, and row-level ownership checks.
PGlite provides one exclusive connection; native mode below adds selected
multi-session contention checks.

## Native PostgreSQL verification

The same suite can run against an explicitly disposable PostgreSQL test cluster
with pinned `pg@8.16.3` installed into TEMP. It additionally runs four tests using
two sessions: simultaneous migrations, single-use scan confirmation, optimistic
version updates, and idempotency-key contention. The three competing-write tests
observe PostgreSQL lock waits before releasing the first writer.

Install the test driver separately from application dependencies:

```powershell
$m4PgRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'powershift-ai-m4-pg-8.16.3'
npm.cmd install --prefix $m4PgRoot --cache (Join-Path $m4PgRoot 'npm-cache') --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund --save-exact --fetch-retries=0 --fetch-timeout=15000 pg@8.16.3
$env:POWERSHIFT_PG_ROOT = $m4PgRoot
$env:POWERSHIFT_NATIVE_TESTS = '1'
# Set POWERSHIFT_TEST_DATABASE_URL to your disposable test cluster's admin URL.
node --test tests/persistence.test.cjs
```

Never use a development database containing valuable records or a production
database. Native mode refuses to run without the explicit opt-in flag. Each
fixture creates a generated `powershift_m4_test_<pid>_<random>` database, uses a
dedicated connection for each transaction, and closes its connections before
dropping that generated database. Schema migrations use cluster-scoped role
names, so fixtures serialize with an administrative session advisory lock,
refuse pre-existing `powershift_app` or `m4_migration_owner` roles, and clean up
only those exact roles after proving they were absent before the fixture.
The test administrator needs permission to create/drop databases and roles;
these are test privileges and must not be granted to the application identity.

`test-adapter.cjs` implements this test isolation only; it is not the production
persistence adapter. The suite does not provision a native server, select a
hosting platform, or validate deployment backups and operational monitoring.

The M4 verification passed **69/69** tests on PostgreSQL 18.6 through PGlite
0.5.10, and **73/73** tests on native PostgreSQL **17.11** through `pg@8.16.3`,
including all four two-session concurrency cases. Both runs had zero failures
and zero skips. The native run used a disposable Docker image pinned as
`postgres@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3`.

The migrations target PostgreSQL 17 or later. These checks establish behavior on
the tested versions; production authentication, pooling, deployment configuration,
backup restoration, monitoring, and the future application adapter remain
unverified. Compatibility must be checked again in the selected deployment
environment. See the
[official PGlite overview](https://pglite.dev/docs/about),
[querying and transaction API](https://pglite.dev/docs/api), and
[installation guide](https://pglite.dev/docs/).
