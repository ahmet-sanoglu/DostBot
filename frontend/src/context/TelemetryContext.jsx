import React, { createContext, useContext, useMemo, useState } from 'react';

const TelemetryContext = createContext(null);

export function TelemetryProvider({ children }) {
  const [pose, setPose] = useState(null);
  const [velocity, setVelocity] = useState({ linearX: 0, angularZ: 0 });

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

export function useTelemetry() {
  const context = useContext(TelemetryContext);
  if (!context) {
    throw new Error('useTelemetry, TelemetryProvider içinde kullanılmalıdır.');
  }
  return context;
}
