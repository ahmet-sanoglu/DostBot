# DostBot web arayüzünün veri katmanı.
# Robotla doğrudan konuşmaz; harita görüntüsü diskten, görev/sınır/yasak bölge
# PostgreSQL'den okunur/yazılır. Flask bu dosyayı "REST API sunucusu" olarak çalıştırır.
#
# Neden JSON → PostgreSQL? Dosya yazımında yarış/yarım JSON ve eşzamanlı panel
# yazımları riskliydi; DB transaction + CASCADE ilişkiler güvenilir kalıcılık sağlar.
# API sözleşmesi (camelCase) aynı kaldı — frontend değişmeden satır→dict çevirisi burada.
# Konumlar (locations) kaldırıldı — rota noktaları artık görev steps içinde tutulur;
# ayrı locations.json /locationId senkronu yoktu, çift kaynak sapması ve UI karmaşası yaratıyordu.

import json
import os
import re
import secrets
import socket
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

import cv2
import yaml
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory
from flask_cors import CORS

from convert_map import convert_pgm_to_png
from db import db_conn, execute  # ham SQL; ORM yok — mevcut jsonify şekli korunur

# Ana sera haritası — silinemez; yanlışlıkla silinirse operatör/mühendis paneli veri kaybeder.
PROTECTED_MAP_ID = "map_default"

# .env dosyasındaki ADMIN_PIN gibi gizli ayarları belleğe yükler.
load_dotenv()

app = Flask(__name__)


def _ensure_task_history_run_id_column():
    """
    Mevcut DB'de run_id yoksa ekle.
    Neden startup'ta? CREATE TABLE IF NOT EXISTS eski tablolara sütun eklemez;
    migration dosyasını elle çalıştırmadan da GET/POST kırılmasın.
    """
    try:
        with db_conn(commit=True) as conn:
            execute(
                conn,
                "ALTER TABLE task_history ADD COLUMN IF NOT EXISTS run_id TEXT",
            )
            execute(
                conn,
                "CREATE INDEX IF NOT EXISTS idx_task_history_run ON task_history(map_id, run_id)",
            )
    except Exception as exc:
        # Sunucu ayağa kalksın; POST run_id yazamazsa log'dan görünür
        print(f"[schema] task_history.run_id migration skipped: {exc}")


_ensure_task_history_run_id_column()

# Tarayıcıdaki React uygulamasının (localhost:5173) bu sunucuya istek atabilmesi için CORS açılır.
# X-Admin-Pin başlığına izin verilir; mühendis paneli yazma işlemlerinde bunu gönderir.
CORS(
    app,
    resources={r"/api/*": {
        "origins": "http://localhost:5173",
        "allow_headers": ["Content-Type", "X-Admin-Pin"],
    }},
)

# ROS'tan üretilen occupancy grid haritasının diskteki klasörü (PNG + YAML burada).
MAP_DIR = os.getenv("MAP_DIRECTORY", os.path.expanduser("~/AgriFleet/agriculture_map1"))
# Harita kimliğinde sadece harf, rakam, tire ve alt çizgiye izin verilir (path injection önlemi).
MAP_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")
ADMIN_PIN = os.getenv("ADMIN_PIN", "")
# RTSP kamera URL — boşsa /api/camera/stream 503; tarayıcı native RTSP oynatamadığı için MJPEG gerekir.
CAMERA_RTSP_URL = os.getenv("CAMERA_RTSP_URL", "")
# sim = web_video_server (:8080 /camera/image_raw); real = RTSP proxy (/api/camera/stream)
_CAMERA_MODE_RAW = os.getenv("CAMERA_MODE", "real").strip().lower()
CAMERA_MODE = "sim" if _CAMERA_MODE_RAW in {"sim", "simulation"} else "real"

# Görev geçmişi — nav_relay/Nav2'dan bağımsız yan log; UI modalı okur.
TASK_HISTORY_MAX = 200
TASK_HISTORY_STATUSES = {"başlatıldı", "başarılı", "iptal edildi", "başarısız"}


