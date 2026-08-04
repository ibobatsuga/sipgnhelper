import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { OverviewCards } from './components/OverviewCards';
import { DataManager, DataItem } from './components/DataManager';
import { AutomationRunner, AutomationTask } from './components/AutomationRunner';
import { LogConsole, AutomationLog } from './components/LogConsole';

export const App: React.FC = () => {
  const [serverStatus, setServerStatus] = useState<'connected' | 'disconnected' | 'checking'>('checking');
  const [dataItems, setDataItems] = useState<DataItem[]>([]);
  const [automationTasks, setAutomationTasks] = useState<AutomationTask[]>([]);
  const [logs, setLogs] = useState<AutomationLog[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [lastRefreshTime, setLastRefreshTime] = useState<string>('');
  const [requestError, setRequestError] = useState<string>('');

  const fetchBackendData = async () => {
    setIsLoading(true);
    setServerStatus('checking');
    try {
      const healthRes = await fetch('/api/health');
      if (healthRes.ok) {
        setServerStatus('connected');
      } else {
        setServerStatus('disconnected');
      }

      // Fetch Data Items
      const dataRes = await fetch('/api/data');
      if (dataRes.ok) {
        const json = await dataRes.json();
        setDataItems(json.data || []);
      }

      // Fetch Tasks
      const taskRes = await fetch('/api/automation/tasks');
      if (taskRes.ok) {
        const json = await taskRes.json();
        setAutomationTasks(json.data || []);
      }

      // Fetch Logs
      const logRes = await fetch('/api/automation/logs');
      if (logRes.ok) {
        const json = await logRes.json();
        setLogs(json.data || []);
      }

      setLastRefreshTime(new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }));
    } catch (err) {
      console.warn('Backend server disconnected or unreachable:', err);
      setServerStatus('disconnected');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchBackendData();

    // Auto-refresh daily (check every 5 minutes)
    const interval = setInterval(() => {
      fetchBackendData();
    }, 300000);

    // Auto refresh when user comes back to the browser tab
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        fetchBackendData();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const handleAddItem = async (newItem: { name: string; category: string; value: number }): Promise<boolean> => {
    setRequestError('');
    try {
      const res = await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newItem),
      });
      if (res.ok) {
        await fetchBackendData();
        return true;
      }
      const body = await res.json().catch(() => null);
      setRequestError(body?.message || 'Data tidak dapat disimpan. Silakan coba lagi.');
    } catch (err) {
      console.error('Error adding item:', err);
      setRequestError('Koneksi ke server gagal. Data tidak disimpan.');
    }
    return false;
  };

  const handleUpdateStatus = async (id: string, status: DataItem['status']) => {
    try {
      const res = await fetch(`/api/data/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        setDataItems((prev) =>
          prev.map((item) => (item.id === id ? { ...item, status, lastUpdated: new Date().toISOString() } : item))
        );
      } else {
        setRequestError('Status data tidak dapat diperbarui. Data terbaru dimuat ulang.');
        await fetchBackendData();
      }
    } catch (err) {
      console.error('Error updating status:', err);
    }
  };

  const handleDeleteItem = async (id: string) => {
    try {
      const res = await fetch(`/api/data/${id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setDataItems((prev) => prev.filter((item) => item.id !== id));
      } else {
        setRequestError('Data tidak dapat dihapus. Data terbaru dimuat ulang.');
        await fetchBackendData();
      }
    } catch (err) {
      console.error('Error deleting item:', err);
    }
  };

  const handleRunTask = async (taskId: string) => {
    try {
      // Optimistic update
      setAutomationTasks((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status: 'running' } : t))
      );

      const res = await fetch(`/api/automation/tasks/${taskId}/run`, {
        method: 'POST',
      });
      if (res.ok) {
        setTimeout(() => {
          fetchBackendData();
        }, 3000);
      } else {
        setRequestError('Tugas tidak dapat dijalankan. Status terbaru dimuat ulang.');
        await fetchBackendData();
      }
    } catch (err) {
      console.error('Error running task:', err);
      setRequestError('Koneksi ke server gagal. Status terbaru dimuat ulang.');
      await fetchBackendData();
    }
  };

  const completedCount = dataItems.filter((i) => i.status === 'completed').length;
  const pendingCount = dataItems.filter((i) => i.status === 'pending').length;

  return (
    <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '24px 16px' }}>
      <Header serverStatus={serverStatus} lastRefreshTime={lastRefreshTime} onRefresh={fetchBackendData} />

      {requestError && (
        <p role="alert" style={{ margin: '0 0 16px', color: 'var(--accent-rose)' }}>
          {requestError}
        </p>
      )}

      <OverviewCards
        totalRecords={dataItems.length}
        activeTasks={automationTasks.length}
        completedTasks={completedCount}
        pendingSyncs={pendingCount}
      />

      <DataManager
        items={dataItems}
        onAddItem={handleAddItem}
        onUpdateStatus={handleUpdateStatus}
        onDeleteItem={handleDeleteItem}
        isLoading={isLoading}
      />

      <AutomationRunner tasks={automationTasks} onRunTask={handleRunTask} />

      <LogConsole logs={logs} onClearLogs={() => setLogs([])} />
    </div>
  );
};

export default App;
