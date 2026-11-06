#!/usr/bin/env python3
"""Local, read-only dashboard server for the Garmin Connect Personal API.

Runs only on 127.0.0.1. The API key stays in a file readable only by you, the
access token stays in memory, and the browser never receives either one.

macOS's built-in Python cannot complete a TLS handshake with Garmin, so upstream
requests go through curl. Secrets are passed on stdin, which keeps them out of
the process list.
"""

import argparse
import base64
import json
import os
import re
import subprocess
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_URL = "https://personal.connectapi.garmin.com"
TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token"
KEY_FILE = Path("~/.config/garmin/connect-personal-api-key").expanduser()
APP_DIR = Path(__file__).resolve().parent
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
}
SERVICES = (
    "usersummary-service|goal-service|weight-service|nutrition-service|userprofile-service|"
    "sleep-service|wellness-service|hrv-service|biometric-service|fitnessage-service|"
    "periodichealth-service|wellnessactivity-service|activitylist-service|activity-service|"
    "download-service"
)
SAFE_PATH = re.compile(r"^/(?:%s)/[A-Za-z0-9_\-./]*(?:\?[A-Za-z0-9_\-.=&%%]*)?$" % SERVICES)
SAFE_KEY = re.compile(r"^[A-Za-z0-9_.+/=\-]{20,512}$")
SAFE_TOKEN = re.compile(r"^[A-Za-z0-9_.\-]+$")
CACHE_SECONDS = 300
CACHE_MAX_ENTRIES = 500
TOKEN_REFRESH_MARGIN_SECONDS = 3600
MAX_UPSTREAM_CONCURRENCY = 4
MAX_KEY_BODY_BYTES = 2048

CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; "
    "frame-ancestors 'none'"
)


class UpstreamError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def curl(path, method, authorization, accept):
    """Call Garmin and return (status, body). Raises UpstreamError on network failure."""
    config = "\n".join(
        [
            'url = "%s%s"' % (BASE_URL, path),
            'request = "%s"' % method,
            'header = "Authorization: %s"' % authorization,
            'header = "Accept: %s"' % accept,
            "silent",
            "max-time = 90",
            'write-out = "\\n%{http_code}"',
        ]
    )
    result = subprocess.run(["curl", "--config", "-"], input=config.encode(), capture_output=True)
    if result.returncode != 0:
        raise UpstreamError(502, "Could not reach Garmin (curl exit %d)." % result.returncode)
    body, _, status = result.stdout.rpartition(b"\n")
    return int(status or 0), body


def jwt_expiry(token):
    try:
        payload = token.split(".")[1]
        decoded = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
        return float(json.loads(decoded)["exp"])
    except (IndexError, KeyError, TypeError, ValueError):
        return time.time() + 3600


class Garmin:
    """Holds the access token and a short-lived response cache in memory."""

    def __init__(self):
        self.lock = threading.Lock()
        self.token = None
        self.token_expires_at = 0.0
        self.cache = {}
        self.upstream_slots = threading.BoundedSemaphore(MAX_UPSTREAM_CONCURRENCY)

    def read_key(self):
        try:
            return KEY_FILE.read_text(encoding="utf-8").strip() or None
        except FileNotFoundError:
            return None

    def exchange(self, key):
        if not SAFE_KEY.match(key):
            raise UpstreamError(400, "That doesn't look like a Garmin Personal API key.")
        status, body = curl(TOKEN_PATH, "POST", "ApiKey " + key, "*/*")
        if status in (400, 401, 403):
            raise UpstreamError(401, "Garmin rejected the API key (HTTP %d). It may be expired or deleted." % status)
        if status != 200:
            raise UpstreamError(502, "Garmin's token service returned HTTP %d." % status)
        token = body.decode("ascii", "replace").strip()
        if not SAFE_TOKEN.match(token):
            raise UpstreamError(502, "Garmin's token service returned an unexpected response.")
        return token, jwt_expiry(token)

    def get_token(self, force=False):
        with self.lock:
            fresh = self.token and self.token_expires_at - time.time() > TOKEN_REFRESH_MARGIN_SECONDS
            if fresh and not force:
                return self.token
            key = self.read_key()
            if not key:
                raise UpstreamError(401, "No API key saved yet.")
            self.token, self.token_expires_at = self.exchange(key)
            return self.token

    def save_key(self, key):
        """Validate a key against Garmin, then store it atomically with owner-only access."""
        token, expires_at = self.exchange(key)
        KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(KEY_FILE.parent, 0o700)
        temp = KEY_FILE.with_name(KEY_FILE.name + ".tmp")
        descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(key)
        os.replace(temp, KEY_FILE)
        with self.lock:
            self.token, self.token_expires_at = token, expires_at
            self.cache.clear()

    def clear_cache(self):
        with self.lock:
            self.cache.clear()

    def fetch(self, path):
        is_download = path.startswith("/download-service/")
        accept = "application/zip, application/x-zip-compressed, application/octet-stream" if is_download else "application/json"
        with self.lock:
            hit = self.cache.get(path)
        if hit and hit[0] > time.time():
            return hit[1], hit[2]
        with self.upstream_slots:
            status, body = curl(path, "GET", "Bearer " + self.get_token(), accept)
            if status == 401:
                status, body = curl(path, "GET", "Bearer " + self.get_token(force=True), accept)
        if status in (200, 204) and not is_download:
            with self.lock:
                if len(self.cache) >= CACHE_MAX_ENTRIES:
                    self.cache.clear()
                self.cache[path] = (time.time() + CACHE_SECONDS, status, body)
        return status, body


