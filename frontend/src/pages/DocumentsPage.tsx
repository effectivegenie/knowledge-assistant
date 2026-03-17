import { useState, useEffect, useCallback } from 'react';
import { Table, Button, Input, Typography, Space, Popconfirm, message, Drawer, Select, Upload, Empty } from 'antd';
import type { UploadFile } from 'antd';
import { SearchOutlined, FolderOutlined, EyeOutlined, DeleteOutlined, UploadOutlined, InboxOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';
import { adminApiUrl } from '../config';

const { Dragger } = Upload;

const BUSINESS_GROUPS = [
  'financial', 'accounting', 'operations', 'marketing', 'IT',
  'warehouse', 'security', 'logistics', 'sales', 'design', 'HR',
];

const DOCUMENT_TAG_OPTIONS = [
  { label: 'general — достъпни за всички', value: 'general' },
  ...BUSINESS_GROUPS.map(g => ({ label: g, value: g })),
];

const ACCEPTED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'text/markdown', 'text/html', 'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff', 'image/bmp',
]);
const ACCEPTED_EXT = /\.(pdf|docx?|txt|md|html?|csv|xlsx?|pptx?|jpe?g|png|gif|webp|tiff?|bmp)$/i;

const DRAWER_STYLES = {
  header: { background: '#1e3a5f', borderBottom: '2px solid #e6a800', padding: '16px 20px' },
  body:   { paddingTop: 24 },
  footer: { borderTop: '1px solid #f0f4fb' },
};

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
  const { user, idToken } = useAuth();
  const tenantId = user?.tenantId ?? 'default';
  const { listDocuments, deleteDocument, getViewUrl } = useDocumentsApi();
  const [allItems, setAllItems] = useState<DocItem[]>([]);
  const [loading, setLoading]   = useState(false);
  const [search, setSearch]     = useState('');

  // Upload state
  const [uploadOpen, setUploadOpen]         = useState(false);
  const [uploadFileList, setUploadFileList] = useState<UploadFile[]>([]);
  const [uploadGroups, setUploadGroups]     = useState<string[]>([]);
  const [uploadCategory, setUploadCategory] = useState<'general' | 'invoice' | 'contract'>('general');
  const [uploading, setUploading]           = useState(false);

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

  const resetUploadDrawer = () => {
    setUploadOpen(false);
    setUploadFileList([]);
    setUploadGroups([]);
    setUploadCategory('general');
  };

  const handleUpload = async () => {
    if (uploadFileList.length === 0) return;
    setUploading(true);
    let successCount = 0;
    for (const fileWrapper of uploadFileList) {
      const f = fileWrapper as unknown as File;
      try {
        const effectiveGroups = uploadGroups.length > 0 ? uploadGroups : ['general'];
        const res = await fetch(`${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}/upload-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ filename: f.name, groups: effectiveGroups, category: uploadCategory }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        const { url, metadataUrl, category } = data;

        const metadata = JSON.stringify({ metadataAttributes: { tenantId, groups: effectiveGroups, category } });
        const metaRes = await fetch(metadataUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: metadata,
        });
        if (!metaRes.ok) throw new Error('Metadata upload failed');

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.onload = () => (xhr.status === 200 || xhr.status === 204) ? resolve() : reject(new Error(`S3 upload failed: ${xhr.status}`));
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.open('PUT', url);
          xhr.setRequestHeader('Content-Type', f.type || 'application/octet-stream');
          xhr.send(f);
        });

        successCount++;
      } catch (e) {
        message.error(`${f.name}: ${e instanceof Error ? e.message : 'Грешка при качване'}`);
      }
    }
    setUploading(false);
    if (successCount > 0) {
      message.success(`${successCount} файл${successCount !== 1 ? 'а' : ''} качен`);
      resetUploadDrawer();
      fetchDocuments();
    }
  };

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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <Space size={10}>
          <FolderOutlined style={{ fontSize: 22, color: BLUE }} />
          <Title level={4} style={{ margin: 0, color: BLUE }}>Документи</Title>
        </Space>
        <Button type="primary" icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>
          Качи документи
        </Button>
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
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={<span style={{ color: '#888' }}>Няма качени документи</span>}
            >
              <Button type="primary" icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>
                Качи първия документ
              </Button>
            </Empty>
          ),
        }}
      />
      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Качи документи</span>}
        placement="right"
        open={uploadOpen}
        onClose={resetUploadDrawer}
        width={440}
        closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
        styles={DRAWER_STYLES}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={resetUploadDrawer} disabled={uploading}>Отказ</Button>
            <Button
              type="primary"
              icon={<UploadOutlined />}
              loading={uploading}
              disabled={uploadFileList.length === 0}
              onClick={handleUpload}
            >
              Качи{uploadFileList.length > 0 ? ` (${uploadFileList.length})` : ''}
            </Button>
          </Space>
        }
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          Файловете се качват в базата знания на <strong>{tenantId}</strong> и се индексират автоматично.
        </Text>
        <div style={{ marginBottom: 16 }}>
          <Text strong style={{ display: 'block', marginBottom: 6 }}>Категория</Text>
          <Select
            value={uploadCategory}
            onChange={v => setUploadCategory(v)}
            style={{ width: '100%' }}
            options={[
              { value: 'general',  label: 'Общи — само база знания' },
              { value: 'invoice',  label: 'Фактури — база знания + обработка на фактури' },
              { value: 'contract', label: 'Договори — база знания + обработка на договори' },
            ]}
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <Text strong style={{ display: 'block', marginBottom: 6 }}>Групи за достъп</Text>
          <Select
            mode="multiple"
            options={DOCUMENT_TAG_OPTIONS}
            value={uploadGroups}
            onChange={setUploadGroups}
            placeholder="Избери групи (оставете празно за достъп от всички)"
            style={{ width: '100%' }}
            allowClear
          />
        </div>
        <Dragger
          multiple
          fileList={uploadFileList}
          beforeUpload={(file) => {
            const valid = ACCEPTED_MIME.has(file.type) || ACCEPTED_EXT.test(file.name);
            if (!valid) {
              message.error(`${file.name}: неподдържан формат`);
              return Upload.LIST_IGNORE;
            }
            setUploadFileList(prev => [...prev, file as unknown as UploadFile]);
            return false;
          }}
          onRemove={(file) => {
            setUploadFileList(prev => prev.filter(f => f.uid !== file.uid));
          }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined style={{ color: BLUE, fontSize: 48 }} />
          </p>
          <p className="ant-upload-text">Кликни или провлачи файлове тук</p>
          <p className="ant-upload-hint">PDF, Word, Excel, PowerPoint, CSV, Markdown, текст, изображения</p>
        </Dragger>
      </Drawer>
    </div>
  );
}
