import React, { createContext, useContext, useEffect, useState } from 'react';
import { Ros } from 'roslib';

export const ROSBRIDGE_URL = 'ws://localhost:9090';

const RosContext = createContext(null);

/**
 * Tek bir rosbridge WebSocket bağlantısını tüm bileşenlerle paylaşır.
 */
export function RosProvider({ children, url = ROSBRIDGE_URL }) {
  const [ros, setRos] = useState(null);
  const [status, setStatus] = useState('Bağlanıyor...');

  useEffect(() => {
    const instance = new Ros({ url });

    instance.on('connection', () => setStatus('ROS bağlantısı kuruldu'));
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

  return (
    <RosContext.Provider value={{ ros, status }}>
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
