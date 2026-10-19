# Local label scanning

M7 uses a server-side `VisionAdapter` boundary, initially `OllamaAdapter`.
`POWERSHIFT_SCAN_PROVIDER=disabled` is the default. The only enabled provider
accepted today is `ollama`; no hosted API budget or image processing is approved.
Only literal loopback HTTP addresses are accepted. Redirects, environment HTTP
proxies, cloud model tags and model metadata identifying remote inference are
rejected. Keep the local Ollama instance private and disable its cloud features.

## Local setup

Install a current Ollama release with Gemma 4 support, then start the local
server in PowerShell:

```powershell
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:OLLAMA_NUM_PARALLEL = '1'
ollama serve
```

In another terminal, download the development candidate:

```powershell
ollama pull gemma4:e2b-it-qat
ollama show gemma4:e2b-it-qat
```

For the existing authenticated API process, add:

```powershell
$env:POWERSHIFT_SCAN_PROVIDER = 'ollama'
$env:POWERSHIFT_SCAN_BASE_URL = 'http://127.0.0.1:11434'
$env:POWERSHIFT_SCAN_MODEL = 'gemma4:e2b-it-qat'
.venv/Scripts/python.exe -m uvicorn backend.api.app:create_app --factory --host 127.0.0.1 --port 8000
```

Keep the existing database and JWT settings from `README.md`. No browser model
endpoint, model credentials or client-side inference library is needed.
The browser calls FastAPI through the existing same-origin proxy.

## Development limits and privacy behavior

Defaults are explicit local-development choices, not production sizing:

| `POWERSHIFT_SCAN_` suffix | Default | Meaning |
| --- | --- | --- |
| `TIMEOUT_SECONDS` | 120 | Shared show/chat inference deadline; configurable 5–300 seconds |
| `MAX_IMAGE_BYTES` | 2097152 | 2 MiB limit for upload bytes and sanitized PNG |
| `MAX_PIXELS` | 12000000 | Pixel count before full decode |
| `MAX_SIDE` | 6000 | Maximum width or height |
| `EXPIRY_SECONDS` | 1800 | Candidate validity, 30 minutes |
| `DAILY_LIMIT` | 20 | Attempts per owner in a rolling 24 hours |

The image request has a bounded base64 JSON allowance; other endpoints retain
their smaller body limit. Requests larger than the transport limit return 413;
invalid/oversized decoded images return 400. Only still JPEG, PNG and WebP are
accepted. Orientation is applied and metadata stripped before local transfer.
The resulting PNG can exceed the limit even if the original compressed photo
fits; crop/resize the photo in that case.

Images remain in request memory and the preview only; PowerShift writes no image
files or image database columns. Memory is released normally, not securely
erased. Avoid swap/crash dumps/access logs that capture bodies in a deployment.
Model process memory is outside PowerShift's control. `keep_alive: 0` requests
unloading after each result. Restart Ollama with `OLLAMA_NO_CLOUD=1` and avoid
external proxies/debug logging. The application does not change global Ollama
settings or inspect unrelated user configuration.

`GET /api/status` advertises the versioned `local-label-scan-v1` notice and
public upload/time limits when enabled. This means configured, not healthy or
accuracy-verified. Explicit customer consent is required before each photo.
The notice states candidates/evidence/consent are retained until an operator
deletes the profile/account. Expiry prevents reuse but does not purge data;
there is no self-service account/profile deletion or automatic retention worker.
These limitations are disclosed before upload. Use synthetic/de-identified
images in development. No change to hosted privacy approval is implied.

## Extraction and confirmation

The adapter checks `/api/show` for vision/local capabilities before sending an
image to `/api/chat`. It requests bounded non-streaming JSON-schema output with
temperature 0, 4096 context tokens, 1200 output tokens and thinking disabled.
It checks completion status, schema, string/numeric constraints and W evidence.
Blurry, missing-label, VA-only or ambiguous power is null. kW and VA are not
converted. Voltage/current/label kWh remain evidence, never usage assumptions.
Evidence checks cannot prove the model read the image correctly.

The API commits an owned pending scan receipt before inference and stores a
validated candidate or safe failure afterward. No database transaction remains
open during inference. An advisory lock makes quota reservations atomic across
workers. One unexpired pending scan is allowed per owner, with one inference
slot per adapter process. An API-worker semaphore also bounds pixel decoding
and the whole inference lifecycle; run one local API worker and one Ollama parallel slot
on a small machine. Failed attempts count toward the daily quota. A crash or
cancelled client can leave a pending receipt until expiry; it does not confirm
an appliance. There is no automated retry that could duplicate inference.

The React appliance editor previews the photo, asks consent, displays evidence
and nullable extracted values, and requires a separate review checkbox and save.
The customer supplies hours/load. Corrections receive `user_correction`
provenance; matching candidate values receive `label_extraction`. Scan receipts
cannot cross profiles/owners or be consumed twice. Expired receipts cannot
create new appliances. Manual entry remains available after every failure.

## Reproducible local evaluation

Generate smoke fixtures and evaluate only against local Ollama:

```powershell
.venv/Scripts/python.exe tools/vision/evaluate.py --generate-synthetic docs/evaluation/m7-synthetic
.venv/Scripts/python.exe tools/vision/evaluate.py --manifest docs/evaluation/m7-synthetic/manifest.json --output docs/evaluation/m7-results.json --timeout 120
```

The manifest is an array of `{id, image, expected_watts, kind}` objects. Image
paths are relative to the manifest; expected watts is a number or null. Use
`kind: representative_photo` for reviewed, de-identified real appliance labels
and hand-check expected values before running. Reports contain expected/actual
watts, safe errors and elapsed seconds; they exclude image bytes and raw output.
Failed/malformed calls are failures, not successful unknown-value predictions.

Generated cases cover clear, blurry, absent, VA-only, conflicting and kW-only
labels. They are synthetic smoke checks, not representative-photo accuracy or
proof of production suitability. Check results, latency, memory and false watt
claims on real labels before selecting a production model/provider. Model tags
can change; record Ollama version and model digest with each evaluation.

Official references: [Gemma 4 variants](https://ollama.com/library/gemma4/tags),
[Ollama chat API](https://docs.ollama.com/api/chat),
[structured output](https://docs.ollama.com/capabilities/structured-outputs),
[local-only configuration](https://docs.ollama.com/faq).
