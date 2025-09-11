from flask import Blueprint, request, jsonify
from datetime import datetime
import json
from db import get_conn

bp = Blueprint("chats", __name__, url_prefix="/local")


def _now():
    return datetime.utcnow().isoformat() + "Z"


@bp.get("/chats")
def list_chats():
    with get_conn() as conn:
        rows = conn.execute("SELECT id, name FROM chats ORDER BY id DESC").fetchall()
        return jsonify([dict(r) for r in rows])


@bp.post("/chats")
def create_chat():
    data = request.get_json(silent=True) or {}
    name = data.get("name") or "New chat"
    state = json.dumps(data.get("state") or {})
    now = _now()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO chats (name, state, created_at, updated_at) VALUES (?,?,?,?)",
            (name, state, now, now),
        )
        chat_id = cur.lastrowid
        conn.commit()
    return jsonify({"id": chat_id, "name": name, "state": json.loads(state)})


@bp.get("/chats/<int:chat_id>/messages")
def list_messages(chat_id):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, role, content, params, attachments, created_at FROM messages WHERE chat_id=? ORDER BY id",
            (chat_id,),
        ).fetchall()
        res = []
        for r in rows:
            item = dict(r)
            for f in ("params", "attachments"):
                if item.get(f):
                    try:
                        item[f] = json.loads(item[f])
                    except json.JSONDecodeError:
                        item[f] = None
            res.append(item)
        return jsonify(res)


@bp.post("/chats/<int:chat_id>/messages")
def add_message(chat_id):
    data = request.get_json(silent=True) or {}
    role = data.get("role", "user")
    content = data.get("content", "")
    params = json.dumps(data.get("params") or {})
    attachments = json.dumps(data.get("attachments") or [])
    now = _now()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO messages (chat_id, role, content, params, attachments, created_at) VALUES (?,?,?,?,?,?)",
            (chat_id, role, content, params, attachments, now),
        )
        msg_id = cur.lastrowid
        conn.commit()
    return jsonify({"id": msg_id})
