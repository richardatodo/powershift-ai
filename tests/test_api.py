"""HTTP/security tests, with optional explicit disposable native PostgreSQL mode."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
from decimal import Decimal, localcontext
import csv
import io
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
import httpx
import jwt
import psycopg
from psycopg import sql
import pytest

from backend.api.app import create_app
from backend.api.auth import TokenVerifier
from backend.api.config import Settings
from backend.api.database import Database
from backend.api.errors import APIError
from backend.api.validation import fingerprint, validate, CONTRACT

ISSUER = "https://identity.example.test/"
AUDIENCE = "powershift-api-tests"


class NoDatabase:
    def open(self): pass
    def close(self): pass
    def run(self, *args): raise RuntimeError("SENSITIVE_SQL_AND_PASSWORD_SENTINEL")


@pytest.fixture(scope="module")
def signing():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    public.update(kid="test-key", use="sig", alg="RS256")
    return key, public


def token(signing, subject="owner-a", **changes):
    now = int(time.time())
    claims = {"iss": ISSUER, "sub": subject, "aud": AUDIENCE, "iat": now, "exp": now + 300}
    claims.update(changes)
    return jwt.encode(claims, signing[0], algorithm="RS256", headers={"kid": "test-key"})


def headers(signing, subject="owner-a", **changes):
    return {"Authorization": "Bearer " + token(signing, subject, **changes)}


@contextmanager
def client_for(signing, database=None, scanner=None, **settings_overrides):
    settings = Settings("postgresql://unused", ISSUER, AUDIENCE, ISSUER + "jwks", requests_per_minute=10000)
    settings = replace(settings, **settings_overrides)
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json={"keys": [signing[1]]}))
    verifier = TokenVerifier(settings, httpx.Client(transport=transport))
    with TestClient(create_app(settings, database=database or NoDatabase(), verifier=verifier, scanner=scanner)) as client:
        yield client


def assert_error(result, status, code):
    assert result.status_code == status, result.text
    body = result.json()
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message", "details", "request_id"}
    assert body["error"]["code"] == code
    assert body["error"]["request_id"] == result.headers["X-Request-ID"]
    assert result.headers["Cache-Control"] == "no-store"
    assert result.headers["X-Contract-Version"] == "0.1.0"
    if status == 401:
        assert result.headers["WWW-Authenticate"] == "Bearer"
    validate("Error", body)


def calculation_row(**changes):
    return {"id": str(uuid4()), "name": "Fan", "quantity": 1, "rated_watts": 100,
            "hours_per_day": 8, "effective_load_percent": 50,
            "source_status": "customer_confirmed", **changes}


def appliance_body(**changes):
    return {"name": "Fan", "quantity": 1, "rated_watts": 100, "hours_per_day": 8,
            "effective_load_percent": 50, "brand": None, "model": None,
            "source_method": "manual", "source_notes": None, "scan_id": None,
            "confirmation": True, "client_request_id": str(uuid4()), **changes}


def test_public_status_and_auth_contract(signing):
    with client_for(signing) as client:
        result = client.get("/api/status", headers={"X-Request-ID": "untrusted-input"})
        assert result.status_code == 200
        assert result.json() == {"imageScanningConfigured": False}
        assert result.headers["X-Request-ID"] != "untrusted-input"
        api = client.app.openapi()
        for route, paths in api["paths"].items():
            for op in paths.values():
                if isinstance(op, dict) and "responses" in op:
                    assert op["security"] == ([] if route == "/api/status" else [{"BearerAuth": []}])


@pytest.mark.parametrize("method,path", [
    ("get", "/api/profiles"),
    ("post", "/api/profiles"), ("get", "/api/profiles/" + str(uuid4())),
    ("post", "/api/profiles/" + str(uuid4()) + "/appliances"),
    ("patch", "/api/appliances/" + str(uuid4())),
    ("delete", "/api/appliances/" + str(uuid4()) + "?version=1"),
    ("post", "/api/calculations"), ("post", "/api/reports"),
    ("get", "/api/reports/" + str(uuid4())),
    ("get", "/api/reports/" + str(uuid4()) + "/export.csv"), ("post", "/api/scan")])
def test_every_private_operation_requires_authentication(signing, method, path):
    with client_for(signing) as client:
        assert_error(client.request(method, path), 401, "AUTHENTICATION_REQUIRED")


@pytest.mark.parametrize("changes", [
    {"iss": "https://attacker.example.test/"}, {"aud": "another-api"}, {"exp": 1},
    {"nbf": int(time.time()) + 3600}, {"iat": int(time.time()) + 3600},
    {"sub": ""}, {"sub": 123}, {"exp": "9999999999"}, {"iat": True}])
def test_wrong_or_expired_claims_are_rejected(signing, changes):
    with client_for(signing) as client:
        assert_error(client.post("/api/calculations", headers=headers(signing, **changes)), 401, "INVALID_CREDENTIALS")


@pytest.mark.parametrize("variant", ["malformed", "unsigned", "hmac", "unknown-key", "missing-exp", "wrong-signature", "duplicate-header"])
def test_signature_and_algorithm_attacks_fail(signing, variant):
    value = token(signing)
    if variant == "malformed": value = "not-a-token"
    elif variant == "unsigned": value = jwt.encode({"sub": "a"}, "", algorithm="none")
    elif variant == "hmac": value = jwt.encode({"sub": "a"}, "SYNTHETIC_TEST_SECRET_32_BYTES_12345", algorithm="HS256", headers={"kid": "test-key"})
    elif variant == "unknown-key": value = jwt.encode({"sub": "a"}, signing[0], algorithm="RS256", headers={"kid": "unknown"})
    elif variant == "missing-exp": value = jwt.encode({"iss": ISSUER, "sub": "a", "aud": AUDIENCE, "iat": int(time.time())}, signing[0], algorithm="RS256", headers={"kid": "test-key"})
    elif variant == "wrong-signature": value = token((rsa.generate_private_key(public_exponent=65537, key_size=2048), signing[1]))
    auth = [("Authorization", "Bearer " + value)]
    if variant == "duplicate-header": auth.append(("Authorization", "Bearer " + value))
    with client_for(signing) as client:
        assert_error(client.post("/api/calculations", headers=auth), 401, "INVALID_CREDENTIALS")


def test_jwks_cache_rotation_and_untrusted_urls(signing):
    calls = []
    second = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(second.public_key()))
    public.update(kid="new-key", alg="RS256")
    keys = [signing[1]]
    def transport(request):
        calls.append(str(request.url))
        return httpx.Response(200, json={"keys": keys})
    settings = Settings("unused", ISSUER, AUDIENCE, ISSUER + "jwks")
    verifier = TokenVerifier(settings, httpx.Client(transport=httpx.MockTransport(transport)))
    try:
        bearer = "Bearer " + token(signing)
        assert verifier.verify(bearer).subject == "owner-a"
        verifier.verify(bearer)
        assert len(calls) == 1
        malicious = jwt.encode({"sub": "a"}, second, algorithm="RS256",
                               headers={"kid": "new-key", "jku": "http://169.254.169.254/credentials"})
        for _ in range(3):
            with pytest.raises(APIError) as error: verifier.verify("Bearer " + malicious)
            assert error.value.status == 401
        assert len(calls) == 1
        keys.append(public)
        verifier.last_attempt -= 6
        claims = {"iss": ISSUER, "sub": "b", "aud": AUDIENCE, "iat": int(time.time()), "exp": int(time.time()) + 300}
        rotated = jwt.encode(claims, second, algorithm="RS256", headers={"kid": "new-key"})
        assert verifier.verify("Bearer " + rotated).subject == "b"
        assert calls == [settings.jwks_url, settings.jwks_url]
    finally: verifier.close()


@pytest.mark.parametrize("document", [{"keys": []}, {"keys": [123]}, {"keys": [{"kid": "a", "kty": "oct"}]}, {"keys": "invalid"}])
def test_invalid_jwks_fails_closed(signing, document):
    settings = Settings("unused", ISSUER, AUDIENCE, ISSUER + "jwks")
    verifier = TokenVerifier(settings, httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=document))))
    try:
        with pytest.raises(APIError) as error: verifier.verify("Bearer " + token(signing))
        assert error.value.code == "AUTHENTICATION_UNAVAILABLE"
    finally: verifier.close()


def test_jwks_network_failure_is_sanitized_and_bounded(signing):
    def unavailable(_): raise httpx.ConnectError("SECRET_URL_PASSWORD_SENTINEL")
    settings = Settings("unused", ISSUER, AUDIENCE, ISSUER + "jwks")
    verifier = TokenVerifier(settings, httpx.Client(transport=httpx.MockTransport(unavailable)))
    with TestClient(create_app(settings, database=NoDatabase(), verifier=verifier)) as client:
        result = client.post("/api/calculations", headers=headers(signing))
        assert_error(result, 503, "AUTHENTICATION_UNAVAILABLE")
        assert "SENTINEL" not in result.text


@pytest.mark.parametrize("raw,status,code", [
    ('{"appliances": [], "appliances": []}', 400, "MALFORMED_JSON"),
    ('{"value": NaN}', 400, "MALFORMED_JSON"), ('{', 400, "MALFORMED_JSON"),
    ('[]', 422, "VALIDATION_ERROR"),
    ('{"appliances":[],"period_days":"30","rate_ngn_per_kwh":null}', 422, "VALIDATION_ERROR"),
    ('{"appliances":[],"period_days":true,"rate_ngn_per_kwh":null}', 422, "VALIDATION_ERROR"),
    ('{"appliances":[],"period_days":30,"rate_ngn_per_kwh":null,"owner_id":"forged"}', 422, "VALIDATION_ERROR")])
def test_strict_json_and_no_coercion(signing, raw, status, code):
    with client_for(signing) as client:
        result = client.post("/api/calculations", content=raw, headers={**headers(signing), "Content-Type": "application/json"})
        assert_error(result, status, code)


def test_exact_decimal_calculation_and_null_load_http(signing):
    with client_for(signing) as client:
        row = calculation_row(rated_watts=None, hours_per_day=0, effective_load_percent=None)
        result = client.post("/api/calculations", json={"appliances": [row], "period_days": 30, "rate_ngn_per_kwh": 0}, headers=headers(signing))
        assert result.status_code == 200
        assert result.json()["totals"] == {"daily_kwh": None, "period_kwh": None, "grid_equivalent_cost_ngn": None}
        row = calculation_row()
        raw = json.dumps({"appliances": [row], "period_days": 30, "rate_ngn_per_kwh": 100}).replace('"rated_watts": 100', '"rated_watts": 100.0000000000000000000001')
        result = client.post("/api/calculations", content=raw, headers={**headers(signing), "Content-Type": "application/json"})
        assert result.status_code == 200
        assert result.json()["totals"]["period_kwh"] == "12.000000"
        assert result.json()["totals"]["grid_equivalent_cost_ngn"] == "1200.00"


def test_size_limit_media_type_rate_limit_and_safe_unexpected_error(signing, caplog):
    with client_for(signing, max_body_bytes=1024) as client:
        assert_error(client.post("/api/calculations", content="{}", headers=headers(signing)), 415, "UNSUPPORTED_MEDIA_TYPE")
        assert_error(client.post("/api/calculations", content="x" * 1025, headers=headers(signing)), 413, "REQUEST_TOO_LARGE")
        assert_error(client.get("/api/status", headers={"Content-Length": "9" * 100}), 413, "REQUEST_TOO_LARGE")
        result = client.post("/api/profiles", json={"name": None, "sector": "home", "currency": "NGN", "client_request_id": str(uuid4())}, headers=headers(signing))
        assert_error(result, 500, "INTERNAL_ERROR")
        assert "SENSITIVE" not in result.text + caplog.text
    with client_for(signing, requests_per_minute=1) as client:
        assert client.get("/api/status").status_code == 200
        result = client.get("/api/status")
        assert_error(result, 429, "RATE_LIMITED")
        assert result.headers["Retry-After"] == "60"


def test_equivalent_numeric_fingerprints_ignore_decimal_context():
    with localcontext() as context:
        context.prec = 2
        first = {"x": Decimal("123456789.120000"), "client_request_id": "a"}
        second = {"client_request_id": "b", "x": Decimal("123456789.12")}
        assert fingerprint(first) == fingerprint(second)
        assert fingerprint({"x": Decimal("-0")}) == fingerprint({"x": 0})
        assert fingerprint({"x": "123456789.12"}) != fingerprint(second)


@pytest.fixture(scope="module")
def native_database():
    admin_url = os.environ.get("POWERSHIFT_TEST_DATABASE_URL")
    if not admin_url:
        pytest.skip("Native HTTP tests require an explicitly disposable PostgreSQL cluster")
    if os.environ.get("POWERSHIFT_NATIVE_TESTS") != "1":
        pytest.fail("Explicit POWERSHIFT_NATIVE_TESTS=1 is required")
    if not os.environ.get("POWERSHIFT_PG_ROOT"):
        pytest.fail("Set POWERSHIFT_PG_ROOT for the pinned migration driver")
    database_name = "powershift_m5_test_" + uuid4().hex
    login = "powershift_m5_login_" + uuid4().hex[:16]
    password = uuid4().hex
    parsed = urlsplit(admin_url)
    def url_for(database, user=None, secret=None):
        host = parsed.netloc if user is None else f"{user}:{secret}@{parsed.hostname}:{parsed.port or 5432}"
        return urlunsplit((parsed.scheme, host, "/" + database, parsed.query, ""))
    admin = psycopg.connect(admin_url, autocommit=True)
    reserved = admin.execute("SELECT rolname FROM pg_roles WHERE rolname IN ('powershift_app','m4_migration_owner')").fetchall()
    if reserved:
        admin.close()
        pytest.fail("Disposable native cluster already has reserved roles; refusing cleanup of existing resources")
    database_created, role_created = False, False
    try:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database_name)))
        database_created = True
        target = url_for(database_name)
        env = {**os.environ, "POWERSHIFT_MIGRATION_DATABASE_URL": target}
        result = subprocess.run(["node", "tools/db/migrate-postgres.cjs"], env=env, capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stderr
        admin.execute(sql.SQL("CREATE ROLE {} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD {}")
                      .format(sql.Identifier(login), sql.Literal(password)))
        role_created = True
        admin.execute(sql.SQL("GRANT powershift_app TO {}").format(sql.Identifier(login)))
        yield url_for(database_name, login, password), target
    finally:
        if database_created:
            assert database_name.startswith("powershift_m5_test_") and len(database_name) == 51
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(database_name)))
        if role_created:
            admin.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(login)))
        if database_created:
            admin.execute("DROP ROLE IF EXISTS powershift_app")
        admin.close()


@pytest.fixture
def live(signing, native_database):
    url, admin = native_database
    settings = Settings(url, ISSUER, AUDIENCE, ISSUER + "jwks", requests_per_minute=10000, pool_size=2)
    with client_for(signing, Database(settings), database_url=url) as client:
        yield client, admin


def profile(client, signing, subject="owner-a", **changes):
    body = {"name": "Test home", "sector": "home", "currency": "NGN", "client_request_id": str(uuid4()), **changes}
    result = client.post("/api/profiles", json=body, headers=headers(signing, subject))
    assert result.status_code == 201, result.text
    validate("ProfileRead", result.json())
    return result.json(), body


def appliance(client, signing, profile_id, **changes):
    body = appliance_body(**changes)
    result = client.post(f"/api/profiles/{profile_id}/appliances", json=body, headers=headers(signing))
    assert result.status_code == 201, result.text
    validate("ApplianceRead", result.json())
    return result.json(), body


def test_native_profile_appliance_roundtrip_and_owner_isolation(live, signing):
    client, _ = live
    saved, body = profile(client, signing)
    again = client.post("/api/profiles", json=body, headers=headers(signing))
    assert again.status_code == 200 and again.json()["id"] == saved["id"]
    changed = client.post("/api/profiles", json={**body, "name": "different"}, headers=headers(signing))
    assert_error(changed, 409, "IDEMPOTENCY_CONFLICT")
    device, _ = appliance(client, signing, saved["id"])
    result = client.get("/api/profiles/" + saved["id"], headers=headers(signing))
    validate("ProfileWithAppliances", result.json())
    assert result.json()["appliances"][0]["calculated_daily_kwh"] == "0.400000"
    for method, path, data in [
        ("get", "/api/profiles/" + saved["id"], None),
        ("post", f'/api/profiles/{saved["id"]}/appliances', appliance_body()),
        ("patch", "/api/appliances/" + device["id"], {"name": "stolen", "version": 1, "confirmation": True}),
        ("delete", "/api/appliances/" + device["id"] + "?version=1", None),
        ("post", "/api/reports", {"profile_id": saved["id"], "period_days": 30, "rate_ngn_per_kwh": None, "client_request_id": str(uuid4())})]:
        assert_error(client.request(method, path, json=data, headers=headers(signing, "owner-b")), 404, "RESOURCE_NOT_FOUND")
    missing_result = client.get("/api/profiles/" + str(uuid4()), headers=headers(signing, "owner-b"))
    assert_error(missing_result, 404, "RESOURCE_NOT_FOUND")


@pytest.mark.parametrize("change", [{"quantity": True}, {"rated_watts": "100"}, {"hours_per_day": -1},
    {"effective_load_percent": 0}, {"confirmation": False}, {"owner_id": str(uuid4())},
    {"calculated_daily_kwh": "1000.000000"}, {"field_provenance": {}}, {"source_status": "measured"}])
def test_native_request_validation_rejects_forgery_and_bad_types(live, signing, change):
    client, _ = live
    saved, _ = profile(client, signing)
    result = client.post(f'/api/profiles/{saved["id"]}/appliances', json=appliance_body(**change), headers=headers(signing))
    assert_error(result, 422, "VALIDATION_ERROR")
    assert client.get("/api/profiles/" + saved["id"], headers=headers(signing)).json()["appliances"] == []


def test_native_incomplete_reconfirmation_stale_edits_and_deleted_replay(live, signing):
    client, _ = live
    saved, _ = profile(client, signing)
    device, body = appliance(client, signing, saved["id"], effective_load_percent=None, hours_per_day=0)
    assert device["calculated_daily_kwh"] is None and device["calculation_status"] == "incomplete"
    path = "/api/appliances/" + device["id"]
    edited = client.patch(path, json={"effective_load_percent": 50, "version": 1, "confirmation": True}, headers=headers(signing))
    assert edited.status_code == 200, edited.text
    assert edited.json()["version"] == 2 and edited.json()["calculated_daily_kwh"] == "0.000000"
    assert edited.json()["field_provenance"]["effective_load_percent"]["origin"] == "user_correction"
    assert_error(client.patch(path, json={"name": "stale", "version": 1, "confirmation": True}, headers=headers(signing)), 409, "STALE_VERSION")
    assert_error(client.delete(path + "?version=1", headers=headers(signing)), 409, "STALE_VERSION")
    deleted = client.delete(path + "?version=2", headers=headers(signing))
    assert deleted.status_code == 204 and deleted.content == b""
    assert_error(client.post(f'/api/profiles/{saved["id"]}/appliances', json=body, headers=headers(signing)), 404, "RESOURCE_NOT_FOUND")
    assert_error(client.post(f'/api/profiles/{saved["id"]}/appliances', json={**body, "name": "changed"}, headers=headers(signing)), 409, "IDEMPOTENCY_CONFLICT")


def test_native_reports_are_computed_owned_and_historical(live, signing):
    client, _ = live
    saved, _ = profile(client, signing)
    device, _ = appliance(client, signing, saved["id"], name="=SUM(1,2)")
    incomplete, _ = appliance(client, signing, saved["id"], name="Unknown", effective_load_percent=None)
    body = {"profile_id": saved["id"], "period_days": 30, "rate_ngn_per_kwh": 100, "client_request_id": str(uuid4())}
    result = client.post("/api/reports", json=body, headers=headers(signing))
    assert result.status_code == 201, result.text
    report = result.json()
    validate("ReportRead", report)
    assert report["calculation"]["totals"] == {"daily_kwh": "0.400000", "period_kwh": "12.000000", "grid_equivalent_cost_ngn": "1200.00"}
    assert report["calculation"]["counts"]["incomplete"] == 1
    assert_error(client.get("/api/reports/" + report["id"], headers=headers(signing, "owner-b")), 404, "RESOURCE_NOT_FOUND")
    assert_error(client.get("/api/reports/" + report["id"] + "/export.csv", headers=headers(signing, "owner-b")), 404, "RESOURCE_NOT_FOUND")
    assert client.delete("/api/appliances/" + device["id"] + "?version=1", headers=headers(signing)).status_code == 204
    assert client.patch("/api/appliances/" + incomplete["id"], json={"name": "Edited later", "version": 1, "confirmation": True}, headers=headers(signing)).status_code == 200
    assert client.get("/api/reports/" + report["id"], headers=headers(signing)).json() == report
    replay = client.post("/api/reports", json=body, headers=headers(signing))
    assert replay.status_code == 200 and replay.json() == report
    csv_result = client.get("/api/reports/" + report["id"] + "/export.csv", headers=headers(signing))
    assert csv_result.status_code == 200 and csv_result.headers["Cache-Control"] == "no-store"
    rows = list(csv.DictReader(io.StringIO(csv_result.text)))
    eligible = next(row for row in rows if row["calculation_status"] == "eligible")
    excluded = next(row for row in rows if row["calculation_status"] == "incomplete")
    assert eligible["name"] == "'=SUM(1,2)" and eligible["grid_equivalent_cost_ngn"] == "1200.00"
    assert excluded["name"] == "Unknown" and excluded["daily_kwh"] == "" and excluded["exclusion_codes"] == "MISSING_VALUE"


def test_native_empty_zero_tariff_and_exact_persistence(live, signing):
    client, _ = live
    saved, _ = profile(client, signing)
    def report(rate):
        return client.post("/api/reports", json={"profile_id": saved["id"], "period_days": 30,
            "rate_ngn_per_kwh": rate, "client_request_id": str(uuid4())}, headers=headers(signing))
    result = report(0)
    assert result.status_code == 201, result.text
    assert result.json()["calculation"]["totals"]["daily_kwh"] is None
    body = json.dumps(appliance_body()).replace('"rated_watts": 100', '"rated_watts": 100.000000000000000000000001')
    result = client.post(f'/api/profiles/{saved["id"]}/appliances', content=body,
                         headers={**headers(signing), "Content-Type": "application/json"})
    assert result.status_code == 201, result.text
    assert "100.000000000000000000000001" in result.text
    assert report(0).json()["calculation"]["totals"]["grid_equivalent_cost_ngn"] == "0.00"
    assert report(None).json()["calculation"]["totals"]["grid_equivalent_cost_ngn"] is None


def test_native_scanning_disabled_owned_scope(live, signing):
    client, _ = live
    saved, _ = profile(client, signing)
    body = {"profile_id": saved["id"], "imageDataUrl": "data:image/png;base64,aGVsbG8=",
            "consent": {"granted": True, "notice_version": "test-notice"}}
    assert_error(client.post("/api/scan", json=body, headers=headers(signing)), 503, "SCANNER_UNAVAILABLE")
    assert_error(client.post("/api/scan", json=body, headers=headers(signing, "owner-b")), 404, "RESOURCE_NOT_FOUND")


def test_native_pool_context_does_not_leak_between_owners(live, signing):
    client, _ = live
    a, _ = profile(client, signing, "pool-a")
    b, _ = profile(client, signing, "pool-b")
    def read(index):
        subject, own, other = ("pool-a", a, b) if index % 2 else ("pool-b", b, a)
        own_result = client.get("/api/profiles/" + own["id"], headers=headers(signing, subject))
        denied = client.get("/api/profiles/" + other["id"], headers=headers(signing, subject))
        return own_result.status_code, denied.status_code
    with ThreadPoolExecutor(max_workers=4) as workers:
        assert list(workers.map(read, range(12))) == [(200, 404)] * 12


def test_native_idempotency_race_and_numeric_equivalence(live, signing):
    client, _ = live
    saved, _ = profile(client, signing)
    body = appliance_body()
    def create(_): return client.post(f'/api/profiles/{saved["id"]}/appliances', json=body, headers=headers(signing))
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(create, range(2)))
    assert sorted(result.status_code for result in results) == [200, 201]
    assert results[0].json()["id"] == results[1].json()["id"]
    raw = json.dumps(body).replace('"quantity": 1', '"quantity": 1.000e0')
    result = client.post(f'/api/profiles/{saved["id"]}/appliances', content=raw,
                         headers={**headers(signing), "Content-Type": "application/json"})
    assert result.status_code == 200, result.text


def test_native_identity_mapping_and_direct_role_isolation(live, signing):
    client, admin_url = live
    a, _ = profile(client, signing, "identity-one")
    profile(client, signing, "identity-two")
    with psycopg.connect(admin_url, autocommit=True) as conn:
        owners = conn.execute("SELECT id,identity_subject FROM powershift.users WHERE identity_subject IN ('identity-one','identity-two')").fetchall()
        assert len(owners) == 2 and owners[0][0] != owners[1][0]
        conn.execute("SET ROLE powershift_app")
        assert conn.execute("SELECT count(*) FROM powershift.profiles").fetchone()[0] == 0
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("INSERT INTO powershift.users(identity_issuer,identity_subject) VALUES ('forged','forged')")


def test_native_api_rejects_administrative_database_credentials(native_database):
    _, admin_url = native_database
    settings = Settings(admin_url, ISSUER, AUDIENCE, ISSUER + "jwks")
    with psycopg.connect(admin_url, autocommit=True, row_factory=psycopg.rows.dict_row) as conn:
        with pytest.raises(ValueError, match="restricted database login"):
            Database._configure(conn)


def test_native_scan_receipts_are_owned_single_use_and_preserve_evidence(live, signing):
    from psycopg.types.json import Jsonb
    client, admin_url = live
    first, _ = profile(client, signing)
    second, _ = profile(client, signing)
    other, _ = profile(client, signing, "scan-other-owner")
    candidate = {"name": "Fan", "brand": None, "model": None, "watts": 100,
                 "voltage": None, "current": None, "kwh_per_day": None,
                 "notes": "", "visible_evidence": "100 W visible on label"}
    def seed(expired=False):
        scan_id = str(uuid4())
        with psycopg.connect(admin_url, autocommit=True) as conn:
            owner = conn.execute("SELECT owner_id FROM powershift.profiles WHERE id=%s", (first["id"],)).fetchone()[0]
            conn.execute("""INSERT INTO powershift.scan_sessions(id,owner_id,profile_id,status,candidate,
                consent_notice_version,created_at,consented_at,expires_at)
                VALUES (%s,%s,%s,'candidate',%s,'test-notice',clock_timestamp()-interval '2 hours',
                    clock_timestamp()-interval '2 hours',clock_timestamp() + %s::interval)""",
                (scan_id, owner, first["id"], Jsonb(candidate), "-1 hour" if expired else "1 hour"))
        return scan_id
    receipt = seed()
    body = appliance_body(source_method="ai_label_extraction", scan_id=receipt)
    for scope, subject in ((second, "owner-a"), (other, "scan-other-owner")):
        result = client.post(f'/api/profiles/{scope["id"]}/appliances', json=body, headers=headers(signing, subject))
        assert_error(result, 404, "RESOURCE_NOT_FOUND")
    path = f'/api/profiles/{first["id"]}/appliances'
    result = client.post(path, json=body, headers=headers(signing))
    assert result.status_code == 201, result.text
    saved = result.json()
    assert saved["field_provenance"]["rated_watts"] == {"origin": "label_extraction", "evidence": candidate["visible_evidence"]}
    assert client.post(path, json=body, headers=headers(signing)).status_code == 200
    assert_error(client.post(path, json={**body, "client_request_id": str(uuid4())}, headers=headers(signing)), 409, "SCAN_ALREADY_CONFIRMED")
    corrected = client.patch("/api/appliances/" + saved["id"], json={"rated_watts": 125, "version": 1, "confirmation": True}, headers=headers(signing))
    assert corrected.status_code == 200, corrected.text
    assert corrected.json()["field_provenance"]["rated_watts"] == {"origin": "user_correction", "evidence": candidate["visible_evidence"]}
    assert_error(client.post(path, json=appliance_body(source_method="ai_label_extraction", scan_id=seed(expired=True)), headers=headers(signing)), 409, "SCAN_EXPIRED")


def test_signed_owner_id_claim_cannot_override_subject(live, signing):
    client, admin_url = live
    saved, _ = profile(client, signing, "claim-owner")
    with psycopg.connect(admin_url) as conn:
        owner = conn.execute("SELECT owner_id FROM powershift.profiles WHERE id=%s", (saved["id"],)).fetchone()[0]
    result = client.get("/api/profiles/" + saved["id"], headers=headers(signing, "claim-attacker", owner_id=str(owner)))
    assert_error(result, 404, "RESOURCE_NOT_FOUND")


def test_streaming_body_limit_and_numeric_resource_error(signing):
    with client_for(signing, max_body_bytes=1024) as client:
        def chunks():
            yield b'{"a":"'
            yield b'x' * 1100
            yield b'"}'
        result = client.post("/api/calculations", content=chunks(),
                             headers={**headers(signing), "Content-Type": "application/json"})
        assert_error(result, 413, "REQUEST_TOO_LARGE")
    with client_for(signing) as client:
        raw = '{"appliances":[],"period_days":30,"rate_ngn_per_kwh":1e999999}'
        result = client.post("/api/calculations", content=raw,
                             headers={**headers(signing), "Content-Type": "application/json"})
        assert_error(result, 422, "CALCULATION_OUT_OF_RANGE")


def test_database_connection_error_does_not_leak_details(signing, caplog):
    class FailedDatabase(NoDatabase):
        def run(self, *args): raise psycopg.OperationalError("SQL_PASSWORD_SENTINEL")
    with client_for(signing, database=FailedDatabase()) as client:
        result = client.get("/api/profiles/" + str(uuid4()), headers=headers(signing))
        assert_error(result, 503, "SERVICE_UNAVAILABLE")
        assert "SENTINEL" not in result.text + caplog.text


def test_environment_configuration_requires_explicit_trust(monkeypatch):
    for name in ("DATABASE_URL", "AUTH_ISSUER", "AUTH_AUDIENCE", "AUTH_JWKS_URL"):
        monkeypatch.delenv("POWERSHIFT_" + name, raising=False)
    with pytest.raises(ValueError): Settings.from_env()
    for name, value in (("DATABASE_URL", "postgresql://test"), ("AUTH_ISSUER", ISSUER),
                        ("AUTH_AUDIENCE", AUDIENCE), ("AUTH_JWKS_URL", ISSUER + "jwks"),
                        ("POOL_SIZE", "2"), ("MAX_BODY_BYTES", "2048"), ("REQUESTS_PER_MINUTE", "20")):
        monkeypatch.setenv("POWERSHIFT_" + name, value)
    settings = Settings.from_env()
    assert (settings.pool_size, settings.max_body_bytes, settings.requests_per_minute) == (2, 2048, 20)
    monkeypatch.setenv("POWERSHIFT_AUTH_JWKS_URL", "http://untrusted.example.test/keys")
    with pytest.raises(ValueError): Settings.from_env()


@pytest.mark.parametrize("bad_text", ["null\x00byte", "surrogate\ud800"])
def test_json_text_must_be_representable_in_postgresql(signing, bad_text):
    with client_for(signing) as client:
        raw = json.dumps({"name": bad_text, "sector": "home", "currency": "NGN", "client_request_id": str(uuid4())})
        result = client.post("/api/profiles", content=raw,
                             headers={**headers(signing), "Content-Type": "application/json"})
        assert_error(result, 422, "VALIDATION_ERROR")


def test_native_profile_list_is_owned_paginated_and_validated(live, signing):
    client, _ = live
    owner = 'm6-list-' + uuid4().hex
    other = 'm6-other-' + uuid4().hex
    created = [profile(client, signing, owner, name=f'Profile {index}')[0] for index in range(3)]
    foreign, _ = profile(client, signing, other)
    first = client.get('/api/profiles?limit=2', headers=headers(signing, owner))
    assert first.status_code == 200
    validate('ProfileList', first.json())
    assert len(first.json()['profiles']) == 2 and first.json()['next_cursor']
    second = client.get('/api/profiles?limit=2&after=' + first.json()['next_cursor'], headers=headers(signing, owner))
    assert second.status_code == 200 and second.json()['next_cursor'] is None
    returned = first.json()['profiles'] + second.json()['profiles']
    assert {item['id'] for item in returned} == {item['id'] for item in created}
    assert foreign['id'] not in {item['id'] for item in returned}
    for query in ('limit=0', 'limit=101', 'limit=2&limit=3', 'after=invalid', 'owner_id=' + str(uuid4())):
        assert_error(client.get('/api/profiles?' + query, headers=headers(signing, owner)), 422, 'VALIDATION_ERROR')


@pytest.mark.parametrize("case", ["clear_watts", "blurry", "missing_label", "va_only", "ambiguous"])
def test_native_scan_candidate_needs_confirmation_and_preserves_provenance(native_database, signing, case):
    from backend.api.config import ScanSettings
    from backend.api.scanning import extraction_result
    from backend.api.vision import NOTICE_VERSION
    from test_scanning import extract, image_url
    class LocalScanner:
        def extract(self, image): return extraction_result(extract(case))
        def close(self): pass
    settings = Settings(native_database[0], ISSUER, AUDIENCE, ISSUER + "jwks")
    with client_for(signing, database=Database(settings), scanner=LocalScanner(), scan=ScanSettings(provider="ollama")) as client:
        owner = 'm7-' + uuid4().hex
        saved, _ = profile(client, signing, owner)
        body = {"imageDataUrl": image_url(), "profile_id": saved["id"],
                "consent": {"granted": True, "notice_version": NOTICE_VERSION}}
        result = client.post('/api/scan', json=body, headers=headers(signing, owner))
        assert result.status_code == 200, result.text
        receipt = result.json(); validate('ScanResponse', receipt)
        assert receipt['requiresConfirmation'] is True
        assert receipt['result']['watts'] == (60 if case == 'clear_watts' else None)
        assert client.get('/api/profiles/' + saved['id'], headers=headers(signing, owner)).json()['appliances'] == []
        create = appliance_body(name='Reviewed fan', rated_watts=receipt['result']['watts'],
            source_method='ai_label_extraction', scan_id=receipt['scan_id'])
        path = f'/api/profiles/{saved["id"]}/appliances'
        assert_error(client.post(path, json={**create, 'confirmation': False}, headers=headers(signing, owner)), 422, 'VALIDATION_ERROR')
        assert_error(client.post('/api/scan', json=body, headers=headers(signing, 'm7-other')), 404, 'RESOURCE_NOT_FOUND')
        other_profile, _ = profile(client, signing, 'm7-other')
        assert_error(client.post(f'/api/profiles/{other_profile["id"]}/appliances', json=create,
            headers=headers(signing, 'm7-other')), 404, 'RESOURCE_NOT_FOUND')
        stored = client.post(path, json=create, headers=headers(signing, owner))
        assert stored.status_code == 201, stored.text
        assert stored.json()['field_provenance']['name']['origin'] == 'user_correction'
        assert stored.json()['field_provenance']['rated_watts']['origin'] == 'label_extraction'
        assert stored.json()['calculation_status'] == ('eligible' if case == 'clear_watts' else 'incomplete')
        assert client.post(path, json=create, headers=headers(signing, owner)).status_code == 200
        assert_error(client.post(path, json={**create,'client_request_id':str(uuid4())},
            headers=headers(signing, owner)), 409, 'SCAN_ALREADY_CONFIRMED')


@pytest.mark.parametrize('failure_code,status', [('SCAN_TIMEOUT',504), ('INVALID_SCAN_RESULT',502), ('SCANNER_UNAVAILABLE',503)])
def test_native_scan_failures_are_durable_and_manual_entry_survives(native_database, signing, failure_code, status):
    from backend.api.config import ScanSettings
    from backend.api.vision import NOTICE_VERSION
    from test_scanning import image_url
    class FailedScanner:
        def extract(self, image): raise APIError(status, failure_code, 'Try manual entry.')
        def close(self): pass
    settings = Settings(native_database[0], ISSUER, AUDIENCE, ISSUER + 'jwks')
    with client_for(signing, database=Database(settings), scanner=FailedScanner(),
                    scan=ScanSettings(provider='ollama',daily_limit=1)) as client:
        owner = 'm7-failure-' + uuid4().hex
        saved, _ = profile(client, signing, owner)
        body = {'imageDataUrl':image_url(),'profile_id':saved['id'],
                'consent':{'granted':True,'notice_version':NOTICE_VERSION}}
        assert_error(client.post('/api/scan',json=body,headers=headers(signing,owner)),status,failure_code)
        assert_error(client.post('/api/scan',json=body,headers=headers(signing,owner)),429,'RATE_LIMITED')
        created = client.post(f'/api/profiles/{saved["id"]}/appliances',json=appliance_body(),headers=headers(signing,owner))
        assert created.status_code == 201
        with psycopg.connect(native_database[1], autocommit=True) as conn:
            receipt = conn.execute('SELECT status,error_code,candidate FROM powershift.scan_sessions WHERE profile_id=%s', (saved['id'],)).fetchone()
            assert receipt == ('failed', failure_code if status != 503 else 'SCAN_PROVIDER_ERROR', None)


def test_native_scan_input_consent_and_expiry(native_database, signing):
    from backend.api.config import ScanSettings
    from backend.api.vision import NOTICE_VERSION
    from test_scanning import image_url, extract
    from backend.api.scanning import extraction_result
    class LocalScanner:
        def extract(self,image): return extraction_result(extract())
        def close(self): pass
    settings = Settings(native_database[0],ISSUER,AUDIENCE,ISSUER+'jwks')
    with client_for(signing,database=Database(settings),scanner=LocalScanner(),scan=ScanSettings(provider='ollama')) as client:
        saved,_ = profile(client,signing)
        body={'imageDataUrl':image_url(),'profile_id':saved['id'],'consent':{'granted':True,'notice_version':NOTICE_VERSION}}
        for image in (None, 1, 'data:image/png;base64,AAAA'):
            assert_error(client.post('/api/scan',json={**body,'imageDataUrl':image},headers=headers(signing)),400,'INVALID_IMAGE')
        assert_error(client.post('/api/scan',json={**body,'consent':{'granted':True,'notice_version':'unknown'}},headers=headers(signing)),422,'VALIDATION_ERROR')
        assert_error(client.post('/api/scan',json={**body,'consent':{'granted':False,'notice_version':NOTICE_VERSION}},headers=headers(signing)),422,'VALIDATION_ERROR')
        status=client.get('/api/status'); validate('StatusResponse',status.json())
        assert status.json()['scanNotice']['version'] == NOTICE_VERSION
        result=client.post('/api/scan',json=body,headers=headers(signing)); assert result.status_code==200
        scan_id=result.json()['scan_id']
        # Advance the expiry predicate with an injected application clock; the DB
        # trigger separately enforces real clock expiry and forbids mutating it.
        from unittest.mock import patch
        from datetime import timedelta, datetime, timezone
        with patch('backend.api.service.datetime') as clock:
            clock.now.return_value=datetime.now(timezone.utc)+timedelta(days=2)
            result=client.post(f'/api/profiles/{saved["id"]}/appliances',json=appliance_body(
                source_method='ai_label_extraction',scan_id=scan_id),headers=headers(signing))
        assert_error(result,409,'SCAN_EXPIRED')


def test_native_scanning_bounds_memory_and_leaves_manual_requests_available(native_database, signing):
    import threading
    from backend.api.config import ScanSettings
    from backend.api.scanning import extraction_result
    from backend.api.vision import NOTICE_VERSION
    from test_scanning import extract, image_url
    started, release = threading.Event(), threading.Event()
    class BlockingScanner:
        def extract(self,image):
            started.set()
            if not release.wait(20): raise RuntimeError('Test did not release inference')
            return extraction_result(extract())
        def close(self): release.set()
    settings=Settings(native_database[0],ISSUER,AUDIENCE,ISSUER+'jwks')
    with client_for(signing,database=Database(settings),scanner=BlockingScanner(),scan=ScanSettings(provider='ollama')) as client:
        owner='m7-concurrency-'+uuid4().hex
        saved,_=profile(client,signing,owner)
        body={'imageDataUrl':image_url(),'profile_id':saved['id'],'consent':{'granted':True,'notice_version':NOTICE_VERSION}}
        with ThreadPoolExecutor(max_workers=1) as executor:
            running=executor.submit(client.post,'/api/scan',json=body,headers=headers(signing,owner))
            try:
                assert started.wait(10)
                assert_error(client.post('/api/scan',json=body,headers=headers(signing,owner)),429,'RATE_LIMITED')
                manual=client.post(f'/api/profiles/{saved["id"]}/appliances',json=appliance_body(),headers=headers(signing,owner))
                assert manual.status_code==201,manual.text
            finally: release.set()
            assert running.result(timeout=10).status_code==200


@pytest.mark.parametrize('tariff,cost', [(None,None),(0,'0.00'),(100,'259.00')])
def test_native_report_csv_matches_hand_checked_period_and_complete_schema(live,signing,tariff,cost):
    client,_=live
    saved,_=profile(client,signing)
    malicious='=Fan, "quoted"\nsecond line'
    appliance(client,signing,saved['id'],name=malicious,rated_watts=100,hours_per_day=5,effective_load_percent=50)
    appliance(client,signing,saved['id'],name='Two fans',quantity=2,rated_watts=60,hours_per_day=4,effective_load_percent=25)
    appliance(client,signing,saved['id'],name='Known zero',hours_per_day=0)
    appliance(client,signing,saved['id'],name='Missing load',effective_load_percent=None)
    snapshot=client.get('/api/profiles/'+saved['id'],headers=headers(signing)).json()['appliances']
    inputs=[{key:row[key] for key in ('id','name','quantity','rated_watts','hours_per_day','effective_load_percent','source_status')} for row in snapshot]
    dashboard=client.post('/api/calculations',json={'appliances':inputs,'period_days':7,'rate_ngn_per_kwh':tariff},headers=headers(signing)).json()
    response=client.post('/api/reports',json={'profile_id':saved['id'],'period_days':7,'rate_ngn_per_kwh':tariff,'client_request_id':str(uuid4())},headers=headers(signing))
    assert response.status_code==201,response.text
    report=response.json();assert report['calculation']==dashboard
    assert report['calculation']['totals']=={'daily_kwh':'0.370000','period_kwh':'2.590000','grid_equivalent_cost_ngn':cost}
    assert report['calculation']['counts']['incomplete']==1
    result=client.get(f'/api/reports/{report["id"]}/export.csv',headers=headers(signing))
    assert result.status_code==200 and result.headers['Content-Type'].startswith('text/csv')
    assert result.headers['Content-Disposition']==f'attachment; filename="powershift-{report["id"]}.csv"'
    reader=csv.DictReader(io.StringIO(result.text))
    assert reader.fieldnames=='report_id,estimate,appliance_id,name,quantity,rated_watts,hours_per_day,effective_load_percent,source_method,source_status,calculation_status,daily_kwh,period_days,period_kwh,rate_ngn_per_kwh,tariff_provenance,grid_equivalent_cost_ngn,cost_basis,assumptions,exclusion_codes'.split(',')
    rows=list(reader);assert len(rows)==4
    assert next(row for row in rows if row['name'].startswith("'=Fan"))['name']=="'"+malicious
    unknown=next(row for row in rows if row['name']=='Missing load')
    assert unknown['effective_load_percent']==unknown['daily_kwh']==unknown['period_kwh']==unknown['grid_equivalent_cost_ngn']==''
    assert unknown['exclusion_codes']=='MISSING_VALUE'
    zero=next(row for row in rows if row['name']=='Known zero')
    assert zero['daily_kwh']=='0.000000' and zero['period_kwh']=='0.000000'
    for row in rows:
        assert row['report_id']==report['id'] and row['estimate']=='true' and row['period_days']=='7'
        assert row['assumptions']=='; '.join(report['calculation']['assumptions'])
        assert row['cost_basis']==('grid_equivalent' if tariff is not None else '')
        assert row['tariff_provenance']==('user_input' if tariff is not None else '')


def test_native_report_rounding_uses_unrounded_inputs_for_total_and_csv_cost(live,signing):
    client,_=live;saved,_=profile(client,signing)
    for index in range(3):
        appliance(client,signing,saved['id'],name=f'Tiny load {index}',rated_watts=1,hours_per_day=1,effective_load_percent=0.04)
    result=client.post('/api/reports',json={'profile_id':saved['id'],'period_days':1,'rate_ngn_per_kwh':1000000,'client_request_id':str(uuid4())},headers=headers(signing))
    assert result.status_code==201,result.text
    report=result.json()
    assert report['calculation']['totals']=={'daily_kwh':'0.000001','period_kwh':'0.000001','grid_equivalent_cost_ngn':'1.20'}
    assert any(warning['code']=='ROUNDING_APPLIED' for warning in report['calculation']['warnings'])
    rows=list(csv.DictReader(io.StringIO(client.get(f'/api/reports/{report["id"]}/export.csv',headers=headers(signing)).text)))
    assert len(rows)==3
    assert all(row['daily_kwh']=='0.000000' and row['period_kwh']=='0.000000' and row['grid_equivalent_cost_ngn']=='0.40' for row in rows)


@pytest.mark.parametrize('incomplete', [False,True])
def test_native_report_empty_and_all_incomplete_exports_have_no_invented_totals(live,signing,incomplete):
    client,_=live;saved,_=profile(client,signing)
    if incomplete: appliance(client,signing,saved['id'],rated_watts=None,hours_per_day=None,effective_load_percent=None)
    response=client.post('/api/reports',json={'profile_id':saved['id'],'period_days':366,'rate_ngn_per_kwh':0,'client_request_id':str(uuid4())},headers=headers(signing))
    assert response.status_code==201,response.text
    report=response.json();assert all(value is None for value in report['calculation']['totals'].values())
    assert report['calculation']['counts']['eligible']==0
    assert report['calculation']['assumptions']
    reader=csv.DictReader(io.StringIO(client.get(f'/api/reports/{report["id"]}/export.csv',headers=headers(signing)).text))
    assert len(reader.fieldnames)==20 and len(list(reader))==(1 if incomplete else 0)
