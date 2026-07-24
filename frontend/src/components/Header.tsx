import React from 'react';
import { Activity, Database, Cpu, RefreshCw, Zap } from 'lucide-react';

interface HeaderProps {
  serverStatus: 'connected' | 'disconnected' | 'checking';
  onRefresh: () => void;
}

export const Header: React.FC<HeaderProps> = ({ serverStatus, onRefresh }) => {
  return (
    <header className="glass-panel" style={{ padding: '16px 28px', marginBottom: '24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <div style={{
          width: '42px',
          height: '42px',
          borderRadius: '12px',
          background: 'linear-gradient(135deg, #6366f1, #06b6d4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 16px rgba(99, 102, 241, 0.4)'
        }}>
          <Zap size={24} color="#ffffff" />
        </div>
        <div>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 800, letterSpacing: '-0.02em', background: 'linear-gradient(90deg, #ffffff, #9ca3af)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            SIPGN HELPER
          </h1>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Data Management & System Automation Assistant
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 14px',
          borderRadius: '20px',
          background: 'rgba(255, 255, 255, 0.04)',
          border: '1px solid var(--border-card)',
          fontSize: '0.8rem'
        }}>
          <div style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: serverStatus === 'connected' ? '#10b981' : serverStatus === 'checking' ? '#f59e0b' : '#f43f5e',
            boxShadow: serverStatus === 'connected' ? '0 0 8px #10b981' : 'none'
          }} />
          <span style={{ color: 'var(--text-secondary)' }}>
            Backend API: <strong style={{ color: 'var(--text-primary)' }}>{serverStatus === 'connected' ? 'Online (5001)' : serverStatus === 'checking' ? 'Connecting...' : 'Offline'}</strong>
          </span>
        </div>

        <button className="btn-secondary" onClick={onRefresh} title="Refresh Data">
          <RefreshCw size={16} />
          <span>Refresh</span>
        </button>
      </div>
    </header>
  );
};
