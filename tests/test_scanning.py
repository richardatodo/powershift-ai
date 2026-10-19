"""Synthetic upload and untrusted extraction cases; no hosted provider calls."""
import base64
from io import BytesIO
import json

from PIL import Image, PngImagePlugin
import pytest

from backend.api.errors import APIError
from backend.api.scanning import ImageLimits, extraction_result, validated_image


LIMITS = ImageLimits(max_bytes=10000, max_pixels=1024, max_side=64)


def image_url(fmt="PNG", size=(16, 16), **save):
    output = BytesIO()
    Image.new("RGB", size, "white").save(output, format=fmt, **save)
    mime = {"PNG": "png", "JPEG": "jpeg", "WEBP": "webp"}[fmt]
    return f"data:image/{mime};base64," + base64.b64encode(output.getvalue()).decode()


def extract(status="clear_watts", **values):
    candidate = {"name": "Fan", "brand": None, "model": None, "watts": 60,
                 "voltage": "230 V", "current": None, "kwh_per_day": None,
                 "notes": "Visible rating", "visible_evidence": "Rated power 60 W"}
    candidate.update(values)
    return json.dumps({"power_status": status, "candidate": candidate}).encode()


def assert_failure(operation, code):
    with pytest.raises(APIError) as error:
        operation()
    assert error.value.code == code
    assert "SENSITIVE" not in str(error.value.body("test"))


@pytest.mark.parametrize("fmt", ["PNG", "JPEG", "WEBP"])
def test_accept_and_reencode_allowed_images(fmt):
    result = validated_image(image_url(fmt), LIMITS)
    assert result.startswith("data:image/png;base64,")
    with Image.open(BytesIO(base64.b64decode(result.split(",")[1]))) as image:
        assert image.size == (16, 16)
        assert image.format == "PNG"


def test_metadata_is_removed():
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("private", "SENSITIVE_LOCATION")
    result = validated_image(image_url(pnginfo=metadata), LIMITS)
    raw = base64.b64decode(result.split(",")[1])
    assert b"SENSITIVE" not in raw
    with Image.open(BytesIO(raw)) as image:
        assert not image.info


@pytest.mark.parametrize("value", [None, 123, "", "https://example.test/a.png",
    "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,!",
    "data:image/png;base64,UEFTU1dPUkRfU0VOU0lUSVZF", "data:image/png;base64,AAAA\n"])
def test_invalid_images(value):
    assert_failure(lambda: validated_image(value, LIMITS), "INVALID_IMAGE")


def test_declared_mime_must_match_bytes():
    value = image_url().replace("image/png", "image/jpeg")
    assert_failure(lambda: validated_image(value, LIMITS), "INVALID_IMAGE")


@pytest.mark.parametrize("size", [(33, 33), (65, 1)])
def test_image_dimension_limits_before_decode(size):
    assert_failure(lambda: validated_image(image_url(size=size), LIMITS), "IMAGE_TOO_LARGE")


def test_byte_limit():
    assert_failure(lambda: validated_image(image_url(), ImageLimits(10, 1024, 64)), "IMAGE_TOO_LARGE")


def test_reject_animation():
    output = BytesIO()
    Image.new("RGB", (2, 2), "white").save(output, format="PNG", save_all=True,
        append_images=[Image.new("RGB", (2, 2), "black")], duration=100, loop=0)
    value = "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()
    assert_failure(lambda: validated_image(value, LIMITS), "INVALID_IMAGE")


def test_clear_label_keeps_explicit_rating():
    candidate = extraction_result(extract())
    assert candidate["watts"] == 60
    assert set(candidate) == {"name", "brand", "model", "watts", "voltage", "current",
                              "kwh_per_day", "notes", "visible_evidence"}


@pytest.mark.parametrize("status", ["blurry", "missing_label", "va_only", "ambiguous", "missing_watts"])
def test_uncertainty_never_becomes_watts(status):
    result = extraction_result(extract(status, visible_evidence="60 VA, 230 V, 0.3 A"))
    assert result["watts"] is None
    assert 'No reliable watt rating' in result['notes']


def test_no_label_does_not_infer_facts_from_appearance():
    result = extraction_result(extract('missing_label', name='Guessed fan', brand='Guessed brand', kwh_per_day=1.5))
    assert all(result[field] is None for field in ('name', 'brand', 'model', 'watts', 'voltage', 'current', 'kwh_per_day'))


@pytest.mark.parametrize("raw", [b"not JSON SENSITIVE", b'{"candidate":{}}',
    b'{"power_status":"clear_watts","power_status":"va_only","candidate":{}}',
    b"x" * 16385, b"null", b"[]"])
def test_malformed_provider_output(raw):
    assert_failure(lambda: extraction_result(raw), "INVALID_SCAN_RESULT")


@pytest.mark.parametrize("changes", [{"watts": True}, {"watts": -1}, {"watts": "60"},
    {"brand": "x" * 201}, {"notes": "x" * 2001}, {"visible_evidence": "60 VA"},
    {"visible_evidence": "60 W / 100 W"}, {"visible_evidence": "0.06 kW"},
    {"hours_per_day": 8}, {"watts": None}, {"name": ""}, {"voltage": "SENSITIVE\u0000"}])
def test_invalid_or_unsubstantiated_candidates(changes):
    assert_failure(lambda: extraction_result(extract(**changes)), "INVALID_SCAN_RESULT")


def test_label_energy_is_preserved_separately():
    result = extraction_result(extract(kwh_per_day=1.2))
    assert str(result["kwh_per_day"]) == "1.2"
    assert "calculated_daily_kwh" not in result
    assert "effective_load_percent" not in result
