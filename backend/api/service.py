"""Owner-scoped persistence orchestration; all energy arithmetic belongs to M3."""
import csv
from datetime import datetime, timezone
from io import StringIO
from uuid import UUID

from psycopg.types.json import Jsonb

from backend.calculations import calculate_assessment, evaluate_appliance, dumps_assessment
from .errors import APIError, missing, conflict
from .validation import CONTRACT, fingerprint, validate

INPUT_FIELDS = ("name", "quantity", "rated_watts", "hours_per_day", "effective_load_percent",
                "brand", "model", "source_method", "source_notes", "scan_id")
ESTIMATE_FIELDS = ("id", "name", "quantity", "rated_watts", "hours_per_day",
                   "effective_load_percent", "source_status")
PROFILE_FIELDS = tuple(CONTRACT["components"]["schemas"]["ProfileRead"]["properties"])
APPLIANCE_FIELDS = tuple(CONTRACT["components"]["schemas"]["ApplianceRead"]["properties"])
REPORT_FIELDS = tuple(CONTRACT["components"]["schemas"]["ReportRead"]["properties"])


def wire(value):
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: wire(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [wire(v) for v in value]
    return value


def project(row, fields):
    return {key: wire(row[key]) for key in fields}


def estimate_input(row):
    return project(row, ESTIMATE_FIELDS)


def appliance_read(row):
    result = wire(dict(row))
    result["calculated_daily_kwh"] = evaluate_appliance(estimate_input(row), 0, 1)["daily_kwh"]
    return project(result, APPLIANCE_FIELDS)


def owned(conn, table, resource_id, *, lock=False):
    if table not in ("profiles", "appliances", "reports", "scan_sessions"):
        raise ValueError("Unsupported relation")
    row = conn.execute("SELECT * FROM powershift." + table +
                       " WHERE owner_id=powershift.current_owner_id() AND id=%s" +
                       (" FOR UPDATE" if lock else ""), (resource_id,)).fetchone()
    if not row:
        raise missing()
    return row


def scan_start(conn, profile_id, notice_version, settings):
    owned(conn, "profiles", profile_id)
    # Serialize quota reservations across API workers without holding a lock
    # during inference. All attempts count, including unavailable/model failures.
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(powershift.current_owner_id()::text,7))")
    count = conn.execute("""SELECT count(*) AS total,
        count(*) FILTER (WHERE status='pending' AND expires_at>clock_timestamp()) AS pending
        FROM powershift.scan_sessions WHERE owner_id=powershift.current_owner_id()
        AND created_at>clock_timestamp()-interval '24 hours'""").fetchone()
    if count["total"] >= settings.daily_limit or count["pending"]:
        raise APIError(429, "RATE_LIMITED", "The scan limit has been reached. Enter values manually or retry later.")
    return conn.execute("""INSERT INTO powershift.scan_sessions
        (profile_id,status,consent_notice_version,consented_at,expires_at)
        VALUES (%s,'pending',%s,clock_timestamp(),clock_timestamp()+(%s*interval '1 second'))
        RETURNING id""", (profile_id, notice_version, settings.expiry_seconds)).fetchone()["id"]


def scan_finish(conn, resource_id, *, candidate=None, error_code=None):
    row = owned(conn, "scan_sessions", resource_id, lock=True)
    if row["status"] != "pending":
        raise conflict("SCAN_ALREADY_CONFIRMED")
    row = conn.execute("""UPDATE powershift.scan_sessions SET status=%s,candidate=%s,error_code=%s
        WHERE owner_id=powershift.current_owner_id() AND id=%s RETURNING *""",
        ("failed" if error_code else "candidate", Jsonb(candidate, dumps=dumps_assessment) if candidate else None,
         error_code, resource_id)).fetchone()
    if error_code:
        return None
    return {"scan_id": str(row["id"]), "profile_id": str(row["profile_id"]),
            "expires_at": wire(row["expires_at"]), "result": wire(row["candidate"]),
            "requiresConfirmation": True}


def replay(conn, operation, profile, data, table, render):
    key = conn.execute("""SELECT resource_id, request_fingerprint FROM powershift.request_keys
        WHERE owner_id=powershift.current_owner_id() AND operation=%s
        AND scope_key=coalesce(%s::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
        AND client_request_id=%s""", (operation, profile, data["client_request_id"])).fetchone()
    if key:
        if key["request_fingerprint"] != fingerprint(data):
            raise conflict("IDEMPOTENCY_CONFLICT")
        return render(owned(conn, table, key["resource_id"]))
    return None


