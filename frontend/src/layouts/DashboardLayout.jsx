import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from '../components/dashboard/Sidebar';
import TopBar from '../components/dashboard/TopBar';

export default function DashboardLayout() {
  return (
    <div className="dashboard">
      <div className="dashboard-body">
        <Sidebar />

        <div className="workspace">
          <TopBar />
          <Outlet />
        </div>
      </div>
    </div>
  );
}
