import json
import os
import re
import uuid
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import yaml
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(
    app,
    resources={r"/api/*": {
        "origins": "http://localhost:5173",
        "allow_headers": ["Content-Type", "X-Admin-Pin"],
    }},
)

MAP_DIR = os.getenv("MAP_DIRECTORY", os.path.expanduser("~/AgriFleet/agriculture_map1"))
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
MAPS_FILE = os.path.join(DATA_DIR, "maps.json")
MAP_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")
ADMIN_PIN = os.getenv("ADMIN_PIN", "")


def _read_json_file(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_json_file(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _load_maps():
    maps = _read_json_file(MAPS_FILE, default=[])
    return maps if isinstance(maps, list) else []


def _validate_map_id(map_id):
    if not map_id or not MAP_ID_PATTERN.match(map_id):
        return False
    return True


def _map_data_dir(map_id):
    return os.path.join(DATA_DIR, map_id)


def _map_data_file(map_id, filename):
    return os.path.join(_map_data_dir(map_id), filename)


def _find_map(map_id):
    for entry in _load_maps():
        if entry.get("id") == map_id:
            return entry
    return None


def _read_map_data_file(map_id, filename):
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
    # Gerçek bir auth sistemi değil — sadece mühendis panelinde yanlışlıkla veri silmeyi engelleyen basit PIN katmanı.
    if not ADMIN_PIN:
        return False
    supplied = request.headers.get("X-Admin-Pin", "")
    return supplied == ADMIN_PIN


def _require_admin():
    if not _verify_admin_pin():
        return jsonify({"error": "Unauthorized"}), 401
    return None


def _normalize_location(raw):
    if not isinstance(raw, dict):
        return None
    name = raw.get("name")
    x, y, yaw = raw.get("x"), raw.get("y"), raw.get("yaw")
    if not isinstance(name, str) or not name.strip():
        return None
    if not all(isinstance(v, (int, float)) for v in (x, y, yaw)):
        return None
    return {
        "id": raw.get("id") or f"loc_{uuid.uuid4().hex[:8]}",
        "name": name.strip(),
        "x": float(x),
        "y": float(y),
        "yaw": float(yaw),
    }


def _normalize_task(raw):
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


def _boundary_file(map_id):
    return _map_data_file(map_id, "boundary.json")


def _normalize_boundary_points(raw):
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


# ROS occupancy grid metadata (resolution, origin) — harita üzerinde dünya↔piksel dönüşümü için.
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


# PNG harita görüntüsü — frontend occupancy piksel örneklemesi bu dosyadan yapılır.
@app.route('/api/map/image', methods=['GET'])
def get_map_image():
    if not os.path.exists(os.path.join(MAP_DIR, "map_from_bag.png")):
        return jsonify({"error": "Map image (PNG) not found. Run conversion script first."}), 404

    return send_from_directory(MAP_DIR, "map_from_bag.png")


# Mühendis paneli girişi — PIN doğruysa sessionStorage'a yazılır, yazma işlemleri X-Admin-Pin ile korunur.
@app.route('/api/admin/verify-pin', methods=['POST'])
def verify_admin_pin():
    payload = request.get_json(silent=True) or {}
    pin = payload.get("pin", "")
    if not ADMIN_PIN:
        return jsonify({"error": "Admin PIN not configured"}), 500
    if pin == ADMIN_PIN:
        return jsonify({"valid": True})
    return jsonify({"valid": False, "error": "Invalid PIN"}), 401


# Operatör arayüzünün kullandığı tek aktif harita (maps.json içinde isActive: true).
@app.route('/api/maps/active', methods=['GET'])
def get_active_map():
    active_maps = [entry for entry in _load_maps() if entry.get("isActive") is True]
    if not active_maps:
        return jsonify({"error": "No active map configured"}), 404

    active = active_maps[0]
    return jsonify({
        "id": active.get("id"),
        "name": active.get("name"),
    })


# Haritaya kayıtlı konum noktaları (görev adımlarında referans olarak kullanılır).
@app.route('/api/maps/<map_id>/locations', methods=['GET'])
def get_map_locations(map_id):
    data, error = _read_map_data_file(map_id, "locations.json")
    if error:
        return error
    return jsonify(data)


# Yeni konum ekleme — PIN korumalı (mühendis paneli).
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
        location["id"] = f"loc_{uuid.uuid4().hex[:8]}"

    data.append(location)
    _write_json_file(_map_data_file(map_id, "locations.json"), data)
    return jsonify(location), 201


# Konum silme — PIN korumalı.
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
    return jsonify({"ok": True})


# Operatör panelindeki "Görevler" listesinin kaynağı.
@app.route('/api/maps/<map_id>/tasks', methods=['GET'])
def get_map_tasks(map_id):
    data, error = _read_map_data_file(map_id, "tasks.json")
    if error:
        return error
    return jsonify(data)


# Çok adımlı görev tanımı ekleme — PIN korumalı.
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


# Geofence poligonu — yoksa null döner (sınır çizilmemiş haritalarda kontrol atlanır).
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
    if not points or len(points) < 3:
        return jsonify(None)
    return jsonify({"points": points})


# Mühendis panelinden çizilen geofence sınırını kaydeder — PIN korumalı.
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


# Geofence sınırını kaldırır — sonrasında sadece occupancy + yasak bölgeler geçerli olur.
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


# Operatör hedef doğrulamasında kullanılan dikdörtgen yasak bölgeler.
@app.route('/api/maps/<map_id>/forbidden-zones', methods=['GET'])
def get_map_forbidden_zones(map_id):
    data, error = _read_map_data_file(map_id, "forbidden_zones.json")
    if error:
        return error
    return jsonify(data)


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
