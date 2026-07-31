# AgriFleet web arayüzünün veri katmanı.
# Robotla doğrudan konuşmaz; harita görüntüsü, görevler ve sınır bilgisini
# JSON dosyalarından okur/yazar. Flask bu dosyayı "REST API sunucusu" olarak çalıştırır.
# Konumlar (locations) kaldırıldı — rota noktaları artık görev steps içinde tutulur;
# ayrı locations.json /locationId senkronu yoktu, çift kaynak sapması ve UI karmaşası yaratıyordu.

import json
import os
import re
import secrets
import shutil
import socket
import tempfile
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse
from flask import Flask, Response, jsonify, request, send_from_directory
from flask_cors import CORS
import yaml
from dotenv import load_dotenv
import cv2

from convert_map import convert_pgm_to_png

# Ana sera haritası — silinemez; yanlışlıkla silinirse operatör/mühendis paneli veri kaybeder.
PROTECTED_MAP_ID = "map_default"

# .env dosyasındaki ADMIN_PIN gibi gizli ayarları belleğe yükler.
load_dotenv()

app = Flask(__name__)

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
# Görev/sınır gibi kullanıcı tanımlı verilerin tutulduğu klasör (backend/data/).
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
MAPS_FILE = os.path.join(DATA_DIR, "maps.json")
# Harita kimliğinde sadece harf, rakam, tire ve alt çizgiye izin verilir (path injection önlemi).
MAP_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")
ADMIN_PIN = os.getenv("ADMIN_PIN", "")
# RTSP kamera URL — boşsa /api/camera/stream 503; tarayıcı native RTSP oynatamadığı için MJPEG gerekir.
CAMERA_RTSP_URL = os.getenv("CAMERA_RTSP_URL", "")


def _read_json_file(path, default=None):
    """Diskteki bir JSON dosyasını okur; dosya yoksa default değeri döner."""
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_json_file(path, data):
    """
    Veriyi JSON olarak diske yazar; klasör yoksa önce oluşturur.

    Neden atomik (tmp + fsync + os.replace)?
    Doğrudan hedefe "r+"/seek yazımında yeni içerik kısaysa eski baytlar kalır
    (task_history.json sonunda fazladan ] gibi bozuk JSON).
    Önce tmp'ye "w" (truncate) yazıp replace etmek: yarım yazım hedefi bozmaz,
    kısa yeniden yazımda eski kuyruk kalmaz.
    """
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)

    # Aynı klasörde tmp — rename/replace aynı filesystem'de atomik olsun
    fd, tmp_path = tempfile.mkstemp(
        prefix=".tmp_",
        suffix=".json",
        dir=directory or None,
    )
    try:
        # "w": truncate; "a"/"r+" yok — eski içerik birikmesin
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())  # replace öncesi diske insin; crash'te yarım tmp kalsın, hedef bozulmasın
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _load_maps():
    """maps.json içindeki tüm harita kayıtlarını liste olarak döner."""
    maps = _read_json_file(MAPS_FILE, default=[])
    return maps if isinstance(maps, list) else []


def _validate_map_id(map_id):
    """Harita kimliğinin güvenli karakterlerden oluşup oluşmadığını kontrol eder."""
    if not map_id or not MAP_ID_PATTERN.match(map_id):
        return False
    return True


def _map_data_dir(map_id):
    """Belirli bir haritaya ait alt veri klasörünün yolunu döner (örn. data/map_default/)."""
    return os.path.join(DATA_DIR, map_id)


def _map_data_file(map_id, filename):
    """Harita klasörü içindeki tek bir dosyanın tam yolunu üretir (örn. tasks.json)."""
    return os.path.join(_map_data_dir(map_id), filename)


def _find_map(map_id):
    """maps.json kayıtları arasında verilen kimliğe sahip haritayı arar."""
    for entry in _load_maps():
        if entry.get("id") == map_id:
            return entry
    return None


def _get_active_map_entry():
    """maps.json içinde isActive: true olan ilk harita kaydını döner."""
    for entry in _load_maps():
        if entry.get("isActive") is True:
            return entry
    return None


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


