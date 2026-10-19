# React energy workspace

React + TypeScript implements profile selection/creation, manual appliance
entry, edits/reconfirmation, deletion, validation and the estimated-energy
dashboard. No client code computes kWh or tariff cost: results come from M3
through the authenticated FastAPI API. Browser arithmetic is limited to input
range validation and visual bar proportions.

The appliance editor also supports optional local label scanning: preview a
photo, consent to local processing, review/edit candidates and explicitly save.
Unknown power/usage stays blank. Manual entry works when scanning is disabled
or unavailable. See [local scan setup](../backend/api/SCANNING.md); hosted image
processing is disabled and no production vision model has been selected.

## Run locally

Node 24.21.0/npm 11.19.0 were verified; the package requires Node 22.12+.
From the repository root:

```powershell
npm.cmd --prefix frontend ci
Copy-Item frontend/.env.example frontend/.env.local
# Edit frontend/.env.local with your public identity-provider settings.
npm.cmd --prefix frontend run dev
```

Use an existing `.env.local` if already configured. Open
`http://127.0.0.1:5173`. Start/configure the [FastAPI backend](../backend/api/README.md)
separately. Vite proxies `/api` to `http://127.0.0.1:8000`, or the server-only
`POWERSHIFT_API_PROXY` target. The browser always uses relative `/api` requests.
There are no browser database credentials or secret keys.

For a deployment build:

```powershell
npm.cmd --prefix frontend run build
```

Serve `frontend/dist` with SPA fallback and a same-origin `/api` reverse proxy to
FastAPI. Do not cache protected API responses. Deployment hosting, TLS and reverse
proxy configuration have not been provisioned or verified by this milestone.
The project uses local assets/system fonts without a third-party asset CDN.

## Provider-neutral sign-in

The browser adapter uses `oidc-client-ts` with Authorization Code + PKCE (S256).
Configure a compatible managed OIDC provider as a public browser client:

| Browser setting | Purpose |
| --- | --- |
| `VITE_OIDC_AUTHORITY` | HTTPS OIDC authority/discovery issuer |
| `VITE_OIDC_CLIENT_ID` | Public browser client ID, never a client secret |
| `VITE_OIDC_SCOPE` | Provider-approved scopes; default `openid profile email`; include the API scope when required |
| `VITE_OIDC_AUDIENCE` | Optional provider-specific audience query parameter |

Register these exact development redirect URLs, or their actual hosted-origin
equivalents:

```text
http://127.0.0.1:5173/auth/callback
http://127.0.0.1:5173/auth/signout-callback
http://127.0.0.1:5173/auth/silent-callback
```

The provider must allow the browser client's origin/token exchange and issue an
access token for the API audience. FastAPI's issuer, audience and JWKS settings
must match that access token; the backend currently accepts RS256. The frontend
client ID is not automatically the API audience. HTTP identity authorities are
accepted only for loopback hosts in Vite development mode.

Without browser auth settings, the landing page explains that sign-in is not
connected. There is no token-pasting interface or development auth bypass.
Sessions/PKCE state use sessionStorage; application records remain in PostgreSQL.
Account changes reset workspace state; expiry/401 clears private UI, including
non-JSON 401 responses. Sign-out removes the local session before the provider
logout redirect. Renewal is delegated to the OIDC library/provider configuration.

No live identity provider was selected/onboarded. Native Supabase Auth SDK flows
are not implemented by this OIDC adapter; a future provider decision may require
an adapter and signing-algorithm update. Backend JWT verification remains
provider-neutral. Live login, callback and renewal need verification against the
chosen provider before deployment.

## User journey and data handling

Create/select a home or supported nonclinical business profile. Name suggestions
depend on sector and supply names only. Rated watts, daily hours and effective
load start blank. Quantity starts at one; the reporting period is visibly 30
days. No tariff or effective-load default is inferred.

Save requires explicit review of final values, even when unknown. Every edit
clears the checkbox. Incomplete records are saved, counted and excluded from
totals; a known zero is shown as zero, while an unavailable total is a dash.
The dashboard includes daily/period kWh, optional NGN grid-equivalent cost,
per-appliance comparisons, missing-data warnings and server assumptions. Costs
are hypothetical all-grid scenarios, not actual bills or savings claims.

