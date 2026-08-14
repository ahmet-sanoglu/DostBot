#!/bin/bash
set -e

echo "=== Once eski surecler temizleniyor ==="
pkill -9 -f "gz sim" 2>/dev/null || true
pkill -9 -f gzserver 2>/dev/null || true
pkill -9 -f gzclient 2>/dev/null || true
pkill -9 -f map_server 2>/dev/null || true
pkill -9 -f amcl 2>/dev/null || true
pkill -9 -f controller_server 2>/dev/null || true
pkill -9 -f planner_server 2>/dev/null || true
pkill -9 -f bt_navigator 2>/dev/null || true
pkill -9 -f behavior_server 2>/dev/null || true
pkill -9 -f smoother_server 2>/dev/null || true
pkill -9 -f route_server 2>/dev/null || true
pkill -9 -f waypoint_follower 2>/dev/null || true
pkill -9 -f velocity_smoother 2>/dev/null || true
pkill -9 -f collision_monitor 2>/dev/null || true
pkill -9 -f docking_server 2>/dev/null || true
pkill -9 -f lifecycle_manager 2>/dev/null || true
pkill -9 -f rosbridge 2>/dev/null || true
pkill -9 -f nav_relay 2>/dev/null || true
pkill -9 -f cmd_vel_relay 2>/dev/null || true
pkill -9 -f odom_relay 2>/dev/null || true
sleep 3

echo "=== 1/9 Gazebo baslatiliyor ==="
gnome-terminal --tab --title="Gazebo" -- bash -c "
source ~/turtlebot3_ws/install/setup.bash
export TURTLEBOT3_MODEL=waffle_pi
ros2 launch turtlebot3_gazebo turtlebot3_world.launch.py
exec bash"
sleep 8

echo "=== 2/9 rosbridge baslatiliyor ==="
gnome-terminal --tab --title="rosbridge" -- bash -c "
source /opt/ros/jazzy/setup.bash
ros2 launch rosbridge_server rosbridge_websocket_launch.xml
exec bash"
sleep 3

echo "=== 3/9 map_server + AMCL baslatiliyor ==="
gnome-terminal --tab --title="localization" -- bash -c "
source /opt/ros/jazzy/setup.bash
ros2 launch nav2_bringup localization_launch.py map:=/home/ahmet/AgriFleet/turtlebot3_sim_map_v3/map.yaml use_sim_time:=True
exec bash"
sleep 8

echo "=== 4/9 Baslangic konumu AMCL'e bildiriliyor ==="
source /opt/ros/jazzy/setup.bash
ros2 topic pub --once /initialpose geometry_msgs/msg/PoseWithCovarianceStamped "{header: {frame_id: 'map'}, pose: {pose: {position: {x: 0.0, y: 0.0, z: 0.0}, orientation: {w: 1.0}}}}"
sleep 2

echo "=== 5/9 Nav2 baslatiliyor ==="
gnome-terminal --tab --title="Nav2" -- bash -c "
source /opt/ros/jazzy/setup.bash
export TURTLEBOT3_MODEL=waffle_pi
ros2 launch nav2_bringup navigation_launch.py use_sim_time:=True params_file:=/opt/ros/jazzy/share/turtlebot3_navigation2/param/waffle_pi.yaml
exec bash"
sleep 10

echo "=== 6/9 nav_relay baslatiliyor ==="
gnome-terminal --tab --title="nav_relay" -- bash -c "
source /opt/ros/jazzy/setup.bash
python3 -u ~/AgriFleet/ros_nodes/nav_relay.py
exec bash"
sleep 2

echo "=== 7/9 cmd_vel_relay baslatiliyor ==="
gnome-terminal --tab --title="cmd_vel_relay" -- bash -c "
source /opt/ros/jazzy/setup.bash
python3 ~/cmd_vel_relay.py
exec bash"
sleep 1

echo "=== 8/9 odom_relay baslatiliyor ==="
gnome-terminal --tab --title="odom_relay" -- bash -c "
source /opt/ros/jazzy/setup.bash
python3 ~/odom_relay.py
exec bash"
sleep 1

echo "=== 9/9 Backend ve Frontend baslatiliyor ==="
gnome-terminal --tab --title="backend" -- bash -c "
cd ~/AgriFleet/backend
source ../venv/bin/activate
python3 app.py
exec bash"
sleep 2

gnome-terminal --tab --title="frontend" -- bash -c "
cd ~/AgriFleet/frontend
npm run dev
exec bash"

echo "=== TAMAMLANDI - kontrol icin: ==="
echo "ros2 action info /navigate_to_pose   (Action servers: 1 olmali)"
echo "ros2 node list | grep nav_relay        (gorunmeli)"
