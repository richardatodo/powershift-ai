"""Validation for the M2 calculation-input projection, not appliance CRUD."""

import re
from decimal import Decimal
from fractions import Fraction

from .errors import Issue, invalid_request
from .numbers import to_decimal

MAX_QUANTITY = 9_007_199_254_740_991
ROW_FIELDS = ("id", "name", "quantity", "rated_watts", "hours_per_day",
              "effective_load_percent", "source_status")
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z")
_READ_ONLY = {"owner_id", "calculated_daily_kwh", "daily_kwh", "period_kwh",
              "field_provenance", "confirmed_at", "created_at", "updated_at"}


def valid_id(value: object) -> bool:
    return isinstance(value, str) and _UUID.fullmatch(value) is not None


def pointer(key: str) -> str:
    return "/" + key.replace("~", "~0").replace("/", "~1")


def object_issues(candidate: dict, fields: tuple[str, ...]) -> list[Issue]:
    issues = [Issue(pointer(key), "REQUIRED", "This field is required.")
              for key in fields if key not in candidate]
    for key in sorted(key for key in candidate if isinstance(key, str) and key not in fields):
        code = "READ_ONLY_FIELD" if key in _READ_ONLY else "UNKNOWN_FIELD"
        issues.append(Issue(pointer(key), code, "This field is not accepted."))
    if any(not isinstance(key, str) for key in candidate):
        issues.append(Issue("", "UNKNOWN_FIELD", "Object field names must be strings."))
    return issues


def integer_value(value: object, minimum: int, maximum: int | None,
                  path: str) -> tuple[int | None, Issue | None]:
    number = to_decimal(value, path)
    if number is None:
        return None, Issue(path, "INVALID_TYPE", "A finite integer is required.")
    ratio = Fraction(number)
    if ratio.denominator != 1:
        return None, Issue(path, "INVALID_TYPE", "An integer is required.")
    result = ratio.numerator
    if result < minimum or (maximum is not None and result > maximum):
        return None, Issue(path, "OUT_OF_RANGE", "The integer is outside the allowed range.")
    return result, None


def numeric_issue(value: object, path: str, minimum: int,
                  maximum: int | None = None, exclusive: bool = False) -> Issue | None:
    number = to_decimal(value, path)
    if number is None:
        return Issue(path, "INVALID_TYPE", "A finite JSON number is required.")
    if number < minimum or (exclusive and number == minimum) or (maximum is not None and number > maximum):
        return Issue(path, "OUT_OF_RANGE", "The number is outside the allowed range.")
    return None


def validate_appliance(candidate: object) -> tuple[Issue, ...]:
    """Validate a CalculationInputRow. Explicit nullable unknowns are valid."""
    if not isinstance(candidate, dict):
        return (Issue("", "INVALID_TYPE", "An appliance calculation object is required."),)
    issues = object_issues(candidate, ROW_FIELDS)
    if "id" in candidate and not valid_id(candidate["id"]):
        issues.append(Issue("/id", "INVALID_FORMAT", "A UUID identifier is required."))
    if "name" in candidate:
        name = candidate["name"]
        if not isinstance(name, str):
            issues.append(Issue("/name", "INVALID_TYPE", "A name string is required."))
        elif not name.strip():
            issues.append(Issue("/name", "BLANK_VALUE", "A nonblank appliance name is required."))
        elif name != name.strip() or len(name) > 200:
            issues.append(Issue("/name", "INVALID_FORMAT", "Use trimmed text of at most 200 characters."))
    if "quantity" in candidate:
        _, issue = integer_value(candidate["quantity"], 1, MAX_QUANTITY, "/quantity")
        if issue:
            issues.append(issue)
    for field, minimum, maximum, exclusive in (
        ("rated_watts", 0, None, True), ("hours_per_day", 0, 24, False),
        ("effective_load_percent", 0, 100, True),
    ):
        if field in candidate and candidate[field] is not None:
            issue = numeric_issue(candidate[field], pointer(field), minimum, maximum, exclusive)
            if issue:
                issues.append(issue)
    if "source_status" in candidate and candidate["source_status"] not in ("unconfirmed", "customer_confirmed"):
        issues.append(Issue("/source_status", "INVALID_PROVENANCE", "Use an unconfirmed or customer-confirmed estimate."))
    return tuple(issues)


def settings(period_days: object, rate: object) -> tuple[int, Decimal | None]:
    period, issue = integer_value(period_days, 1, 366, "/period_days")
    issues = [issue] if issue else []
    if rate is not None:
        rate_issue = numeric_issue(rate, "/rate_ngn_per_kwh", 0)
        if rate_issue:
            issues.append(rate_issue)
    if issues:
        raise invalid_request(issues)
    return period, None if rate is None else to_decimal(rate, "/rate_ngn_per_kwh")


def duplicate_issues(candidates: list | tuple) -> list[Issue]:
    seen = set()
    issues = []
    for index, candidate in enumerate(candidates):
        value = candidate.get("id") if isinstance(candidate, dict) else None
        if valid_id(value):
            canonical = value.lower()
            if canonical in seen:
                issues.append(Issue(f"/appliances/{index}/id", "DUPLICATE_ID", "Appliance identifiers must be unique."))
            seen.add(canonical)
    return issues
