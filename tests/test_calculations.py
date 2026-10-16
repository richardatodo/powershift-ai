"""Contract-driven M3 tests, using hand-calculated expectations and stdlib only.

Run from the repository root: python -m unittest discover -s tests -v
"""

from copy import deepcopy
from decimal import Decimal, Inexact, ROUND_DOWN, Rounded, localcontext
import json
import sys
import unittest

from backend.calculations import (
    CalculationError,
    calculate_assessment,
    calculate_request,
    dumps_assessment,
    evaluate_appliance,
    parse_calculation_request,
    validate_appliance,
)


ID_A = "11111111-1111-4111-8111-111111111111"
ID_B = "22222222-2222-4222-8222-222222222222"
ID_C = "33333333-3333-4333-8333-333333333333"
ID_D = "44444444-4444-4444-8444-444444444444"
NULL_TOTALS = {
    "daily_kwh": None,
    "period_kwh": None,
    "grid_equivalent_cost_ngn": None,
}
_DEFAULT_ROWS = object()


def appliance(**changes):
    row = {
        "id": ID_A,
        "name": "Synthetic fan",
        "quantity": 1,
        "rated_watts": 100,
        "hours_per_day": 5,
        "effective_load_percent": 100,
        "source_status": "customer_confirmed",
    }
    row.update(changes)
    return row


def request(rows=_DEFAULT_ROWS, **changes):
    body = {
        "appliances": [appliance()] if rows is _DEFAULT_ROWS else rows,
        "period_days": 30,
        "rate_ngn_per_kwh": None,
    }
    body.update(changes)
    return body


def warning_codes(result):
    return {warning["code"] for warning in result["warnings"]}


class CalculationTestCase(unittest.TestCase):
    def assert_issue(self, issues, path, code):
        observed = {(issue.path, issue.code) for issue in issues}
        self.assertIn((path, code), observed)

    def assert_row_issue(self, result, path, code):
        observed = {(issue["path"], issue["code"]) for issue in result["issues"]}
        self.assertIn((path, code), observed)

    def assert_validation_error(self, callback, path=None, code=None):
        with self.assertRaises(CalculationError) as caught:
            callback()
        error = caught.exception
        self.assertEqual("VALIDATION_ERROR", error.code)
        self.assertIsInstance(error.details, tuple)
        if path is not None:
            self.assert_issue(error.details, path, code)
        return error


class HandCheckedCalculationTests(CalculationTestCase):
    def test_blueprint_daily_energy_examples(self):
        cases = [
            ({}, "0.500000"),
            ({"quantity": 2}, "1.000000"),
            ({"rated_watts": 2000, "hours_per_day": 0.5}, "1.000000"),
            ({"effective_load_percent": 50}, "0.250000"),
            ({"hours_per_day": 0}, "0.000000"),
        ]
        for values, expected in cases:
            with self.subTest(values=values):
                result = evaluate_appliance(appliance(**values), 0, 30)
                self.assertEqual("eligible", result["status"])
                self.assertEqual(expected, result["daily_kwh"])
                self.assertEqual([], result["issues"])

    def test_blueprint_period_and_optional_tariff(self):
        result = calculate_assessment([appliance()], 30, 100)
        self.assertEqual(
            {"daily_kwh": "0.500000", "period_kwh": "15.000000",
             "grid_equivalent_cost_ngn": "1500.00"},
            result["totals"],
        )
        self.assertEqual("15.000000", result["rows"][0]["period_kwh"])
        self.assertEqual("user_input", result["tariff_provenance"])

    def test_fractional_factor_quantity_and_hours(self):
        # 3 * 80 * 1.25 * 12.5 / 100 / 1000 = 0.0375 kWh/day.
        result = calculate_assessment(
            [appliance(quantity=3, rated_watts=80, hours_per_day=Decimal("1.25"),
                       effective_load_percent=Decimal("12.5"))],
            7, Decimal("123.45"),
        )
        self.assertEqual("0.037500", result["totals"]["daily_kwh"])
        self.assertEqual("0.262500", result["totals"]["period_kwh"])
        self.assertEqual("32.41", result["totals"]["grid_equivalent_cost_ngn"])

    def test_multiple_eligible_rows_are_summed(self):
        result = calculate_assessment(
            [appliance(), appliance(id=ID_B, quantity=2),
             appliance(id=ID_C, rated_watts=2000, hours_per_day=0.5)],
            30, 100,
        )
        self.assertEqual("2.500000", result["totals"]["daily_kwh"])
        self.assertEqual("75.000000", result["totals"]["period_kwh"])
        self.assertEqual("7500.00", result["totals"]["grid_equivalent_cost_ngn"])

    def test_inclusive_period_bounds(self):
        for period, expected in [(1, "0.500000"), (366, "183.000000")]:
            with self.subTest(period=period):
                result = calculate_assessment([appliance()], period, None)
                self.assertEqual(expected, result["totals"]["period_kwh"])

    def test_quantity_at_javascript_exact_integer_limit(self):
        result = calculate_assessment(
            [appliance(quantity=9007199254740991, rated_watts=1000,
                       hours_per_day=1)], 1, None,
        )
        self.assertEqual("9007199254740991.000000", result["totals"]["daily_kwh"])

    def test_hours_and_load_inclusive_upper_bounds(self):
        result = calculate_assessment(
            [appliance(rated_watts=1000, hours_per_day=24,
                       effective_load_percent=100)], 366, None,
        )
        self.assertEqual("24.000000", result["totals"]["daily_kwh"])
        self.assertEqual("8784.000000", result["totals"]["period_kwh"])

    def test_null_tariff_always_has_null_cost(self):
        for hours in [0, 5]:
            with self.subTest(hours=hours):
                result = calculate_assessment([appliance(hours_per_day=hours)], 30, None)
                self.assertIsNone(result["totals"]["grid_equivalent_cost_ngn"])
                self.assertIsNone(result["tariff_provenance"])

    def test_zero_tariff_is_explicit_user_input(self):
        result = calculate_assessment([appliance()], 30, 0)
        self.assertEqual("0.00", result["totals"]["grid_equivalent_cost_ngn"])
        self.assertEqual("user_input", result["tariff_provenance"])
        self.assertEqual(0, result["rate_ngn_per_kwh"])

    def test_eligible_zero_energy_with_tariff_is_zero_cost(self):
        result = calculate_assessment([appliance(hours_per_day=0)], 30, 100)
        self.assertEqual("0.000000", result["totals"]["daily_kwh"])
        self.assertEqual("0.000000", result["totals"]["period_kwh"])
        self.assertEqual("0.00", result["totals"]["grid_equivalent_cost_ngn"])
        self.assertNotIn("NO_ELIGIBLE_RECORDS", warning_codes(result))


