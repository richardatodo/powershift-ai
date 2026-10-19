# PowerShift AI

PowerShift AI turns customer-confirmed appliance ratings and usage assumptions
into transparent energy estimates for Nigerian households and nonclinical
businesses. AI-assisted label extraction is planned; deterministic application
code is authoritative for arithmetic.

## Current implementation

M1 established the repository/environment baseline. M2 defined and reviewed the
domain/API contracts. M3 implements the standalone Python calculation engine and
its tests. M4 adds the PostgreSQL schema, transactional migrations, ownership
constraints and persistence tests. M5 adds FastAPI, verified JWT authentication,
owner-scoped PostgreSQL integration, report snapshots and CSV responses. M6 adds
the React manual workflow and dashboard: profiles, appliance entry/edit/delete,
missing-data feedback and server-calculated estimates. Live managed sign-in
configuration, AI integration and report/export UI remain future work.

The engine has no third-party dependencies. Its public interfaces live in
[`backend/calculations`](backend/calculations/__init__.py).
Use Python 3.12 or newer.

## Run the tests

From this repository's root on Windows:

```powershell
py -3 -B -m unittest discover -s tests -v
```

`-B` prevents Python bytecode/cache files from being created. No package install,
API key, database, or running web service is needed. A restricted execution
environment may require permission to run the installed Python interpreter.

Database setup, schema constraints and access patterns are described in
[`backend/persistence`](backend/persistence/README.md). See
[`tools/db`](tools/db/README.md) for the migration runner and isolated PostgreSQL
test commands. The database tests use Node's built-in test runner and a separate
test runtime; the Python calculation engine remains dependency-free.

## Run the API

See [`backend/api`](backend/api/README.md) for dependencies, migrations,
restricted database login setup, managed-issuer configuration and automated
HTTP/authentication tests. Once configured:

```powershell
.venv/Scripts/python.exe -m uvicorn backend.api.app:create_app --factory --host 127.0.0.1 --port 8000 --no-proxy-headers
```

Only `/api/status` is public. All other API operations require a verified RS256
bearer access token for the configured API audience. Scanning remains disabled.

## Run the frontend

See [`frontend`](frontend/README.md) for identity-provider configuration, local
API proxying and browser tests. With the API and browser sign-in configured:

```powershell
npm.cmd --prefix frontend ci
npm.cmd --prefix frontend run dev
```

Open `http://127.0.0.1:5173`. The browser uses server-calculated energy values;
unknown required inputs remain incomplete and excluded from totals.

## Calculate an estimate

This example uses synthetic appliance data and a synthetic tariff, not a
verified electricity price. Run it from the repository root in Python:

```python
from backend.calculations import calculate_request, dumps_assessment

result = calculate_request({
    "appliances": [{
        "id": "11111111-1111-4111-8111-111111111111",
        "name": "Synthetic example fan",
        "quantity": 1,
        "rated_watts": 100,
        "hours_per_day": 5,
        "effective_load_percent": 100,
        "source_status": "customer_confirmed",
    }],
    "period_days": 30,
    "rate_ngn_per_kwh": 100,
})

print(result["totals"])
# {'daily_kwh': '0.500000', 'period_kwh': '15.000000',
#  'grid_equivalent_cost_ngn': '1500.00'}

print(dumps_assessment(result))
```

Daily kWh is `quantity * rated_watts * hours_per_day * effective_load_percent /
100 / 1000`. Period energy multiplies the unrounded daily value by the selected
days. Optional cost multiplies unrounded period energy by the supplied tariff.
Cost is a hypothetical all-grid estimate, not an actual mixed-source bill or
savings claim. Rated watts can differ from average draw.

### Interfaces and missing data

- `calculate_request(payload)` validates the complete M2 calculation request.
  Invalid rows reject the whole request with `CalculationError`; explicit null
  estimate inputs are accepted and explained as incomplete.
- `parse_calculation_request(json_text)` parses strict JSON with exact decimal
  numbers and returns the calculated assessment. Use it at a future raw-JSON
  boundary to preserve precision before a default float decoder can lose it.
- `calculate_assessment(rows, period_days, rate_ngn_per_kwh)` defensively
  evaluates imported/internal rows. Invalid, unconfirmed, and incomplete rows
  are excluded and counted, with field-level issues.
- `evaluate_appliance(row, input_index, period_days)` evaluates one row.
  `validate_appliance(row)` validates the calculation-input projection, not the
  future appliance create/update API schema.
- `dumps_assessment(result)` serializes exact Decimal tariff metadata as a JSON
  number. The result dictionary can contain a Decimal tariff; do not replace
  this encoder with float conversion or ordinary `json.dumps(result)`.

Unknown watts, hours, or effective-load percentage must be explicitly null.
They are never defaulted. Missing required keys are invalid. Zero hours produces
zero only when every other required input is valid and confirmed. An empty or
wholly excluded assessment has null totals; eligible zero-energy records have
explicit zero totals. No tariff means no cost, while an explicitly supplied zero
tariff is a valid zero-cost scenario.

Exact decimal inputs are represented as rational values during multiplication
and aggregation. Integer half-up rounding occurs only when formatting energy
to six places and NGN to two. The engine does not depend on or modify the
caller's Decimal precision, rounding mode, or trap settings.

### Numerical limits and errors

The implementation supports up to 4,096 coefficient digits and absolute
base-ten exponent 4,096 per numeric input. A JSON number token is limited to
8,224 characters. A formatted result's scaled integer has at most 4,096 digits;
a stricter host integer-string limit is respected. Unsupported numerical sizes
raise `CALCULATION_OUT_OF_RANGE` rather than clamping, rounding early, or
returning infinity. These are representation/resource guards, not appliance
rating defaults or additional electrical recommendations.

`CalculationError` exposes stable `code` and field `details`. Its
`as_dict(server_request_id)` method produces the reviewed error envelope without
rejected input values. Strict JSON rejects duplicate properties, NaN/Infinity,
malformed documents, and implicit numeric strings. Database row-level security
and ownership constraints are defined in M4. M5 implements HTTP error mapping,
verified authentication, database request context and bounded request handling.
