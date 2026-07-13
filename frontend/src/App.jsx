import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { RosProvider } from './context/RosContext';
import { TelemetryProvider } from './context/TelemetryContext';
import DashboardLayout from './layouts/DashboardLayout';
import LiveMonitoringPage from './pages/LiveMonitoringPage';
import AutonomousPage from './pages/AutonomousPage';
import './App.css';

function App() {
  return (
    <RosProvider>
      <TelemetryProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<DashboardLayout />}>
              <Route index element={<LiveMonitoringPage />} />
              <Route path="canli-izleme" element={<LiveMonitoringPage />} />
              <Route path="otonom" element={<AutonomousPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </TelemetryProvider>
    </RosProvider>
  );
}

export default App;