class MissingDataAndStatusTests(CalculationTestCase):
    def test_explicit_unknown_calculation_inputs_are_valid_but_incomplete(self):
        for field in ["rated_watts", "hours_per_day", "effective_load_percent"]:
            with self.subTest(field=field):
                row = appliance(**{field: None})
                self.assertEqual((), validate_appliance(row))
                result = evaluate_appliance(row, 0, 30)
                self.assertEqual("incomplete", result["status"])
                self.assertIsNone(result["daily_kwh"])
                self.assertIsNone(result["period_kwh"])
                self.assert_row_issue(result, "/" + field, "MISSING_VALUE")

    def test_zero_hours_does_not_fill_unknown_rating_or_factor(self):
        for field in ["rated_watts", "effective_load_percent"]:
            with self.subTest(field=field):
                result = evaluate_appliance(
                    appliance(hours_per_day=0, **{field: None}), 0, 30,
                )
                self.assertEqual("incomplete", result["status"])
                self.assertIsNone(result["daily_kwh"])
                self.assert_row_issue(result, "/" + field, "MISSING_VALUE")

    def test_all_unknown_fields_are_explained(self):
        result = evaluate_appliance(
            appliance(rated_watts=None, hours_per_day=None, effective_load_percent=None),
            0, 30,
        )
        for field in ["rated_watts", "hours_per_day", "effective_load_percent"]:
            self.assert_row_issue(result, "/" + field, "MISSING_VALUE")

    def test_unconfirmed_is_excluded_even_when_complete(self):
        result = evaluate_appliance(appliance(source_status="unconfirmed"), 0, 30)
        self.assertEqual("unconfirmed", result["status"])
        self.assertIsNone(result["daily_kwh"])
        self.assertIsNone(result["period_kwh"])
        self.assert_row_issue(result, "/source_status", "UNCONFIRMED_VALUE")

    def test_unconfirmed_precedes_incomplete(self):
        result = evaluate_appliance(
            appliance(source_status="unconfirmed", effective_load_percent=None), 0, 30,
        )
        self.assertEqual("unconfirmed", result["status"])

    def test_invalid_precedes_unconfirmed_and_incomplete(self):
        result = evaluate_appliance(
            appliance(quantity=0, source_status="unconfirmed",
                      effective_load_percent=None), 0, 30,
        )
        self.assertEqual("invalid", result["status"])
        self.assert_row_issue(result, "/quantity", "OUT_OF_RANGE")

    def test_mix_of_statuses_counts_and_totals(self):
        result = calculate_assessment(
            [appliance(), appliance(id=ID_B, effective_load_percent=None),
             appliance(id=ID_C, quantity=0),
             appliance(id=ID_D, source_status="unconfirmed")],
            30, 100,
        )
        self.assertEqual(
            {"total": 4, "eligible": 1, "incomplete": 1,
             "invalid": 1, "unconfirmed": 1}, result["counts"],
        )
        self.assertEqual(["eligible", "incomplete", "invalid", "unconfirmed"],
                         [row["status"] for row in result["rows"]])
        self.assertEqual("0.500000", result["totals"]["daily_kwh"])
        self.assertEqual("1500.00", result["totals"]["grid_equivalent_cost_ngn"])
        self.assertTrue({"INCOMPLETE_RECORDS", "INVALID_RECORDS", "UNCONFIRMED_RECORDS"}
                        <= warning_codes(result))
        self.assertNotIn("NO_ELIGIBLE_RECORDS", warning_codes(result))

    def test_empty_assessment_has_null_totals_even_with_zero_tariff(self):
        for tariff in [None, 0, 100]:
            with self.subTest(tariff=tariff):
                result = calculate_assessment([], 30, tariff)
                self.assertEqual(NULL_TOTALS, result["totals"])
                self.assertEqual([], result["rows"])
                self.assertEqual(0, result["counts"]["total"])
                self.assertIn("NO_ELIGIBLE_RECORDS", warning_codes(result))

    def test_wholly_excluded_assessment_has_null_totals(self):
        result = calculate_assessment(
            [appliance(effective_load_percent=None),
             appliance(id=ID_B, quantity=0),
             appliance(id=ID_C, source_status="unconfirmed")], 30, 0,
        )
        self.assertEqual(NULL_TOTALS, result["totals"])
        self.assertIn("NO_ELIGIBLE_RECORDS", warning_codes(result))
        self.assertEqual(0, result["counts"]["eligible"])

    def test_invalid_identity_preserves_index_without_inventing_id(self):
        cases = [None, 100, [], {}, appliance(id="broken"), appliance(id=None)]
        result = calculate_assessment(cases, 30, None)
        self.assertEqual(list(range(len(cases))),
                         [row["input_index"] for row in result["rows"]])
        for row in result["rows"]:
            self.assertEqual("invalid", row["status"])
            self.assertIsNone(row["id"])
            self.assertIsNone(row["daily_kwh"])

    def test_valid_original_uuid_retained_even_when_another_field_is_invalid(self):
        original = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"
        result = evaluate_appliance(appliance(id=original, quantity=0), 7, 30)
        self.assertEqual(original, result["id"])
        self.assertEqual(7, result["input_index"])
        self.assertEqual("invalid", result["status"])

    def test_missing_nullable_key_is_invalid_rather_than_unknown(self):
        for field in ["rated_watts", "hours_per_day", "effective_load_percent"]:
            with self.subTest(field=field):
                row = appliance()
                del row[field]
                self.assert_issue(validate_appliance(row), "/" + field, "REQUIRED")
                self.assertEqual("invalid", evaluate_appliance(row, 0, 30)["status"])


