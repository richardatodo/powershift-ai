# PostgreSQL persistence

M4 defines the database schema, migrations, ownership controls and service access
patterns. It targets PostgreSQL 17 or newer. Migrations and integration tests
passed on native PostgreSQL 17.11 in a disposable Docker container and PostgreSQL
18.6 compiled to WASM in PGlite. M5 adds the [FastAPI service](../api/README.md),
its runtime PostgreSQL pool and JWT authentication. No persistent hosted database
or live managed identity account has been provisioned.

The SQL assets live directly under `backend/persistence/`. The calculation
engine remains in `backend/calculations/` and is authoritative for arithmetic.
The database classifies input completeness and checks report consistency without
calculating energy or substituting unknown values.

## Tables and relationships

All business tables are in schema `powershift`. UUIDs identify resources;
`audit_events` uses a bigint identity. Owner/profile composite foreign keys
prevent attaching another owner's or another profile's resource.

| Table | Purpose and relationships |
| --- | --- |
| `users` | Local owner identity mapped by unique external issuer/subject. No passwords or provider choice. |
| `profiles` | One owner's home/business context; reviewed sector enum, NGN, version and creation request. |
| `appliances` | Confirmed, versioned estimate inputs and field provenance; belongs to a profile; optional scan association. |
| `scan_sessions` | Owned, consented, expiring pending/candidate/failed/confirmed workflow and extraction evidence. |
| `energy_records` | Separate measured kWh observations, interval and required source notes; optional appliance link. |
| `tariff_inputs` | Append-only customer-entered rate and period used by a report; zero is valid. |
| `reports` | Immutable engine output and full appliance input/version/provenance snapshot; optional tariff reference. |
| `request_keys` | Durable scoped creation idempotency ledger; survives appliance deletion. |
| `audit_events` | Transactional resource/action/actor/time/version/request metadata; no raw input or image payload. |

Profiles own appliances, scans, measured observations, tariffs and reports. A
report's JSON snapshot has no live appliance foreign key: edits/deletion do not
rewrite history. A measured record's optional appliance link becomes null on
appliance deletion while its owner/profile and observation remain. A confirmed
scan retains the consumed appliance UUID as a tombstone, preventing reuse after
that appliance is deleted.

## Domain constraints

- Quantities are integers from 1 through 9,007,199,254,740,991. Known watts must
  be positive, hours 0 through 24, and effective load greater than 0 through 100.
  These three estimate inputs accept null without defaults. A record with any
  null required estimate input is `incomplete`; known zero hours is eligible.
- Input decimals use unconstrained `numeric`, with explicit rejection of NaN
  and infinities. No fixed scale silently rounds inputs. The engine's separate
  numerical resource limits still apply when a report is calculated.
- Provenance has the exact reviewed seven fields and allowed origins. Usage
  assumptions come from the customer; manual input cannot claim label evidence;
  document origin applies only to rated watts. Unchanged extraction claims must
  match the associated immutable scan candidate. Corrections use customer origin.
- Appliance insert/update requires a trusted service confirmation assertion.
  The API must first validate explicit customer review. Unknown load stays null
  until explicitly supplied. Only confirmed rows enter the appliance table.
- Scan consumption locks the receipt and completes in the same transaction as
  the appliance, idempotency ledger and audits. Expired/consumed scans cannot
  create a new appliance. Reconfirming the same appliance preserves its receipt.
- Reports require REPEATABLE READ or SERIALIZABLE, all currently visible profile
  appliances exactly once, matching input versions/provenance, owned tariff,
  reconciled counts, decimal result formats, null/exclusion rules and required
  warnings/issues. The service supplies output from the Python engine; database
  checks do not independently verify the arithmetic or every assumption's prose.
- Versioned updates advance version automatically. The caller must use a
  `WHERE version = expected_version` condition to detect concurrent edits.

