"""Disposable browser-test API with real JWT verification and PostgreSQL.

Not an application entry point. Requires explicit disposable-cluster opt-in.
Ephemeral signed sessions live only in TEMP; no auth bypass enters app code.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Request
import httpx
import jwt
import psycopg
from psycopg import sql
import uvicorn

from backend.api.app import create_app
from backend.api.auth import TokenVerifier
from backend.api.config import Settings, ScanSettings
from backend.api.vision import OllamaAdapter


def main():
    if os.environ.get('POWERSHIFT_NATIVE_TESTS') != '1':
        raise RuntimeError('Explicit disposable native-test mode is required')
    admin_url = os.environ['POWERSHIFT_TEST_DATABASE_URL']
    session_path = Path(os.environ['POWERSHIFT_BROWSER_SESSION_FILE']).resolve()
    import tempfile
    if session_path.parent != Path(tempfile.gettempdir()).resolve() or not session_path.name.startswith('powershift-m6-browser-'):
        raise RuntimeError('Browser session file must be a generated TEMP file')
    name = 'powershift_m6_browser_' + uuid4().hex
    login = 'powershift_m6_login_' + uuid4().hex[:16]
    password, stop_key = uuid4().hex, uuid4().hex
    source = urlsplit(admin_url)
    admin = psycopg.connect(admin_url, autocommit=True)
    database_created, role_created = False, False
    server = None
    try:
        if admin.execute("SELECT 1 FROM pg_roles WHERE rolname IN ('powershift_app','m4_migration_owner')").fetchone():
            raise RuntimeError('Reserved test roles already exist; refusing to modify them')
        admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
        database_created = True
        migration_url = urlunsplit((source.scheme, source.netloc, '/' + name, source.query, ''))
        result = subprocess.run(['node', 'tools/db/migrate-postgres.cjs'], cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, 'POWERSHIFT_MIGRATION_DATABASE_URL': migration_url}, capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError('Browser fixture migration failed')
        admin.execute(sql.SQL('CREATE ROLE {} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD {}')
                      .format(sql.Identifier(login), sql.Literal(password)))
        role_created = True
        admin.execute(sql.SQL('GRANT powershift_app TO {}').format(sql.Identifier(login)))
        runtime_url = urlunsplit((source.scheme, f'{login}:{password}@{source.hostname}:{source.port or 5432}', '/' + name, source.query, ''))
        issuer, client_id, audience = 'https://identity.example.test/', 'powershift-browser-client', 'powershift-browser-api'
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
        public.update(kid='browser-test-key', alg='RS256', use='sig')
        now = int(time.time())
        token = jwt.encode({'iss': issuer, 'sub': 'browser-owner', 'aud': audience, 'iat': now, 'exp': now + 3600}, key,
                           algorithm='RS256', headers={'kid': 'browser-test-key'})
        settings = Settings(runtime_url, issuer, audience, issuer + 'jwks', requests_per_minute=10000, pool_size=3,
                            scan=ScanSettings(provider='ollama'))
        verifier = TokenVerifier(settings, httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={'keys': [public]}))))
        # Browser fixtures exercise real scan orchestration/database/validation,
        # but deliberately mock local model transport. This is not an accuracy test.
        def local_model(request):
            if request.url.path == '/api/show':
                return httpx.Response(200, json={'capabilities': ['vision']})
            return httpx.Response(200, json={'done': True, 'message': {'content': json.dumps({
                'power_status': 'clear_watts', 'candidate': {'name': 'Scanned fan', 'brand': None,
                    'model': None, 'watts': 60, 'voltage': '230 V', 'current': None,
                    'kwh_per_day': None, 'notes': 'Review this synthetic test candidate.',
                    'visible_evidence': 'Input power 60 W'}})}})
        scanner = OllamaAdapter(settings.scan, httpx.Client(base_url=settings.scan.base_url,
            transport=httpx.MockTransport(local_model)))
        app = create_app(settings, verifier=verifier, scanner=scanner)

        @app.post('/__test/shutdown')
        def stop(request: Request):
            if request.headers.get('x-test-stop') == stop_key and server:
                server.should_exit = True
            return {'ok': True}

        session_path.write_text(json.dumps({'authority': issuer, 'clientId': client_id, 'stopKey': stop_key,
            'user': {'access_token': token, 'token_type': 'Bearer', 'scope': 'openid profile email', 'expires_at': now + 3600,
                     'profile': {'iss': issuer, 'sub': 'browser-owner', 'aud': client_id, 'iat': now, 'exp': now + 3600}}}), encoding='utf8')
        server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=8787, access_log=False, log_level='warning'))
        server.run()
    finally:
        session_path.unlink(missing_ok=True)
        if database_created:
            if not name.startswith('powershift_m6_browser_'):
                raise RuntimeError('Unexpected test database')
            admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
        if role_created:
            admin.execute(sql.SQL('DROP ROLE {}').format(sql.Identifier(login)))
        if database_created:
            admin.execute('DROP ROLE IF EXISTS powershift_app')
        admin.close()


if __name__ == '__main__':
    main()
