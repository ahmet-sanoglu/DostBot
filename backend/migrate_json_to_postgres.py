#!/usr/bin/env python3
"""
Tek seferlik: backend/data/*.json → PostgreSQL.

Neden ayrı script? Canlı app.py okuma yolunu bozmadan bir kez aktarım yapmak;
başarısız denemelerde JSON yedek kalır, ON CONFLICT ile güvenli yeniden çalıştırılabilir.
Şemayı uygular (schema.sql), sonra harita/görev/zone/sınır/geçmiş aktarır.
"""

import json
import os
import sys
from datetime import datetime, timezone

from dotenv import load_dotenv
from sqlalchemy import text

# backend/ içinden çalıştırılsın
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BACKEND_DIR)

load_dotenv(os.path.join(BACKEND_DIR, ".env"))
load_dotenv()  # repo kökü .env de denensin

from db import get_engine  # noqa: E402

DATA_DIR = os.path.join(BACKEND_DIR, "data")
MAPS_FILE = os.path.join(DATA_DIR, "maps.json")
SCHEMA_FILE = os.path.join(BACKEND_DIR, "schema.sql")


def _read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _parse_ts(value):
    """ISO / Z damgasını datetime'a çevir; yoksa now()."""
    if not value or not isinstance(value, str):
        return datetime.now(timezone.utc)
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return datetime.now(timezone.utc)


def apply_schema(conn):
    with open(SCHEMA_FILE, "r", encoding="utf-8") as f:
        sql = f.read()
    # Satır yorumlarını çıkar; sürücü tek execute'ta çoklu ifadeyi her zaman çalıştırmaz
    lines = []
    for line in sql.splitlines():
        if line.strip().startswith("--"):
            continue
        lines.append(line)
    cleaned = "\n".join(lines)
    for statement in cleaned.split(";"):
        stmt = statement.strip()
        if stmt:
            conn.execute(text(stmt))
    print("✓ schema.sql uygulandı")