def _fmt_ts(dt):
    """DB TIMESTAMPTZ → API'nin beklediği Z-suffixed ISO (eski JSON damgası ile uyum)."""
    if dt is None:
        return None
    if isinstance(dt, str):
        return dt.strip()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_ts(raw):
    """İstemciden gelen timestamp string'ini doğrular; geçersizse None."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    return raw.strip()


def _map_row_to_api(row):
    """snake_case satır → camelCase (imageDir/isActive); React tarafı sütun adı bilmez."""
    return {
        "id": row["id"],
        "name": row["name"],
        "imageDir": row["image_dir"],
        "isActive": bool(row["is_active"]),
        "createdAt": _fmt_ts(row["created_at"]),
    }


def _load_maps():
    """Tüm harita kayıtlarını liste olarak döner."""
    with db_conn() as conn:
        result = execute(
            conn,
            "SELECT id, name, image_dir, is_active, created_at FROM maps ORDER BY created_at",
        )
        return [_map_row_to_api(row) for row in result.mappings().all()]


def _validate_map_id(map_id):
    """Harita kimliğinin güvenli karakterlerden oluşup oluşmadığını kontrol eder."""
    if not map_id or not MAP_ID_PATTERN.match(map_id):
        return False
    return True


def _find_map(map_id):
    """Verilen kimliğe sahip harita kaydını arar."""
    with db_conn() as conn:
        result = execute(
            conn,
            "SELECT id, name, image_dir, is_active, created_at FROM maps WHERE id = :id",
            {"id": map_id},
        )
        row = result.mappings().first()
        return _map_row_to_api(row) if row else None


def _get_active_map_entry():
    """is_active=true olan ilk harita kaydını döner."""
    with db_conn() as conn:
        result = execute(
            conn,
            "SELECT id, name, image_dir, is_active, created_at FROM maps WHERE is_active = TRUE LIMIT 1",
        )
        row = result.mappings().first()
        return _map_row_to_api(row) if row else None


def _require_map(map_id):
    """
    Harita kimliğini doğrular; yoksa (None, HTTP_yanıt_demeti) döner.
    Görev/sınır endpoint'lerinde ortak 400/404 kontrolü.
    """
    if not _validate_map_id(map_id):
        return None, (jsonify({"error": "Invalid map id"}), 400)
    entry = _find_map(map_id)
    if not entry:
        return None, (jsonify({"error": "Map not found"}), 404)
    return entry, None


def _active_image_dir():
    """
    Aktif haritanın imageDir yolunu döner.
    Kayıtta imageDir yoksa MAP_DIRECTORY ortam değişkenine düşer (eski kurulumlar).
    """
    active = _get_active_map_entry()
    if active:
        image_dir = active.get("imageDir")
        if isinstance(image_dir, str) and image_dir.strip():
            return os.path.expanduser(image_dir.strip())
    return MAP_DIR


def _find_map_yaml(image_dir):
    """
    Harita YAML dosyasını bulur.
    map_from_bag.yaml önce denenir: mevcut map_default (agriculture_map1) davranışı bozulmasın diye.
    Yeni haritalarda yalnızca map.yaml vardır.
    """
    for name in ("map_from_bag.yaml", "map.yaml"):
        path = os.path.join(image_dir, name)
        if os.path.isfile(path):
            return path
    return None


def _find_map_png(image_dir):
    """PNG görüntüsünü bulur; map_from_bag.png öncelikli (geriye dönük uyumluluk)."""
    for name in ("map_from_bag.png", "map.png"):
        path = os.path.join(image_dir, name)
        if os.path.isfile(path):
            return path
    return None


def _verify_admin_pin():
    """
    İstek başlığındaki X-Admin-Pin değerini .env'deki ADMIN_PIN ile karşılaştırır.
    NOT: Bu gerçek bir kimlik doğrulama (auth) sistemi değildir; oturum, token veya
    şifreleme içermez. Yalnızca mühendis panelinde yanlışlıkla veri silmeyi/değiştirmeyi
    engelleyen basit bir PIN katmanıdır. Üretim ortamında tek başına güvenlik sağlamaz.
    """
    if not ADMIN_PIN:
        return False
    supplied = request.headers.get("X-Admin-Pin", "")
    return supplied == ADMIN_PIN


def _require_admin():
    """
    Yazma/silme endpoint'lerinin başında çağrılır; PIN yanlışsa 401 Unauthorized döner.
    Doğruysa None döner ve işleme devam edilir.
    """
    if not _verify_admin_pin():
        return jsonify({"error": "Unauthorized"}), 401
    return None


def _normalize_step_action(raw):
    """
    Bir navigasyon adımına varıldığında çalışacak eylemi doğrular; geçersiz/eksikse wait'a düşer.
    Görev sonunda tek eylem yerine step başına action kullanılır — aynı rotada bir noktada
    sürüm, diğerinde bekleme gibi çoklu tarla/çoklu eylem senaryoları tanımlanabilsin diye.
    Tür anlamları (NavigationContext her adım sonrası buna göre dal seçer):
      wait — hemen sıradaki adıma geç veya görevi bitir
      till — bu noktada Toprağı Sür (coverage) ROS akışı
      goto_charge / goto_base — henüz ROS'a bağlı değil (şimdilik uyarı + geç)
    """
    valid_types = {"wait", "till", "goto_charge", "goto_base"}
    if not isinstance(raw, dict):
        return {"type": "wait"}
    action_type = raw.get("type")
    if action_type not in valid_types:
        return {"type": "wait"}
    return {"type": action_type}


def _normalize_task(raw):
    """
    İstemciden gelen görev verisini doğrular: ad + en az bir adım (x, y, yaw, action).
    Üst seviye finalAction kaldırıldı — eylem görev bitince değil, varılan her noktada
    ayrı tanımlanır; NavigationContext zinciri step.action üzerinden ilerler.
    Opsiyonel: description (metin), pinned (bool, varsayılan false).
    """
    if not isinstance(raw, dict):
        return None
    name = raw.get("name")
    steps = raw.get("steps")
    if not isinstance(name, str) or not name.strip():
        return None
    if not isinstance(steps, list) or len(steps) == 0:
        return None

    normalized_steps = []
    for step in steps:
        if not isinstance(step, dict):
            return None
        x, y, yaw = step.get("x"), step.get("y"), step.get("yaw")
        if not all(isinstance(v, (int, float)) for v in (x, y, yaw)):
            return None
        normalized_steps.append({
            "x": float(x),
            "y": float(y),
            "yaw": float(yaw),
            "action": _normalize_step_action(step.get("action")),
        })

    description = raw.get("description")
    if description is not None and not isinstance(description, str):
        return None

    # pinned: Kontrol Paneli'nde sık görevleri üste sabitlemek için.
    pinned = raw.get("pinned", False)
    if not isinstance(pinned, bool):
        pinned = bool(pinned)

    task = {
        "id": raw.get("id") or f"task_{uuid.uuid4().hex[:8]}",
        "name": name.strip(),
        "steps": normalized_steps,
        "pinned": pinned,
    }
    if isinstance(description, str) and description.strip():
        task["description"] = description.strip()
    return task


def _normalize_boundary_points(raw):
    """
    Geofence poligonu için gelen nokta listesini doğrular.
    Her nokta {x, y} içermeli; en az 3 nokta geofence oluşturmak için yeterlidir.
    """
    if isinstance(raw, dict):
        raw = raw.get("points")
    if not isinstance(raw, list):
        return None
    points = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        x, y = item.get("x"), item.get("y")
        if isinstance(x, (int, float)) and isinstance(y, (int, float)):
            points.append({"x": float(x), "y": float(y)})
    return points


def _jsonb_to_points(raw):
    """JSONB sütununu liste olarak okur; sürücü string veya dict/list dönebilir."""
    if raw is None:
        return None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return None
    if isinstance(raw, dict):
        return raw.get("points")
    return raw


def _fetch_task_steps(conn, task_id):
    """Görev adımlarını step_order sırasıyla API formatında döner."""
    result = execute(
        conn,
        """
        SELECT x, y, yaw, action_type
        FROM task_steps
        WHERE task_id = :task_id
        ORDER BY step_order
        """,
        {"task_id": task_id},
    )
    steps = []
    for row in result.mappings().all():
        steps.append({
            "x": float(row["x"]),
            "y": float(row["y"]),
            "yaw": float(row["yaw"]),
            "action": {"type": row["action_type"] or "wait"},
        })
    return steps


def _task_row_to_api(row, steps):
    """tasks satırı + adımlar → eski JSON görev şekli (camelCase); UI sözleşmesi bozulmasın."""
    task = {
        "id": row["id"],
        "name": row["name"],
        "steps": steps,
        "pinned": bool(row["pinned"]),
    }
    description = row.get("description")
    if isinstance(description, str) and description.strip():
        task["description"] = description.strip()
    return task


def _insert_task_steps(conn, task_id, steps):
    """Görev adımlarını task_steps tablosuna yazar."""
    for order, step in enumerate(steps):
        execute(
            conn,
            """
            INSERT INTO task_steps (task_id, step_order, x, y, yaw, action_type)
            VALUES (:task_id, :step_order, :x, :y, :yaw, :action_type)
            """,
            {
                "task_id": task_id,
                "step_order": order,
                "x": step["x"],
                "y": step["y"],
                "yaw": step["yaw"],
                "action_type": step["action"]["type"],
            },
        )


def _list_map_tasks(conn, map_id):
    """Haritaya ait tüm görevleri adımlarıyla birlikte listeler."""
    result = execute(
        conn,
        """
        SELECT id, name, description, pinned
        FROM tasks
        WHERE map_id = :map_id
        ORDER BY created_at
        """,
        {"map_id": map_id},
    )
    tasks = []
    for row in result.mappings().all():
        steps = _fetch_task_steps(conn, row["id"])
        tasks.append(_task_row_to_api(row, steps))
    return tasks


def _zone_row_to_api(row):
    """forbidden_zones satırını camelCase API nesnesine çevirir."""
    return {
        "id": row["id"],
        "name": row["name"],
        "xMin": float(row["x_min"]),
        "xMax": float(row["x_max"]),
        "yMin": float(row["y_min"]),
        "yMax": float(row["y_max"]),
    }


def _normalize_forbidden_zone(raw):
    """
    Yasak dikdörtgen doğrular: name + xMin<xMax, yMin<yMax (hepsi sayı).
    Geofence poligonundan farklı — birden fazla dikdörtgen tutulabilir; id yoksa üretilir.
    """
    if not isinstance(raw, dict):
        return None
    name = raw.get("name")
    x_min, x_max = raw.get("xMin"), raw.get("xMax")
    y_min, y_max = raw.get("yMin"), raw.get("yMax")
    if not isinstance(name, str) or not name.strip():
        return None
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (x_min, x_max, y_min, y_max)):
        return None
    if not (x_min < x_max and y_min < y_max):
        return None
    return {
        "id": raw.get("id") or f"zone_{uuid.uuid4().hex[:8]}",
        "name": name.strip(),
        "xMin": float(x_min),
        "xMax": float(x_max),
        "yMin": float(y_min),
        "yMax": float(y_max),
    }


def _trim_task_history(conn, map_id):
    """Harita başına en fazla TASK_HISTORY_MAX — sınırsız büyüme / modal şişmesini önler."""
    # İç içe SELECT: PostgreSQL, silinen tabloyu doğrudan alt sorguda referanslamaya izin vermez
    execute(
        conn,
        """
        DELETE FROM task_history
        WHERE map_id = :map_id
          AND id NOT IN (
            SELECT id FROM (
              SELECT id FROM task_history
              WHERE map_id = :map_id
              ORDER BY timestamp DESC
              LIMIT :limit
            ) keep_rows
          )
        """,
        {"map_id": map_id, "limit": TASK_HISTORY_MAX},
    )


# GET /api/map/metadata — Herkese açık. Operatör + mühendis paneli.
# Aktif haritanın imageDir'indeki YAML'dan resolution/origin okunur.
@app.route('/api/map/metadata', methods=['GET'])
def get_map_metadata():
    image_dir = _active_image_dir()
    yaml_path = _find_map_yaml(image_dir)
    if not yaml_path:
        return jsonify({"error": "Map metadata not found"}), 404

    try:
        with open(yaml_path, 'r') as f:
            data = yaml.safe_load(f)

        return jsonify({
            "resolution": data.get("resolution", 0.1),
            "origin": data.get("origin", [0.0, 0.0, 0.0])
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# GET /api/map/image — Herkese açık. Operatör + mühendis paneli.
# Aktif haritanın imageDir'indeki PNG'yi tarayıcıya gönderir.
@app.route('/api/map/image', methods=['GET'])
def get_map_image():
    image_dir = _active_image_dir()
    png_path = _find_map_png(image_dir)
    if not png_path:
        return jsonify({"error": "Map image (PNG) not found. Run conversion script first."}), 404

    return send_from_directory(image_dir, os.path.basename(png_path))


# POST /api/admin/verify-pin — Herkese açık (PIN bilmeden çağrılabilir, ama doğru PIN gerekir).
# Mühendis paneli giriş ekranında kullanılır; PIN doğruysa frontend sessionStorage'a kaydeder.
# Sonraki yazma isteklerinde aynı PIN, X-Admin-Pin başlığıyla gönderilir.
@app.route('/api/admin/verify-pin', methods=['POST'])
def verify_admin_pin():
    payload = request.get_json(silent=True) or {}
    pin = payload.get("pin", "")
    if not ADMIN_PIN:
        return jsonify({"error": "Admin PIN not configured"}), 500
    if pin == ADMIN_PIN:
        return jsonify({"valid": True})
    return jsonify({"valid": False, "error": "Invalid PIN"}), 401


# GET /api/maps — Herkese açık. Mühendis paneli harita seçici listesi.
# Tüm harita kayıtlarını döner (aktif + pasif).
@app.route('/api/maps', methods=['GET'])
def list_maps():
    return jsonify(_load_maps())


# POST /api/maps — PIN korumalı. Yeni sera/simülasyon haritası kaydı.
# Neden: tek sabit MAP_DIRECTORY yetmez; her haritanın kendi imageDir'i olmalı.
# Otomatik aktive edilmez — mühendis bilerek switch etsin, operatör aniden boş haritaya düşmesin.
@app.route('/api/maps', methods=['POST'])
def create_map():
    denied = _require_admin()
    if denied:
        return denied

    payload = request.get_json(silent=True) or {}
    name = payload.get("name")
    source_dir = payload.get("sourceDir")

    if not isinstance(name, str) or not name.strip():
        return jsonify({"error": "name is required"}), 400
    if not isinstance(source_dir, str) or not source_dir.strip():
        return jsonify({"error": "sourceDir is required"}), 400

    source_dir = os.path.expanduser(source_dir.strip())
    if not os.path.isdir(source_dir):
        return jsonify({"error": "sourceDir does not exist or is not a directory"}), 400

    yaml_path = os.path.join(source_dir, "map.yaml")
    pgm_path = os.path.join(source_dir, "map.pgm")
    png_path = os.path.join(source_dir, "map.png")

    if not os.path.isfile(yaml_path):
        return jsonify({"error": "map.yaml not found in sourceDir"}), 400
    if not os.path.isfile(pgm_path) and not os.path.isfile(png_path):
        return jsonify({"error": "map.pgm or map.png required in sourceDir"}), 400

    # PNG yoksa PGM'den üret — tarayıcı PNG ister; sabit agriculture_map1 yolu yok (çoklu harita).
    if not os.path.isfile(png_path):
        try:
            convert_pgm_to_png(pgm_path, png_path)
        except Exception as e:
            return jsonify({"error": f"Failed to convert PGM to PNG: {e}"}), 500

    map_id = f"map_{secrets.token_hex(4)}"
    # Çakışma çok düşük ihtimal; yine de benzersiz olduğundan emin ol.
    while _find_map(map_id):
        map_id = f"map_{secrets.token_hex(4)}"

    created_at = datetime.now(timezone.utc)
    with db_conn(commit=True) as conn:
        execute(
            conn,
            """
            INSERT INTO maps (id, name, image_dir, is_active, created_at)
            VALUES (:id, :name, :image_dir, FALSE, :created_at)
            """,
            {
                "id": map_id,
                "name": name.strip(),
                "image_dir": source_dir,
                "created_at": created_at,
            },
        )

    entry = {
        "id": map_id,
        "name": name.strip(),
        "imageDir": source_dir,
        "isActive": False,
        "createdAt": _fmt_ts(created_at),
    }
    return jsonify(entry), 201


# PUT /api/maps/<map_id>/activate — PIN korumalı.
# Tek aktif harita kuralı: metadata/image + tasks hep aynı kayıttan gelsin; iki aktif = karışık UI.
@app.route('/api/maps/<map_id>/activate', methods=['PUT'])
def activate_map(map_id):
    denied = _require_admin()
    if denied:
        return denied

    if not _validate_map_id(map_id):
        return jsonify({"error": "Invalid map id"}), 400

    with db_conn(commit=True) as conn:
        result = execute(conn, "SELECT id FROM maps WHERE id = :id", {"id": map_id})
        if not result.mappings().first():
            return jsonify({"error": "Map not found"}), 404

        execute(conn, "UPDATE maps SET is_active = FALSE WHERE is_active = TRUE")
        execute(conn, "UPDATE maps SET is_active = TRUE WHERE id = :id", {"id": map_id})

    return jsonify({"id": map_id, "isActive": True})


# DELETE /api/maps/<map_id> — PIN korumalı.
# Aktif harita silinmez: panel anında boş/404'e düşmesin. map_default silinmez: ana sera yedeği kalsın.
# imageDir silinmez: diskteki SLAM çıktısı elle temizlenir; CASCADE yalnızca DB kayıtlarını kaldırır.
@app.route('/api/maps/<map_id>', methods=['DELETE'])
def delete_map(map_id):
    denied = _require_admin()
    if denied:
        return denied

    if not _validate_map_id(map_id):
        return jsonify({"error": "Invalid map id"}), 400

    if map_id == PROTECTED_MAP_ID:
        return jsonify({"error": "map_default cannot be deleted"}), 400

    entry = _find_map(map_id)
    if not entry:
        return jsonify({"error": "Map not found"}), 404

    if entry.get("isActive") is True:
        return jsonify({
            "error": "Aktif haritayı silemezsiniz, önce başka bir haritayı aktive edin",
        }), 400

    with db_conn(commit=True) as conn:
        execute(conn, "DELETE FROM maps WHERE id = :id", {"id": map_id})

    return jsonify({"deleted": map_id})


# GET /api/maps/active — Herkese açık. Operatör + mühendis paneli.
# isActive=true olan tek haritanın kimliğini ve adını döner.
@app.route('/api/maps/active', methods=['GET'])
def get_active_map():
    active = _get_active_map_entry()
    if not active:
        return jsonify({"error": "No active map configured"}), 404

    return jsonify({
        "id": active.get("id"),
        "name": active.get("name"),
    })


# GET /api/maps/<map_id>/tasks — Herkese açık. Operatör + mühendis paneli.
# Görev listesini döner (tek adımlı / çok adımlı).
@app.route('/api/maps/<map_id>/tasks', methods=['GET'])
def get_map_tasks(map_id):
    _, error = _require_map(map_id)
    if error:
        return error

    with db_conn() as conn:
        return jsonify(_list_map_tasks(conn, map_id))


# POST /api/maps/<map_id>/tasks — PIN korumalı. Yalnızca mühendis paneli.
# Rota görevi ekler (tek veya çok adımlı; X/Y/Yaw doğrudan görevde tutulur).
@app.route('/api/maps/<map_id>/tasks', methods=['POST'])
def add_map_task(map_id):
    auth_error = _require_admin()
    if auth_error:
        return auth_error

    payload = request.get_json(silent=True)
    task = _normalize_task(payload)
    if task is None:
        return jsonify({"error": "Expected {name, steps: [{x,y,yaw}, ...]}"}), 400

    _, error = _require_map(map_id)
    if error:
        return error

    with db_conn(commit=True) as conn:
        result = execute(conn, "SELECT id FROM tasks WHERE id = :id", {"id": task["id"]})
        if result.mappings().first():
            task["id"] = f"task_{uuid.uuid4().hex[:8]}"

        execute(
            conn,
            """
            INSERT INTO tasks (id, map_id, name, description, pinned)
            VALUES (:id, :map_id, :name, :description, :pinned)
            """,
            {
                "id": task["id"],
                "map_id": map_id,
                "name": task["name"],
                "description": task.get("description"),
                "pinned": task["pinned"],
            },
        )
        _insert_task_steps(conn, task["id"], task["steps"])

    return jsonify(task), 201


# Mühendis paneli: görev adı, adımları (step başına action) ve açıklamayı günceller.
# Operatör paneli aynı PUT ile pinned toggle eder — ayrı endpoint yok; içerik değişmezse PIN gerekmez
# (operatör PIN bilmeden sabitleyebilsin, görev içeriğini ise mühendis PIN'i olmadan değiştiremesin).
# PUT /api/maps/<map_id>/tasks/<task_id>
@app.route('/api/maps/<map_id>/tasks/<task_id>', methods=['PUT'])
def update_map_task(map_id, task_id):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Expected JSON body"}), 400

    _, error = _require_map(map_id)
    if error:
        return error

    with db_conn() as conn:
        result = execute(
            conn,
            "SELECT id, name, description, pinned FROM tasks WHERE id = :task_id AND map_id = :map_id",
            {"task_id": task_id, "map_id": map_id},
        )
        row = result.mappings().first()
        if not row:
            return jsonify({"error": "Task not found"}), 404

        existing_steps = _fetch_task_steps(conn, task_id)
        existing = _task_row_to_api(row, existing_steps)

    # Mühendis kaydı pinned göndermezse mevcut sabitleme sıfırlanmasın (AddTaskModal alanı yok)
    if "pinned" not in payload:
        payload = {**payload, "pinned": bool(existing.get("pinned", False))}

    task = _normalize_task({**payload, "id": task_id})
    if task is None:
        return jsonify({"error": "Expected {name, steps: [{x,y,yaw}, ...]}"}), 400

    auth_error = _require_admin()
    if auth_error:
        # PIN yoksa yalnızca pinned farkına izin — name/steps değişimi hâlâ mühendis işi
        existing_norm = _normalize_task({**existing, "id": task_id})
        if existing_norm is None:
            return auth_error
        content_same = (
            existing_norm["name"] == task["name"]
            and existing_norm["steps"] == task["steps"]
            and existing_norm.get("description") == task.get("description")
        )
        if not content_same:
            return auth_error

    with db_conn(commit=True) as conn:
        execute(
            conn,
            """
            UPDATE tasks
            SET name = :name, description = :description, pinned = :pinned
            WHERE id = :task_id AND map_id = :map_id
            """,
            {
                "task_id": task_id,
                "map_id": map_id,
                "name": task["name"],
                "description": task.get("description"),
                "pinned": task["pinned"],
            },
        )
        execute(conn, "DELETE FROM task_steps WHERE task_id = :task_id", {"task_id": task_id})
        _insert_task_steps(conn, task_id, task["steps"])

    return jsonify(task)


# Mühendis paneli: görevi kalıcı olarak kaldırır.
# DELETE /api/maps/<map_id>/tasks/<task_id> — PIN korumalı. Yalnızca mühendis paneli.
@app.route('/api/maps/<map_id>/tasks/<task_id>', methods=['DELETE'])
def delete_map_task(map_id, task_id):
    auth_error = _require_admin()
    if auth_error:
        return auth_error

    _, error = _require_map(map_id)
    if error:
        return error

    with db_conn(commit=True) as conn:
        result = execute(
            conn,
            "DELETE FROM tasks WHERE id = :task_id AND map_id = :map_id RETURNING id",
            {"task_id": task_id, "map_id": map_id},
        )
        if not result.mappings().first():
            return jsonify({"error": "Task not found"}), 404

    return jsonify({"ok": True})


# GET /api/maps/<map_id>/task-history — Herkese açık.
# Ham olayları (başlatıldı + sonuç) tek "run" nesnesine birleştirir — UI gün/durum gruplaması için.
TERMINAL_HISTORY_STATUSES = {"başarılı", "iptal edildi", "başarısız"}
# Sonuçsuz "başlatıldı" bu süreden eskiyse "devam ediyor" değil "yarım kaldı" (sunucu kesintisi / eski test).
RUNNING_MAX_AGE_SECONDS = 10 * 60


def _parse_iso_ts(value):
    """ISO / TIMESTAMPTZ → aware UTC datetime; süre hesabı için."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if isinstance(value, str):
        raw = value.strip()
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(raw)
        except ValueError:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    return None


