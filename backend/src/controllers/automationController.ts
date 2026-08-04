import { Request, Response } from 'express';

export interface AutomationTask {
  id: string;
  name: string;
  type: 'sync' | 'validation' | 'report' | 'export';
  status: 'idle' | 'running' | 'completed' | 'failed';
  lastRun?: string;
  intervalMinutes: number;
}

export interface AutomationLog {
  id: string;
  timestamp: string;
  taskId: string;
  taskName: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

let mockTasks: AutomationTask[] = [
  { id: 'task-1', name: 'Auto-Sync Metering Data', type: 'sync', status: 'idle', lastRun: new Date(Date.now() - 3600000).toISOString(), intervalMinutes: 15 },
  { id: 'task-2', name: 'Auto-Validasi Tagihan Pelanggan', type: 'validation', status: 'idle', lastRun: new Date(Date.now() - 7200000).toISOString(), intervalMinutes: 60 },
  { id: 'task-3', name: 'Generate Laporan Harian SIPGN', type: 'report', status: 'idle', lastRun: new Date(Date.now() - 86400000).toISOString(), intervalMinutes: 1440 },
  { id: 'task-4', name: 'Export Backup Data Rekonsiliasi', type: 'export', status: 'idle', lastRun: new Date(Date.now() - 43200000).toISOString(), intervalMinutes: 720 }
];

let mockLogs: AutomationLog[] = [
  { id: 'log-1', timestamp: new Date(Date.now() - 300000).toISOString(), taskId: 'task-1', taskName: 'Auto-Sync Metering Data', level: 'success', message: 'Berhasil menyinkronkan 142 record data metering dari server utama.' },
  { id: 'log-2', timestamp: new Date(Date.now() - 900000).toISOString(), taskId: 'task-2', taskName: 'Auto-Validasi Tagihan Pelanggan', level: 'info', message: 'Memulai validasi tagihan untuk 45 akun komersial.' },
  { id: 'log-3', timestamp: new Date(Date.now() - 1800000).toISOString(), taskId: 'task-2', taskName: 'Auto-Validasi Tagihan Pelanggan', level: 'warn', message: 'Terdapat 2 akun dengan selisih pembacaan meter > 5%.' },
  { id: 'log-4', timestamp: new Date(Date.now() - 3600000).toISOString(), taskId: 'task-3', taskName: 'Generate Laporan Harian SIPGN', level: 'success', message: 'Laporan PDF & Excel harian berhasil dibentuk di storage.' }
];

const MAX_LOG_ENTRIES = 500;

const prependLog = (log: AutomationLog) => {
  mockLogs.unshift(log);
  if (mockLogs.length > MAX_LOG_ENTRIES) {
    mockLogs.length = MAX_LOG_ENTRIES;
  }
};

export const getTasks = (req: Request, res: Response) => {
  res.json({ success: true, data: mockTasks });
};

export const getLogs = (req: Request, res: Response) => {
  res.json({ success: true, data: mockLogs });
};

export const runTask = (req: Request, res: Response) => {
  const { taskId } = req.params;
  const task = mockTasks.find(t => t.id === taskId);

  if (!task) {
    res.status(404).json({ success: false, message: 'Task not found' });
    return;
  }

  if (task.status === 'running') {
    res.status(409).json({ success: false, message: `Task '${task.name}' is already running` });
    return;
  }

  task.status = 'running';
  
  // Add log entry
  const startLog: AutomationLog = {
    id: `log-${Date.now()}-start`,
    timestamp: new Date().toISOString(),
    taskId: task.id,
    taskName: task.name,
    level: 'info',
    message: `Proses '${task.name}' mulai dijalankan...`
  };
  prependLog(startLog);

  // Simulate async task execution finish
  setTimeout(() => {
    task.status = 'completed';
    task.lastRun = new Date().toISOString();
    
    const finishLog: AutomationLog = {
      id: `log-${Date.now()}-end`,
      timestamp: new Date().toISOString(),
      taskId: task.id,
      taskName: task.name,
      level: 'success',
      message: `Proses '${task.name}' selesai dilaksanakan dengan sukses.`
    };
    prependLog(finishLog);
  }, 2500);

  res.json({ success: true, message: `Task '${task.name}' started`, data: task });
};
