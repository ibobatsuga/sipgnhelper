import React from 'react';
import { Database, PlayCircle, CheckCircle2, Clock } from 'lucide-react';

interface OverviewProps {
  totalRecords: number;
  activeTasks: number;
  completedTasks: number;
  pendingSyncs: number;
}

export const OverviewCards: React.FC<OverviewProps> = ({
  totalRecords,
  activeTasks,
  completedTasks,
  pendingSyncs,
}) => {
  const cards = [
    {
      title: 'Total Data Item',
      value: totalRecords,
      icon: Database,
      color: '#6366f1',
      bgGlow: 'rgba(99, 102, 241, 0.12)',
    },
    {
      title: 'Tugas Otomatisasi',
      value: activeTasks,
      icon: PlayCircle,
      color: '#06b6d4',
      bgGlow: 'rgba(6, 182, 212, 0.12)',
    },
    {
      title: 'Proses Selesai',
      value: completedTasks,
      icon: CheckCircle2,
      color: '#10b981',
      bgGlow: 'rgba(16, 185, 129, 0.12)',
    },
    {
      title: 'Pending Sinkronisasi',
      value: pendingSyncs,
      icon: Clock,
      color: '#f59e0b',
      bgGlow: 'rgba(245, 158, 11, 0.12)',
    },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '24px' }}>
      {cards.map((card, index) => {
        const IconComponent = card.icon;
        return (
          <div key={index} className="glass-panel" style={{ padding: '20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '6px', fontWeight: 500 }}>
                {card.title}
              </p>
              <h2 style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                {card.value}
              </h2>
            </div>
            <div style={{
              width: '46px',
              height: '46px',
              borderRadius: '12px',
              background: card.bgGlow,
              border: `1px solid ${card.color}33`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <IconComponent size={22} color={card.color} />
            </div>
          </div>
        );
      })}
    </div>
  );
};
