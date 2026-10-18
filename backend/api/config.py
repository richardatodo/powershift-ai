"""Explicit environment configuration; no default identity or development bypass."""
from dataclasses import dataclass
import os
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Settings:
    database_url: str
    issuer: str
    audience: str
    jwks_url: str
    max_body_bytes: int = 262144
    requests_per_minute: int = 120
    pool_size: int = 4

    def __post_init__(self):
        for value in (self.issuer, self.jwks_url):
            parsed = urlsplit(value)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
                raise ValueError("Authentication endpoints must be explicit HTTPS URLs.")
        if not self.audience.strip() or len(self.audience) > 2000 or len(self.issuer) > 2000:
            raise ValueError("An API audience and issuer are required.")
        if not self.database_url or not 1024 <= self.max_body_bytes <= 1048576:
            raise ValueError("A database connection and bounded request size are required.")
        if not 1 <= self.pool_size <= 20 or not 1 <= self.requests_per_minute <= 10000:
            raise ValueError("Connection and request limits must be bounded.")

    @classmethod
    def from_env(cls):
        names = ("DATABASE_URL", "AUTH_ISSUER", "AUTH_AUDIENCE", "AUTH_JWKS_URL")
        values = [os.environ.get("POWERSHIFT_" + name, "") for name in names]
        if not all(values):
            raise ValueError("Set POWERSHIFT_DATABASE_URL, AUTH_ISSUER, AUTH_AUDIENCE and AUTH_JWKS_URL (all with POWERSHIFT_ prefix).")
        return cls(*values,
                   max_body_bytes=int(os.environ.get("POWERSHIFT_MAX_BODY_BYTES", "262144")),
                   requests_per_minute=int(os.environ.get("POWERSHIFT_REQUESTS_PER_MINUTE", "120")),
                   pool_size=int(os.environ.get("POWERSHIFT_POOL_SIZE", "4")))
