import React from 'react';
import { Play, RotateCw, Settings, CheckCircle2, Clock } from 'lucide-react';

export interface AutomationTask {
  id: string;
  name: string;
  type: 'sync' | 'validation' | 'report' | 'export';
  status: 'idle' | 'running' | 'completed' | 'failed';
  lastRun?: string;
  intervalMinutes: number;
}

interface AutomationRunnerProps {
  tasks: AutomationTask[];
  onRunTask: (taskId: string) => void;
}

export const AutomationRunner: React.FC<AutomationRunnerProps> = ({ tasks, onRunTask }) => {
  return (
    <div className="glass-panel" style={{ padding: '24px', marginBottom: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
        <div>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Otomatisasi & Batch Jobs</h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Jalankan tugas terjadwal dan sinkronisasi otomatis SIPGN
          </p>
        </div>
        <button className="btn-secondary" style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
          <Settings size={14} />
          <span>Pengaturan Jadwal</span>
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px' }}>
        {tasks.map((task) => (
          <div
            key={task.id}
            style={{
              padding: '16px',
              borderRadius: '12px',
              background: 'rgba(15, 23, 42, 0.6)',
              border: '1px solid var(--border-card)',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: '12px',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--accent-cyan)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {task.type}
                </span>
                <span className={`badge badge-${task.status}`}>
                  {task.status === 'running' && <RotateCw size={12} className="spin-animation" />}
                  {task.status === 'completed' && <CheckCircle2 size={12} />}
                  {task.status === 'idle' && <Clock size={12} />}
                  {task.status}
                </span>
              </div>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '4px' }}>{task.name}</h4>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Interval: Interval per {task.intervalMinutes} menit
              </p>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '10px', borderTop: '1px solid rgba(255, 255, 255, 0.04)' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                Terakhir: {task.lastRun ? new Date(task.lastRun).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-'}
              </span>
              <button
                className="btn-primary"
                style={{ padding: '6px 14px', fontSize: '0.8rem' }}
                disabled={task.status === 'running'}
                onClick={() => onRunTask(task.id)}
              >
                {task.status === 'running' ? (
                  <>
                    <RotateCw size={14} className="spin-animation" />
                    <span>Proses...</span>
                  </>
                ) : (
                  <>
                    <Play size={14} />
                    <span>Jalankan</span>
                  </>
                )}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
