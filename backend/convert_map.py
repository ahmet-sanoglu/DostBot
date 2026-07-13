import os
from PIL import Image

def convert_ros_map():
    map_dir = os.path.expanduser("~/AgriFleet/agriculture_map1")
    pgm_path = os.path.join(map_dir, "map.pgm")
    output_png_path = os.path.join(map_dir, "map.png")

    if not os.path.exists(pgm_path):
        print(f"Hata: {pgm_path} bulunamadı!")
        return

    try:
        with Image.open(pgm_path) as img:
            img.save(output_png_path, "PNG")
        print(f"Başarılı: Harita PNG formatına çevrildi -> {output_png_path}")
    except Exception as e:
        print(f"Dönüştürme sırasında hata oluştu: {e}")

if __name__ == "__main__":
    convert_ros_map()
