# Service data access patterns

These patterns define the future trusted backend's use of the M4 schema.
Examples use PostgreSQL positional parameters and are separate operations, not
a batch script. Bind values through a driver; never interpolate user text into
SQL. M4 does not yet implement that driver or HTTP error mapping.

## Connection and request context

Acquire one connection for the complete transaction. Authenticate before
establishing context, using a separate restricted identity mapping/provisioning
path. Obtain the local UUID from verified issuer/subject, never a request-body
owner ID. A backend login must be authorized to SET ROLE; it must not own tables
or have superuser/BYPASSRLS privileges.

```sql
BEGIN;
SET LOCAL ROLE powershift_app;
SELECT set_config('powershift.owner_id', $1::text, true),
       set_config('powershift.request_id', $2::text, true);
-- Scoped operation(s).
COMMIT;
```

Use a server-generated/sanitized nonblank request ID of at most 200 characters.
Rollback on every error before releasing the connection. Never leave a
transaction open while calling an external AI provider or waiting for customer
confirmation. SET LOCAL expires at transaction end; pooled requests must set
their own context every time. A missing owner sees no rows and cannot write.

## Creates and idempotency

Validate the reviewed request, including exact decimal types, allowed fields,
confirmation and provenance rules, before calculating its SHA256 fingerprint.
The fingerprint identifies the full normalized meaningful request, scoped by
owner, operation and profile. Server-owned timestamps/IDs and request trace IDs
are not input. The production adapter must implement/test one stable
canonicalization preserving exact decimal values; M4 stores/enforces the key
and fingerprint, not the canonicalization algorithm.

Check the durable ledger before scan expiry/consumption on retries:

```sql
SELECT resource_id, request_fingerprint
FROM powershift.request_keys
WHERE owner_id = powershift.current_owner_id()
  AND operation = $1
  AND scope_key = coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
  AND client_request_id = $3::uuid;
```

If found and fingerprints match, return the original owned resource with HTTP
200. If fingerprints differ, return `409 IDEMPOTENCY_CONFLICT`. A deleted
appliance's retained key must not recreate it: matching replay returns
`404 RESOURCE_NOT_FOUND`. Otherwise insert the business row; a trigger adds the
ledger and audit in the same transaction. `profile.create` uses null profile
scope; `appliance.create` and `report.create` use the real profile ID.

On a concurrent unique-key conflict, roll back the whole attempted transaction
and re-read the ledger in a fresh transaction before deciding replay/conflict.
Do not use `ON CONFLICT DO UPDATE` on resources: it would silently edit a prior
request or interfere with scan consumption. Do not infer success from a failed
statement inside an aborted transaction. Native PostgreSQL tests verify that
concurrent duplicate keys commit one resource and reject the other write
atomically. HTTP replay/conflict mapping still needs service integration tests.

## Reads, edits and deletion

Every lookup explicitly scopes owner as well as relying on RLS. Cross-owner and
missing IDs both become `404 RESOURCE_NOT_FOUND`; do not reveal existence through
unscoped preflight queries. Profile reads and related appliance reads that must
represent one revision use a read-only REPEATABLE READ transaction.

```sql
SELECT * FROM powershift.profiles
WHERE owner_id = powershift.current_owner_id() AND id = $1::uuid;

SELECT * FROM powershift.appliances
WHERE owner_id = powershift.current_owner_id() AND profile_id = $1::uuid
ORDER BY id;
```

For appliance create/edit, first validate the full merged row and explicit
customer confirmation, then set `powershift.confirmed` to literal `true` using
transaction-local `set_config`. Generate field provenance in the service; do not
accept server-owned provenance, timestamps or version as arbitrary client data.
Triggers reset the confirmation timestamp and increment versions.

```sql
SELECT set_config('powershift.confirmed', 'true', true);
UPDATE powershift.appliances
SET name = $3, quantity = $4::bigint, rated_watts = $5::numeric,
    hours_per_day = $6::numeric, effective_load_percent = $7::numeric,
    brand = $8, model = $9, source_notes = $10, field_provenance = $11::jsonb
WHERE owner_id = powershift.current_owner_id()
  AND id = $1::uuid AND version = $2::bigint
RETURNING *;

DELETE FROM powershift.appliances
WHERE owner_id = powershift.current_owner_id()
  AND id = $1::uuid AND version = $2::bigint
RETURNING id;
```

