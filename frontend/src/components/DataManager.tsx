import React, { useState } from 'react';
import { Search, Plus, Trash2, Filter, CheckCircle, Clock, AlertCircle } from 'lucide-react';

export interface DataItem {
  id: string;
  code: string;
  name: string;
  category: string;
  status: 'active' | 'pending' | 'completed' | 'failed';
  lastUpdated: string;
  value: number;
}

interface DataManagerProps {
  items: DataItem[];
  onAddItem: (newItem: { name: string; category: string; value: number }) => Promise<boolean>;
  onUpdateStatus: (id: string, status: DataItem['status']) => void;
  onDeleteItem: (id: string) => void;
  isLoading: boolean;
}

export const DataManager: React.FC<DataManagerProps> = ({
  items,
  onAddItem,
  onUpdateStatus,
  onDeleteItem,
  isLoading,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [showAddModal, setShowAddModal] = useState(false);

  // Form states
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState('Distribusi');
  const [newValue, setNewValue] = useState(1000);
  const [isSaving, setIsSaving] = useState(false);

  const categories = ['All', 'Distribusi', 'Pelanggan', 'Metering', 'Tagihan', 'Audit'];

  const filteredItems = items.filter((item) => {
    const matchesSearch =
      item.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.category.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === 'All' || item.category.toLowerCase() === selectedCategory.toLowerCase();
    return matchesSearch && matchesCategory;
  });

  const handleSubmitNewItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setIsSaving(true);
    try {
      const wasSaved = await onAddItem({ name: newName, category: newCategory, value: Number(newValue) });
      if (wasSaved) {
        setNewName('');
        setShowAddModal(false);
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="glass-panel" style={{ padding: '24px', marginBottom: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Kelola Data SIPGN</h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Daftar berkas, status sinkronisasi, dan catatan operasional
          </p>
        </div>

        <button className="btn-primary" onClick={() => setShowAddModal(true)}>
          <Plus size={16} />
          <span>Tambah Data Baru</span>
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '18px', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: '220px' }}>
          <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            type="text"
            className="input-field"
            placeholder="Cari kode, nama, atau kategori..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ paddingLeft: '38px', width: '100%' }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Filter size={16} color="var(--text-muted)" />
          <select
            className="input-field"
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            style={{ cursor: 'pointer' }}
          >
            {categories.map((cat) => (
              <option key={cat} value={cat} style={{ background: '#111827', color: '#fff' }}>
                {cat}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table className="custom-table">
          <thead>
            <tr>
              <th>Kode</th>
              <th>Nama Modul / Data</th>
              <th>Kategori</th>
              <th>Nilai</th>
              <th>Status</th>
              <th>Terakhir Diperbarui</th>
              <th style={{ textAlign: 'right' }}>Aksi</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
                  Memuat data dari server...
                </td>
              </tr>
            ) : filteredItems.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
                  Tidak ada data yang ditemukan.
                </td>
              </tr>
            ) : (
              filteredItems.map((item) => (
                <tr key={item.id}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--accent-cyan)' }}>
                    {item.code}
                  </td>
                  <td style={{ fontWeight: 600 }}>{item.name}</td>
                  <td>
                    <span style={{ padding: '2px 8px', borderRadius: '6px', background: 'rgba(255, 255, 255, 0.05)', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                      {item.category}
                    </span>
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{item.value.toLocaleString('id-ID')}</td>
                  <td>
                    <span className={`badge badge-${item.status}`}>
                      {item.status === 'completed' && <CheckCircle size={12} />}
                      {item.status === 'active' && <Clock size={12} />}
                      {item.status === 'pending' && <Clock size={12} />}
                      {item.status === 'failed' && <AlertCircle size={12} />}
                      {item.status}
                    </span>
                  </td>
                  <td style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    {new Date(item.lastUpdated).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                      <select
                        className="input-field"
                        value={item.status}
                        onChange={(e) => onUpdateStatus(item.id, e.target.value as DataItem['status'])}
                        style={{ padding: '4px 8px', fontSize: '0.75rem' }}
                      >
                        <option value="active" style={{ background: '#111827' }}>Active</option>
                        <option value="pending" style={{ background: '#111827' }}>Pending</option>
                        <option value="completed" style={{ background: '#111827' }}>Completed</option>
                        <option value="failed" style={{ background: '#111827' }}>Failed</option>
                      </select>
                      <button
                        onClick={() => onDeleteItem(item.id)}
                        style={{
                          background: 'rgba(244, 63, 94, 0.1)',
                          border: '1px solid rgba(244, 63, 94, 0.2)',
                          color: 'var(--accent-rose)',
                          borderRadius: '8px',
                          padding: '6px 8px',
                          cursor: 'pointer',
                        }}
                        title="Hapus Data"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Modal Add Item */}
      {showAddModal && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div className="glass-panel" style={{ width: '100%', maxWidth: '440px', padding: '28px', background: '#111827' }}>
            <h3 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '16px' }}>Tambah Data SIPGN</h3>
            <form onSubmit={handleSubmitNewItem} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>Nama Modul / Tugas</label>
                <input
                  type="text"
                  className="input-field"
                  style={{ width: '100%' }}
                  placeholder="Contoh: Metering Gas Stasiun X"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  required
                />
              </div>

              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>Kategori</label>
                <select
                  className="input-field"
                  style={{ width: '100%' }}
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                >
                  <option value="Distribusi" style={{ background: '#111827' }}>Distribusi</option>
                  <option value="Pelanggan" style={{ background: '#111827' }}>Pelanggan</option>
                  <option value="Metering" style={{ background: '#111827' }}>Metering</option>
                  <option value="Tagihan" style={{ background: '#111827' }}>Tagihan</option>
                  <option value="Audit" style={{ background: '#111827' }}>Audit</option>
                </select>
              </div>

              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '4px' }}>Nilai / Kapasitas</label>
                <input
                  type="number"
                  className="input-field"
                  style={{ width: '100%' }}
                  value={newValue}
                  onChange={(e) => setNewValue(Number(e.target.value))}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
                <button type="button" className="btn-secondary" onClick={() => setShowAddModal(false)}>
                  Batal
                </button>
                <button type="submit" className="btn-primary" disabled={isSaving}>
                  {isSaving ? 'Menyimpan...' : 'Simpan Data'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