class ValidationBoundaryTests(CalculationTestCase):
    def test_all_required_row_keys_are_required(self):
        for field in appliance():
            with self.subTest(field=field):
                row = appliance()
                del row[field]
                self.assert_issue(validate_appliance(row), "/" + field, "REQUIRED")

    def test_boolean_string_and_nonfinite_decimal_inputs_are_rejected(self):
        invalid_values = [True, False, "100", "", float("nan"), float("inf"),
                          float("-inf"), Decimal("NaN"), Decimal("sNaN"),
                          Decimal("Infinity"), Decimal("-Infinity"), [], {}]
        for field in ["rated_watts", "hours_per_day", "effective_load_percent"]:
            for value in invalid_values:
                with self.subTest(field=field, value=repr(value)):
                    self.assertTrue(validate_appliance(appliance(**{field: value})))
                    self.assertEqual("invalid", evaluate_appliance(
                        appliance(**{field: value}), 0, 30)["status"])

    def test_quantity_is_strict_bounded_integer(self):
        values = [0, -1, 9007199254740992, 1.5, Decimal("1.1"),
                  True, False, "1", None]
        for value in values:
            with self.subTest(value=repr(value)):
                self.assertTrue(validate_appliance(appliance(quantity=value)))

    def test_mathematically_integral_numbers_are_valid_in_integer_fields(self):
        for value in [1, 1.0, Decimal("1"), Decimal("1.0"), Decimal("1e0")]:
            with self.subTest(value=repr(value)):
                self.assertEqual((), validate_appliance(appliance(quantity=value)))
                result = calculate_assessment([appliance(quantity=value)], value, None)
                self.assertEqual("0.500000", result["totals"]["daily_kwh"])
                self.assertIs(type(result["period_days"]), int)
                self.assertEqual(1, result["period_days"])

    def test_nonpositive_watts_are_rejected(self):
        for value in [0, -1, Decimal("-0.001")]:
            with self.subTest(value=value):
                self.assert_issue(validate_appliance(appliance(rated_watts=value)),
                                  "/rated_watts", "OUT_OF_RANGE")

    def test_hours_outside_closed_interval_are_rejected(self):
        for value in [-1, Decimal("-0.000001"), Decimal("24.000001"), 25]:
            with self.subTest(value=value):
                self.assert_issue(validate_appliance(appliance(hours_per_day=value)),
                                  "/hours_per_day", "OUT_OF_RANGE")

    def test_load_percentage_excludes_zero_and_values_above_one_hundred(self):
        for value in [0, -1, Decimal("100.000001"), 101]:
            with self.subTest(value=value):
                self.assert_issue(validate_appliance(appliance(effective_load_percent=value)),
                                  "/effective_load_percent", "OUT_OF_RANGE")

    def test_nonblank_trimmed_name_is_required(self):
        for value in ["", " ", "\t\n", " fan", "fan ", "fan\n", "x" * 201,
                      None, True, 123]:
            with self.subTest(value=repr(value)):
                self.assertTrue(validate_appliance(appliance(name=value)))
        self.assertEqual((), validate_appliance(appliance(name="x" * 200)))
        self.assertEqual((), validate_appliance(appliance(name="Synthetic\nfan")))

    def test_only_preview_confirmation_statuses_are_valid(self):
        for value in ["measured", "ai_confirmed", "confirmed", None, True, ""]:
            with self.subTest(value=value):
                self.assertTrue(validate_appliance(appliance(source_status=value)))

    def test_invalid_uuid_formats_are_rejected(self):
        for value in ["", "not-a-uuid", 123, None,
                      "11111111111141118111111111111111", "{" + ID_A + "}"]:
            with self.subTest(value=value):
                self.assertTrue(validate_appliance(appliance(id=value)))

    def test_unknown_and_authoritative_client_fields_are_rejected(self):
        for field in ["daily_kwh", "calculated_daily_kwh", "owner_id", "watts",
                      "kwh_per_day", "source_method", "field_provenance"]:
            with self.subTest(field=field):
                self.assertTrue(validate_appliance(appliance(**{field: "untrusted"})))

    def test_issue_paths_escape_json_pointer_characters(self):
        issues = validate_appliance(appliance(**{"extra/~field": 1}))
        self.assertIn("/extra~1~0field", {issue.path for issue in issues})

    def test_nonobject_candidates_receive_whole_input_issue(self):
        for value in [None, 0, "row", [], True]:
            with self.subTest(value=value):
                self.assert_issue(validate_appliance(value), "", "INVALID_TYPE")

    def test_assessment_period_rejects_noninteger_and_out_of_range(self):
        for value in [0, -1, 367, 30.1, Decimal("30.1"), True, "30", None]:
            with self.subTest(value=value):
                self.assert_validation_error(
                    lambda: calculate_assessment([appliance()], value, None))

    def test_assessment_tariff_rejects_invalid_values(self):
        for value in [-1, Decimal("-0.001"), True, False, "100", [], {},
                      float("nan"), float("inf"), Decimal("NaN"), Decimal("sNaN")]:
            with self.subTest(value=repr(value)):
                self.assert_validation_error(
                    lambda: calculate_assessment([appliance()], 30, value))

    def test_duplicate_valid_uuid_fails_entire_assessment(self):
        self.assert_validation_error(
            lambda: calculate_assessment([appliance(), appliance()], 30, None),
            "/appliances/1/id", "DUPLICATE_ID",
        )

    def test_duplicate_uuid_is_case_insensitive_even_for_excluded_rows(self):
        first = "abcdefab-cdef-4abc-8def-abcdefabcdef"
        rows = [appliance(id=first, rated_watts=None),
                appliance(id=first.upper(), quantity=0)]
        self.assert_validation_error(
            lambda: calculate_assessment(rows, 30, None),
            "/appliances/1/id", "DUPLICATE_ID",
        )

    def test_repeated_invalid_ids_do_not_become_duplicate_resource_ids(self):
        result = calculate_assessment([appliance(id="broken"), appliance(id="broken")],
                                      30, None)
        self.assertEqual(2, result["counts"]["invalid"])
        self.assertEqual([None, None], [row["id"] for row in result["rows"]])


