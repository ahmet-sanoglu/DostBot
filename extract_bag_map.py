import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSDurabilityPolicy
from nav_msgs.msg import OccupancyGrid
from PIL import Image
import numpy as np
import yaml
import time

class MapExtractor(Node):
    def __init__(self):
        super().__init__('map_extractor')
        qos = QoSProfile(
            depth=1,
            reliability=QoSReliabilityPolicy.RELIABLE,
            durability=QoSDurabilityPolicy.TRANSIENT_LOCAL
        )
        self.sub = self.create_subscription(OccupancyGrid, '/map', self.callback, qos)
        self.saved = False
        self.get_logger().info("Dinlemeye basladi, /map bekleniyor...")

    def callback(self, msg):
        if self.saved:
            return
        self.get_logger().info(f"MESAJ ALINDI! width={msg.info.width}, height={msg.info.height}")
        width = msg.info.width
        height = msg.info.height
        data = np.array(msg.data, dtype=np.int8).reshape((height, width))

        img_data = np.zeros((height, width), dtype=np.uint8)
        img_data[data == -1] = 205
        img_data[data == 0] = 254
        img_data[data == 100] = 0
        img_data = np.flipud(img_data)

        img = Image.fromarray(img_data, mode='L')
        img.save('/home/vboxuser/AgriFleet/agriculture_map1/map_from_bag.pgm')
        img.save('/home/vboxuser/AgriFleet/agriculture_map1/map_from_bag.png')

        yaml_data = {
            'image': 'map_from_bag.pgm',
            'resolution': float(msg.info.resolution),
            'origin': [float(msg.info.origin.position.x), float(msg.info.origin.position.y), 0.0],
            'negate': 0,
            'occupied_thresh': 0.65,
            'free_thresh': 0.01
        }
        with open('/home/vboxuser/AgriFleet/agriculture_map1/map_from_bag.yaml', 'w') as f:
            yaml.dump(yaml_data, f)

        print(f"KAYDEDILDI! resolution={msg.info.resolution}, origin={msg.info.origin.position.x},{msg.info.origin.position.y}, size={width}x{height}")
        self.saved = True

def main():
    rclpy.init()
    node = MapExtractor()
    start = time.time()
    while not node.saved and (time.time() - start) < 20.0:
        rclpy.spin_once(node, timeout_sec=1.0)
    if not node.saved:
        print("UYARI: 20 saniyede /map mesaji alinamadi!")
    rclpy.shutdown()

if __name__ == '__main__':
    main()
