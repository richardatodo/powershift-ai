"""Explicit environment configuration; no default identity or development bypass."""
from dataclasses import dataclass, field
import os
import re
from urllib.parse import urlsplit


@dataclass(frozen=True)
class ScanSettings:
    provider: str = "disabled"
    base_url: str = "http://127.0.0.1:11434"
    model: str = "gemma4:e2b-it-qat"
    timeout_seconds: int = 120
    max_image_bytes: int = 2097152
    max_pixels: int = 12000000
    max_side: int = 6000
    expiry_seconds: int = 1800
    daily_limit: int = 20

    def __post_init__(self):
        if self.provider not in ("disabled", "ollama"):
            raise ValueError("Only disabled or local Ollama scanning is supported; hosted processing is not approved.")
        url = urlsplit(self.base_url)
        if (url.scheme != "http" or url.hostname not in ("127.0.0.1", "::1")
                or url.username or url.password or url.query or url.fragment or url.path not in ("", "/")):
            raise ValueError("Ollama must use a literal loopback HTTP address.")
        if not re.fullmatch(r"gemma4:[a-zA-Z0-9_.-]+", self.model) or "cloud" in self.model.lower():
            raise ValueError("Use an explicit local Gemma 4 tag; cloud models are disabled.")
        for value, low, high in ((self.timeout_seconds, 5, 300), (self.max_image_bytes, 1024, 5242880),
                (self.max_pixels, 1, 20000000), (self.max_side, 1, 10000),
                (self.expiry_seconds, 600, 86400), (self.daily_limit, 1, 100)):
            if type(value) is not int or not low <= value <= high:
                raise ValueError("Scan limits must be bounded integers.")

    @classmethod
    def from_env(cls):
        prefix = "POWERSHIFT_SCAN_"
        values = {name: os.environ[prefix + name.upper()] for name in ("provider", "base_url", "model")
                  if prefix + name.upper() in os.environ}
        values.update({name: int(os.environ[prefix + name.upper()]) for name in
            ("timeout_seconds", "max_image_bytes", "max_pixels", "max_side", "expiry_seconds", "daily_limit")
            if prefix + name.upper() in os.environ})
        return cls(**values)


@dataclass(frozen=True)
class Settings:
    database_url: str
    issuer: str
    audience: str
    jwks_url: str
    max_body_bytes: int = 262144
    requests_per_minute: int = 120
    pool_size: int = 4
    scan: ScanSettings = field(default_factory=ScanSettings)

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
                   pool_size=int(os.environ.get("POWERSHIFT_POOL_SIZE", "4")),
                   scan=ScanSettings.from_env())