def _save_maps(maps):
    """maps.json kaydını diske yazar."""
    _write_json_file(MAPS_FILE, maps)


def _read_map_data_file(map_id, filename):
    """
    Harita kimliğini doğrular, dosyayı okur ve liste formatında döner.
    Hata durumunda (None, HTTP_yanıt_demeti) çifti döner; çağıran fonksiyon bunu kontrol eder.
    """
    if not _validate_map_id(map_id):
        return None, (jsonify({"error": "Invalid map id"}), 400)
    if not _find_map(map_id):
        return None, (jsonify({"error": "Map not found"}), 404)

    path = _map_data_file(map_id, filename)
    data = _read_json_file(path, default=[])
    if not isinstance(data, list):
        return None, (jsonify({"error": f"Invalid {filename} format"}), 500)
    return data, None


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
    # Ayrı "favori" listesi tutmak yerine tasks.json'da kalır — harita değişince kaybolmaz.
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


def _boundary_file(map_id):
    """Geofence (izin verilen alan poligonu) dosyasının yolunu döner."""
    return _map_data_file(map_id, "boundary.json")


def _normalize_boundary_points(raw):
    """
    Geofence poligonu için gelen nokta listesini doğrular.
    Her nokta {x, y} içermeli; en az 3 nokta geofence oluşturmak için yeterlidir.
    """
    if isinstance(raw, dict):
        raw = raw.get("points")  # {"points": [...]} veya doğrudan liste kabul edilir
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
# Neden: tek sabit MAP_DIRECTORY yetmez; her haritanın kendi imageDir + data/<id>/ klasörü olmalı.
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

    data_dir = _map_data_dir(map_id)
    try:
        os.makedirs(data_dir, exist_ok=False)
    except FileExistsError:
        return jsonify({"error": "Map data directory already exists"}), 500

    # Görev/sınır verisi harita başına ayrı — başka haritanın kayıtları karışmasın.
    _write_json_file(_map_data_file(map_id, "tasks.json"), [])
    _write_json_file(_map_data_file(map_id, "forbidden_zones.json"), [])
    _write_json_file(_map_data_file(map_id, "boundary.json"), None)
    # Boş geçmiş: GET/POST hemen çalışsın; dosya yok hatası olmasın
    _write_json_file(_map_data_file(map_id, "task_history.json"), [])

    entry = {
        "id": map_id,
        "name": name.strip(),
        "imageDir": source_dir,
        "isActive": False,
        "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    maps = _load_maps()
    maps.append(entry)
    _save_maps(maps)

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

    maps = _load_maps()
    found = False
    for entry in maps:
        if entry.get("id") == map_id:
            entry["isActive"] = True
            found = True
        else:
            entry["isActive"] = False

    if not found:
        return jsonify({"error": "Map not found"}), 404

    _save_maps(maps)
    return jsonify({"id": map_id, "isActive": True})


# DELETE /api/maps/<map_id> — PIN korumalı.
# Aktif harita silinmez: panel anında boş/404'e düşmesin. map_default silinmez: ana sera yedeği kalsın.
# imageDir silinmez: diskteki SLAM çıktısı elle temizlenir; yanlışlıkla harita dosyası kaybolmasın.
@app.route('/api/maps/<map_id>', methods=['DELETE'])
def delete_map(map_id):
    denied = _require_admin()
    if denied:
        return denied

    if not _validate_map_id(map_id):
        return jsonify({"error": "Invalid map id"}), 400

    if map_id == PROTECTED_MAP_ID:
        return jsonify({"error": "map_default cannot be deleted"}), 400

    maps = _load_maps()
    entry = next((m for m in maps if m.get("id") == map_id), None)
    if not entry:
        return jsonify({"error": "Map not found"}), 404

    if entry.get("isActive") is True:
        return jsonify({
            "error": "Aktif haritayı silemezsiniz, önce başka bir haritayı aktive edin",
        }), 400

    remaining = [m for m in maps if m.get("id") != map_id]
    _save_maps(remaining)

    data_dir = _map_data_dir(map_id)
    # imageDir silinmez — yalnızca görev/sınır verisi klasörü kaldırılır.
    if os.path.isdir(data_dir):
        shutil.rmtree(data_dir)

    return jsonify({"deleted": map_id})


# GET /api/maps/active — Herkese açık. Operatör + mühendis paneli.
# maps.json içinde isActive: true olan tek haritanın kimliğini ve adını döner.
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
    data, error = _read_map_data_file(map_id, "tasks.json")
    if error:
        return error
    return jsonify(data)


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

    data, error = _read_map_data_file(map_id, "tasks.json")
    if error:
        return error

    if any(item.get("id") == task["id"] for item in data):
        task["id"] = f"task_{uuid.uuid4().hex[:8]}"

    data.append(task)
    _write_json_file(_map_data_file(map_id, "tasks.json"), data)
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

    data, error = _read_map_data_file(map_id, "tasks.json")
    if error:
        return error

    index = next((i for i, item in enumerate(data) if item.get("id") == task_id), None)
    if index is None:
        return jsonify({"error": "Task not found"}), 404

    existing = data[index]
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

    data[index] = task
    _write_json_file(_map_data_file(map_id, "tasks.json"), data)
    return jsonify(task)


# Mühendis paneli: görevi tasks.json'dan kalıcı olarak kaldırır.
# DELETE /api/maps/<map_id>/tasks/<task_id> — PIN korumalı. Yalnızca mühendis paneli.
@app.route('/api/maps/<map_id>/tasks/<task_id>', methods=['DELETE'])
def delete_map_task(map_id, task_id):
    auth_error = _require_admin()
    if auth_error:
        return auth_error

    data, error = _read_map_data_file(map_id, "tasks.json")
    if error:
        return error

    next_data = [item for item in data if item.get("id") != task_id]
    if len(next_data) == len(data):
        return jsonify({"error": "Task not found"}), 404

    _write_json_file(_map_data_file(map_id, "tasks.json"), next_data)
    return jsonify({"ok": True})


# Görev geçmişi — nav_relay/Nav2'dan bağımsız yan log; UI modalı okur.
# Üst sınır: disk şişmesin, eski kayıtlar düşürülsün.
TASK_HISTORY_MAX = 200
TASK_HISTORY_STATUSES = {"başlatıldı", "başarılı", "iptal edildi", "başarısız"}


# GET /api/maps/<map_id>/task-history — Herkese açık.
# Neden reverse? Dosyada kronolojik append (eski→yeni); liste en yeniyi üstte ister.
@app.route('/api/maps/<map_id>/task-history', methods=['GET'])
def get_map_task_history(map_id):
    data, error = _read_map_data_file(map_id, "task_history.json")
    if error:
        return error
    return jsonify(list(reversed(data)))


# POST /api/maps/<map_id>/task-history — PIN yok: operatör paneli fire-and-forget loglar.
# Neden ayrı endpoint? Nav durum makinesine bağlanmadan denetim izi tutmak için.
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

    timestamp = payload.get("timestamp")
    if not isinstance(timestamp, str) or not timestamp.strip():
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    data, error = _read_map_data_file(map_id, "task_history.json")
    if error:
        return error

    entry = {
        "taskName": task_name.strip(),
        "status": status,
        "timestamp": timestamp.strip(),
    }
    data.append(entry)
    # Ring buffer: sonsuz büyüyen geçmiş dosyasını önlemek için
    if len(data) > TASK_HISTORY_MAX:
        data = data[-TASK_HISTORY_MAX:]

    _write_json_file(_map_data_file(map_id, "task_history.json"), data)
    return jsonify(entry), 201


# GET /api/maps/<map_id>/boundary — Herkese açık. Operatör + mühendis paneli.
# Geofence poligonunu döner; sınır çizilmemişse null (operatör hedef kontrolünde sınır atlanır).
@app.route('/api/maps/<map_id>/boundary', methods=['GET'])
def get_map_boundary(map_id):
    if not _validate_map_id(map_id):
        return jsonify({"error": "Invalid map id"}), 400
    if not _find_map(map_id):
        return jsonify({"error": "Map not found"}), 404

    path = _boundary_file(map_id)
    if not os.path.exists(path):
        return jsonify(None)

    data = _read_json_file(path, default=None)
    points = _normalize_boundary_points(data)
    if not points or len(points) < 3:  # geçerli poligon için en az 3 köşe gerekir
        return jsonify(None)
    return jsonify({"points": points})


# POST /api/maps/<map_id>/boundary — PIN korumalı. Yalnızca mühendis paneli.
# Mühendis panelinde çizilen geofence sınırını kaydeder (robot bu alan dışına gitmemeli).
@app.route('/api/maps/<map_id>/boundary', methods=['POST'])
def save_map_boundary(map_id):
    auth_error = _require_admin()
    if auth_error:
        return auth_error

    if not _validate_map_id(map_id):
        return jsonify({"error": "Invalid map id"}), 400
    if not _find_map(map_id):
        return jsonify({"error": "Map not found"}), 404

    payload = request.get_json(silent=True)
    points = _normalize_boundary_points(payload)
    if points is None or len(points) < 3:
        return jsonify({"error": "Boundary requires at least 3 {x, y} points"}), 400

    _write_json_file(_boundary_file(map_id), {"points": points})
    return jsonify({"points": points})


# DELETE /api/maps/<map_id>/boundary — PIN korumalı. Yalnızca mühendis paneli.
# Geofence sınırını kaldırır; sonrasında hedef kontrolünde yalnızca harita pikseli + yasak bölgeler kalır.
@app.route('/api/maps/<map_id>/boundary', methods=['DELETE'])
def delete_map_boundary(map_id):
    auth_error = _require_admin()
    if auth_error:
        return auth_error

    if not _validate_map_id(map_id):
        return jsonify({"error": "Invalid map id"}), 400
    if not _find_map(map_id):
        return jsonify({"error": "Map not found"}), 404

    path = _boundary_file(map_id)
    if os.path.exists(path):
        os.remove(path)
    return jsonify({"ok": True})


# GET /api/maps/<map_id>/forbidden-zones — Herkese açık. Operatör + mühendis paneli.
# Operatör panelinde hedef seçilirken kontrol edilen dikdörtgen yasak bölgeleri listeler.
@app.route('/api/maps/<map_id>/forbidden-zones', methods=['GET'])
def get_map_forbidden_zones(map_id):
    data, error = _read_map_data_file(map_id, "forbidden_zones.json")
    if error:
        return error
    return jsonify(data)


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

    data, error = _read_map_data_file(map_id, "forbidden_zones.json")
    if error:
        return error

    if any(item.get("id") == zone["id"] for item in data):
        zone["id"] = f"zone_{uuid.uuid4().hex[:8]}"

    data.append(zone)
    _write_json_file(_map_data_file(map_id, "forbidden_zones.json"), data)
    return jsonify(zone), 201


# DELETE /api/maps/<map_id>/forbidden-zones/<zone_id> — PIN korumalı. Yalnızca mühendis paneli.
# Tek bir yasak dikdörtgeni listeden çıkarır (geofence gibi tek dosya silinmez; çoklu bölge).
@app.route('/api/maps/<map_id>/forbidden-zones/<zone_id>', methods=['DELETE'])
def delete_map_forbidden_zone(map_id, zone_id):
    auth_error = _require_admin()
    if auth_error:
        return auth_error

    if not _validate_map_id(map_id):
        return jsonify({"error": "Invalid map id"}), 400

    data, error = _read_map_data_file(map_id, "forbidden_zones.json")
    if error:
        return error

    next_data = [item for item in data if item.get("id") != zone_id]
    if len(next_data) == len(data):
        return jsonify({"error": "Forbidden zone not found"}), 404

    _write_json_file(_map_data_file(map_id, "forbidden_zones.json"), next_data)
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