def _open_history_run(task_name, started, *, now):
    """
    Sonuçsuz başlatıldı → devam ediyor / yarım kaldı.
    Neden yaş eşiği? Restart/test orphan'ları "şu an çalışıyor" sanılmasın.
    """
    age_seconds = (now - started).total_seconds()
    if age_seconds <= RUNNING_MAX_AGE_SECONDS:
        return {
            "taskName": task_name,
            "startedAt": _fmt_ts(started),
            "endedAt": None,
            "finalStatus": "devam ediyor",
            "durationSeconds": None,
        }
    return {
        "taskName": task_name,
        "startedAt": _fmt_ts(started),
        "endedAt": None,
        "finalStatus": "yarım kaldı",
        "durationSeconds": max(0, int(age_seconds)),
    }


def _merge_task_history_fifo(entries, *, now):
    """
    Legacy: run_id yokken aynı task_name + kronolojik FIFO.
    Yalnızca migration öncesi satırlar için; yeni kayıtlar run_id kullanır.
    Neden tutuluyor? Eski JSON→PG verisi silinmeden UI boşalmasın.
    """
    chronological = sorted(
        entries,
        key=lambda e: (_parse_iso_ts(e.get("timestamp")) or datetime.min.replace(tzinfo=timezone.utc)),
    )
    pending_starts = {}
    runs = []

    for entry in chronological:
        task_name = entry.get("taskName") or ""
        status = entry.get("status")
        ts = _parse_iso_ts(entry.get("timestamp"))
        if not task_name or ts is None:
            continue

        if status == "başlatıldı":
            pending_starts.setdefault(task_name, []).append(ts)
            continue

        if status in TERMINAL_HISTORY_STATUSES:
            starts = pending_starts.get(task_name) or []
            if starts:
                started = starts.pop(0)
                duration = max(0, int((ts - started).total_seconds()))
                runs.append({
                    "taskName": task_name,
                    "startedAt": _fmt_ts(started),
                    "endedAt": _fmt_ts(ts),
                    "finalStatus": status,
                    "durationSeconds": duration,
                })
            else:
                runs.append({
                    "taskName": task_name,
                    "startedAt": _fmt_ts(ts),
                    "endedAt": _fmt_ts(ts),
                    "finalStatus": status,
                    "durationSeconds": 0,
                })

    for task_name, starts in pending_starts.items():
        for started in starts:
            runs.append(_open_history_run(task_name, started, now=now))

    return runs


