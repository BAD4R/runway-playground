# proxy/main.py
# Flask proxy for Runway API with proper CORS preflight handling and verbose logging.
# Run:  python main.py
# Listens: http://localhost:5100
# Proxies: /api/*  -> https://api.dev.runwayml.com/v1/*
# - Authorization is taken from client's header (you enter key on the site)
# - X-Runway-Version kept or defaulted to 2024-11-06
# - OPTIONS handled LOCALLY (204) to avoid upstream 401 on CORS preflight
# - Verbose logging; Authorization redacted in logs

from flask import Flask, request, Response, jsonify, make_response, send_from_directory
import requests
import logging
import sys
from datetime import datetime
from pathlib import Path

from chat_routes import bp as chat_bp

UPSTREAM = "https://api.dev.runwayml.com/v1"
DEFAULT_API_VERSION = "2024-11-06"
READ_LOG_BODY_LIMIT = 4096  # bytes

app = Flask(__name__)
CLIENT_DIR = Path(__file__).resolve().parent.parent / "client"
app.register_blueprint(chat_bp)

# ---------- Logging ----------
logger = logging.getLogger("runway_proxy")
logger.setLevel(logging.INFO)
handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | %(message)s"))
logger.addHandler(handler)

def redact_auth(hdr: str) -> str:
    if not hdr:
        return hdr
    parts = hdr.split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        tok = parts[1]
        return f"Bearer ****{tok[-4:]}" if len(tok) > 8 else "Bearer ****"
    return hdr

def dump_headers_for_log(headers):
    return {k: (redact_auth(v) if k.lower() == "authorization" else v) for k, v in headers.items()}

def log_request(req):
    if req.args.get("no_log"):
        return
    try:
        body = req.get_data(cache=True)
    except Exception:
        body = b""
    preview = (body[:READ_LOG_BODY_LIMIT]).decode("utf-8", errors="replace") if body else ""
    logger.info(
        "REQ %s %s%s | args=%s | headers=%s | body=%s",
        req.method,
        req.path,
        f"?{req.query_string.decode()}" if req.query_string else "",
        dict(req.args),
        dump_headers_for_log(dict(req.headers)),
        preview,
    )

def log_response(status_code, headers, content):
    if request.args.get("no_log"):
        return
    try:
        preview = (content[:READ_LOG_BODY_LIMIT]).decode("utf-8", errors="replace")
    except Exception:
        preview = "<unreadable>"
    key_hdrs = {k.lower(): v for k, v in headers.items()}
    brief = {k: key_hdrs[k] for k in ["content-type", "content-length", "date"] if k in key_hdrs}
    logger.info("RES %s | headers=%s | body=%s", status_code, brief, preview)

# ---------- CORS helpers ----------
def cors_headers():
    origin = request.headers.get("Origin", "*")
    allow_headers = request.headers.get(
        "Access-Control-Request-Headers",
        "Authorization, Content-Type, X-Runway-Version",
    )
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": allow_headers,
        "Vary": "Origin",
    }

@app.after_request
def add_cors(resp):
    # Add CORS headers to every response
    for k, v in cors_headers().items():
        resp.headers[k] = v
    return resp

# ---------- Health ----------
@app.get("/health")
def health():
    return jsonify({"ok": True, "time": datetime.utcnow().isoformat() + "Z"})

# ---------- Proxy helpers ----------
def _build_upstream_url(path: str) -> str:
    path = path.lstrip("/")
    return f"{UPSTREAM}/{path}"

# ---------- Runway proxy ----------
@app.route("/api/<path:full_path>", methods=["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"])
def proxy(full_path):
    # Handle CORS preflight locally
    if request.method == "OPTIONS":
        logger.info("Handling CORS preflight locally for /api/%s", full_path)
        resp = make_response("", 204)
        for k, v in cors_headers().items():
            resp.headers[k] = v
        return resp

    # Log incoming request
    log_request(request)

    upstream_url = _build_upstream_url(full_path)

    # Prepare headers for upstream
    headers = {}
    # Authorization from client
    auth = request.headers.get("Authorization", "")
    if auth:
        headers["Authorization"] = auth
    # X-Runway-Version
    api_ver = request.headers.get("X-Runway-Version", DEFAULT_API_VERSION)
    headers["X-Runway-Version"] = api_ver
    # Content-Type if present
    if request.headers.get("Content-Type"):
        headers["Content-Type"] = request.headers["Content-Type"]

    method = request.method.upper()
    try:
        params = dict(request.args)
        params.pop("no_log", None)
        r = requests.request(
            method=method,
            url=upstream_url,
            params=params,
            data=(request.get_data() if method not in ("GET", "HEAD", "DELETE") else None),
            headers=headers,
            timeout=120,
        )
    except requests.RequestException as e:
        logger.error("Upstream request error: %s", e)
        # Build error response with CORS
        resp = jsonify({"error": "proxy_error", "message": str(e)})
        resp.status_code = 502
        return resp

    # Log upstream response
    log_response(r.status_code, r.headers, r.content or b"")

    # Build response
    resp = Response(
        response=r.content,
        status=r.status_code,
        headers={"Content-Type": r.headers.get("Content-Type", "application/octet-stream")},
    )
    # CORS headers added by after_request
    return resp

# ---------- Client files ----------
@app.route("/", defaults={"path": "index.html"}, methods=["GET"])
@app.route("/<path:path>", methods=["GET"])
def client_files(path):
    target = CLIENT_DIR / path
    if target.is_dir():
        path = f"{path.rstrip('/')}/index.html"
    return send_from_directory(CLIENT_DIR, path)

if __name__ == "__main__":
    logger.info("▶️  Flask proxy listening on http://localhost:5100")
    logger.info("    Forwarding /api/* -> %s/*", UPSTREAM)
    logger.info("    Client must send Authorization: Bearer <RUNWAY_API_KEY>")
    app.run(host="0.0.0.0", port=5100, debug=False)
