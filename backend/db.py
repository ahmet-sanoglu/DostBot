# PostgreSQL bağlantı katmanı — JSON dosya I/O yerine kalıcı, eşzamanlı güvenli depolama.
# Neden ORM yok? Mevcut Flask API şekli (camelCase dict) korunacak; Model/Session katmanı
# ek karmaşa getirirdi. SQLAlchemy yalnızca Engine + text() ile havuz ve parametre bağlama sağlar.

import os
from contextlib import contextmanager
from typing import Optional

from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()

_engine: Optional[Engine] = None


def get_engine() -> Engine:
    """Tekil Engine — uygulama ömrü boyunca aynı havuz (her istekte yeni bağlantı maliyeti olmasın)."""
    global _engine
    if _engine is None:
        if not DATABASE_URL:
            raise RuntimeError("DATABASE_URL is not set in environment")
        # pool_pre_ping: uzun idle sonrası kopuk socket'i yenile (aksi halde ilk sorgu hata verir)
        _engine = create_engine(
            DATABASE_URL,
            pool_size=5,
            max_overflow=5,
            pool_pre_ping=True,
        )
    return _engine


@contextmanager
def db_conn(*, commit=False):
    """
    Havuzdan bağlantı al; iş bitince bırak.
    commit=True: yazma işlemlerinde tek transaction (kısmi yazım kalmasın).
    """
    engine = get_engine()
    if commit:
        with engine.begin() as conn:
            yield conn
    else:
        with engine.connect() as conn:
            yield conn


def execute(conn, sql, params=None):
    """Ham SQL + named params — string birleştirme yok (SQL injection'a karşı)."""
    return conn.execute(text(sql), params or {})
