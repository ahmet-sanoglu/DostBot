# Occupancy grid PGM → tarayıcıda kullanılabilir PNG dönüşümü.
# Parametrik: sabit agriculture_map1 yolu kaldırıldı — her haritanın kendi sourceDir'i olabilir;
# POST /api/maps yeni klasör eklerken PNG yoksa bu fonksiyonu çağırır.

from PIL import Image
import os
import sys


def convert_pgm_to_png(pgm_path, png_path=None):
    """
    PGM occupancy grid'i PNG'ye çevirir.
    png_path verilmezse aynı klasörde aynı isimle .png üretir.
    Dönüş: yazılan PNG dosyasının yolu.
    """
    if not os.path.isfile(pgm_path):
        raise FileNotFoundError(f"PGM not found: {pgm_path}")

    if png_path is None:
        base, _ = os.path.splitext(pgm_path)
        png_path = f"{base}.png"

    img = Image.open(pgm_path)
    img.save(png_path)
    return png_path


if __name__ == "__main__":
    # Kullanım: python convert_map.py [pgm_path] [png_path]
    # Argüman yoksa eski agriculture_map1 yolu (manuel CLI kolaylığı).
    default_pgm = os.path.expanduser("~/AgriFleet/agriculture_map1/map_from_bag.pgm")
    pgm = sys.argv[1] if len(sys.argv) > 1 else default_pgm
    png = sys.argv[2] if len(sys.argv) > 2 else None
    out = convert_pgm_to_png(pgm, png)
    print(f"Converted {pgm} -> {out}")