def profile_create(conn, data):
    previous = replay(conn, "profile.create", None, data, "profiles", lambda r: project(r, PROFILE_FIELDS))
    if previous is not None:
        return previous, 200
    row = conn.execute("""INSERT INTO powershift.profiles(name,sector,currency,client_request_id,request_fingerprint)
        VALUES (%s,%s,%s,%s,%s) RETURNING *""", (data["name"], data["sector"], data["currency"],
        data["client_request_id"], fingerprint(data))).fetchone()
    return project(row, PROFILE_FIELDS), 201


def profile_get(conn, resource_id):
    profile = owned(conn, "profiles", resource_id)
    rows = conn.execute("SELECT * FROM powershift.appliances WHERE owner_id=powershift.current_owner_id() "
                        "AND profile_id=%s ORDER BY id", (resource_id,)).fetchall()
    return {"profile": project(profile, PROFILE_FIELDS), "appliances": [appliance_read(row) for row in rows]}


def profile_list(conn, after=None, limit=50):
    rows = conn.execute("SELECT * FROM powershift.profiles WHERE owner_id=powershift.current_owner_id() "
                        "AND (%s::uuid IS NULL OR id>%s::uuid) ORDER BY id LIMIT %s",
                        (after, after, limit + 1)).fetchall()
    return {"profiles": [project(row, PROFILE_FIELDS) for row in rows[:limit]],
            "next_cursor": str(rows[limit - 1]["id"]) if len(rows) > limit else None}


def provenance(conn, profile_id, values, old=None):
    fields = ("name", "quantity", "rated_watts", "hours_per_day", "effective_load_percent", "brand", "model")
    receipt = None
    if values["source_method"] == "ai_label_extraction":
        receipt = owned(conn, "scan_sessions", values["scan_id"], lock=True)
        if str(receipt["profile_id"]) != str(profile_id):
            raise missing()
        same = old is not None and receipt["confirmed_appliance_id"] == old["id"] and receipt["status"] == "confirmed"
        if not same:
            if receipt["status"] == "confirmed":
                raise conflict("SCAN_ALREADY_CONFIRMED")
            if receipt["expires_at"] <= datetime.now(timezone.utc):
                raise conflict("SCAN_EXPIRED")
            if receipt["status"] != "candidate":
                raise missing()
    result = {}
    for field in fields:
        original = old["field_provenance"][field] if old else None
        origin, evidence = "user_entry", original["evidence"] if original else None
        if old and old[field] != values[field]:
            origin = "user_correction"
        if receipt and field in ("name", "rated_watts", "brand", "model"):
            candidate_field = "watts" if field == "rated_watts" else field
            origin = "label_extraction" if values[field] == receipt["candidate"][candidate_field] else "user_correction"
            evidence = receipt["candidate"]["visible_evidence"] or None
        elif values["source_method"] == "document" and field == "rated_watts":
            origin, evidence = "document", values["source_notes"]
        elif original and old[field] == values[field] and original["origin"] in ("user_entry", "user_correction"):
            origin = original["origin"]
        elif original and original["origin"] == "label_extraction":
            origin = "user_correction"
        result[field] = {"origin": origin, "evidence": evidence}
    return result


