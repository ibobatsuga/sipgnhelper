import React from 'react';
import { Terminal, ShieldCheck, AlertTriangle, Info, CheckCircle2 } from 'lucide-react';

export interface AutomationLog {
  id: string;
  timestamp: string;
  taskId: string;
  taskName: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

interface LogConsoleProps {
  logs: AutomationLog[];
  onClearLogs?: () => void;
}

export const LogConsole: React.FC<LogConsoleProps> = ({ logs, onClearLogs }) => {
  const getLogIcon = (level: AutomationLog['level']) => {
    switch (level) {
      case 'success':
        return <CheckCircle2 size={13} color="var(--accent-emerald)" />;
      case 'warn':
        return <AlertTriangle size={13} color="var(--accent-amber)" />;
      case 'error':
        return <AlertTriangle size={13} color="var(--accent-rose)" />;
      default:
        return <Info size={13} color="var(--accent-cyan)" />;
    }
  };

  const getLogColor = (level: AutomationLog['level']) => {
    switch (level) {
      case 'success':
        return '#10b981';
      case 'warn':
        return '#f59e0b';
      case 'error':
        return '#f43f5e';
      default:
        return '#38bdf8';
    }
  };

  return (
    <div className="glass-panel" style={{ padding: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Terminal size={18} color="var(--accent-cyan)" />
          <h3 style={{ fontSize: '1.05rem', fontWeight: 700 }}>Konsol Log Aktivitas System</h3>
        </div>
        {onClearLogs && (
          <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: '0.75rem' }} onClick={onClearLogs}>
            Bersihkan Log
          </button>
        )}
      </div>

      <div className="console-box">
        {logs.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'center', margin: '20px 0' }}>
            Belum ada log aktivitas...
          </p>
        ) : (
          logs.map((log) => (
            <div key={log.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '8px', lineHeight: 1.4 }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', flexShrink: 0 }}>
                [{new Date(log.timestamp).toLocaleTimeString('id-ID')}]
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0, marginTop: '2px' }}>
                {getLogIcon(log.level)}
              </div>
              <span style={{ color: 'var(--accent-cyan)', fontWeight: 600, flexShrink: 0 }}>
                [{log.taskName}]
              </span>
              <span style={{ color: getLogColor(log.level), wordBreak: 'break-word' }}>
                {log.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
