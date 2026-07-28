"""AgriFleet Nav2 rölesi.

rosbridge ROS 2 action protokolünü (özellikle feedback/result/cancel akışını) güvenilir
taşımadığı için UI doğrudan ActionClient kullanmaz. Bunun yerine bu native Python node,
NavigateToPose action'ını lokal olarak çalıştırır ve frontend ile yalnızca
/agrifleet/nav_command ve /agrifleet/nav_status topic'leri üzerinden düz JSON konuşur.
"""

import json, math
import rclpy
from rclpy.node import Node
from rclpy.action import ActionClient
from nav2_msgs.action import NavigateToPose
from std_msgs.msg import String

class NavRelay(Node):
    def __init__(self):
        super().__init__('nav_relay')
        self.client = ActionClient(self, NavigateToPose, '/navigate_to_pose')
        self.current_goal_handle = None
        self.create_subscription(String, '/agrifleet/nav_command', self.on_command, 10)
        self.status_pub = self.create_publisher(String, '/agrifleet/nav_status', 10)
        self.get_logger().info('nav_relay hazir')

    def on_command(self, msg):
        # UI'dan gelen düz topic komutunu ActionClient çağrısına çevirir; web tarafı ROS action
        # ayrıntılarını bilmesin diye giriş noktası burada tekleştirilir.
        self.get_logger().info(f'KOMUT GELDI: {msg.data}')
        try:
            data = json.loads(msg.data)
        except Exception as e:
            self.get_logger().error(f'JSON parse hatasi: {e}')
            return

        if data.get('type') == 'cancel':
            # İptal, aktif goal handle üzerinden cancel_goal_async ile yapılır; web tarafı boş goal_id
            # gibi ROS 2 action ayrıntılarıyla uğraşmasın diye cancel burada native olarak çözülür.
            if self.current_goal_handle is not None:
                self.current_goal_handle.cancel_goal_async()
                self.get_logger().info('Iptal istegi gonderildi')
            return

        goal = NavigateToPose.Goal()
        goal.pose.header.frame_id = 'map'
        goal.pose.pose.position.x = float(data['x'])
        goal.pose.pose.position.y = float(data['y'])
        yaw = float(data.get('yaw', 0.0))
        goal.pose.pose.orientation.z = math.sin(yaw / 2)
        goal.pose.pose.orientation.w = math.cos(yaw / 2)
        self.get_logger().info('Nav2 sunucusu bekleniyor...')
        self.client.wait_for_server()
        self.get_logger().info('Goal gonderiliyor...')
        future = self.client.send_goal_async(goal, feedback_callback=self.on_feedback)
        future.add_done_callback(self.on_response)

    def on_response(self, future):
        # Goal kabul/red kararını düz topic mesajına indirger; frontend yalnızca accepted/rejected bilir.
        handle = future.result()
        if not handle.accepted:
            self.get_logger().warn('Goal reddedildi')
            self.status_pub.publish(String(data=json.dumps({"type": "rejected"})))
            return
        self.current_goal_handle = handle
        self.get_logger().info('Goal kabul edildi')
        self.status_pub.publish(String(data=json.dumps({"type": "accepted"})))
        handle.get_result_async().add_done_callback(self.on_result)

    def on_feedback(self, fb):
        # Action feedback'i web'e taşınabilir, sade bir kalan mesafe mesajına dönüştürür.
        self.status_pub.publish(String(data=json.dumps({
            "type": "feedback",
            "distance_remaining": fb.feedback.distance_remaining,
        })))

    def on_result(self, future):
        # Final sonucu tek, güvenilir kaynak olarak yayınlar; UI artık status_list yorumlamaz.
        result = future.result()
        self.current_goal_handle = None
        self.get_logger().info(f'Sonuc: {result.status}')
        self.status_pub.publish(String(data=json.dumps({
            "type": "result",
            "status": result.status,
        })))

def main():
    rclpy.init()
    node = NavRelay()
    rclpy.spin(node)

if __name__ == '__main__':
    main()
