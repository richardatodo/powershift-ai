"""Authoritative pure energy calculations; no AI, storage, clock, or network."""

from fractions import Fraction

from .errors import CalculationError, Issue, invalid_request
from .numbers import exact, fixed
from .validation import (duplicate_issues, integer_value, object_issues, settings,
                         valid_id, validate_appliance)

CONTRACT_VERSION = "0.1.0"


def _evaluate(candidate: object, input_index: int, period: int) -> tuple[dict, Fraction | None, bool]:
    issues = validate_appliance(candidate)
    row_id = candidate.get("id") if isinstance(candidate, dict) else None
    row = {"input_index": input_index, "id": row_id if valid_id(row_id) else None,
           "status": "invalid", "daily_kwh": None, "period_kwh": None, "issues": []}
    if issues:
        row["issues"] = [issue.as_dict() for issue in issues]
        return row, None, False

    missing = [Issue("/" + field, "MISSING_VALUE", "This estimate input is unknown.")
               for field in ("rated_watts", "hours_per_day", "effective_load_percent")
               if candidate[field] is None]
    if candidate["source_status"] == "unconfirmed":
        row["status"] = "unconfirmed"
        row["issues"] = [Issue("/source_status", "UNCONFIRMED_VALUE", "Customer review is required.").as_dict()]
        row["issues"].extend(issue.as_dict() for issue in missing)
        return row, None, False
    if missing:
        row["status"] = "incomplete"
        row["issues"] = [issue.as_dict() for issue in missing]
        return row, None, False

    daily = (exact(candidate["quantity"]) * exact(candidate["rated_watts"])
             * exact(candidate["hours_per_day"]) * exact(candidate["effective_load_percent"]) / 100_000)
    row["status"] = "eligible"
    row["daily_kwh"], rounded_daily = fixed(daily, 6)
    row["period_kwh"], rounded_period = fixed(daily * period, 6)
    return row, daily, rounded_daily or rounded_period


def evaluate_appliance(candidate: object, input_index: int, period_days: int) -> dict:
    """Defensively classify one row, including malformed imported data."""
    index, issue = integer_value(input_index, 0, None, "/input_index")
    if issue:
        raise invalid_request([issue])
    period, _ = settings(period_days, None)
    return _evaluate(candidate, index, period)[0]


def calculate_assessment(candidates: list | tuple, period_days: int,
                         rate_ngn_per_kwh: object) -> dict:
    """Evaluate rows defensively; omit and count invalid/unconfirmed/unknowns.

    Use calculate_request for atomic validation at an HTTP/request boundary.
    Decimal tariff metadata is preserved; use dumps_assessment for exact JSON.
    """
    if not isinstance(candidates, (list, tuple)):
        raise invalid_request([Issue("/appliances", "INVALID_TYPE", "An appliance collection is required.")])
    period, tariff = settings(period_days, rate_ngn_per_kwh)
    duplicates = duplicate_issues(candidates)
    if duplicates:
        raise invalid_request(duplicates)

    rows = []
    counts = {"total": len(candidates), "eligible": 0, "incomplete": 0, "invalid": 0, "unconfirmed": 0}
    daily_total = Fraction(0)
    rounded = False
    for index, candidate in enumerate(candidates):
        row, daily, row_rounded = _evaluate(candidate, index, period)
        rows.append(row)
        counts[row["status"]] += 1
        if daily is not None:
            daily_total += daily
        rounded = rounded or row_rounded

    totals = {"daily_kwh": None, "period_kwh": None, "grid_equivalent_cost_ngn": None}
    if counts["eligible"]:
        period_total = daily_total * period
        totals["daily_kwh"], daily_rounded = fixed(daily_total, 6)
        totals["period_kwh"], period_rounded = fixed(period_total, 6)
        rounded = rounded or daily_rounded or period_rounded
        if tariff is not None:
            totals["grid_equivalent_cost_ngn"], cost_rounded = fixed(period_total * exact(tariff), 2)
            rounded = rounded or cost_rounded

    warnings = []
    for status, code in (("incomplete", "INCOMPLETE_RECORDS"), ("invalid", "INVALID_RECORDS"),
                         ("unconfirmed", "UNCONFIRMED_RECORDS")):
        if counts[status]:
            warnings.append({"code": code, "message": f"{counts[status]} {status} record(s) were excluded from totals."})
    if not counts["eligible"]:
        warnings.append({"code": "NO_ELIGIBLE_RECORDS", "message": "No complete confirmed records are available for an estimate."})
    warnings.append({"code": "RATED_POWER_ESTIMATE", "message": "Rated power can differ from average operating draw."})
    if rounded:
        warnings.append({"code": "ROUNDING_APPLIED", "message": "Results are rounded after exact calculations; displayed row sums may differ from totals."})

    assumptions = [
        "Energy is estimated from customer-provided ratings and usage, not measured by a meter.",
        "Rated watts may differ from average operating draw.",
        "Each eligible row uses the explicitly supplied effective-load percentage; unknown values are never defaulted.",
        f"{counts['eligible']} eligible record(s) contribute; {counts['total'] - counts['eligible']} record(s) are excluded.",
        "Exact decimal-input arithmetic precedes round-half-up presentation: energy has six decimal places and NGN has two.",
    ]
    if tariff is not None:
        assumptions.append("Cost is a hypothetical all-grid estimate using a customer-entered tariff, not an actual mixed-source bill or savings claim.")
    else:
        assumptions.append("No tariff was supplied, so no cost estimate is shown.")

    return {"contract_version": CONTRACT_VERSION, "estimate": True,
            "period_days": period, "rate_ngn_per_kwh": tariff,
            "tariff_provenance": None if tariff is None else "user_input",
            "rows": rows, "counts": counts, "totals": totals,
            "warnings": warnings, "assumptions": assumptions}


def calculate_request(payload: object) -> dict:
    """Validate the entire M2 CalculationRequest before any successful result."""
    if not isinstance(payload, dict):
        raise invalid_request([Issue("", "INVALID_TYPE", "A calculation request object is required.")])
    issues = object_issues(payload, ("appliances", "period_days", "rate_ngn_per_kwh"))
    candidates = payload.get("appliances")
    if "appliances" in payload:
        if not isinstance(candidates, list):
            issues.append(Issue("/appliances", "INVALID_TYPE", "An appliance array is required."))
        else:
            for index, candidate in enumerate(candidates):
                issues.extend(Issue(f"/appliances/{index}" + issue.path, issue.code, issue.message)
                              for issue in validate_appliance(candidate))
            issues.extend(duplicate_issues(candidates))
    if "period_days" in payload and "rate_ngn_per_kwh" in payload:
        try:
            settings(payload["period_days"], payload["rate_ngn_per_kwh"])
        except CalculationError as error:
            if error.code != "VALIDATION_ERROR":
                raise
            issues.extend(error.details)
    if issues:
        raise invalid_request(issues)
    return calculate_assessment(candidates, payload["period_days"], payload["rate_ngn_per_kwh"])
