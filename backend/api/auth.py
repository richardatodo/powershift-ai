"""RS256 access-token verification against a configured, bounded HTTPS JWKS."""
from dataclasses import dataclass
import json
import threading
import time

import httpx
import jwt

from .errors import APIError


@dataclass(frozen=True)
class Principal:
    issuer: str
    subject: str


class TokenVerifier:
    def __init__(self, settings, client=None):
        self.settings = settings
        self.client = client or httpx.Client(timeout=3.0, follow_redirects=False, trust_env=False)
        self.lock = threading.Lock()
        self.keys = {}
        self.loaded_at = 0.0
        self.last_attempt = 0.0

    def close(self):
        self.client.close()

    def _load(self):
        self.last_attempt = time.monotonic()
        try:
            with self.client.stream("GET", self.settings.jwks_url) as response:
                response.raise_for_status()
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > 65536:
                        raise ValueError("Oversize JWKS")
            document = json.loads(body)
            keys = document["keys"]
            if not isinstance(keys, list) or not 1 <= len(keys) <= 32:
                raise ValueError("Invalid JWKS")
            parsed = {}
            for item in keys:
                if (item.get("kty") != "RSA" or item.get("use", "sig") != "sig"
                        or item.get("alg", "RS256") != "RS256"
                        or "verify" not in item.get("key_ops", ["verify"])):
                    continue
                kid = item.get("kid")
                if not isinstance(kid, str) or not 1 <= len(kid) <= 200 or kid in parsed:
                    raise ValueError("Invalid key identity")
                key = jwt.PyJWK.from_dict(item, algorithm="RS256").key
                if key.key_size < 2048:
                    raise ValueError("Weak key")
                parsed[kid] = key
            if not parsed:
                raise ValueError("No verification keys")
            self.keys, self.loaded_at = parsed, time.monotonic()
        except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError, jwt.PyJWTError):
            raise APIError(503, "AUTHENTICATION_UNAVAILABLE", "Authentication is temporarily unavailable.") from None

    def verify(self, authorization: str | None) -> Principal:
        if authorization is None:
            raise APIError(401, "AUTHENTICATION_REQUIRED", "Authentication is required.")
        try:
            scheme, token = authorization.split(" ", 1)
            if scheme.lower() != "bearer" or not token or len(token) > 8192 or any(c.isspace() for c in token):
                raise ValueError("Invalid bearer")
            header = jwt.get_unverified_header(token)
            kid = header.get("kid")
            if header.get("alg") != "RS256" or not isinstance(kid, str) or not 1 <= len(kid) <= 200 or header.get("crit"):
                raise ValueError("Invalid JWT header")
            with self.lock:
                now = time.monotonic()
                if not self.keys or now - self.loaded_at >= 300 or (kid not in self.keys and now - self.last_attempt >= 5):
                    # Unknown keys cannot force unlimited outbound requests.
                    if now - self.last_attempt < 5 and (not self.keys or now - self.loaded_at >= 300):
                        raise APIError(503, "AUTHENTICATION_UNAVAILABLE", "Authentication is temporarily unavailable.")
                    self._load()
                key = self.keys.get(kid)
            if key is None:
                raise ValueError("Unknown key")
            claims = jwt.decode(token, key, algorithms=["RS256"], issuer=self.settings.issuer,
                                audience=self.settings.audience, leeway=0,
                                options={"require": ["iss", "sub", "aud", "exp", "iat"]})
            if (not isinstance(claims["sub"], str) or not claims["sub"].strip()
                    or len(claims["sub"]) > 2000
                    or any(isinstance(claims.get(k), bool) or not isinstance(claims.get(k), (int, float))
                           for k in ("exp", "iat") + (("nbf",) if "nbf" in claims else ()))):
                raise ValueError("Invalid claims")
            return Principal(self.settings.issuer, claims["sub"])
        except (jwt.PyJWTError, ValueError, TypeError, KeyError, OverflowError):
            raise APIError(401, "INVALID_CREDENTIALS", "The credentials are invalid or expired.") from None