class ExactArithmeticAndPresentationTests(CalculationTestCase):
    def test_energy_uses_half_up_at_six_places(self):
        cases = [(Decimal("0.0005"), "0.000001"),
                 (Decimal("0.0015"), "0.000002"),
                 (Decimal("0.0004999999"), "0.000000")]
        for watts, expected in cases:
            with self.subTest(watts=watts):
                result = evaluate_appliance(appliance(rated_watts=watts, hours_per_day=1),
                                            0, 1)
                self.assertEqual(expected, result["daily_kwh"])

    def test_money_uses_half_up_at_two_places(self):
        result = calculate_assessment(
            [appliance(rated_watts=1000, hours_per_day=1)], 1, Decimal("1.005"),
        )
        self.assertEqual("1.01", result["totals"]["grid_equivalent_cost_ngn"])

    def test_aggregate_is_not_sum_of_rounded_rows(self):
        # Each exact daily value is .0000004; their sum is .0000008.
        rows = [appliance(rated_watts=Decimal("0.0004"), hours_per_day=1),
                appliance(id=ID_B, rated_watts=Decimal("0.0004"), hours_per_day=1)]
        result = calculate_assessment(rows, 1, None)
        self.assertEqual(["0.000000", "0.000000"],
                         [row["daily_kwh"] for row in result["rows"]])
        self.assertEqual("0.000001", result["totals"]["daily_kwh"])
        self.assertIn("ROUNDING_APPLIED", warning_codes(result))

    def test_near_half_micro_kwh_rows_aggregate_before_rounding(self):
        rows = [appliance(rated_watts=Decimal("0.00049"), hours_per_day=1),
                appliance(id=ID_B, rated_watts=Decimal("0.00049"), hours_per_day=1)]
        result = calculate_assessment(rows, 1, None)
        self.assertEqual(["0.000000", "0.000000"],
                         [row["daily_kwh"] for row in result["rows"]])
        self.assertEqual("0.000001", result["totals"]["daily_kwh"])

    def test_period_is_not_rounded_daily_energy_times_days(self):
        result = calculate_assessment(
            [appliance(rated_watts=Decimal("0.0004"), hours_per_day=1)], 30, None,
        )
        self.assertEqual("0.000000", result["totals"]["daily_kwh"])
        self.assertEqual("0.000012", result["totals"]["period_kwh"])
        self.assertEqual("0.000012", result["rows"][0]["period_kwh"])
        self.assertIn("ROUNDING_APPLIED", warning_codes(result))

    def test_cost_is_based_on_unrounded_period_energy(self):
        result = calculate_assessment(
            [appliance(rated_watts=Decimal("0.0004"), hours_per_day=1)],
            1, 20000,
        )
        self.assertEqual("0.000000", result["totals"]["period_kwh"])
        self.assertEqual("0.01", result["totals"]["grid_equivalent_cost_ngn"])

    def test_large_magnitude_preserves_decimal_tail(self):
        result = calculate_assessment(
            [appliance(rated_watts=Decimal("123456789012345678901234567890.123456789"),
                       hours_per_day=1)], 1, None,
        )
        self.assertEqual("123456789012345678901234567.890123",
                         result["totals"]["daily_kwh"])

    def test_ambient_decimal_precision_rounding_and_traps_do_not_change_results(self):
        rows = [appliance(rated_watts=Decimal("123456.789"), hours_per_day=Decimal("1.25"),
                          effective_load_percent=Decimal("12.5"))]
        expected = calculate_assessment(rows, 366, Decimal("123.45"))
        with localcontext() as context:
            context.prec = 2
            context.rounding = ROUND_DOWN
            context.traps[Inexact] = True
            context.traps[Rounded] = True
            actual = calculate_assessment(rows, 366, Decimal("123.45"))
        self.assertEqual(expected, actual)

    def test_engine_does_not_modify_callers_decimal_context(self):
        with localcontext() as context:
            context.prec = 7
            context.rounding = ROUND_DOWN
            before = context.copy()
            calculate_assessment([appliance()], 30, Decimal("1.005"))
            self.assertEqual(before.prec, context.prec)
            self.assertEqual(before.rounding, context.rounding)
            self.assertEqual(before.traps, context.traps)
            self.assertEqual(before.flags, context.flags)

    def test_json_decimal_token_below_halfway_is_not_rounded_up_as_float(self):
        # This token is strictly below .0005 W, so its daily kWh rounds down.
        body = json.dumps(request()).replace('"rated_watts": 100',
            '"rated_watts": 0.000499999999999999999999999999999999')
        body = body.replace('"hours_per_day": 5', '"hours_per_day": 1')
        result = parse_calculation_request(body)
        self.assertEqual("0.000000", result["totals"]["daily_kwh"])

    def test_json_long_zero_padded_exponent_is_a_valid_finite_number(self):
        # 1e000...000 is mathematically 1; its exponent need not become a huge int.
        token = "1e" + "0" * 5000
        body = json.dumps(request()).replace('"rated_watts": 100',
                                             '"rated_watts": ' + token)
        result = parse_calculation_request(body)
        self.assertEqual("0.005000", result["totals"]["daily_kwh"])
        self.assertEqual("0.150000", result["totals"]["period_kwh"])

    def test_json_integral_exponent_tokens_satisfy_integer_fields(self):
        body = json.dumps(request()).replace('"quantity": 1', '"quantity": 3e1')
        body = body.replace('"period_days": 30', '"period_days": 3e1')
        result = parse_calculation_request(body)
        self.assertIs(type(result["period_days"]), int)
        self.assertEqual(30, result["period_days"])
        self.assertEqual("15.000000", result["totals"]["daily_kwh"])
        self.assertEqual("450.000000", result["totals"]["period_kwh"])

    def test_json_large_exact_integer_keeps_all_quantity_digits(self):
        body = json.dumps(request(
            [appliance(quantity=9007199254740991, rated_watts=1000, hours_per_day=1)],
            period_days=1,
        ))
        result = parse_calculation_request(body)
        self.assertEqual("9007199254740991.000000", result["totals"]["daily_kwh"])

    def test_negative_zero_does_not_leak_into_presentation(self):
        result = calculate_assessment([appliance(hours_per_day=Decimal("-0"))],
                                      30, Decimal("-0"))
        self.assertEqual("0.000000", result["totals"]["daily_kwh"])
        self.assertEqual("0.00", result["totals"]["grid_equivalent_cost_ngn"])


