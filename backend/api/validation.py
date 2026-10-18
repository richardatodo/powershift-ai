"""Strict reviewed JSON schemas and lossless, bounded JSON/fingerprint handling."""
from decimal import Decimal
from hashlib import sha256
import json
from pathlib import Path
from uuid import UUID

from jsonschema import Draft202012Validator, FormatChecker, validators

from backend.calculations import CalculationError
from backend.calculations.numbers import decimal_token
from .errors import APIError, invalid

CONTRACT = json.loads(Path(__file__).with_name("openapi.json").read_text(encoding="utf8"))
_types = Draft202012Validator.TYPE_CHECKER.redefine(
    "integer", lambda _, value: not isinstance(value, bool) and
    (isinstance(value, int) or isinstance(value, Decimal) and value == value.to_integral_value()))
StrictValidator = validators.extend(Draft202012Validator, type_checker=_types)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate property")
        result[key] = value
    return result


def parse_json(raw: bytes):
    try:
        value = json.loads(raw.decode("utf8"), parse_float=decimal_token, parse_int=decimal_token,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
                           object_pairs_hook=unique_object)
        pending = [(value, 0)]
        while pending:
            item, depth = pending.pop()
            if depth > 64:
                raise ValueError("JSON nesting budget exceeded")
            if isinstance(item, str):
                if "\x00" in item:
                    raise invalid("", "INVALID_FORMAT")
                try:
                    item.encode("utf8", errors="strict")
                except UnicodeError:
                    raise invalid("", "INVALID_FORMAT") from None
            elif isinstance(item, dict):
                pending.extend((v, depth + 1) for pair in item.items() for v in pair)
            elif isinstance(item, list):
                pending.extend((v, depth + 1) for v in item)
        return value
    except CalculationError:
        raise
    except (UnicodeError, ValueError, RecursionError):
        raise APIError(400, "MALFORMED_JSON", "A valid JSON document is required.") from None


def validate(name, value):
    schema = {"$ref": "#/components/schemas/" + name, "components": CONTRACT["components"]}
    error = next(StrictValidator(schema, format_checker=FormatChecker()).iter_errors(value), None)
    if error:
        path = "".join("/" + str(p).replace("~", "~0").replace("/", "~1") for p in error.absolute_path)
        code = {"required": "REQUIRED", "additionalProperties": "UNKNOWN_FIELD",
                "type": "INVALID_TYPE", "minimum": "OUT_OF_RANGE", "maximum": "OUT_OF_RANGE",
                "exclusiveMinimum": "OUT_OF_RANGE", "const": "CONFIRMATION_REQUIRED"}.get(error.validator, "INVALID_FORMAT")
        raise invalid(path[:256], code)
    return value


def uuid_text(value: str) -> str:
    try:
        parsed = str(UUID(value))
        if len(value) != 36:
            raise ValueError()
        return parsed
    except (ValueError, TypeError, AttributeError):
        raise invalid("", "INVALID_FORMAT") from None


def canonical(value):
    """Typed canonical tree: exact equivalent numbers share a fingerprint.

    Decimal.normalize() is intentionally avoided: it uses ambient precision.
    JSON strings cannot collide with numeric tags because every node is typed.
    """
    if isinstance(value, dict):
        return ["object", [[k, canonical(value[k])] for k in sorted(value)]]
    if isinstance(value, list):
        return ["array", [canonical(v) for v in value]]
    if value is None or isinstance(value, (bool, str)):
        return [type(value).__name__, value]
    if isinstance(value, (int, Decimal)) and not isinstance(value, bool):
        number = Decimal(value)
        if not number:
            return ["number", 0, "0", 0]
        sign, digits, exponent = number.as_tuple()
        digits = list(digits)
        while digits[-1] == 0:
            digits.pop()
            exponent += 1
        return ["number", sign, "".join(map(str, digits)), exponent]
    raise TypeError("Unsupported canonical input")


def fingerprint(value):
    value = {key: item for key, item in value.items() if key != "client_request_id"}
    return sha256(json.dumps(canonical(value), ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