An update/delete returning no row requires an owned existence lookup: absence is
404, an existing different version is `409 STALE_VERSION`. Never overwrite the
version explicitly or silently retry the customer's edit against a newer row.
Audit, measured-record unlinking and ledger/tombstone retention are transactional.

Report history can use keyset pagination, with the cursor encoding the last
`created_at,id` pair and a bounded service-controlled page size:

```sql
SELECT id, profile_id, created_at
FROM powershift.reports
WHERE owner_id = powershift.current_owner_id() AND profile_id = $1::uuid
  AND (created_at, id) < ($2::timestamptz, $3::uuid)
ORDER BY created_at DESC, id DESC
LIMIT $4::integer;
```

Omit the cursor predicate for the first page. Similar owner-leading indexes
support profiles, measured intervals and audit history. These are storage access
patterns, not additional public endpoints beyond M2.

## Scan lifecycle

Persist an owned pending receipt with consent notice/version/time and a finite
server-controlled expiry. Commit before making the external provider call. Store
only a validated candidate or sanitized stable failure code in a new short
transaction. Never store raw image bytes or unrestricted provider payloads.
Candidate values and consent metadata become immutable; provider failure is final.

Confirmation validates the owned candidate, full reviewed appliance and allowed
corrections. In the appliance creation transaction, the guard locks the receipt
FOR UPDATE, checks candidate status and expiry, and validates unchanged label
claims. An AFTER trigger marks it consumed. A failure of the appliance, request
key or audit rolls back consumption. Reconfirmation of that same appliance may
use its existing consumed receipt; a different/new appliance may not.

An expiry worker is not implemented. A later cleanup worker needs a separate
operator/maintenance role and an approved retention policy. Expiry is checked
against the database clock on consumption even without a worker.

## Report creation and retrieval

Begin with `BEGIN ISOLATION LEVEL REPEATABLE READ` (or SERIALIZABLE), then set the
request role/context. Perform idempotency lookup first. Load the owned profile
and all its appliances in deterministic ID order within that same transaction.
Do not use a client-supplied appliance list or totals for saving a report.

Project each appliance to the engine's seven inputs (`id`, `name`, `quantity`,
`rated_watts`, `hours_per_day`, `effective_load_percent`, `source_status`). Preserve
NUMERIC as exact Decimal values, not binary floats. Call
`backend.calculations.calculate_assessment`; retain `dumps_assessment` semantics
for numeric metadata and fixed-point result strings. Build the complete M2
ApplianceRead snapshot, deriving each `calculated_daily_kwh` from its engine row,
and keep its provenance, version and timestamps.

If the customer supplied a tariff, insert an owned `tariff_inputs` row for this
period, including zero; otherwise use no tariff row. Insert the report with its
four-key `input_snapshot`, exact engine `calculation`, contract version, request
key and fingerprint. The report trigger checks the snapshot against the same
visible inputs. Commit report, tariff, ledger and audits together. Keep CPU work
bounded and the transaction short; make no external AI/network call inside it.

On serialization/deadlock failure, retry the entire bounded transaction from
fresh reads, including recalculation. Never reuse old output with a newer input
snapshot. A concurrent committed edit may be excluded from this transaction's
MVCC snapshot; that is a consistent historical version, not a mixture of inputs.

```sql
SELECT id, profile_id, created_at, contract_version, input_snapshot, calculation
FROM powershift.reports
WHERE owner_id = powershift.current_owner_id() AND id = $1::uuid;
```

GET/export reads this saved snapshot. It does not recalculate from live rows.
Measured observations are excluded from the modeled appliance calculation;
their separate interval/source records do not override estimates.

## Errors and privacy

The service must map known application/domain cases to M2's stable envelope.
SQLSTATE alone is not enough to distinguish all scan or version conflicts;
use scoped state checks and named constraint context where appropriate. A
constraint violation that escaped validated service input indicates a defect or
race to classify safely. Never forward PostgreSQL messages, failed statements,
parameter values, provider payloads or credentials to clients or ordinary logs.
Log a sanitized server request ID and internal category for investigation.

The application cannot delete profiles/users/reports or modify audit/request
ledgers through this role. An approved account purge must explicitly include
snapshots, scans, tariff/measurement records, keys and audits using a separate
maintenance path. No current constraint implies those records may be retained
indefinitely.