GARMIN = Garmin()


class Handler(BaseHTTPRequestHandler):
    server_version = "GarminDashboard"
    sys_version = ""

    def log_message(self, *args):
        pass

    def host_allowed(self):
        # Rejecting other Host values stops DNS-rebinding sites from reading local data.
        port = self.server.server_address[1]
        return self.headers.get("Host") in ("127.0.0.1:%d" % port, "localhost:%d" % port)

    def origin_allowed(self):
        origin = self.headers.get("Origin")
        return origin is None or origin == "http://" + self.headers.get("Host", "")

    def send_bytes(self, status, body, content_type, extra=None):
        self.send_response(status)
        if status != 204:
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CSP)
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if status != 204:
            self.wfile.write(body)

    def send_json(self, status, value):
        self.send_bytes(status, json.dumps(value).encode(), "application/json")

    def do_GET(self):
        if not self.host_allowed():
            return self.send_json(403, {"error": "Forbidden host"})
        route = self.path.split("?", 1)[0]
        if route in STATIC_FILES:
            name, content_type = STATIC_FILES[route]
            return self.send_bytes(200, (APP_DIR / name).read_bytes(), content_type)
        if route == "/api/status":
            return self.handle_status()
        if self.path.startswith("/api/garmin/"):
            return self.handle_proxy(self.path[len("/api/garmin"):])
        return self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if not self.host_allowed() or not self.origin_allowed():
            return self.send_json(403, {"error": "Forbidden origin"})
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return self.send_json(415, {"error": "JSON required"})
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_KEY_BODY_BYTES:
            return self.send_json(413, {"error": "Too large"})
        raw = self.rfile.read(length)
        if self.path == "/api/cache/clear":
            GARMIN.clear_cache()
            return self.send_json(200, {"ok": True})
        if self.path == "/api/key":
            return self.handle_save_key(raw)
        return self.send_json(404, {"error": "Not found"})

    def handle_status(self):
        info = {"keyPath": "~/.config/garmin/connect-personal-api-key", "hasKey": False, "ok": False}
        if not GARMIN.read_key():
            return self.send_json(200, info)
        info["hasKey"] = True
        try:
            GARMIN.get_token()
            info["ok"] = True
            info["tokenExpiresAt"] = GARMIN.token_expires_at
        except UpstreamError as error:
            info["error"] = error.message
        self.send_json(200, info)

    def handle_save_key(self, raw):
        try:
            key = str(json.loads(raw).get("key", "")).strip()
            GARMIN.save_key(key)
        except (ValueError, AttributeError):
            return self.send_json(400, {"error": "Invalid request."})
        except UpstreamError as error:
            return self.send_json(error.status, {"error": error.message})
        self.send_json(200, {"ok": True})

    def handle_proxy(self, path):
        if ".." in path or not SAFE_PATH.match(path):
            return self.send_json(400, {"error": "This path isn't one of the Garmin data services."})
        try:
            status, body = GARMIN.fetch(path)
        except UpstreamError as error:
            return self.send_json(error.status, {"error": error.message})
        if status == 204:
            return self.send_bytes(204, b"", "")
        if status != 200:
            detail = body.decode("utf-8", "replace")[:300]
            return self.send_json(status, {"error": "Garmin returned HTTP %d." % status, "detail": detail})
        if path.startswith("/download-service/"):
            activity_id = re.sub(r"\D", "", path)
            headers = {"Content-Disposition": 'attachment; filename="garmin-activity-%s.zip"' % activity_id}
            return self.send_bytes(200, body, "application/zip", headers)
        self.send_bytes(200, body or b"null", "application/json")


def main():
    parser = argparse.ArgumentParser(description="Local Garmin dashboard")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--open", action="store_true", help="open the dashboard in your browser")
    args = parser.parse_args()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError:
        raise SystemExit("Port %d is in use. Try: python3 server.py --port %d" % (args.port, args.port + 1))
    url = "http://127.0.0.1:%d/" % args.port
    print("Garmin dashboard running at %s  (press Ctrl+C to stop)" % url, flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
