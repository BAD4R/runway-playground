import sqlite3
from pathlib import Path
DB_PATH = Path(__file__).resolve().parent.parent / "chat.db"


def get_conn():
    need_init = not DB_PATH.exists()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    if need_init:
        conn.execute(
            """
            CREATE TABLE chats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                state TEXT,
                created_at TEXT,
                updated_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id INTEGER,
                role TEXT,
                content TEXT,
                params TEXT,
                attachments TEXT,
                created_at TEXT
            )
            """
        )
        conn.commit()
    return conn


def init_db():
    """Ensure database file and tables exist."""
    conn = get_conn()
    conn.close()

