import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { Ros, Topic } from 'roslib';

export const ROSBRIDGE_URL = 'ws://localhost:9090';
export const PLAN_TOPIC = '/plan';
export const ROS_CONNECTED_STATUS = 'ROS bağlantısı kuruldu';

const RosContext = createContext(null);

/**
 * Tek bir rosbridge WebSocket bağlantısını tüm bileşenlerle paylaşır.
 * /plan topic'inden gelen rota da burada tutulur.
 */
export function RosProvider({ children, url = ROSBRIDGE_URL }) {
  const [ros, setRos] = useState(null);
  const [status, setStatus] = useState('Bağlanıyor...');
  const [planPath, setPlanPath] = useState([]);

  const clearPlanPath = useCallback(() => {
    setPlanPath([]);
  }, []);

  useEffect(() => {
    const instance = new Ros({ url });

    instance.on('connection', () => setStatus(ROS_CONNECTED_STATUS));
    instance.on('error', (error) => {
      console.error('ROS hatası:', error);
      setStatus('ROS bağlantı hatası');
    });
    instance.on('close', () => setStatus('ROS bağlantısı kapandı'));

    setRos(instance);

    return () => {
      instance.close();
      setRos(null);
    };
  }, [url]);

  useEffect(() => {
    if (!ros) {
      setPlanPath([]);
      return;
    }

    const planTopic = new Topic({
      ros,
      name: PLAN_TOPIC,
      messageType: 'nav_msgs/Path',
    });

    planTopic.subscribe((message) => {
      const points = (message.poses ?? []).map((poseStamped) => ({
        x: poseStamped.pose.position.x,
        y: poseStamped.pose.position.y,
      }));
      setPlanPath(points);
    });

    return () => planTopic.unsubscribe();
  }, [ros]);

  return (
    <RosContext.Provider value={{ ros, status, planPath, clearPlanPath }}>
      {children}
    </RosContext.Provider>
  );
}

export function useRos() {
  const context = useContext(RosContext);
  if (!context) {
    throw new Error('useRos, RosProvider içinde kullanılmalıdır.');
  }
  return context;
}
