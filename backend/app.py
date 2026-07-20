# AgriFleet web arayüzünün veri katmanı.
# Robotla doğrudan konuşmaz; harita görüntüsü, konumlar, görevler ve sınır bilgisini
# JSON dosyalarından okur/yazar. Flask bu dosyayı "REST API sunucusu" olarak çalıştırır.

import json
import os
import re
import uuid
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import yaml
from dotenv import load_dotenv

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
# Konum/görev/sınır gibi kullanıcı tanımlı verilerin tutulduğu klasör (backend/data/).
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
MAPS_FILE = os.path.join(DATA_DIR, "maps.json")
# Harita kimliğinde sadece harf, rakam, tire ve alt çizgiye izin verilir (path injection önlemi).
MAP_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")
ADMIN_PIN = os.getenv("ADMIN_PIN", "")


def _read_json_file(path, default=None):
    """Diskteki bir JSON dosyasını okur; dosya yoksa default değeri döner."""
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_json_file(path, data):
    """Veriyi JSON olarak diske yazar; klasör yoksa önce oluşturur."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


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
    """Harita klasörü içindeki tek bir dosyanın tam yolunu üretir (örn. locations.json)."""
    return os.path.join(_map_data_dir(map_id), filename)


def _find_map(map_id):
    """maps.json kayıtları arasında verilen kimliğe sahip haritayı arar."""
    for entry in _load_maps():
        if entry.get("id") == map_id:
            return entry
    return None


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


def _normalize_location(raw):
    """
    İstemciden gelen ham konum verisini doğrular ve standart formata çevirir.
    Beklenen alanlar: name (metin), x/y/yaw (sayı). Geçersizse None döner.
    """
    if not isinstance(raw, dict):
        return None
    name = raw.get("name")
    x, y, yaw = raw.get("x"), raw.get("y"), raw.get("yaw")
    if not isinstance(name, str) or not name.strip():
        return None
    if not all(isinstance(v, (int, float)) for v in (x, y, yaw)):
        return None
    return {
        "id": raw.get("id") or f"loc_{uuid.uuid4().hex[:8]}",  # id yoksa rastgele üret
        "name": name.strip(),
        "x": float(x),
        "y": float(y),
        "yaw": float(yaw),
    }


def _normalize_task(raw):
    """
    İstemciden gelen görev verisini doğrular: ad + en az bir adım (x, y, yaw).
    Çok adımlı rotalar ve tek adımlı görevler aynı yapıda saklanır.
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
        })

    return {
        "id": raw.get("id") or f"task_{uuid.uuid4().hex[:8]}",
        "name": name.strip(),
        "steps": normalized_steps,
    }


def _coords_match(a, b, tolerance=1e-3):
    """İki noktanın x/y/yaw değerlerinin verilen tolerans içinde eşit olup olmadığını kontrol eder."""
    return (
        abs(float(a.get("x", 0)) - float(b.get("x", 0))) <= tolerance
        and abs(float(a.get("y", 0)) - float(b.get("y", 0))) <= tolerance
        and abs(float(a.get("yaw", 0)) - float(b.get("yaw", 0))) <= tolerance
    )


def _location_has_single_step_task(tasks, location):
    """
    Verilen konum için zaten tek adımlı bir görev var mı diye bakar.
    Önce locationId eşleşmesine, yoksa koordinat eşleşmesine bakar (eski kayıtlar için).
    """
    loc_id = location.get("id")
    for task in tasks:
        if not isinstance(task, dict):
            continue
        if loc_id and task.get("locationId") == loc_id:
            return True
        steps = task.get("steps") or []
        if len(steps) == 1 and _coords_match(steps[0], location):
            return True
    return False


def _task_from_location(location):
    """
    Konum kaydından operatör panelinde 'Başlat' edilebilir tek adımlı görev üretir.
    locationId alanı, konum silindiğinde bağlı görevin de silinmesini sağlar.
    """
    return {
        "id": f"task_{uuid.uuid4().hex[:8]}",
        "name": location["name"],
        "locationId": location["id"],
        "steps": [{
            "x": location["x"],
            "y": location["y"],
            "yaw": location["yaw"],
        }],
    }


def _sync_single_step_tasks_from_locations(map_id):
    """
    Her konum için eksik tek adımlı görevleri tasks.json'a ekler (geriye dönük senkron).
    GET /tasks çağrıldığında çalışır; operatör panelinde eski konumların da görevi görünür.
    """
    locations_path = _map_data_file(map_id, "locations.json")
    tasks_path = _map_data_file(map_id, "tasks.json")
    locations = _read_json_file(locations_path, default=[])
    tasks = _read_json_file(tasks_path, default=[])
    if not isinstance(locations, list):
        locations = []
    if not isinstance(tasks, list):
        tasks = []

    modified = False
    for location in locations:
        if not isinstance(location, dict) or not location.get("id"):
            continue
        if _location_has_single_step_task(tasks, location):
            continue
        tasks.append(_task_from_location(location))
        modified = True

    if modified:
        _write_json_file(tasks_path, tasks)
    return tasks


