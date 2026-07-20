// Robot ile konuşan tek WebSocket bağlantısını tüm arayüze paylaşır.
// rosbridge (localhost:9090) üzerinden ROS topic'lerine abone olur veya mesaj gönderir.
// Bağlantı durumu ve Nav2'nin planladığı rota (/plan) burada tutulur.

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

// Context: alt bileşenlere veri taşıyan React mekanizması; prop drilling olmadan ros/status paylaşılır.
const RosContext = createContext(null);

/**
 * Uygulama açıldığında rosbridge'e bağlanır; kapanınca bağlantıyı keser.
 * /plan topic'inden gelen rota noktalarını haritada çizmek için planPath state'inde tutar.
 */
export function RosProvider({ children, url = ROSBRIDGE_URL }) {
  // useState: ekranda gösterilecek ve değişince arayüzü yenileyen değerler.
  const [ros, setRos] = useState(null);
  const [status, setStatus] = useState('Bağlanıyor...');
  const [planPath, setPlanPath] = useState([]);

  // useCallback: fonksiyon referansını sabit tutar; alt bileşenler gereksiz yeniden render olmaz.
  const clearPlanPath = useCallback(() => {
    setPlanPath([]);
  }, []);

  // useEffect: bileşen mount olduğunda rosbridge bağlantısını kurar, unmount'ta kapatır.
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

  // ROS bağlandığında /plan topic'ine abone ol; Nav2 yeni rota planladıkça planPath güncellenir.
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

/** RosProvider dışında kullanılırsa hata fırlatır — bağlantı bilgisine güvenli erişim sağlar. */
export function useRos() {
  const context = useContext(RosContext);
  if (!context) {
    throw new Error('useRos, RosProvider içinde kullanılmalıdır.');
  }
  return context;
}
