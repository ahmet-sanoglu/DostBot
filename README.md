# DostBot

Web tabanlı tarım robotu kontrol sistemi. Sera içinde çalışan bir tarım robotunu, tarayıcıdan (herhangi bir teknik bilgiye gerek kalmadan) kontrol etmeyi sağlar.

## Teknoloji Yığını

- **ROS 2 (Jazzy)** — robotun çalıştığı sistem
- **React** — web arayüzü (frontend)
- **Flask (Python)** — arka plan sunucusu (backend)
- **PostgreSQL** — veritabanı
- **rosbridge** — ROS 2 ile web tarayıcısı arasındaki köprü

## Sistem Mimarisi

```
[Robot / ROS 2] → rosbridge (WebSocket :9090) → React Frontend (:5173)
                                                        ↕
                                                Flask Backend (:5000)
                                                        ↕
                                                  PostgreSQL
```

## İki Panel

- **Kontrol Paneli** (`/`) — operatör ekranı. Görev başlatma, izleme, Acil Dur, kamera görüntüsü, harita.
- **Mühendis Paneli** (`/muhendis`) — PIN korumalı. Harita ekleme, görev tanımlama, güvenlik sınırları çizme.

## Kurulum

### 1. Sistem paketleri

```bash
# ROS 2 Jazzy
sudo apt install curl gnupg lsb-release -y
sudo curl -sSL https://raw.githubusercontent.com/ros/rosdistro/master/ros.key -o /usr/share/keyrings/ros-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/ros-archive-keyring.gpg] http://packages.ros.org/ros2/ubuntu $(. /etc/os-release && echo $UBUNTU_CODENAME) main" | sudo tee /etc/apt/sources.list.d/ros2.list > /dev/null
sudo apt update
sudo apt install ros-jazzy-desktop python3-colcon-common-extensions python3-rosdep -y
sudo rosdep init
rosdep update
echo 'source /opt/ros/jazzy/setup.bash' >> ~/.bashrc

# Node.js
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install nodejs -y

# PostgreSQL
sudo apt install postgresql postgresql-contrib -y

# Python temel araçlar
sudo apt install python3-pip python3-venv build-essential -y
```

### 2. PostgreSQL veritabanı kurulumu

```bash
sudo -u postgres psql -c "CREATE DATABASE dostbot;"
sudo -u postgres psql -c "CREATE USER dostbot_user WITH PASSWORD 'sifre_belirle';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE dostbot TO dostbot_user;"
sudo -u postgres psql -d dostbot -c "GRANT ALL ON SCHEMA public TO dostbot_user;"
sudo -u postgres psql -d dostbot -c "GRANT CREATE ON SCHEMA public TO dostbot_user;"

cd backend
psql -h localhost -U dostbot_user -d dostbot -f schema.sql
```

### 3. Backend kurulumu

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 4. Frontend kurulumu

```bash
cd frontend
npm install
```

### 5. `.env` dosyası

`backend/.env` dosyasını oluştur:

```
MAP_DIRECTORY=/home/KULLANICI_ADIN/AgriFleet/agriculture_map1
ADMIN_PIN=1234
CAMERA_RTSP_URL=rtsp://kullanici:sifre@ip:554/yol
CAMERA_MODE=sim
DATABASE_URL=postgresql://dostbot_user:sifre_belirle@localhost:5432/dostbot
```

- `CAMERA_MODE`: `sim` (simülasyon kamerası) veya `real` (gerçek RTSP kamera)
- `ADMIN_PIN`: Mühendis Paneli'ne giriş şifresi — gerçek bir kimlik doğrulama değil, kaza önleyici basit bir katman

### 6. Mevcut JSON verisi varsa, veritabanına aktar (tek seferlik)

```bash
python3 migrate_json_to_postgres.py
```

## Simülasyon Testi (TurtleBot3 + Gazebo)

Tüm sistemi tek komutla ayağa kaldıran script:

```bash
~/start_agrifleet_sim.sh
```

Bu script sırayla: Gazebo, rosbridge, **AMCL tabanlı lokalizasyon** (`localization_launch.py` — sadece `map_server` DEĞİL, çünkü tek başına `map_server` kullanmak `map`→`odom` TF bağlantısını sağlamaz ve tüm navigasyon hedefleri reddedilir), Nav2, nav_relay, cmd_vel_relay, odom_relay, backend ve frontend'i başlatır.

Elle başlatmak istersen, script'in içeriğine bakarak adımları sırayla çalıştırabilirsin.

### Doğrulama

```bash
ros2 action info /navigate_to_pose   # "Action servers: 1" olmalı
ros2 node list | grep nav_relay       # görünmeli
```

## Proje Yapısı

```
backend/          → Flask sunucusu, PostgreSQL erişimi, schema.sql
frontend/          → React uygulaması (Kontrol Paneli + Mühendis Paneli)
ros_nodes/          → nav_relay.py (rosbridge'in desteklemediği Nav2 action feedback'ini taşıyan köprü node'u)
```

## Neden Kendi `nav_relay.py` Yazıldı

`rosbridge_suite`, ROS 2 action protokolünü (goal/feedback/result) tam desteklemiyor — bu, aracın bilinen bir sınırlaması. Bu yüzden Nav2 ile native olarak (rclpy üzerinden) konuşan, sonucu basit ROS topic'lerine ("/agrifleet/nav_command", "/agrifleet/nav_status") çeviren bir röle node'u yazıldı.

## Bilinen Sınırlamalar / Bekleyen İşler

- Batarya göstergesi henüz gerçek ROS verisine bağlanmadı (sabit/demo değer gösteriyor)
- Şarj istasyonuna gitme özelliği, mühendisten servis/action bilgisi bekliyor (`goto_charge` şu an placeholder)
- Çoklu robot desteği yok, tek robot için tasarlandı
- Saha koşullarında (uzun mesafe, bağlantı kesintisi) kapsamlı test henüz yapılmadı
