# AgriFleet

Dost Tarim Teknolojileri bunyesinde gelistirilen, serada calisan otonom/manuel kontrol edilebilir bir AGV icin web tabanli kontrol paneli.

## Mimari

Robot / ROS 2 -> rosbridge (WebSocket :9090) -> React Frontend -> MapView / Joystick / Gorevler
                 -> nav_relay.py (NavigateToPose ActionClient) <-> /agrifleet/nav_*
Flask Backend :5000 -> harita gorseli + metadata + gorev/harita verisi (JSON)

Teknoloji yigini:
- Frontend: React + Vite, react-router-dom, roslibjs, nipplejs, recharts
- Backend: Flask, flask-cors, Pillow
- ROS 2 Jazzy, rosbridge_suite, Nav2 (navigate_to_pose); UI action yerine nav_relay topic'leri kullanir

## Klasor Yapisi

- backend/app.py (Flask API)
- backend/convert_map.py (PGM -> PNG donusumu)
- backend/.env (MAP_DIRECTORY, ADMIN_PIN, git'e dahil degil)
- backend/data/maps.json (harita kayit defteri)
- backend/data/map_id/ (tasks.json, forbidden_zones.json, boundary.json)
- frontend/src/pages/DashboardPage.jsx (Operator - Kontrol Paneli, /)
- frontend/src/pages/EngineerPage.jsx (Muhendis Paneli, /muhendis)
- frontend/src/components/dashboard/ (Operator bilesenleri)
- frontend/src/components/engineer/ (Muhendis paneli bilesenleri)
- agriculture_map1/ (statik harita dosyalari)
- extract_bag_map.py (bag'den canli harita cikarma scripti)
- ros_nodes/nav_relay.py (Nav2 ActionClient role; UI <-> /agrifleet/nav_command|nav_status)

## Iki Panel

Kontrol Paneli (/) - Operator arayuzu. Harita, joystick, onceden tanimlanmis gorevleri baslatma. Ham koordinat girisi yok.

Muhendis Paneli (/muhendis) - Gorev tanimlama, harita secimi, gecilebilir alan siniri cizme. Basit PIN korumasi var, gercek kimlik dogrulama degil.

## Guvenlik Katmanlari

1. Harita piksel kontrolu
2. Gecilebilir alan poligonu (boundary.json)
3. Yasakli dikdortgen bolgeler (planlandi, henuz aktif degil)

## Kurulum

### Hizli kurulum (tek komut)

```bash
chmod +x setup.sh
./setup.sh
```

Bundan sonra elle yapman gerekenler:

1. `backend/.env` dosyasini olustur (`MAP_DIRECTORY`, `ADMIN_PIN`) — yedekten kopyala
2. `agriculture_map1/` klasorunu yedekten geri getir
3. `bag_examples_for_ui/` klasorunu yedekten geri getir
4. GitHub icin SSH anahtari olustur (`ssh-keygen`) ve GitHub hesabina ekle

### Calistirma

Backend: cd backend, source ../venv/bin/activate, python3 app.py
Frontend: cd frontend, npm run dev
ROS koprusu: ros2 launch rosbridge_server rosbridge_websocket_launch.xml

Nav role (rosbridge yaninda zorunlu — action feedback/result UI'ya topic ile gelir):

```bash
source /opt/ros/jazzy/setup.bash
python3 ros_nodes/nav_relay.py
```

## TurtleBot3 Simulasyon Test Sureci

Asagidaki sira kritiktir. SLAM ile haritalama bittikten sonra **SLAM kapatilip** lokalizasyon (`map_server` + **AMCL**) baslatilmali; aksi halde Nav2 robotun haritadaki yerini bilmez / `/map` alamaz ve hedefler **ABORTED (status 6)** ile reddedilir.

### Hizli baslatma (onerilen)

Tum terminalleri dogru sirayla acmak icin:

```bash
~/start_agrifleet_sim.sh
```

Script Gazebo, lokalizasyon, Nav2, rosbridge, nav_relay, backend ve frontend'i ayri terminallerde otomatik acar. Elle adim adim kurulum asagidadir.

### Elle adim adim

1. **Gazebo** — TurtleBot3 simulasyonunu baslat (ornek: `turtlebot3_gazebo` world).
2. **SLAM ile haritalama** — Ortami gezerek haritayi olustur; bitince haritayi diske kaydet (`map.yaml` + `map.pgm`/`map.png`).
3. **SLAM'i kapat** — Haritalama bittiyse SLAM dugumunu durdur. Ayni anda hem SLAM hem map_server `/map` yayinlamamali.
4. **Lokalizasyon (map_server + AMCL)** — Kaydedilen haritayi `nav2_bringup` `localization_launch.py` ile yukle (yalnizca map_server degil; AMCL birlikte gelir):

```bash
ros2 launch nav2_bringup localization_launch.py \
  map:=<harita_yolu>/map.yaml \
  use_sim_time:=True
```

`<harita_yolu>` ornegi: `/home/ahmet/AgriFleet/turtlebot3_sim_map`

5. **Baslangic pozu (`/initialpose`)** — AMCL robotun haritadaki yerini bilmeden Nav2 hedef kabul etmez. RViz'de **2D Pose Estimate** ile robotun yaklasik konum/yonunu verin; veya `/initialpose` topic'ine `geometry_msgs/PoseWithCovarianceStamped` yayinlayin. Laser tarama harita duvarlariyla cakisiyorsa poz yeterince iyidir.
6. **Nav2** — Navigasyon stack'ini baslat (`use_sim_time:=True` ile). Costmap `/map`'i lokalizasyondan bekler.
7. **rosbridge** — `ros2 launch rosbridge_server rosbridge_websocket_launch.xml`
8. **nav_relay** — `python3 ros_nodes/nav_relay.py` (NavigateToPose ActionClient; UI topic'leri)
9. **Backend / Frontend** — Flask `:5000`, Vite `npm run dev` (`:5173`). Muhendis panelinden ilgili `imageDir` haritasini ekle/aktive et.

### Uyari: SLAM sonrasi lokalizasyon zorunlu

SLAM ile haritalama bittikten sonra SLAM kapatilip **`localization_launch.py`** (map_server + AMCL) baslatilmali; ardindan **`/initialpose`** verilmeli.

- SLAM acik kalirsa veya lokalizasyon hic baslamazsa Nav2 costmap / poz tahmini guvenilir olmaz.
- `initialpose` verilmezse AMCL baslatilmaz; hedefler reddedilir veya sapar.
- Sonuc: planlama basarisiz, hedefler **ABORTED (status 6)**; UI'da gorevler de reddedilir / tamamlanmaz.
- Web paneli harita PNG'sini Flask'tan gosterir; bu, Nav2'nin `/map`'ini **yerine gecmez**.

Eski yaklasim (yalnizca `ros2 run nav2_map_server map_server` + lifecycle) yeterli degildir — AMCL ve `/initialpose` olmadan lokalizasyon tamamlanmaz. Tercih edilen yol: `localization_launch.py`.

## Acik Isler

- Nav2 parametre paneli planlandi, uygulanmadi
- Tum testler bag / simulasyon ile yapildi, gercek robot testi bekliyor
