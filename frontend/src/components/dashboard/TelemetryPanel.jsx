import React, { useEffect, useState } from 'react';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { useRos } from '../../context/RosContext';
import { useTelemetry } from '../../context/TelemetryContext';
import { normalizeAngle } from '../../utils/rosNavigation';

const HISTORY_WINDOW_MS = 30_000;
const SPARKLINE_COLOR = '#6366F1';
const DEMO_BATTERY_PERCENT = 87;

function pruneHistory(entries) {
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  return entries.filter((entry) => entry.t >= cutoff);
}

function useRosConnected() {
  const { status } = useRos();
  return status === 'ROS bağlantısı kuruldu';
}

function StatusLed({ connected }) {
  return (
    <span
      className={`status-led ${connected ? 'status-led--connected' : 'status-led--disconnected'}`}
      aria-hidden="true"
    />
  );
}

function CardTitle({ icon, connected, children }) {
  return (
    <div className="panel-card__title">
      <StatusLed connected={connected} />
      <span className="panel-card__icon">{icon}</span>
      {children}
    </div>
  );
}

function Sparkline({ data }) {
  if (data.length < 2) {
    return <div className="sparkline sparkline--empty" aria-hidden="true" />;
  }

  return (
    <div className="sparkline">
      <ResponsiveContainer width="100%" height={60}>
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

function CompassWidget({ yawRad, isConnected }) {
  const yawDeg = yawRad != null
    ? ((normalizeAngle(yawRad) * 180) / Math.PI).toFixed(1)
    : '—';

  return (
    <div className="panel-card">
      <CardTitle icon="🧭" connected={isConnected}>Yön</CardTitle>
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
      <div className="compass__yaw-text">{yawDeg}°</div>
    </div>
  );
}

export default function TelemetryPanel() {
  const isConnected = useRosConnected();
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

  return (
    <aside className="telemetry-panel" aria-label="Telemetri kartları">
      <div className="panel-card panel-card--primary">
        <CardTitle icon="📍" connected={isConnected}>Konum</CardTitle>
        <div className="metric-row">
          <span className="metric-label">X</span>
          <span className={`metric-value ${pose ? '' : 'metric-value--muted'}`}>
            {pose ? `${pose.x.toFixed(2)} m` : '—'}
          </span>
        </div>
        <div className="metric-row">
          <span className="metric-label">Y</span>
          <span className={`metric-value ${pose ? '' : 'metric-value--muted'}`}>
            {pose ? `${pose.y.toFixed(2)} m` : '—'}
          </span>
        </div>
        <div className="metric-row">
          <span className="metric-label">Yaw</span>
          <span className={`metric-value ${pose ? '' : 'metric-value--muted'}`}>
            {yawRad != null
              ? `${((normalizeAngle(yawRad) * 180) / Math.PI).toFixed(1)}°`
              : '—'}
          </span>
        </div>
        <Sparkline data={positionHistory} />
      </div>

      <div className="panel-card">
        <CardTitle icon="⚡" connected={isConnected}>Hız (cmd_vel)</CardTitle>
        <div className="metric-row">
          <span className="metric-label">linear.x</span>
          <span className="metric-value">{velocity.linearX.toFixed(2)} m/s</span>
        </div>
        <div className="metric-row">
          <span className="metric-label">angular.z</span>
          <span className="metric-value">{velocity.angularZ.toFixed(2)} rad/s</span>
        </div>
        <Sparkline data={speedHistory} />
      </div>

      <div className="panel-card">
        <CardTitle icon="🔋" connected={isConnected}>Batarya</CardTitle>
        <div className="battery-percent">{DEMO_BATTERY_PERCENT}%</div>
        <div className="battery-bar">
          <div
            className="battery-bar__fill"
            style={{ width: `${DEMO_BATTERY_PERCENT}%` }}
          />
        </div>
      </div>

      <CompassWidget yawRad={yawRad} isConnected={isConnected} />
    </aside>
  );
}
