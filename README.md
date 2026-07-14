# AgriFleet

Dost Tarim Teknolojileri bunyesinde gelistirilen, serada calisan otonom/manuel kontrol edilebilir bir AGV icin web tabanli kontrol paneli.

## Mimari

Robot / ROS 2 -> rosbridge (WebSocket :9090) -> React Frontend -> MapView / Joystick / Gorevler
Flask Backend :5000 -> harita gorseli + metadata + konum/gorev/harita verisi (JSON)

Teknoloji yigini:
- Frontend: React + Vite, react-router-dom, roslibjs, nipplejs, recharts
- Backend: Flask, flask-cors, Pillow
- ROS 2 Jazzy, rosbridge_suite, Nav2 (navigate_to_pose action)

## Klasor Yapisi

- backend/app.py (Flask API)
- backend/convert_map.py (PGM -> PNG donusumu)
- backend/.env (MAP_DIRECTORY, ADMIN_PIN, git'e dahil degil)
- backend/data/maps.json (harita kayit defteri)
- backend/data/map_id/ (locations.json, tasks.json, forbidden_zones.json, boundary.json)
- frontend/src/pages/DashboardPage.jsx (Operator - Kontrol Paneli, /)
- frontend/src/pages/EngineerPage.jsx (Muhendis Paneli, /muhendis)
- frontend/src/components/dashboard/ (Operator bilesenleri)
- frontend/src/components/engineer/ (Muhendis paneli bilesenleri)
- agriculture_map1/ (statik harita dosyalari)
- extract_bag_map.py (bag'den canli harita cikarma scripti)

## Iki Panel

Kontrol Paneli (/) - Operator arayuzu. Harita, joystick, onceden tanimlanmis gorevleri baslatma. Ham koordinat girisi yok.

Muhendis Paneli (/muhendis) - Konum/gorev tanimlama, harita secimi, gecilebilir alan siniri cizme. Basit PIN korumasi var, gercek kimlik dogrulama degil.

## Guvenlik Katmanlari

1. Harita piksel kontrolu
2. Gecilebilir alan poligonu (boundary.json)
3. Yasakli dikdortgen bolgeler (planlandi, henuz aktif degil)

## Kurulum

Backend: cd backend, source ../venv/bin/activate, python3 app.py
Frontend: cd frontend, npm run dev
ROS koprusu: ros2 launch rosbridge_server rosbridge_websocket_launch.xml

## Acik Isler

- Yasakli dikdortgen bolge yonetimi henuz eklenmedi
- Nav2 parametre paneli planlandi, uygulanmadi
- Coklu harita ekleme islevi henuz aktif degil
- Tum testler bag ile yapildi, gercek robot testi bekliyor
