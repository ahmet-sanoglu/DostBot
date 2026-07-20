// Debug telemetri kartları — ?debug=1 ile Kontrol Paneli yanında gösterilir.
// Konum, hız, demo batarya ve pusula; son 30 saniyelik mini grafikler içerir.

import React, { useEffect, useState } from 'react';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { useTelemetry } from '../../context/TelemetryContext';
import { normalizeAngle } from '../../utils/rosNavigation';

const HISTORY_WINDOW_MS = 30_000;
const SPARKLINE_COLOR = '#06A89B';
const DEMO_BATTERY_PERCENT = 87;

/** 30 saniyeden eski grafik noktalarını atar — bellek ve çizim yükünü sınırlar. */
function pruneHistory(entries) {
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  return entries.filter((entry) => entry.t >= cutoff);
}

/** Telemetri kart başlığındaki küçük ikon sarmalayıcısı. */
function CardIcon({ children }) {
  return (
    <span className="telemetry-card__icon" aria-hidden="true">
      {children}
    </span>
  );
}

function IconLocation() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconSpeed() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M13 2.05v3.03c3.39.49 6 3.39 6 6.92 0 .9-.18 1.75-.48 2.54l2.6 1.53c.56-1.24.88-2.62.88-4.07 0-5.18-3.95-9.45-9-9.95zM12 19c-3.87 0-7-3.13-7-7 0-3.53 2.61-6.43 6-6.92V2.05c-5.06.5-9 4.76-9 9.95 0 5.52 4.47 10 9.99 10 3.31 0 6.24-1.61 8.06-4.09l-2.6-1.53A6.95 6.95 0 0112 19z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconBattery() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15.67 4H14V2h-4v2H8.33C7.6 4 7 4.6 7 5.33v15.33C7 21.4 7.6 22 8.33 22h7.33c.74 0 1.34-.6 1.34-1.33V5.33C17 4.6 16.4 4 15.67 4z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconCompass() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm3.5 6L12 17.5 8.5 8 12 6.5 15.5 8z"
        fill="currentColor"
      />
    </svg>
  );
}

function TelemetryCardTitle({ icon, children }) {
  return (
    <div className="telemetry-card__title">
      <CardIcon>{icon}</CardIcon>
      <span>{children}</span>
    </div>
  );
}

/** Son 30 sn hız/konum mini çizgi grafiği. */
function Sparkline({ data }) {
  if (data.length < 2) {
    return <div className="sparkline sparkline--empty" aria-hidden="true" />;
  }

  return (
    <div className="sparkline">
      <ResponsiveContainer width="100%" height={52}>
        <LineChart data={data} margin={{ top: 6, right: 0, left: 0, bottom: 6 }}>
          <XAxis dataKey="t" hide />
          <YAxis hide domain={['auto', 'auto']} />
          <Line
            type="monotone"
            dataKey="value"
            stroke={SPARKLINE_COLOR}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Pusula görseli — robot yaw açısını derece olarak gösterir. */
function CompassWidget({ yawRad }) {
  const yawDeg = yawRad != null
    ? ((normalizeAngle(yawRad) * 180) / Math.PI).toFixed(1)
    : '—';

  return (
    <div className="panel-card telemetry-card">
      <TelemetryCardTitle icon={<IconCompass />}>Yön</TelemetryCardTitle>
      <div className="telemetry-card__primary">{yawDeg}°</div>
      <div className="compass">
        <div className="compass__dial">
          <span className="compass__label compass__label--n">K</span>
          <span className="compass__label compass__label--s">G</span>
          <span className="compass__label compass__label--e">D</span>
          <span className="compass__label compass__label--w">B</span>
          {yawRad != null && (
            <div
              className="compass__arrow"
              style={{ transform: `rotate(${yawDeg}deg)` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Debug telemetri yan paneli; TelemetryContext'ten canlı pose/velocity okur. */
export default function TelemetryPanel({ debugMode = false }) {
  const { pose, velocity } = useTelemetry();
  const yawRad = pose?.yaw ?? null;
  const [speedHistory, setSpeedHistory] = useState([]);
  const [positionHistory, setPositionHistory] = useState([]);

  useEffect(() => {
    const now = Date.now();
    setSpeedHistory((prev) =>
      pruneHistory([...prev, { t: now, value: velocity.linearX }]),
    );
  }, [velocity.linearX]);

  useEffect(() => {
    if (!pose) return;
    const now = Date.now();
    setPositionHistory((prev) =>
      pruneHistory([...prev, { t: now, value: pose.x }]),
    );
  }, [pose]);

  const yawDisplay = yawRad != null
    ? `${((normalizeAngle(yawRad) * 180) / Math.PI).toFixed(1)}°`
    : '—';

  return (
    <aside className="telemetry-panel" aria-label="Telemetri kartları">
      {debugMode && (
        <p className="telemetry-panel__debug-note">
          Debug modu — ham telemetri kartları (?debug=1)
        </p>
      )}
      <div className="panel-card telemetry-card">
        <TelemetryCardTitle icon={<IconLocation />}>Konum</TelemetryCardTitle>
        <div className={`telemetry-card__primary ${pose ? '' : 'telemetry-card__primary--muted'}`}>
          {pose ? `${pose.x.toFixed(2)} m` : '—'}
        </div>
        <div className="telemetry-card__secondary">
          <span>Y {pose ? `${pose.y.toFixed(2)} m` : '—'}</span>
          <span>Yaw {yawDisplay}</span>
        </div>
        <Sparkline data={positionHistory} />
      </div>

      <div className="panel-card telemetry-card">
        <TelemetryCardTitle icon={<IconSpeed />}>Hız</TelemetryCardTitle>
        <div className="telemetry-card__primary">
          {velocity.linearX.toFixed(2)} m/s
        </div>
        <div className="telemetry-card__secondary">
          <span>angular.z {velocity.angularZ.toFixed(2)} rad/s</span>
        </div>
        <Sparkline data={speedHistory} />
      </div>

      <div className="panel-card telemetry-card">
        <TelemetryCardTitle icon={<IconBattery />}>Batarya</TelemetryCardTitle>
        <div className="telemetry-card__primary telemetry-card__primary--battery">
          {DEMO_BATTERY_PERCENT}%
        </div>
        <div className="battery-bar">
          <div
            className="battery-bar__fill battery-bar__fill--teal"
            style={{ width: `${DEMO_BATTERY_PERCENT}%` }}
          />
        </div>
      </div>

      <CompassWidget yawRad={yawRad} />
    </aside>
  );
}
