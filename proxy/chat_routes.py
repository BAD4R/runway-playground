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
    now = _now()
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO chats (name, state, created_at, updated_at) VALUES (?,?,?,?)",
            (name, json.dumps({}), now, now),
        )
        chat_id = cur.lastrowid
        conn.commit()
    return jsonify({"id": chat_id, "name": name})


@bp.get("/chats/<int:chat_id>")
def get_chat(chat_id):
    with get_conn() as conn:
        row = conn.execute("SELECT id,name,state FROM chats WHERE id=?", (chat_id,)).fetchone()
        if not row:
            return jsonify({"error": "not_found"}), 404
        data = dict(row)
        try:
            data["state"] = json.loads(data.get("state") or "{}")
        except json.JSONDecodeError:
            data["state"] = {}
        return jsonify(data)


@bp.patch("/chats/<int:chat_id>")
def update_chat(chat_id):
    data = request.get_json(silent=True) or {}
    name = data.get("name")
    state = data.get("state")
    now = _now()
    with get_conn() as conn:
        if name is not None:
            conn.execute(
                "UPDATE chats SET name=?, updated_at=? WHERE id=?", (name, now, chat_id)
            )
        if state is not None:
            conn.execute(
                "UPDATE chats SET state=?, updated_at=? WHERE id=?",
                (json.dumps(state), now, chat_id),
            )
        conn.commit()
    return jsonify({"ok": True})


@bp.delete("/chats/<int:chat_id>")
def delete_chat(chat_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM messages WHERE chat_id=?", (chat_id,))
        conn.execute("DELETE FROM chats WHERE id=?", (chat_id,))
        conn.commit()
    return ("", 204)


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

