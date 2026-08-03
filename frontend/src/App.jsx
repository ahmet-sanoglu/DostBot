import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { RosProvider } from './context/RosContext';
import { NavigationProvider } from './context/NavigationContext';
import { TelemetryProvider } from './context/TelemetryContext';
import DashboardLayout from './layouts/DashboardLayout';
import DashboardPage from './pages/DashboardPage';
import EngineerPage from './pages/EngineerPage';
import TaskHistoryPage from './pages/TaskHistoryPage';
import './App.css';

function App() {
  return (
    <RosProvider>
      <TelemetryProvider>
        {/* NavigationProvider layout dışında: /gorev-gecmisi yeni sekmede de context + broadcast alsın */}
        <NavigationProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<DashboardLayout />}>
                <Route index element={<DashboardPage />} />
                {/* Modal yerine sayfa — Sidebar target=_blank ile canlı nav sekmesinden ayrılır */}
                <Route path="gorev-gecmisi" element={<TaskHistoryPage />} />
                <Route path="muhendis" element={<EngineerPage />} />
                <Route path="otonom" element={<Navigate to="/" replace />} />
                <Route path="canli-izleme" element={<Navigate to="/" replace />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </NavigationProvider>
      </TelemetryProvider>
    </RosProvider>
  );
}

export default App;
