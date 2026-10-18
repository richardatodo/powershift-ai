"""Safe errors: exception text and rejected input never become HTTP messages."""

class APIError(Exception):
    def __init__(self, status: int, code: str, message: str, details: list | None = None):
        super().__init__(code)
        self.status, self.code, self.message = status, code, message
        self.details = details or []

    def body(self, request_id: str) -> dict:
        return {"error": {"code": self.code, "message": self.message,
                          "details": self.details, "request_id": request_id}}


def invalid(path: str = "", code: str = "INVALID_FORMAT") -> APIError:
    return APIError(422, "VALIDATION_ERROR", "Some fields need correction.",
                    [{"path": path, "code": code, "message": "Use a valid value for this field."}])


def missing() -> APIError:
    return APIError(404, "RESOURCE_NOT_FOUND", "The resource was not found.")


def conflict(code: str) -> APIError:
    return APIError(409, code, "The request conflicts with the current resource state.")
