// Robotun anlık konum ve hız bilgisini arayüz genelinde paylaşır.
// MapView konumu günceller; Joystick manuel sürüşte hızı yazar.
// Telemetri paneli ve debug görünümü bu veriyi okur.

import React, { createContext, useContext, useMemo, useState } from 'react';

const TelemetryContext = createContext(null);

/** Robot pozisyonu (pose) ve joystick hızını alt bileşenlere sağlar. */
export function TelemetryProvider({ children }) {
  const [pose, setPose] = useState(null);
  const [velocity, setVelocity] = useState({ linearX: 0, angularZ: 0 });

  // useMemo: pose/velocity değişmedikçe aynı value nesnesi döner; gereksiz re-render azalır.
  const value = useMemo(
    () => ({ pose, setPose, velocity, setVelocity }),
    [pose, velocity],
  );

  return (
    <TelemetryContext.Provider value={value}>
      {children}
    </TelemetryContext.Provider>
  );
}

/** TelemetryProvider dışında kullanılırsa hata fırlatır. */
export function useTelemetry() {
  const context = useContext(TelemetryContext);
  if (!context) {
    throw new Error('useTelemetry, TelemetryProvider içinde kullanılmalıdır.');
  }
  return context;
}
