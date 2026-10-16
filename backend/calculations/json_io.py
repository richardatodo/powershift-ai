"""Strict JSON boundary and exact numeric metadata serialization."""

import json
from decimal import Decimal

from .engine import calculate_request
from .errors import CalculationError
from .numbers import check_budget, decimal_token


class _InvalidJSON(ValueError):
    pass


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise _InvalidJSON("Duplicate object property.")
        result[key] = value
    return result


def _reject_constant(_: str) -> None:
    raise _InvalidJSON("Nonstandard JSON numeric constant.")


def parse_calculation_request(document: str) -> dict:
    """Parse a strict JSON request and return its calculated assessment.

    Numeric lexemes are preserved as Decimal values, including tariff metadata.
    This is a JSON-to-assessment adapter, not an HTTP handler.
    """
    if not isinstance(document, str):
        raise CalculationError("MALFORMED_JSON", "A valid JSON document is required.")
    try:
        payload = json.loads(document, parse_float=decimal_token, parse_int=decimal_token,
                             parse_constant=_reject_constant, object_pairs_hook=_unique_object)
    except CalculationError:
        raise
    except (ValueError, RecursionError):
        raise CalculationError("MALFORMED_JSON", "A valid JSON document is required.") from None
    return calculate_request(payload)


def dumps_assessment(result: dict) -> str:
    """Serialize without converting exact Decimal tariff metadata to float."""
    def encode(value: object) -> str:
        if isinstance(value, Decimal):
            if not value.is_finite():
                raise ValueError("Nonfinite JSON numbers are not permitted.")
            check_budget(value)
            return str(value)
        if isinstance(value, dict):
            if any(not isinstance(key, str) for key in value):
                raise TypeError("JSON object names must be strings.")
            return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + encode(item)
                                   for key, item in value.items()) + "}"
        if isinstance(value, (list, tuple)):
            return "[" + ",".join(encode(item) for item in value) + "]"
        return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    return encode(result)
