"""FastAPI application factory. Start with uvicorn backend.api.app:create_app --factory."""
from collections import OrderedDict, deque
from contextlib import asynccontextmanager
from copy import deepcopy
import logging
import threading
import time
from uuid import uuid4

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import Response
from starlette.exceptions import HTTPException
import psycopg
from psycopg_pool import PoolTimeout

from backend.calculations import CalculationError, calculate_request, dumps_assessment
from .auth import TokenVerifier, Principal
from .config import Settings
from .database import Database
from .errors import APIError, invalid, missing
from . import service
from .validation import CONTRACT, parse_json, validate, uuid_text

LOGGER = logging.getLogger("powershift.api")


def response(data, status=200):
    return Response(dumps_assessment(data), status_code=status, media_type="application/json")


def failure(error, request_id):
    result = response(error.body(request_id), error.status)
    if error.status == 401:
        result.headers["WWW-Authenticate"] = "Bearer"
    if error.status in (429, 503):
        result.headers["Retry-After"] = "5" if error.status == 503 else "60"
    return result


class RequestBoundary:
    """ASGI request IDs, bounded streaming body, safe failures and local IP budget."""
    def __init__(self, app, settings):
        self.app, self.settings = app, settings
        self.buckets = OrderedDict()
        self.lock = threading.Lock()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request_id = str(uuid4())
        scope.setdefault("state", {})["request_id"] = request_id
        started, count = False, 0

        async def safe_send(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                message["headers"] = [(k, v) for k, v in message["headers"]
                                      if k.lower() not in (b"x-request-id", b"x-contract-version", b"cache-control")]
                message["headers"].extend([(b"x-request-id", request_id.encode()),
                                          (b"x-contract-version", b"0.1.0"),
                                          (b"cache-control", b"no-store")])
            await send(message)

        async def bounded_receive():
            nonlocal count
            message = await receive()
            if message["type"] == "http.request":
                count += len(message.get("body", b""))
                if count > self.settings.max_body_bytes:
                    raise APIError(413, "REQUEST_TOO_LARGE", "The request exceeds the size limit.")
            return message

        try:
            host = scope.get("client", ("unknown",))[0]
            now = time.monotonic()
            with self.lock:
                bucket = self.buckets.setdefault(host, deque())
                self.buckets.move_to_end(host)
                while bucket and bucket[0] <= now - 60:
                    bucket.popleft()
                if len(bucket) >= self.settings.requests_per_minute:
                    raise APIError(429, "RATE_LIMITED", "Too many requests. Try again later.")
                bucket.append(now)
                if len(self.buckets) > 10000:
                    self.buckets.popitem(last=False)
            lengths = [v for k, v in scope["headers"] if k.lower() == b"content-length"]
            if len(lengths) > 1 or lengths and (not lengths[0].isdigit()):
                raise APIError(400, "MALFORMED_JSON", "A valid request is required.")
            if lengths and (len(lengths[0]) > 10 or int(lengths[0]) > self.settings.max_body_bytes):
                raise APIError(413, "REQUEST_TOO_LARGE", "The request exceeds the size limit.")
            await self.app(scope, bounded_receive, safe_send)
        except Exception as error:
            if started:
                raise
            if not isinstance(error, APIError):
                # Never log exception text, SQL, tokens, subject IDs or request bodies.
                LOGGER.error("request_failed request_id=%s category=internal", request_id)
                error = APIError(500, "INTERNAL_ERROR", "The request could not be completed.")
            await failure(error, request_id)(scope, receive, safe_send)


def create_app(settings=None, *, database=None, verifier=None):
    settings = settings or Settings.from_env()
    database = database or Database(settings)
    verifier = verifier or TokenVerifier(settings)

    @asynccontextmanager
    async def lifespan(_):
        # Pool opening is bounded; invalid/admin configuration prevents startup.
        import anyio
        try:
            await anyio.to_thread.run_sync(database.open)
            yield
        finally:
            database.close()
            verifier.close()

    app = FastAPI(title="PowerShift AI", version="0.1.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None, debug=False)
    app.state.database, app.state.verifier = database, verifier
    app.add_middleware(RequestBoundary, settings=settings)
    app.openapi = lambda: deepcopy(CONTRACT)

    @app.exception_handler(APIError)
    async def api_error(request, error):
        return failure(error, request.state.request_id)

    @app.exception_handler(CalculationError)
    async def calculation_error(request, error):
        return failure(APIError(400 if error.code == "MALFORMED_JSON" else 422,
                               error.code, error.message,
                               [issue.as_dict() for issue in error.details]), request.state.request_id)

    @app.exception_handler(RequestValidationError)
    async def request_error(request, _):
        return failure(invalid(), request.state.request_id)

    @app.exception_handler(HTTPException)
    async def http_error(request, error):
        safe = missing() if error.status_code == 404 else APIError(
            error.status_code, "METHOD_NOT_ALLOWED" if error.status_code == 405 else "INVALID_REQUEST",
            "The request is not supported.")
        return failure(safe, request.state.request_id)

    @app.exception_handler(psycopg.Error)
    @app.exception_handler(PoolTimeout)
    async def database_error(request, error):
        unavailable = isinstance(error, (psycopg.OperationalError, PoolTimeout))
        LOGGER.error("request_failed request_id=%s category=%s", request.state.request_id,
                     "database_unavailable" if unavailable else "database_error")
        return failure(APIError(503 if unavailable else 500,
                               "SERVICE_UNAVAILABLE" if unavailable else "INTERNAL_ERROR",
                               "The service is temporarily unavailable." if unavailable else "The request could not be completed."),
                       request.state.request_id)

    def principal(request: Request):
        headers = request.headers.getlist("authorization")
        if len(headers) > 1:
            raise APIError(401, "INVALID_CREDENTIALS", "The credentials are invalid or expired.")
        return verifier.verify(headers[0] if headers else None)

    async def payload(request: Request):
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise APIError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json.")
        return parse_json(await request.body())

    def run(request, identity, operation, isolation="READ COMMITTED"):
        return database.run(identity, request.state.request_id, operation, isolation)

    def checked(name, data):
        validate(name, data)
        # UUID casing is not a semantic request difference.
        for key in ("client_request_id", "profile_id", "scan_id"):
            if key in data and data[key] is not None:
                data[key] = uuid_text(data[key])
        return data

    @app.get("/api/status")
    def status():
        return response({"imageScanningConfigured": False})

    @app.post("/api/profiles")
    def create_profile(request: Request, identity: Principal = Depends(principal), data=Depends(payload)):
        data = checked("ProfileCreate", data)
        result, code = run(request, identity, lambda c: service.profile_create(c, data))
        return response(result, code)

    @app.get("/api/profiles")
    def list_profiles(request: Request, identity: Principal = Depends(principal)):
        query = request.query_params
        if set(query) - {"after", "limit"} or any(len(query.getlist(k)) != 1 for k in query):
            raise invalid()
        after = uuid_text(query["after"]) if "after" in query else None
        text = query.get("limit", "50")
        if not text.isascii() or not text.isdigit() or len(text) > 3 or not 1 <= int(text) <= 100:
            raise invalid("/limit", "OUT_OF_RANGE")
        return response(run(request, identity, lambda c: service.profile_list(c, after, int(text))))

    @app.get("/api/profiles/{profile_id}")
    def get_profile(profile_id: str, request: Request, identity: Principal = Depends(principal)):
        resource = uuid_text(profile_id)
        return response(run(request, identity, lambda c: service.profile_get(c, resource), "REPEATABLE READ"))

    @app.post("/api/profiles/{profile_id}/appliances")
    def create_appliance(profile_id: str, request: Request, identity: Principal = Depends(principal), data=Depends(payload)):
        data, resource = checked("ApplianceCreate", data), uuid_text(profile_id)
        result, code = run(request, identity, lambda c: service.appliance_create(c, resource, data))
        return response(result, code)

    @app.patch("/api/appliances/{appliance_id}")
    def patch_appliance(appliance_id: str, request: Request, identity: Principal = Depends(principal), data=Depends(payload)):
        data, resource = checked("AppliancePatch", data), uuid_text(appliance_id)
        return response(run(request, identity, lambda c: service.appliance_patch(c, resource, data)))

    @app.delete("/api/appliances/{appliance_id}")
    def delete_appliance(appliance_id: str, request: Request, identity: Principal = Depends(principal)):
        values = request.query_params.getlist("version")
        if len(values) != 1 or set(request.query_params) != {"version"} or not values[0].isascii() or not values[0].isdigit() or len(values[0]) > 19:
            raise invalid("/version")
        version = int(values[0])
        if not 1 <= version <= 9223372036854775807:
            raise invalid("/version", "OUT_OF_RANGE")
        resource = uuid_text(appliance_id)
        run(request, identity, lambda c: service.appliance_delete(c, resource, version))
        return Response(status_code=204)

    @app.post("/api/calculations")
    def calculation(identity: Principal = Depends(principal), data=Depends(payload)):
        # M3 validates all rows atomically and retains exact JSON decimal inputs.
        return response(calculate_request(data))

    @app.post("/api/reports")
    def create_report(request: Request, identity: Principal = Depends(principal), data=Depends(payload)):
        data = checked("ReportCreate", data)
        result, code = run(request, identity, lambda c: service.report_create(c, data), "REPEATABLE READ")
        return response(result, code)

    @app.get("/api/reports/{report_id}")
    def get_report(report_id: str, request: Request, identity: Principal = Depends(principal)):
        resource = uuid_text(report_id)
        return response(run(request, identity, lambda c: service.project(service.owned(c, "reports", resource), service.REPORT_FIELDS)))

    @app.get("/api/reports/{report_id}/export.csv")
    def export_report(report_id: str, request: Request, identity: Principal = Depends(principal)):
        resource = uuid_text(report_id)
        saved = run(request, identity, lambda c: service.project(service.owned(c, "reports", resource), service.REPORT_FIELDS))
        return Response(service.report_csv(saved), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="powershift-{resource}.csv"'})

    @app.post("/api/scan")
    def scan(request: Request, identity: Principal = Depends(principal), data=Depends(payload)):
        data = checked("ScanRequest", data)
        run(request, identity, lambda c: service.owned(c, "profiles", data["profile_id"]))
        # No upload/provider side effects until consent/retention/provider gates are approved.
        raise APIError(503, "SCANNER_UNAVAILABLE", "Image scanning is not configured. Enter values manually.")

    return app