Wire-type validation still belongs at the API boundary. PostgreSQL can coerce
SQL parameters, so a successful numeric column cast is not evidence that a
client sent a JSON number. Reject duplicates/unknown fields/coercion before
writing, and preserve decimal values through the production driver.

## Ownership and credentials

Every table enables and forces row-level security. `powershift_app` is a NOLOGIN,
NOBYPASSRLS role with schema usage and restricted data privileges. It does not
own objects, provision users, create schema objects, truncate tables, write audit
or idempotency rows directly, or update/delete saved reports. Narrow trigger
functions perform ledger/audit/scan writes with a fixed search path and revoked
PUBLIC execution. Every future migration must revoke PUBLIC function execution
explicitly; per-schema default privileges cannot remove global defaults.

Only a trusted backend may hold application database credentials. It verifies
authentication, maps issuer/subject to a local owner and uses transaction-local
`powershift.owner_id`. This setting is a routing assertion, not authentication:
any holder of a SQL connection could set another owner's UUID. Never expose this
role/connection or arbitrary SQL to browsers, clients or AI tools. Do not use the
migration owner/superuser for requests. Request context and confirmation are
transaction-local so a pool cannot carry them into the next transaction.

Migrations deliberately do not create a login, password, role membership or
authentication provider. The operator must provision a separate restricted
backend login with permission to SET ROLE to `powershift_app`. M5's restricted
identity-resolution helper maps verified issuer/subject to local users. Direct
user-table writes and unrestricted enumeration remain unavailable to the app.
Live identity-provider onboarding remains deployment configuration work.

## Migrations and validation

`0001_initial` creates nine tables, indexes, RLS, privileges and integrity
triggers. `0002_report_integrity` validates saved input/output snapshots.
`0003_identity_resolution` adds trusted verified-principal mapping. The
[migration runner](../../tools/db/README.md) applies checksummed, ordered files
and their journal in one transaction with an advisory lock. It expects a
dedicated idle privileged connection and SQL without transaction control.

The operator needs schema DDL and CREATEROLE rights. `powershift_app` is a
cluster-wide fixed role; installation fails if it already exists rather than
adopting an unknown role. Use an isolated development cluster for this bootstrap.
Adapting provisioning for a managed host or multiple installations on one
cluster requires an explicit follow-up migration/deployment design.

Down 0003 removes identity resolution, down 0002 removes report guards, and down
0001 drops the domain schema and application role. These are recovery tools,
not a production rollback plan. Backups, retention and restore exercises must be
designed before deployment. The separate migration journal is retained.

Run the PostgreSQL test suites using the commands in
[`tools/db/README.md`](../../tools/db/README.md). Pinned test drivers live in TEMP.
The native PostgreSQL 17.11 run passed 73 tests, including four two-session cases
for migration serialization, scan consumption, version conflicts and duplicate
creation keys. The PostgreSQL 18.6 WASM run passed 69 shared tests; PGlite provides
only one connection. M5 tests runtime pooling and JWT/HTTP ownership integration
on native PostgreSQL; live identity onboarding, backups and deployment
configuration remain unverified.

## Service integration and retention

The [parameterized access patterns](access-patterns.md) are implemented by the
M5 service in `backend/api/`; M4 itself introduced the SQL boundary.
Owner/profile indexes support scoped reads and cursor pagination; partial indexes
support pending scan expiry and optional resource relationships. Their existence
does not establish production performance results.

Raw uploads, provider secrets and provider request bodies have no storage
columns. Scan candidates/evidence, provenance and immutable report text can
still contain personal information. No automatic retention duration, expiry
worker, account deletion or audit anonymization policy is selected. Expiry
prevents scan use; it does not delete its contents. Profile/user deletion is
restricted by retained relationships, while appliance deletion is supported.
Before release, define a reviewed purge/anonymization workflow covering report
snapshots, scans, idempotency and audits; immutability does not mean permanent
retention.
