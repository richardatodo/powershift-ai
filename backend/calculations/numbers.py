"""Exact decimal-input arithmetic, independent of the ambient Decimal context."""

import math
import re
from decimal import Decimal, InvalidOperation
from fractions import Fraction

from .errors import out_of_range

# Resource limits, not electrical-domain defaults. Check before exponentiation.
MAX_DECIMAL_DIGITS = 4096
MAX_DECIMAL_EXPONENT = 4096
MAX_OUTPUT_DIGITS = 4096
_OUTPUT_LIMIT = 10 ** MAX_OUTPUT_DIGITS
_MAX_INT_BITS = (MAX_DECIMAL_DIGITS * 3322 // 1000) + 1
_TOKEN = re.compile(r"(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?\Z")


def decimal_token(token: str) -> Decimal:
    """Parse an already lexically valid JSON number without float conversion."""
    if len(token) > 2 * MAX_DECIMAL_DIGITS + 32:
        raise out_of_range()
    match = _TOKEN.fullmatch(token)
    if match is None:
        raise ValueError("Invalid JSON number.")
    _, whole, fraction, exponent_text = match.groups()
    fraction = fraction or ""
    if len(whole) + len(fraction) > MAX_DECIMAL_DIGITS:
        raise out_of_range()
    exponent_digits = (exponent_text or "0").lstrip("+-").lstrip("0") or "0"
    if len(exponent_digits) > 5:
        raise out_of_range()
    exponent_sign = -1 if exponent_text and exponent_text.startswith("-") else 1
    exponent = exponent_sign * int(exponent_digits) - len(fraction)
    if abs(exponent) > MAX_DECIMAL_EXPONENT:
        raise out_of_range()
    try:
        value = Decimal(token)
    except InvalidOperation:
        raise out_of_range() from None
    check_budget(value)
    return value


def check_budget(value: Decimal, path: str = "") -> None:
    parts = value.as_tuple()
    if len(parts.digits) > MAX_DECIMAL_DIGITS or abs(parts.exponent) > MAX_DECIMAL_EXPONENT:
        raise out_of_range(path)


def to_decimal(value: object, path: str = "") -> Decimal | None:
    """None denotes a nonnumeric/nonfinite value, not an assumed zero."""
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, int) and value.bit_length() > _MAX_INT_BITS:
        raise out_of_range(path)
    if isinstance(value, Decimal):
        result = value
    elif isinstance(value, int):
        result = Decimal(value)
    else:
        result = Decimal(str(value))
    if not result.is_finite():
        return None
    check_budget(result, path)
    return result


def exact(value: int | float | Decimal, path: str = "") -> Fraction:
    result = to_decimal(value, path)
    if result is None:
        raise ValueError("A validated finite numeric value is required.")
    return Fraction(result)


def fixed(value: Fraction, places: int) -> tuple[str, bool]:
    """Format a nonnegative exact rational, using integer ROUND_HALF_UP."""
    scaled, remainder = divmod(value.numerator * (10 ** places), value.denominator)
    if remainder * 2 >= value.denominator:
        scaled += 1
    if scaled < 0 or scaled >= _OUTPUT_LIMIT:
        raise out_of_range()
    try:
        digits = str(scaled).zfill(places + 1)
    except ValueError:
        # Respect a host's stricter integer-string limit without changing it.
        raise out_of_range() from None
    return digits[:-places] + "." + digits[-places:], remainder != 0
