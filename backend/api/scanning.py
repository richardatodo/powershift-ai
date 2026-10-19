"""Provider-independent image and extraction boundaries; no network or persistence.

Operational limits must be supplied by the scan orchestrator. A valid extraction
is still an unconfirmed candidate, never an appliance or calculation input.
"""
import base64
import binascii
from dataclasses import dataclass
from io import BytesIO
import re
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

from backend.calculations import CalculationError
from .errors import APIError
from .validation import parse_json, validate


@dataclass(frozen=True)
class ImageLimits:
    max_bytes: int
    max_pixels: int
    max_side: int

    def __post_init__(self):
        if any(type(value) is not int or value <= 0 for value in
               (self.max_bytes, self.max_pixels, self.max_side)):
            raise ValueError("Positive integer image limits are required.")


def image_error(code="INVALID_IMAGE"):
    return APIError(400, code, "Choose a valid JPEG, PNG or WebP image within the upload limits.")


def validated_image(value, limits: ImageLimits) -> str:
    """Fully decode one still image and strip metadata before external transfer.

    The returned PNG is re-encoded from pixels, not forwarded upload bytes.
    Both the input and the sanitized output must fit the configured byte limit.
    No filenames, EXIF, comments or other metadata are retained.
    """
    if not isinstance(value, str):
        raise image_error()
    header, separator, encoded = value.partition(",")
    formats = {"data:image/jpeg;base64": "JPEG", "data:image/png;base64": "PNG",
               "data:image/webp;base64": "WEBP"}
    if not separator or header not in formats or not encoded:
        raise image_error()
    if len(encoded) > 4 * ((limits.max_bytes + 2) // 3):
        raise image_error("IMAGE_TOO_LARGE")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise image_error() from None
    if len(raw) > limits.max_bytes:
        raise image_error("IMAGE_TOO_LARGE")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(raw), formats=[formats[header]]) as source:
                if source.width * source.height > limits.max_pixels or max(source.size) > limits.max_side:
                    raise image_error("IMAGE_TOO_LARGE")
                if getattr(source, "n_frames", 1) != 1:
                    raise image_error()
                source.verify()
            with Image.open(BytesIO(raw), formats=[formats[header]]) as source:
                source.load()
                # Copy pixels into a new image to avoid carrying any source info.
                pixels = ImageOps.exif_transpose(source).convert("RGB")
                clean = Image.new("RGB", pixels.size)
                clean.paste(pixels)
                output = BytesIO()
                clean.save(output, format="PNG")
                sanitized = output.getvalue()
    except (Image.DecompressionBombWarning, Image.DecompressionBombError):
        raise image_error("IMAGE_TOO_LARGE") from None
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError):
        raise image_error() from None
    if len(sanitized) > limits.max_bytes:
        raise image_error("IMAGE_TOO_LARGE")
    return "data:image/png;base64," + base64.b64encode(sanitized).decode("ascii")


POWER_STATUSES = {"clear_watts", "blurry", "missing_label", "va_only", "ambiguous", "missing_watts"}


def extraction_result(raw: bytes) -> dict:
    """Validate a bounded adapter result and enforce explicit power ambiguity.

    The adapter must return {power_status, candidate}. Only clear_watts allows
    watts to survive. The model must quote a literal W rating in evidence;
    no conversion of VA, kW, voltage/current or label energy is authorized.
    """
    try:
        if not isinstance(raw, bytes) or len(raw) > 16384:
            raise ValueError()
        envelope = parse_json(raw)
        if not isinstance(envelope, dict) or set(envelope) != {"power_status", "candidate"}:
            raise ValueError()
        status, candidate = envelope["power_status"], envelope["candidate"]
        if not isinstance(status, str) or status not in POWER_STATUSES:
            raise ValueError()
        validate("ScanCandidate", candidate)
        for field in ("name", "brand", "model", "voltage", "current", "notes", "visible_evidence"):
            value = candidate[field]
            if value is not None and len(value) > (2000 if field in ("notes", "visible_evidence") else 200):
                raise ValueError()
        if status != "clear_watts":
            candidate["watts"] = None
            candidate["notes"] = ("No reliable watt rating (" + status.replace("_", " ") + "). "
                                  + candidate["notes"])[:2000]
            if status == "missing_label":
                for field in ("name", "brand", "model", "voltage", "current", "kwh_per_day"):
                    candidate[field] = None
        elif candidate["watts"] is None or not candidate["visible_evidence"].strip():
            raise ValueError()
        # Evidence is necessary, but not proof the model read the image correctly.
        # Compare the explicit W number without performing any unit conversion.
        if candidate["watts"] is not None:
            from decimal import Decimal
            ratings = re.findall(r"(?<![\w.])([0-9]+(?:\.[0-9]+)?)\s*[Ww](?!\w)", candidate["visible_evidence"])
            if not ratings or {Decimal(value) for value in ratings} != {candidate["watts"]}:
                raise ValueError()
        return candidate
    except (APIError, CalculationError, ValueError, TypeError, KeyError):
        raise APIError(502, "INVALID_SCAN_RESULT", "The label could not be read safely. Try another photo or enter values manually.") from None
