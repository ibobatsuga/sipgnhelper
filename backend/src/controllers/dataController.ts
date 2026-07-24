import { Request, Response } from 'express';

export interface DataItem {
  id: string;
  code: string;
  name: string;
  category: string;
  status: 'active' | 'pending' | 'completed' | 'failed';
  lastUpdated: string;
  value: number;
}

let mockDataItems: DataItem[] = [
  { id: '1', code: 'SIP-1001', name: 'Pelaporan Distribusi Gas Wilayah I', category: 'Distribusi', status: 'completed', lastUpdated: new Date(Date.now() - 3600000).toISOString(), value: 4500 },
  { id: '2', code: 'SIP-1002', name: 'Rekonsiliasi Pelanggan Industri', category: 'Pelanggan', status: 'active', lastUpdated: new Date(Date.now() - 7200000).toISOString(), value: 12800 },
  { id: '3', code: 'SIP-1003', name: 'Sinkronisasi Metering Node Utama', category: 'Metering', status: 'active', lastUpdated: new Date(Date.now() - 10800000).toISOString(), value: 8900 },
  { id: '4', code: 'SIP-1004', name: 'Validasi Tagihan Bulanan Komersial', category: 'Tagihan', status: 'pending', lastUpdated: new Date(Date.now() - 86400000).toISOString(), value: 24500 },
  { id: '5', code: 'SIP-1005', name: 'Audit Log Akses & Keamanan Sistem', category: 'Audit', status: 'completed', lastUpdated: new Date(Date.now() - 172800000).toISOString(), value: 1200 }
];

export const getDataItems = (req: Request, res: Response) => {
  const { category, search, status } = req.query;
  let results = [...mockDataItems];

  if (category && typeof category === 'string' && category !== 'All') {
    results = results.filter(item => item.category.toLowerCase() === category.toLowerCase());
  }

  if (status && typeof status === 'string' && status !== 'All') {
    results = results.filter(item => item.status === status);
  }

  if (search && typeof search === 'string') {
    const q = search.toLowerCase();
    results = results.filter(item => 
      item.code.toLowerCase().includes(q) || 
      item.name.toLowerCase().includes(q) || 
      item.category.toLowerCase().includes(q)
    );
  }

  res.json({
    success: true,
    total: results.length,
    data: results
  });
};

export const addDataItem = (req: Request, res: Response) => {
  const { name, category, value } = req.body;
  if (!name || !category) {
    res.status(400).json({ success: false, message: 'Name and category are required' });
    return;
  }

  const newItem: DataItem = {
    id: (mockDataItems.length + 1).toString(),
    code: `SIP-${1000 + mockDataItems.length + 1}`,
    name,
    category,
    status: 'pending',
    lastUpdated: new Date().toISOString(),
    value: Number(value) || 0
  };

  mockDataItems.unshift(newItem);
  res.status(201).json({ success: true, data: newItem });
};

export const updateDataItemStatus = (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;

  const item = mockDataItems.find(i => i.id === id);
  if (!item) {
    res.status(404).json({ success: false, message: 'Item not found' });
    return;
  }

  if (status) {
    item.status = status;
    item.lastUpdated = new Date().toISOString();
  }

  res.json({ success: true, data: item });
};

export const deleteDataItem = (req: Request, res: Response) => {
  const { id } = req.params;
  const index = mockDataItems.findIndex(i => i.id === id);
  
  if (index === -1) {
    res.status(404).json({ success: false, message: 'Item not found' });
    return;
  }

  mockDataItems.splice(index, 1);
  res.json({ success: true, message: 'Item deleted successfully' });
};