def _merge_task_history_by_run_id(entries, *, now):
    """
    Aynı run_id altındaki başlatıldı + terminal → tek run.
    Neden FIFO değil? Orphan start sonraki başarılıyı çalıyordu (off-by-one);
    UUID ile her navigasyon run'ı izole kalır.
    """
    by_run = {}
    for entry in entries:
        run_id = entry.get("runId")
        if not run_id:
            continue
        by_run.setdefault(run_id, []).append(entry)

    runs = []
    for run_id, events in by_run.items():
        events_sorted = sorted(
            events,
            key=lambda e: (_parse_iso_ts(e.get("timestamp")) or datetime.min.replace(tzinfo=timezone.utc)),
        )
        starts = [e for e in events_sorted if e.get("status") == "başlatıldı"]
        terminals = [
            e for e in events_sorted
            if e.get("status") in TERMINAL_HISTORY_STATUSES
        ]

        task_name = ""
        for e in events_sorted:
            if e.get("taskName"):
                task_name = e["taskName"]
                break
        if not task_name:
            continue

        start_ts = _parse_iso_ts(starts[0].get("timestamp")) if starts else None
        term = terminals[0] if terminals else None
        term_ts = _parse_iso_ts(term.get("timestamp")) if term else None

        if start_ts and term_ts:
            duration = max(0, int((term_ts - start_ts).total_seconds()))
            runs.append({
                "taskName": task_name,
                "startedAt": _fmt_ts(start_ts),
                "endedAt": _fmt_ts(term_ts),
                "finalStatus": term.get("status"),
                "durationSeconds": duration,
                "runId": run_id,
            })
        elif start_ts and not term_ts:
            run = _open_history_run(task_name, start_ts, now=now)
            run["runId"] = run_id
            runs.append(run)
        elif term_ts and not start_ts:
            # Yetim terminal (accepted öncesi estop vb.)
            runs.append({
                "taskName": task_name,
                "startedAt": _fmt_ts(term_ts),
                "endedAt": _fmt_ts(term_ts),
                "finalStatus": term.get("status"),
                "durationSeconds": 0,
                "runId": run_id,
            })

    return runs


