"""Mocked Ollama wire tests: these do not measure real-model accuracy."""
from dataclasses import replace
import json

import httpx
import pytest

from backend.api.config import ScanSettings
from backend.api.errors import APIError
from backend.api.vision import OllamaAdapter


def candidate(status="clear_watts"):
    return {"power_status": status, "candidate": {"name": "Fan", "brand": None,
        "model": None, "watts": 60, "voltage": "230 V", "current": None,
        "kwh_per_day": None, "notes": "Read and confirm.", "visible_evidence": "Input 60 W"}}


def adapter(handler):
    return OllamaAdapter(ScanSettings(provider="ollama"), httpx.Client(
        base_url="http://127.0.0.1:11434", transport=httpx.MockTransport(handler)))


def test_local_structured_request_and_validated_response():
    calls = []
    def handle(request):
        calls.append(request)
        data = json.loads(request.content)
        if request.url.path == "/api/show":
            return httpx.Response(200, json={"capabilities": ["completion", "vision"]})
        assert data["model"] == "gemma4:e2b-it-qat"
        assert data["stream"] is False and data["think"] is False
        assert data["messages"][0]["images"] == ["YWJj"]
        assert data["format"]["properties"]["candidate"]["type"] == "object"
        return httpx.Response(200, json={"done": True, "done_reason": "stop",
            "message": {"content": json.dumps(candidate())}})
    provider = adapter(handle)
    try:
        assert provider.extract("data:image/png;base64,YWJj")["watts"] == 60
        assert [r.url.path for r in calls] == ["/api/show", "/api/chat"]
    finally: provider.close()


@pytest.mark.parametrize("info", [{"capabilities": ["completion"]}, {"capabilities": "vision"},
    {"capabilities": ["vision"], "remote_model": "cloud-model"},
    {"capabilities": ["vision"], "remote_host": "https://ollama.com"}])
def test_remote_or_nonvision_model_never_receives_image(info):
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(200, json=info)
    provider = adapter(handle)
    with pytest.raises(APIError) as error:
        provider.extract("data:image/png;base64,YWJj")
    assert error.value.code == "SCANNER_UNAVAILABLE" and len(calls) == 1
    provider.close()


@pytest.mark.parametrize("kind,status,code", [("connect",503,"SCANNER_UNAVAILABLE"),
    ("timeout",504,"SCAN_TIMEOUT"), ("bad_json",502,"INVALID_SCAN_RESULT"),
    ("refusal",502,"INVALID_SCAN_RESULT"), ("truncated",502,"INVALID_SCAN_RESULT"),
    ("huge",502,"INVALID_SCAN_RESULT"), ("provider_error",502,"SCAN_PROVIDER_ERROR"),
    ("missing_model",503,"SCANNER_UNAVAILABLE")])
def test_safe_provider_failures(kind, status, code):
    def handle(request):
        if kind == "connect": raise httpx.ConnectError("SENSITIVE")
        if kind == "timeout": raise httpx.ReadTimeout("SENSITIVE")
        if kind == "missing_model": return httpx.Response(404, text="SENSITIVE")
        if request.url.path == "/api/show": return httpx.Response(200, json={"capabilities": ["vision"]})
        if kind == "bad_json": return httpx.Response(200, text="SENSITIVE")
        if kind == "huge": return httpx.Response(200, content=b"SENSITIVE" * 10000)
        if kind == "provider_error": return httpx.Response(500, text="SENSITIVE")
        return httpx.Response(200, json={"done": True, "done_reason": "length" if kind == "truncated" else "stop",
            "message": {"content": "SENSITIVE"}})
    provider = adapter(handle)
    with pytest.raises(APIError) as error:
        provider.extract("data:image/png;base64,YWJj")
    assert (error.value.status, error.value.code) == (status, code)
    assert "SENSITIVE" not in str(error.value.body("request"))
    provider.close()


def test_scanner_concurrency_is_bounded():
    provider = adapter(lambda _: httpx.Response(500))
    provider.slot.acquire()
    with pytest.raises(APIError) as error: provider.extract("data:image/png;base64,YWJj")
    assert error.value.status == 429
    provider.slot.release(); provider.close()


@pytest.mark.parametrize("changes", [{"provider": "openai"}, {"provider": "hosted"},
    {"base_url": "http://example.com"}, {"base_url": "http://localhost:11434"},
    {"base_url": "http://127.0.0.1:11434/redirect"}, {"model": "gemma4:cloud"},
    {"model": "someone/gemma4:e2b"}, {"model": "gemma4"}, {"timeout_seconds": 0},
    {"daily_limit": 10000}])
def test_configuration_fails_closed(changes):
    with pytest.raises(ValueError): replace(ScanSettings(), **changes)
