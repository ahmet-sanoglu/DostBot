import os
from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS
import yaml
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "http://localhost:5173"}})

MAP_DIR = os.getenv("MAP_DIRECTORY", os.path.expanduser("~/AgriFleet/agriculture_map1"))


@app.route('/api/map/metadata', methods=['GET'])
def get_map_metadata():
    """
    map.yaml dosyasindaki cozunurluk ve orijin verilerini JSON olarak doner.
    """
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


@app.route('/api/map/image', methods=['GET'])
def get_map_image():
    """
    Donusturulmus map_from_bag.png dosyasini dogrudan tarayiciya servis eder.
    """
    if not os.path.exists(os.path.join(MAP_DIR, "map_from_bag.png")):
        return jsonify({"error": "Map image (PNG) not found. Run conversion script first."}), 404

    return send_from_directory(MAP_DIR, "map_from_bag.png")


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