def _merge_task_history_runs(entries, *, now=None):
    """
    run_id varsa ona göre birleştir; yoksa (eski satırlar) task_name FIFO.
    Neden iki yol? Yeni istemci UUID gönderir; migration öncesi satırlar NULL kalır.
    Eşleşmeyen başlatıldı:
      - startedAt son RUNNING_MAX_AGE_SECONDS içindeyse → 'devam ediyor'
      - daha eskiyse → 'yarım kaldı'
    Dönüş: en yeni run önce (startedAt DESC).
    """
    if now is None:
        now = datetime.now(timezone.utc)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    else:
        now = now.astimezone(timezone.utc)

    with_run_id = []
    without_run_id = []
    for entry in entries:
        rid = entry.get("runId")
        if isinstance(rid, str) and rid.strip():
            with_run_id.append(entry)
        else:
            without_run_id.append(entry)

    runs = _merge_task_history_by_run_id(with_run_id, now=now)
    runs.extend(_merge_task_history_fifo(without_run_id, now=now))

    runs.sort(
        key=lambda r: (_parse_iso_ts(r.get("startedAt")) or datetime.min.replace(tzinfo=timezone.utc)),
        reverse=True,
    )
    return runs


# GET /api/maps/<map_id>/task-history — Herkese açık.
# Ham olayları run'a birleştirir (run_id tercihli; yoksa FIFO) — UI Kanban için.
# Neden birleştirme GET'te? POST fire-and-forget kalsın; yazım yolu nav'ı bekletmesin.
@app.route('/api/maps/<map_id>/task-history', methods=['GET'])
def get_map_task_history(map_id):
    _, error = _require_map(map_id)
    if error:
        return error

    with db_conn() as conn:
        result = execute(
            conn,
            """
            SELECT task_name, status, timestamp, run_id
            FROM task_history
            WHERE map_id = :map_id
            ORDER BY timestamp ASC
            """,
            {"map_id": map_id},
        )
        entries = []
        for row in result.mappings().all():
            entry = {
                "taskName": row["task_name"],
                "status": row["status"],
                "timestamp": _fmt_ts(row["timestamp"]),
            }
            if row["run_id"]:
                entry["runId"] = row["run_id"]
            entries.append(entry)
    return jsonify(_merge_task_history_runs(entries))