Changing profile resets period/tariff context. Draft settings require an explicit
Update estimate action; calculations/loading states do not show stale totals.
Profile/estimate requests are cancelled on switching or unmount. Delete requires
a confirmation dialog. Stale edits preserve the draft until the user explicitly
discards/reloads; failed creates retain their request key for retries.

`lossless-json` preserves numeric lexemes in both directions. Inputs remain exact
JSON numbers, not strings or rounded JS floats. Quantity/range feedback uses
bounded exact BigInt comparisons; the API remains authoritative. Energy/cost
strings render directly without summing or rounding in the browser. Bar widths
compare server values only. Long values wrap on mobile without widening the page.

## Tests

```powershell
npm.cmd --prefix frontend test
npm.cmd --prefix frontend exec -- playwright install chromium
```

Browser tests need an explicitly disposable PostgreSQL cluster, the Python API
test environment and the pinned TEMP Node `pg` driver described in
[`tools/db`](../tools/db/README.md). Set these environment variables without
committing credentials:

```powershell
$env:POWERSHIFT_NATIVE_TESTS='1'
# POWERSHIFT_TEST_DATABASE_URL = disposable cluster admin URL
# POWERSHIFT_PG_ROOT = TEMP directory containing pg@8.16.3
npm.cmd --prefix frontend run test:e2e
```

Never point native tests at a cluster containing valuable data. The fixture
refuses existing reserved roles, creates a generated database/restricted login,
and runs real FastAPI/PostgreSQL. It signs an ephemeral RSA token and mocks
the external JWKS response and local-model transport; production JWT verification is not bypassed. The
session fixture is a generated TEMP file, never a browser bundle feature.
Playwright supplies an existing OIDC session to the test browser. Redirect/PKCE
checks intercept a synthetic IdP; a real provider was not contacted.

The fixture binds API port 8787 and Vite port 5173 to loopback. Its shutdown
endpoint exists only in `tests/browser_server.py` and requires its generated
test shutdown key. Global teardown shuts it down; the disposable cluster
operator should remove the test container afterward, including after failures.

Test artifacts/traces, dependencies, builds and local env files are ignored by
`frontend/.gitignore`. The root `.gitignore` remains unchanged. Chromium desktop,
390px and 320px layouts are covered; Firefox/Safari and live OIDC are unverified.
Accessibility checks cover automated axe rules and keyboard dialogs, not a full
WCAG certification. Local scan transport is mocked in browser tests; real-model
accuracy remains a separate M7 gate.

## Reports and exports

Use **Save report** after applying the dashboard period and optional tariff.
The server captures every stored appliance in the profile, including incomplete
rows, independently of the current search/filter. Reports show period totals,
saved appliance inputs and daily/period breakdowns, exclusion warnings and all
calculation assumptions. No browser arithmetic recomputes energy or costs.

The report opens at `/?report=<uuid>`. Bookmark its URL to reopen it with an
authorized account. Sign-in preserves valid report return URLs; other return
paths are discarded. A report reflects the captured snapshot even after later
appliance edits. If server capture differs from the dashboard preview, a notice
explains that the report uses the latest saved inputs. Back to dashboard restores
the report's profile, reporting period and tariff using current appliance values.

**Download CSV** fetches the saved report through authenticated `fetch`, validates
the response media type and downloads the server-produced UTF-8 file. It includes
the contracted 20 columns, assumptions, provenance and exclusion codes. Excluded
energy/cost cells are blank; known zero values remain zero. Empty snapshots
export the header only. Formula escaping applies only to the export, preserving
stored names. Rounded rows need not visually sum to independently rounded totals.

**Print report** opens the browser print dialog. Dedicated A4 print CSS hides
controls, shows metadata/inputs/warnings/assumptions, repeats table headers and
allows long reports to paginate. Browser print settings can also save a PDF;
no server-side PDF-generation endpoint is provided. Physical printer output and
Firefox/Safari print layouts have not been verified. Saved-report listing and
self-service report deletion are not implemented; access uses the saved URL.