class RequestBoundaryAndSafeErrorTests(CalculationTestCase):
    def test_calculate_request_is_strict_and_returns_assessment(self):
        result = calculate_request(request(rate_ngn_per_kwh=100))
        self.assertEqual("1500.00", result["totals"]["grid_equivalent_cost_ngn"])

    def test_schema_invalid_row_rejects_request_atomically(self):
        body = request([appliance(), appliance(id=ID_B, quantity=0)])
        self.assert_validation_error(
            lambda: calculate_request(body), "/appliances/1/quantity", "OUT_OF_RANGE",
        )

    def test_explicit_unknown_row_succeeds_with_exclusion(self):
        result = calculate_request(request([appliance(effective_load_percent=None)]))
        self.assertEqual("incomplete", result["rows"][0]["status"])
        self.assertEqual(NULL_TOTALS, result["totals"])

    def test_unconfirmed_preview_is_valid_but_excluded(self):
        result = calculate_request(request([appliance(source_status="unconfirmed")]))
        self.assertEqual("unconfirmed", result["rows"][0]["status"])

    def test_all_request_properties_are_required(self):
        for field in request():
            with self.subTest(field=field):
                body = request()
                del body[field]
                self.assert_validation_error(lambda: calculate_request(body),
                                             "/" + field, "REQUIRED")

    def test_request_rejects_nonobject_and_nonarray_appliances(self):
        for value in [None, [], 1, "body", True]:
            with self.subTest(body=value):
                self.assert_validation_error(lambda: calculate_request(value))
        for value in [None, {}, "rows", (), iter([]), True]:
            with self.subTest(appliances=repr(value)):
                self.assert_validation_error(
                    lambda: calculate_request(request(value)))

    def test_request_rejects_unknown_and_server_owned_properties(self):
        for field in ["owner_id", "totals", "tariff_provenance", "estimate", "extra"]:
            with self.subTest(field=field):
                self.assert_validation_error(
                    lambda: calculate_request(request(**{field: "untrusted"})))

    def test_unknown_row_properties_fail_strict_request(self):
        self.assert_validation_error(
            lambda: calculate_request(request([appliance(kwh_per_day=900)])),
        )

    def test_valid_json_decimals_use_authoritative_calculation(self):
        result = parse_calculation_request(json.dumps(request(rate_ngn_per_kwh=100)))
        self.assertEqual("15.000000", result["totals"]["period_kwh"])
        self.assertEqual("1500.00", result["totals"]["grid_equivalent_cost_ngn"])

    def test_malformed_json_returns_stable_code(self):
        values = ["", "{", "{\"appliances\":[],}", "{} {}", "/* body */ {}"]
        for value in values:
            with self.subTest(value=value):
                with self.assertRaises(CalculationError) as caught:
                    parse_calculation_request(value)
                self.assertEqual("MALFORMED_JSON", caught.exception.code)

    def test_duplicate_json_properties_are_rejected_at_every_depth(self):
        payloads = [
            '{"appliances":[],"period_days":1,"period_days":30,"rate_ngn_per_kwh":null}',
            json.dumps(request()).replace('"quantity": 1', '"quantity": 1,"quantity": 2'),
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                with self.assertRaises(CalculationError) as caught:
                    parse_calculation_request(payload)
                self.assertEqual("MALFORMED_JSON", caught.exception.code)

    def test_nonstandard_nan_and_infinity_json_literals_are_rejected(self):
        for value in ["NaN", "Infinity", "-Infinity"]:
            with self.subTest(value=value):
                payload = json.dumps(request()).replace('"rated_watts": 100',
                                                        '"rated_watts": ' + value)
                with self.assertRaises(CalculationError) as caught:
                    parse_calculation_request(payload)
                self.assertEqual("MALFORMED_JSON", caught.exception.code)

    def test_well_formed_json_with_wrong_body_shape_is_validation_error(self):
        for payload in ["[]", "null", "1", '"body"', "true", "{}"]:
            with self.subTest(payload=payload):
                self.assert_validation_error(lambda: parse_calculation_request(payload))

    def test_json_numbers_are_not_coerced_from_strings_or_booleans(self):
        for field in ["quantity", "rated_watts", "hours_per_day", "effective_load_percent"]:
            for value in ["1", True, False]:
                with self.subTest(field=field, value=value):
                    payload = json.dumps(request([appliance(**{field: value})]))
                    self.assert_validation_error(lambda: parse_calculation_request(payload))

    def test_error_envelope_is_stable_and_contains_no_rejected_value(self):
        secret_like_value = "sensitive-input-do-not-reflect"
        error = self.assert_validation_error(
            lambda: calculate_request(request([appliance(rated_watts=secret_like_value)])),
        )
        envelope = error.as_dict("synthetic-request-id")
        self.assertEqual({"error"}, set(envelope))
        self.assertEqual({"code", "message", "details", "request_id"},
                         set(envelope["error"]))
        self.assertEqual("VALIDATION_ERROR", envelope["error"]["code"])
        self.assertEqual("synthetic-request-id", envelope["error"]["request_id"])
        self.assertIsInstance(envelope["error"]["details"], list)
        self.assertNotIn(secret_like_value, json.dumps(envelope))
        self.assertNotIn("Traceback", json.dumps(envelope))
        for detail in envelope["error"]["details"]:
            self.assertEqual({"path", "code", "message"}, set(detail))


class ArithmeticResourceLimitTests(CalculationTestCase):
    @unittest.skipUnless(hasattr(sys, "set_int_max_str_digits"),
                         "Python runtime has no integer-to-string digit limit")
    def test_large_integer_validation_ignores_host_integer_string_digit_limit(self):
        previous_limit = sys.get_int_max_str_digits()
        try:
            sys.set_int_max_str_digits(640)
            self.assertEqual((), validate_appliance(appliance(rated_watts=10 ** 1000)))
        finally:
            sys.set_int_max_str_digits(previous_limit)

    def test_extreme_finite_input_returns_calculation_out_of_range(self):
        for value in [Decimal("1e4097"), Decimal("1e-4097"),
                      Decimal("1" * 4097)]:
            with self.subTest(value_tuple=value.as_tuple()):
                with self.assertRaises(CalculationError) as caught:
                    calculate_assessment([appliance(rated_watts=value)], 30, None)
                self.assertEqual("CALCULATION_OUT_OF_RANGE", caught.exception.code)
                envelope = caught.exception.as_dict("synthetic-limit-request")
                self.assertEqual("CALCULATION_OUT_OF_RANGE", envelope["error"]["code"])
                self.assertIsInstance(envelope["error"]["details"], list)

    def test_extreme_finite_tariff_does_not_become_infinity_or_zero(self):
        for rate in [Decimal("1e4097"), Decimal("1e-4097")]:
            with self.subTest(rate=rate):
                with self.assertRaises(CalculationError) as caught:
                    calculate_assessment([appliance()], 30, rate)
                self.assertEqual("CALCULATION_OUT_OF_RANGE", caught.exception.code)

    def test_output_exceeding_digit_budget_fails_instead_of_clamping(self):
        with self.assertRaises(CalculationError) as caught:
            calculate_assessment(
                [appliance(quantity=9007199254740991,
                           rated_watts=Decimal("1e4095"), hours_per_day=24)],
                366, None,
            )
        self.assertEqual("CALCULATION_OUT_OF_RANGE", caught.exception.code)

    def test_strict_request_exposes_same_arithmetic_range_failure(self):
        with self.assertRaises(CalculationError) as caught:
            calculate_request(request([appliance(rated_watts=Decimal("1e4097"))]))
        self.assertEqual("CALCULATION_OUT_OF_RANGE", caught.exception.code)


class PurityAndResponseContractTests(CalculationTestCase):
    def test_all_public_evaluators_leave_inputs_unchanged(self):
        rows = [appliance(), appliance(id=ID_B, rated_watts=None)]
        before = deepcopy(rows)
        validate_appliance(rows[0])
        evaluate_appliance(rows[0], 0, 30)
        calculate_assessment(rows, 30, Decimal("123.45"))
        body = request(rows, rate_ngn_per_kwh=Decimal("123.45"))
        body_before = deepcopy(body)
        calculate_request(body)
        self.assertEqual(before, rows)
        self.assertEqual(body_before, body)

    def test_repeated_calls_are_deterministic_and_outputs_are_independent(self):
        rows = [appliance()]
        first = calculate_assessment(rows, 30, 100)
        second = calculate_assessment(rows, 30, 100)
        self.assertEqual(first, second)
        first["rows"][0]["issues"].append({"path": "", "code": "TEST", "message": "test"})
        self.assertEqual([], second["rows"][0]["issues"])

    def test_response_matches_public_key_contract(self):
        result = calculate_assessment([appliance()], 30, 100)
        self.assertEqual(
            {"contract_version", "estimate", "period_days", "rate_ngn_per_kwh",
             "tariff_provenance", "rows", "counts", "totals", "warnings", "assumptions"},
            set(result),
        )
        self.assertEqual("0.1.0", result["contract_version"])
        self.assertIs(True, result["estimate"])
        self.assertEqual(30, result["period_days"])
        self.assertEqual({"input_index", "id", "status", "daily_kwh", "period_kwh", "issues"},
                         set(result["rows"][0]))
        self.assertEqual({"total", "eligible", "incomplete", "invalid", "unconfirmed"},
                         set(result["counts"]))

    def test_response_encoder_preserves_decimal_input_as_json_number(self):
        result = calculate_assessment(
            [appliance(rated_watts=Decimal("100.1"))], 30, Decimal("123.45"),
        )
        serialized = dumps_assessment(result)
        self.assertEqual(result, json.loads(serialized, parse_float=Decimal))
        self.assertRegex(result["totals"]["daily_kwh"], r"^(0|[1-9][0-9]*)\.[0-9]{6}$")
        self.assertRegex(result["totals"]["grid_equivalent_cost_ngn"],
                         r"^(0|[1-9][0-9]*)\.[0-9]{2}$")

    def test_exact_tariff_decimal_token_is_preserved_in_json_response(self):
        rate = Decimal("0.100000000000000000001")
        result = calculate_assessment([appliance()], 30, rate)
        serialized = dumps_assessment(result)
        decoded = json.loads(serialized, parse_float=Decimal)
        self.assertEqual(rate, decoded["rate_ngn_per_kwh"])
        self.assertIsInstance(decoded["rate_ngn_per_kwh"], Decimal)
        self.assertEqual("1.50", decoded["totals"]["grid_equivalent_cost_ngn"])

    def test_warnings_are_unique_and_include_estimate_context(self):
        result = calculate_assessment([appliance()], 30, 100)
        codes = [warning["code"] for warning in result["warnings"]]
        self.assertEqual(len(codes), len(set(codes)))
        self.assertIn("RATED_POWER_ESTIMATE", codes)
        for warning in result["warnings"]:
            self.assertEqual({"code", "message"}, set(warning))
            self.assertTrue(warning["message"].strip())

    def test_assumptions_disclose_usage_rounding_exclusions_and_grid_scenario(self):
        result = calculate_assessment(
            [appliance(), appliance(id=ID_B, effective_load_percent=None)], 30, 100,
        )
        self.assertIsInstance(result["assumptions"], list)
        self.assertTrue(result["assumptions"])
        text = " ".join(result["assumptions"]).lower()
        for concept in ["rated", "load", "round", "exclud", "grid"]:
            self.assertIn(concept, text)
        for assumption in result["assumptions"]:
            self.assertIsInstance(assumption, str)
            self.assertTrue(assumption.strip())


if __name__ == "__main__":
    unittest.main()