# POST /api/maps/<map_id>/task-history — PIN yok: operatör paneli fire-and-forget loglar.
# Neden ayrı endpoint? Nav durum makinesine bağlanmadan denetim izi tutmak için.
# Ham olay yazar (başlatıldı/başarılı/…); birleştirme yalnızca GET'te yapılır.
@app.route('/api/maps/<map_id>/task-history', methods=['POST'])
def add_map_task_history(map_id):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Expected JSON body"}), 400

    task_name = payload.get("taskName")
    status = payload.get("status")
    if not isinstance(task_name, str) or not task_name.strip():
        return jsonify({"error": "Expected taskName string"}), 400
    if status not in TASK_HISTORY_STATUSES:
        return jsonify({
            "error": "Expected status one of: başlatıldı, başarılı, iptal edildi, başarısız",
        }), 400

    timestamp = _parse_ts(payload.get("timestamp"))
    if timestamp is None:
        timestamp = _fmt_ts(datetime.now(timezone.utc))

    # runId opsiyonel: eski istemci / yetim terminal; max 128 — rastgele UUID yeter, abuse sınırı
    run_id_raw = payload.get("runId")
    run_id = None
    if isinstance(run_id_raw, str) and run_id_raw.strip():
        run_id = run_id_raw.strip()[:128]

    _, error = _require_map(map_id)
    if error:
        return error

    entry = {
        "taskName": task_name.strip(),
        "status": status,
        "timestamp": timestamp,
    }
    if run_id:
        entry["runId"] = run_id

    with db_conn(commit=True) as conn:
        execute(
            conn,
            """
            INSERT INTO task_history (map_id, task_name, status, timestamp, run_id)
            VALUES (:map_id, :task_name, :status, CAST(:timestamp AS timestamptz), :run_id)
            """,
            {
                "map_id": map_id,
                "task_name": entry["taskName"],
                "status": entry["status"],
                "timestamp": entry["timestamp"],
                "run_id": run_id,
            },
        )
        _trim_task_history(conn, map_id)

    return jsonify(entry), 201


