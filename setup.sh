#!/bin/bash
set -e
echo "=== ROS 2 Jazzy ve gerekli paketler kuruluyor ==="
sudo apt update
sudo apt install -y ros-jazzy-rosbridge-suite ros-jazzy-rosbridge-server
sudo apt install -y ros-jazzy-navigation2 ros-jazzy-nav2-bringup
sudo apt install -y ros-jazzy-ros-gz ros-jazzy-turtlebot3-msgs ros-jazzy-turtlebot3
echo "=== Python venv kuruluyor ==="
cd "$(dirname "$0")"
python3 -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt --break-system-packages
echo "=== Frontend bağımlılıkları kuruluyor ==="
cd frontend
npm install
cd ..
echo "=== TurtleBot3 simülasyon workspace'i kuruluyor ==="
mkdir -p ~/turtlebot3_ws/src
cd ~/turtlebot3_ws/src
if [ ! -d "turtlebot3_simulations" ]; then
  git clone -b jazzy https://github.com/ROBOTIS-GIT/turtlebot3_simulations.git
fi
cd ~/turtlebot3_ws
rosdep install --from-paths src --ignore-src -r -y
colcon build --symlink-install
echo "=== Tamamlandı ==="
echo "Not: backend/.env dosyasını elle oluşturman gerekiyor (WhatsApp yedeğinden)."
echo "Not: agriculture_map1/ ve bag_examples_for_ui/ klasörlerini WhatsApp yedeğinden geri kopyalaman gerekiyor."