def migrate():
    # maps.json indeks; her map_id altında tasks/zones/boundary/history JSON'ları vardı
    maps = _read_json(MAPS_FILE, default=[])
    if not isinstance(maps, list):
        maps = []

    counts = {
        "maps": 0,
        "tasks": 0,
        "task_steps": 0,
        "forbidden_zones": 0,
        "boundaries": 0,
        "task_history": 0,
    }

    engine = get_engine()
    # Tek transaction: yarıda kalırsa kısmi harita/görev yazılmasın
    with engine.begin() as conn:
        apply_schema(conn)

        for entry in maps:
            if not isinstance(entry, dict):
                continue
            map_id = entry.get("id")
            name = entry.get("name")
            image_dir = entry.get("imageDir")
            if not map_id or not name or not image_dir:
                print(f"  ! atlanan harita kaydı (eksik alan): {entry!r}")
                continue

            is_active = bool(entry.get("isActive", False))
            created_at = _parse_ts(entry.get("createdAt"))

            conn.execute(
                text(
                    """
                    INSERT INTO maps (id, name, image_dir, is_active, created_at)
                    VALUES (:id, :name, :image_dir, :is_active, :created_at)
                    ON CONFLICT (id) DO UPDATE SET
                        name = EXCLUDED.name,
                        image_dir = EXCLUDED.image_dir,
                        is_active = EXCLUDED.is_active,
                        created_at = EXCLUDED.created_at
                    """
                ),
                {
                    "id": map_id,
                    "name": name,
                    "image_dir": image_dir,
                    "is_active": is_active,
                    "created_at": created_at,
                },
            )
            counts["maps"] += 1

            map_dir = os.path.join(DATA_DIR, map_id)

            # --- tasks + steps ---
            tasks = _read_json(os.path.join(map_dir, "tasks.json"), default=[])
            if not isinstance(tasks, list):
                tasks = []
            for task in tasks:
                if not isinstance(task, dict):
                    continue
                task_id = task.get("id")
                task_name = task.get("name")
                if not task_id or not isinstance(task_name, str):
                    continue
                description = task.get("description")
                if not isinstance(description, str) or not description.strip():
                    description = None
                else:
                    description = description.strip()
                pinned = bool(task.get("pinned", False))

                conn.execute(
                    text(
                        """
                        INSERT INTO tasks (id, map_id, name, description, pinned)
                        VALUES (:id, :map_id, :name, :description, :pinned)
                        ON CONFLICT (id) DO UPDATE SET
                            map_id = EXCLUDED.map_id,
                            name = EXCLUDED.name,
                            description = EXCLUDED.description,
                            pinned = EXCLUDED.pinned
                        """
                    ),
                    {
                        "id": task_id,
                        "map_id": map_id,
                        "name": task_name,
                        "description": description,
                        "pinned": pinned,
                    },
                )
                counts["tasks"] += 1

                # Yeniden aktarımda eski adımları temizle (aksi halde çift / eski sıra kalır)
                conn.execute(
                    text("DELETE FROM task_steps WHERE task_id = :task_id"),
                    {"task_id": task_id},
                )

                steps = task.get("steps") if isinstance(task.get("steps"), list) else []
                for order, step in enumerate(steps):
                    if not isinstance(step, dict):
                        continue
                    x, y = step.get("x"), step.get("y")
                    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                        continue
                    yaw = step.get("yaw", 0.0)
                    if not isinstance(yaw, (int, float)):
                        yaw = 0.0
                    action = step.get("action") if isinstance(step.get("action"), dict) else {}
                    action_type = action.get("type", "wait")
                    if action_type not in {"wait", "till", "goto_charge", "goto_base"}:
                        action_type = "wait"

                    conn.execute(
                        text(
                            """
                            INSERT INTO task_steps
                                (task_id, step_order, x, y, yaw, action_type)
                            VALUES
                                (:task_id, :step_order, :x, :y, :yaw, :action_type)
                            """
                        ),
                        {
                            "task_id": task_id,
                            "step_order": order,
                            "x": float(x),
                            "y": float(y),
                            "yaw": float(yaw),
                            "action_type": action_type,
                        },
                    )
                    counts["task_steps"] += 1

            # --- forbidden zones ---
            zones = _read_json(os.path.join(map_dir, "forbidden_zones.json"), default=[])
            if not isinstance(zones, list):
                zones = []
            for zone in zones:
                if not isinstance(zone, dict):
                    continue
                zone_id = zone.get("id")
                zone_name = zone.get("name")
                if not zone_id or not isinstance(zone_name, str):
                    continue
                conn.execute(
                    text(
                        """
                        INSERT INTO forbidden_zones
                            (id, map_id, name, x_min, x_max, y_min, y_max)
                        VALUES
                            (:id, :map_id, :name, :x_min, :x_max, :y_min, :y_max)
                        ON CONFLICT (id) DO UPDATE SET
                            map_id = EXCLUDED.map_id,
                            name = EXCLUDED.name,
                            x_min = EXCLUDED.x_min,
                            x_max = EXCLUDED.x_max,
                            y_min = EXCLUDED.y_min,
                            y_max = EXCLUDED.y_max
                        """
                    ),
                    {
                        "id": zone_id,
                        "map_id": map_id,
                        "name": zone_name,
                        "x_min": zone.get("xMin"),
                        "x_max": zone.get("xMax"),
                        "y_min": zone.get("yMin"),
                        "y_max": zone.get("yMax"),
                    },
                )
                counts["forbidden_zones"] += 1

            # --- boundary ---
            boundary = _read_json(os.path.join(map_dir, "boundary.json"), default=None)
            points = None
            if isinstance(boundary, dict) and isinstance(boundary.get("points"), list):
                points = boundary["points"]
            elif isinstance(boundary, list):
                points = boundary
            if isinstance(points, list) and len(points) >= 3:
                conn.execute(
                    text(
                        """
                        INSERT INTO boundaries (map_id, points)
                        VALUES (:map_id, CAST(:points AS jsonb))
                        ON CONFLICT (map_id) DO UPDATE SET points = EXCLUDED.points
                        """
                    ),
                    {"map_id": map_id, "points": json.dumps(points)},
                )
                counts["boundaries"] += 1

            # --- task history ---
            history = _read_json(os.path.join(map_dir, "task_history.json"), default=[])
            if not isinstance(history, list):
                history = []
            # SERIAL id'li geçmiş: ON CONFLICT yok → yeniden çalıştırmada çift satır olmasın
            conn.execute(
                text("DELETE FROM task_history WHERE map_id = :map_id"),
                {"map_id": map_id},
            )
            for item in history:
                if not isinstance(item, dict):
                    continue
                task_name = item.get("taskName")
                status = item.get("status")
                if not isinstance(task_name, str) or not isinstance(status, str):
                    continue
                ts = _parse_ts(item.get("timestamp"))
                conn.execute(
                    text(
                        """
                        INSERT INTO task_history (map_id, task_name, status, timestamp)
                        VALUES (:map_id, :task_name, :status, :timestamp)
                        """
                    ),
                    {
                        "map_id": map_id,
                        "task_name": task_name,
                        "status": status,
                        "timestamp": ts,
                    },
                )
                counts["task_history"] += 1

            print(f"  → {map_id} ({name})")

    print("\n=== Migration özeti ===")
    for key, value in counts.items():
        print(f"  {key}: {value}")
    print("JSON dosyaları yerinde bırakıldı (yedek).")


if __name__ == "__main__":
    try:
        migrate()
    except Exception as exc:
        print(f"Migration başarısız: {exc}", file=sys.stderr)
        sys.exit(1)
