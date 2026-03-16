import { useState, useEffect, useCallback } from 'react';
import { Table, Button, Input, Typography, Space, Popconfirm, message } from 'antd';
import { SearchOutlined, FolderOutlined, EyeOutlined, DeleteOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';
import { adminApiUrl } from '../config';

const { Title, Text } = Typography;

const BLUE = '#1e3a5f';

const fmtDate = (d?: string | null) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

interface DocItem {
  key: string;
  fullKey: string;
  size: number;
  lastModified: string;
  filename: string;
}

// ── Shared hook ──────────────────────────────────────────────────────────────

function useDocumentsApi() {
  const { user, idToken } = useAuth();
  const tenantId = user?.tenantId ?? 'default';
  const base = `${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}`;

  const listDocuments = useCallback(async (page: number, pageSize: number, search: string) => {
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (search) qs.set('search', search);
    const res = await fetch(`${base}/documents?${qs}`, { headers: { Authorization: `Bearer ${idToken}` } });
    if (!res.ok) throw new Error(res.statusText);
    return res.json();
  }, [base, idToken]);

  const deleteDocument = useCallback(async (key: string) => {
    const res = await fetch(`${base}/documents?key=${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || res.statusText);
    }
    return res.json();
  }, [base, idToken]);

  const getViewUrl = useCallback(async (key: string): Promise<string> => {
    const res = await fetch(`${base}/documents/view-url?key=${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) throw new Error('Failed to get view URL');
    const d = await res.json();
    return d.url;
  }, [base, idToken]);

  return { listDocuments, deleteDocument, getViewUrl };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DocumentsPage() {
  const { listDocuments, deleteDocument, getViewUrl } = useDocumentsApi();
  const [allItems, setAllItems] = useState<DocItem[]>([]);
  const [loading, setLoading]   = useState(false);
  const [search, setSearch]     = useState('');

  const fetchDocuments = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listDocuments(0, 1000, '');
      setAllItems(data.items || []);
    } catch {
      message.error('Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, [listDocuments]);

  useEffect(() => { fetchDocuments(); }, []);

  const filtered = allItems.filter(i =>
    !search || i.filename.toLowerCase().includes(search.toLowerCase())
  );

  const columns = [
    {
      title: 'Файл',
      dataIndex: 'filename',
      key: 'filename',
      sorter: (a: DocItem, b: DocItem) => a.filename.localeCompare(b.filename),
      render: (v: string) => <Text>{v}</Text>,
    },
    {
      title: 'Размер',
      dataIndex: 'size',
      key: 'size',
      sorter: (a: DocItem, b: DocItem) => a.size - b.size,
      render: (v: number) => `${(v / 1024).toFixed(1)} KB`,
    },
    {
      title: 'Дата качване',
      dataIndex: 'lastModified',
      key: 'lastModified',
      sorter: (a: DocItem, b: DocItem) => (a.lastModified || '').localeCompare(b.lastModified || ''),
      render: fmtDate,
    },
    {
      title: '',
      key: 'actions',
      width: 90,
      render: (_: unknown, record: DocItem) => (
        <Space size={0}>
          <Button
            type="text"
            icon={<EyeOutlined />}
            title="Преглед"
            style={{ color: BLUE }}
            onClick={async () => {
              try {
                const url = await getViewUrl(record.key);
                window.open(url, '_blank');
              } catch {
                message.error('Could not load document URL');
              }
            }}
          />
          <Popconfirm
            title="Изтрий документа?"
            onConfirm={async () => {
              try {
                await deleteDocument(record.key);
                message.success('Изтрит');
                fetchDocuments();
              } catch (e) {
                message.error(e instanceof Error ? e.message : 'Грешка');
              }
            }}
            okText="Изтрий"
            okButtonProps={{ danger: true }}
          >
            <Button type="text" icon={<DeleteOutlined />} danger title="Изтрий" />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: '24px 32px', height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20, gap: 10 }}>
        <FolderOutlined style={{ fontSize: 22, color: BLUE }} />
        <Title level={4} style={{ margin: 0, color: BLUE }}>Документи</Title>
      </div>
      <div style={{ marginBottom: 12 }}>
        <Input
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          placeholder="Търсене по файл…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          allowClear
          style={{ width: 280 }}
        />
      </div>
      <Table
        loading={loading}
        dataSource={filtered}
        rowKey="key"
        columns={columns}
        pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false, showTotal: tot => `${tot} документа` }}
        bordered
        size="small"
      />
    </div>
  );
}