# GET /api/maps/<map_id>/boundary — Herkese açık. Operatör + mühendis paneli.
# Geofence poligonunu döner; sınır çizilmemişse null (operatör hedef kontrolünde sınır atlanır).
@app.route('/api/maps/<map_id>/boundary', methods=['GET'])
def get_map_boundary(map_id):
    _, error = _require_map(map_id)
    if error:
        return error

    with db_conn() as conn:
        result = execute(
            conn,
            "SELECT points FROM boundaries WHERE map_id = :map_id",
            {"map_id": map_id},
        )
        row = result.mappings().first()

    if not row:
        return jsonify(None)

    points = _normalize_boundary_points(_jsonb_to_points(row["points"]))
    if not points or len(points) < 3:
        return jsonify(None)
    return jsonify({"points": points})


# POST /api/maps/<map_id>/boundary — PIN korumalı. Yalnızca mühendis paneli.
# Mühendis panelinde çizilen geofence sınırını kaydeder (robot bu alan dışına gitmemeli).
@app.route('/api/maps/<map_id>/boundary', methods=['POST'])
def save_map_boundary(map_id):
    auth_error = _require_admin()
    if auth_error:
        return auth_error

    _, error = _require_map(map_id)
    if error:
        return error

    payload = request.get_json(silent=True)
    points = _normalize_boundary_points(payload)
    if points is None or len(points) < 3:
        return jsonify({"error": "Boundary requires at least 3 {x, y} points"}), 400

    with db_conn(commit=True) as conn:
        execute(
            conn,
            """
            INSERT INTO boundaries (map_id, points)
            VALUES (:map_id, CAST(:points AS jsonb))
            ON CONFLICT (map_id) DO UPDATE SET points = CAST(:points AS jsonb)
            """,
            {"map_id": map_id, "points": json.dumps({"points": points})},
        )

    return jsonify({"points": points})


# DELETE /api/maps/<map_id>/boundary — PIN korumalı. Yalnızca mühendis paneli.
# Geofence sınırını kaldırır; sonrasında hedef kontrolünde yalnızca harita pikseli + yasak bölgeler kalır.
@app.route('/api/maps/<map_id>/boundary', methods=['DELETE'])
def delete_map_boundary(map_id):
    auth_error = _require_admin()
    if auth_error:
        return auth_error

    _, error = _require_map(map_id)
    if error:
        return error

    with db_conn(commit=True) as conn:
        execute(conn, "DELETE FROM boundaries WHERE map_id = :map_id", {"map_id": map_id})

    return jsonify({"ok": True})