def _delete_auto_task_for_location(map_id, location_id):
    """
    Konum silindiğinde, locationId ile bağlı tek adımlı otomatik görevi tasks.json'dan kaldırır.
    Çok adımlı veya locationId taşımayan (manuel/eski) görevlere dokunmaz.
    """
    tasks_path = _map_data_file(map_id, "tasks.json")
    tasks = _read_json_file(tasks_path, default=[])
    if not isinstance(tasks, list):
        return

    next_tasks = []
    for task in tasks:
        if not isinstance(task, dict):
            next_tasks.append(task)
            continue
        steps = task.get("steps") or []
        is_auto_linked = (
            task.get("locationId") == location_id
            and len(steps) == 1
        )
        if is_auto_linked:
            continue  # otomatik bağlı görev — listeden çıkar
        next_tasks.append(task)

    if len(next_tasks) != len(tasks):
        _write_json_file(tasks_path, next_tasks)


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
# Haritanın çözünürlüğü (metre/piksel) ve orijin noktası; frontend dünya↔piksel dönüşümünde kullanır.
@app.route('/api/map/metadata', methods=['GET'])
def get_map_metadata():
    yaml_path = os.path.join(MAP_DIR, "map_from_bag.yaml")
    if not os.path.exists(yaml_path):
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
# ROS occupancy grid'den üretilmiş PNG harita görüntüsünü doğrudan tarayıcıya gönderir.
@app.route('/api/map/image', methods=['GET'])
def get_map_image():
    if not os.path.exists(os.path.join(MAP_DIR, "map_from_bag.png")):
        return jsonify({"error": "Map image (PNG) not found. Run conversion script first."}), 404

    return send_from_directory(MAP_DIR, "map_from_bag.png")


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


# GET /api/maps/active — Herkese açık. Operatör + mühendis paneli.
# maps.json içinde isActive: true olan tek haritanın kimliğini ve adını döner.
@app.route('/api/maps/active', methods=['GET'])
def get_active_map():
    active_maps = [entry for entry in _load_maps() if entry.get("isActive") is True]
    if not active_maps:
        return jsonify({"error": "No active map configured"}), 404

    active = active_maps[0]  # birden fazla aktif tanımlıysa ilki kullanılır
    return jsonify({
        "id": active.get("id"),
        "name": active.get("name"),
    })


# GET /api/maps/<map_id>/locations — Herkese açık. Operatör + mühendis paneli.
# Haritaya kayıtlı robot konum noktalarını (isim, x, y, yaw) listeler.
@app.route('/api/maps/<map_id>/locations', methods=['GET'])
def get_map_locations(map_id):
    data, error = _read_map_data_file(map_id, "locations.json")
    if error:
        return error
    return jsonify(data)


# POST /api/maps/<map_id>/locations — PIN korumalı. Yalnızca mühendis paneli.
# Yeni konum ekler; aynı anda operatör panelinde görünecek tek adımlı görev de oluşturulur.
@app.route('/api/maps/<map_id>/locations', methods=['POST'])
def add_map_location(map_id):
    auth_error = _require_admin()
    if auth_error:
        return auth_error

    payload = request.get_json(silent=True)
    location = _normalize_location(payload)
    if location is None:
        return jsonify({"error": "Expected {name, x, y, yaw}"}), 400

    data, error = _read_map_data_file(map_id, "locations.json")
    if error:
        return error

    if any(item.get("id") == location["id"] for item in data):
        location["id"] = f"loc_{uuid.uuid4().hex[:8]}"  # çakışan id varsa yenisi ver

    data.append(location)
    _write_json_file(_map_data_file(map_id, "locations.json"), data)

    # Konum eklenince operatör panelinde hemen Başlat edilebilir tek adımlı görev de oluşturulur.
    tasks_path = _map_data_file(map_id, "tasks.json")
    tasks = _read_json_file(tasks_path, default=[])
    if not isinstance(tasks, list):
        tasks = []
    if not _location_has_single_step_task(tasks, location):
        tasks.append(_task_from_location(location))
        _write_json_file(tasks_path, tasks)

    return jsonify(location), 201


# DELETE /api/maps/<map_id>/locations/<location_id> — PIN korumalı. Yalnızca mühendis paneli.
# Konumu siler; locationId ile bağlı otomatik tek adımlı görevi de tasks.json'dan kaldırır.
@app.route('/api/maps/<map_id>/locations/<location_id>', methods=['DELETE'])
def delete_map_location(map_id, location_id):
    auth_error = _require_admin()
    if auth_error:
        return auth_error

    if not _validate_map_id(map_id):
        return jsonify({"error": "Invalid map id"}), 400

    data, error = _read_map_data_file(map_id, "locations.json")
    if error:
        return error

    next_data = [item for item in data if item.get("id") != location_id]
    if len(next_data) == len(data):
        return jsonify({"error": "Location not found"}), 404

    _write_json_file(_map_data_file(map_id, "locations.json"), next_data)
    _delete_auto_task_for_location(map_id, location_id)
    return jsonify({"ok": True})


# GET /api/maps/<map_id>/tasks — Herkese açık. Operatör + mühendis paneli.
# Görev listesini döner; eksik tek adımlı konum görevleri otomatik tamamlanır (_sync).
@app.route('/api/maps/<map_id>/tasks', methods=['GET'])
def get_map_tasks(map_id):
    if not _validate_map_id(map_id):
        return jsonify({"error": "Invalid map id"}), 400
    if not _find_map(map_id):
        return jsonify({"error": "Map not found"}), 404

    tasks = _sync_single_step_tasks_from_locations(map_id)
    return jsonify(tasks)


# POST /api/maps/<map_id>/tasks — PIN korumalı. Yalnızca mühendis paneli.
# Çok adımlı rota görevi ekler (birden fazla konumu sırayla birleştirmek için).
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


if __name__ == '__main__':
    # Geliştirme ortamında doğrudan çalıştırma: python app.py
    app.run(host='0.0.0.0', port=5000, debug=True)