def appliance_create(conn, profile_id, data):
    previous = replay(conn, "appliance.create", profile_id, data, "appliances", appliance_read)
    if previous is not None:
        return previous, 200
    owned(conn, "profiles", profile_id)
    prov = provenance(conn, profile_id, data)
    conn.execute("SELECT set_config('powershift.confirmed','true',true)")
    row = conn.execute("""INSERT INTO powershift.appliances(profile_id,name,quantity,rated_watts,
        hours_per_day,effective_load_percent,brand,model,source_method,source_notes,scan_id,
        field_provenance,client_request_id,request_fingerprint)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
        (profile_id, *(int(data[k]) if k == "quantity" else data[k] for k in INPUT_FIELDS),
         Jsonb(prov, dumps=dumps_assessment), data["client_request_id"], fingerprint(data))).fetchone()
    return appliance_read(row), 201


def appliance_patch(conn, resource_id, data):
    old = owned(conn, "appliances", resource_id, lock=True)
    if old["version"] != data["version"]:
        raise conflict("STALE_VERSION")
    merged = {key: wire(old[key]) for key in INPUT_FIELDS}
    merged.update({k: v for k, v in data.items() if k in INPUT_FIELDS})
    validate("ApplianceCreate", {**merged, "confirmation": True, "client_request_id": str(old["client_request_id"])})
    prov = provenance(conn, old["profile_id"], merged, old)
    conn.execute("SELECT set_config('powershift.confirmed','true',true)")
    row = conn.execute("""UPDATE powershift.appliances SET name=%s,quantity=%s,rated_watts=%s,
        hours_per_day=%s,effective_load_percent=%s,brand=%s,model=%s,source_method=%s,source_notes=%s,
        scan_id=%s,field_provenance=%s WHERE owner_id=powershift.current_owner_id()
        AND id=%s AND version=%s RETURNING *""",
        (*(int(merged[k]) if k == "quantity" else merged[k] for k in INPUT_FIELDS),
         Jsonb(prov, dumps=dumps_assessment), resource_id, int(data["version"]))).fetchone()
    if not row:
        raise conflict("STALE_VERSION")
    return appliance_read(row)


def appliance_delete(conn, resource_id, version):
    row = owned(conn, "appliances", resource_id, lock=True)
    if row["version"] != version:
        raise conflict("STALE_VERSION")
    conn.execute("DELETE FROM powershift.appliances WHERE owner_id=powershift.current_owner_id() "
                 "AND id=%s AND version=%s", (resource_id, version))


def report_create(conn, data):
    previous = replay(conn, "report.create", data["profile_id"], data, "reports", lambda r: project(r, REPORT_FIELDS))
    if previous is not None:
        return previous, 200
    owned(conn, "profiles", data["profile_id"])
    inputs = conn.execute("SELECT * FROM powershift.appliances WHERE owner_id=powershift.current_owner_id() "
                          "AND profile_id=%s ORDER BY id", (data["profile_id"],)).fetchall()
    result = calculate_assessment([estimate_input(row) for row in inputs], data["period_days"], data["rate_ngn_per_kwh"])
    snapshot = {"appliances": [appliance_read(row) for row in inputs], "period_days": data["period_days"],
                "rate_ngn_per_kwh": data["rate_ngn_per_kwh"], "tariff_provenance": result["tariff_provenance"]}
    tariff_id = None
    if data["rate_ngn_per_kwh"] is not None:
        tariff_id = conn.execute("""INSERT INTO powershift.tariff_inputs(profile_id,rate_ngn_per_kwh,period_days,provenance)
            VALUES (%s,%s,%s,'user_input') RETURNING id""", (data["profile_id"], data["rate_ngn_per_kwh"],
                                                        int(data["period_days"]))).fetchone()["id"]
    row = conn.execute("""INSERT INTO powershift.reports(profile_id,tariff_input_id,period_days,contract_version,
        input_snapshot,calculation,client_request_id,request_fingerprint)
        VALUES (%s,%s,%s,'0.1.0',%s,%s,%s,%s) RETURNING *""", (data["profile_id"], tariff_id,
        int(data["period_days"]), Jsonb(snapshot, dumps=dumps_assessment), Jsonb(result, dumps=dumps_assessment),
        data["client_request_id"], fingerprint(data))).fetchone()
    return project(row, REPORT_FIELDS), 201


def report_csv(report):
    fields = "report_id,estimate,appliance_id,name,quantity,rated_watts,hours_per_day,effective_load_percent,source_method,source_status,calculation_status,daily_kwh,period_days,period_kwh,rate_ngn_per_kwh,tariff_provenance,grid_equivalent_cost_ngn,cost_basis,assumptions,exclusion_codes".split(",")
    output = StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()
    calc = report["calculation"]
    def cell(value):
        if value is None:
            return ""
        if isinstance(value, str) and (value.lstrip().startswith(("=", "+", "-", "@")) or value.startswith(("\t", "\r", "\n"))):
            return "'" + value
        return value
    for item, result in zip(report["input_snapshot"]["appliances"], calc["rows"], strict=True):
        row = {k: item[k] for k in ("name", "quantity", "rated_watts", "hours_per_day", "effective_load_percent",
                                   "source_method", "source_status", "calculation_status")}
        cost = calculate_assessment([estimate_input(item)], calc["period_days"], calc["rate_ngn_per_kwh"])["totals"]["grid_equivalent_cost_ngn"]
        row.update(report_id=report["id"], estimate="true", appliance_id=item["id"],
                   daily_kwh=result["daily_kwh"], period_kwh=result["period_kwh"], period_days=calc["period_days"],
                   rate_ngn_per_kwh=calc["rate_ngn_per_kwh"], tariff_provenance=calc["tariff_provenance"],
                   grid_equivalent_cost_ngn=cost, cost_basis="grid_equivalent" if calc["rate_ngn_per_kwh"] is not None else "",
                   assumptions="; ".join(calc["assumptions"]), exclusion_codes=";".join(issue["code"] for issue in result["issues"]))
        writer.writerow({k: cell(v) for k, v in row.items()})
    return output.getvalue()