# GET /api/maps/<map_id>/forbidden-zones — Herkese açık. Operatör + mühendis paneli.
# Operatör panelinde hedef seçilirken kontrol edilen dikdörtgen yasak bölgeleri listeler.
@app.route('/api/maps/<map_id>/forbidden-zones', methods=['GET'])
def get_map_forbidden_zones(map_id):
    _, error = _require_map(map_id)
    if error:
        return error

    with db_conn() as conn:
        result = execute(
            conn,
            """
            SELECT id, name, x_min, x_max, y_min, y_max
            FROM forbidden_zones
            WHERE map_id = :map_id
            ORDER BY name
            """,
            {"map_id": map_id},
        )
        zones = [_zone_row_to_api(row) for row in result.mappings().all()]

    return jsonify(zones)


# POST /api/maps/<map_id>/forbidden-zones — PIN korumalı. Yalnızca mühendis paneli.
# Yeni dikdörtgen yasak bölge ekler; operatör hedef kontrolünde isPointInForbiddenZone ile kullanılır.
@app.route('/api/maps/<map_id>/forbidden-zones', methods=['POST'])
def add_map_forbidden_zone(map_id):
    auth_error = _require_admin()
    if auth_error:
        return auth_error

    payload = request.get_json(silent=True)
    zone = _normalize_forbidden_zone(payload)
    if zone is None:
        return jsonify({"error": "Expected {name, xMin, xMax, yMin, yMax} with xMin<xMax and yMin<yMax"}), 400

    _, error = _require_map(map_id)
    if error:
        return error

    with db_conn(commit=True) as conn:
        result = execute(conn, "SELECT id FROM forbidden_zones WHERE id = :id", {"id": zone["id"]})
        if result.mappings().first():
            zone["id"] = f"zone_{uuid.uuid4().hex[:8]}"

        execute(
            conn,
            """
            INSERT INTO forbidden_zones (id, map_id, name, x_min, x_max, y_min, y_max)
            VALUES (:id, :map_id, :name, :x_min, :x_max, :y_min, :y_max)
            """,
            {
                "id": zone["id"],
                "map_id": map_id,
                "name": zone["name"],
                "x_min": zone["xMin"],
                "x_max": zone["xMax"],
                "y_min": zone["yMin"],
                "y_max": zone["yMax"],
            },
        )

    return jsonify(zone), 201


# DELETE /api/maps/<map_id>/forbidden-zones/<zone_id> — PIN korumalı. Yalnızca mühendis paneli.
# Tek bir yasak dikdörtgeni listeden çıkarır.
@app.route('/api/maps/<map_id>/forbidden-zones/<zone_id>', methods=['DELETE'])
def delete_map_forbidden_zone(map_id, zone_id):
    auth_error = _require_admin()
    if auth_error:
        return auth_error

    if not _validate_map_id(map_id):
        return jsonify({"error": "Invalid map id"}), 400

    _, error = _require_map(map_id)
    if error:
        return error

    with db_conn(commit=True) as conn:
        result = execute(
            conn,
            """
            DELETE FROM forbidden_zones
            WHERE id = :zone_id AND map_id = :map_id
            RETURNING id
            """,
            {"zone_id": zone_id, "map_id": map_id},
        )
        if not result.mappings().first():
            return jsonify({"error": "Forbidden zone not found"}), 404

    return jsonify({"ok": True})


def generate_camera_frames(cap):
    """
    Açık VideoCapture'tan MJPEG multipart kare üretir; bitince cap.release().
    Neden MJPEG? Tarayıcı <img> RTSP oynatamaz; multipart JPEG her kareyi gösterebilir.
    """
    try:
        while True:
            success, frame = cap.read()
            if not success:
                break
            ret, buffer = cv2.imencode('.jpg', frame)
            if not ret:
                continue
            frame_bytes = buffer.tobytes()
            yield (
                b'--frame\r\n'
                b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n'
            )
    finally:
        cap.release()


def is_rtsp_reachable(rtsp_url, timeout=2):
    """
    TCP host:port hızlı erişim testi.
    Neden? cv2.VideoCapture kapalı kamerada onlarca sn asılı kalabiliyor;
    2 sn socket ile erken 503 → frontend onError, sekme 'yükleniyor'da kilitlenmesin.
    """
    try:
        parsed = urlparse(rtsp_url)
        host = parsed.hostname
        if not host:
            return False
        port = parsed.port or 554
        sock = socket.create_connection((host, port), timeout=timeout)
        sock.close()
        return True
    except Exception:
        return False


# GET /api/camera/mode — Frontend hangi akış URL'sini kullanacağını öğrenir (sim vs real).
# Neden ayrı endpoint? CAMERA_MODE yalnızca sunucu .env'de; tarayıcıya sızdırmadan okunsun.
@app.route('/api/camera/mode', methods=['GET'])
def camera_mode():
    return jsonify({"mode": CAMERA_MODE})


# GET /api/camera/stream — RTSP → MJPEG.
# Neden bu endpoint? Operatör/mühendis paneli <img> ile canlı izler; native RTSP yok.
# 503 zorunlu: boş generator tarayıcıyı sonsuza bekletirdi; onError tetiklensin.
@app.route('/api/camera/stream')
def camera_stream():
    if not CAMERA_RTSP_URL:
        return jsonify({"error": "Kamera yapilandirilmamis"}), 503

    # OpenCV öncesi ucuz başarısızlık — uzun VideoCapture timeout'unu atla
    if not is_rtsp_reachable(CAMERA_RTSP_URL):
        return jsonify({"error": "Kameraya baglanilamadi (erisilemiyor)"}), 503

    cap = cv2.VideoCapture(CAMERA_RTSP_URL)
    if not cap.isOpened():
        cap.release()
        return jsonify({"error": "Kameraya baglanilamadi"}), 503

    return Response(
        generate_camera_frames(cap),
        mimetype='multipart/x-mixed-replace; boundary=frame',
    )


if __name__ == '__main__':
    # Geliştirme ortamında doğrudan çalıştırma: python app.py
    app.run(host='0.0.0.0', port=5000, debug=True)
