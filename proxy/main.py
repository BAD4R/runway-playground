# proxy/main.py
# Flask proxy for Runway API with proper CORS preflight handling, verbose logging,
# and multi-file upload endpoint for transfer.sh.
# Run:  python main.py
# Listens: http://localhost:5100
# Proxies: /api/*  -> https://api.dev.runwayml.com/v1/*
# - Authorization is taken from client's header (you enter key on the site)
# - X-Runway-Version kept or defaulted to 2024-11-06
# - OPTIONS handled LOCALLY (204) to avoid upstream 401 on CORS preflight
# - Verbose logging; Authorization redacted in logs

from flask import Flask, request, Response, jsonify, make_response
from werkzeug.utils import secure_filename
import requests
import logging
import sys
from datetime import datetime

UPSTREAM = "https://api.dev.runwayml.com/v1"
DEFAULT_API_VERSION = "2024-11-06"
READ_LOG_BODY_LIMIT = 4096  # bytes

app = Flask(__name__)

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

# ---------- File upload (multi) ----------
@app.route("/file/upload", methods=["POST", "OPTIONS"])
def file_upload():
    """
    Accepts multipart/form-data:
      - "files": <file>, "files": <file>, ...
      or single "file": <file>
    Uploads each file to transfer.sh with PUT /<filename>.
    Returns: { "urls": ["https://transfer.sh/<random>/<filename>", ...] }
    """
    # CORS preflight locally
    if request.method == "OPTIONS":
        resp = make_response("", 204)
        for k, v in cors_headers().items():
            resp.headers[k] = v
        return resp

    files = request.files.getlist("files")
    if not files:
        single = request.files.get("file")
        if single:
            files = [single]
    if not files:
        return jsonify({"error": "no_files", "message": "Provide one or multiple 'files' fields"}), 400

    urls = []
    for f in files:
        filename = secure_filename(f.filename or "file.bin")
        try:
            # transfer.sh supports PUT to /<filename>; response body is the public URL
            r = requests.put(f"https://transfer.sh/{filename}", data=f.stream, timeout=120)
            if r.status_code in (200, 201):
                urls.append(r.text.strip())
            else:
                return jsonify({"error": "upload_failed", "status": r.status_code, "body": r.text[:300]}), 502
        except requests.RequestException as e:
            return jsonify({"error": "upload_error", "message": str(e)}), 502

    return jsonify({"urls": urls})

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
        r = requests.request(
            method=method,
            url=upstream_url,
            params=request.args,
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

if __name__ == "__main__":
    logger.info("▶️  Flask proxy listening on http://localhost:5100")
    logger.info("    Forwarding /api/* -> %s/*", UPSTREAM)
    logger.info("    /file/upload handles multiple files and CORS preflight")
    logger.info("    Client must send Authorization: Bearer <RUNWAY_API_KEY>")
    app.run(host="0.0.0.0", port=5100, debug=False)
