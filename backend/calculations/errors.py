"""Safe, transport-independent calculation errors."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Issue:
    path: str
    code: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {"path": self.path, "code": self.code, "message": self.message}


class CalculationError(ValueError):
    """An assessment-level failure; never contains rejected input values."""

    def __init__(self, code: str, message: str, details: tuple[Issue, ...] = ()):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = tuple(details)

    def as_dict(self, request_id: str) -> dict:
        if not isinstance(request_id, str) or not request_id.strip():
            raise ValueError("A server-generated request ID is required.")
        return {"error": {"code": self.code, "message": self.message,
                          "details": [issue.as_dict() for issue in self.details],
                          "request_id": request_id}}


def invalid_request(issues: tuple[Issue, ...] | list[Issue]) -> CalculationError:
    return CalculationError("VALIDATION_ERROR", "Some fields need correction.", tuple(issues))


def out_of_range(path: str = "") -> CalculationError:
    return CalculationError(
        "CALCULATION_OUT_OF_RANGE", "The calculation exceeds the supported numerical budget.",
        (Issue(path, "OUT_OF_RANGE", "Use a value within the documented numerical budget."),),
    )
