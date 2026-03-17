import { useState, useEffect, useCallback } from 'react';
import {
  Tabs, Table, Button, Input, InputNumber, Tag, Space, Typography, Drawer, Descriptions,
  Row, Col, Statistic, DatePicker, Popconfirm, message, Spin, Select, Form,
} from 'antd';
import {
  SearchOutlined, FileTextOutlined, EyeOutlined, CheckOutlined,
  CloseOutlined, SettingOutlined, CheckSquareOutlined, DeleteOutlined, UploadOutlined,
} from '@ant-design/icons';
import UploadDrawer from '../components/UploadDrawer';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import dayjs from 'dayjs';
import { useAuth } from '../auth/AuthContext';
import { adminApiUrl } from '../config';
import { t } from '../i18n';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

const BLUE       = '#1e3a5f';
const GOLD       = '#e6a800';
const GOLD_DARK  = '#c99200';

const DRAWER_STYLES = {
  header: { background: BLUE, borderBottom: `2px solid ${GOLD}`, padding: '16px 20px' },
  body:   { paddingTop: 24 },
  footer: { borderTop: '1px solid #f0f4fb' },
};

const STATUS_COLOR: Record<string, string> = {
  extracted:    'blue',
  review_needed:'orange',
  confirmed:    'green',
  paid:         'purple',
  rejected:     'red',
  pending:      'default',
};

const DIR_COLOR: Record<string, string> = {
  incoming: 'volcano',
  outgoing: 'geekblue',
};

const EUR = new Intl.NumberFormat('en-EU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtEur = (v?: number | null) => v != null ? `€ ${EUR.format(v)}` : '—';
const fmtDate = (d?: string | null) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

interface Invoice {
  invoiceId: string;
  tenantId: string;
  status: string;
  documentType: string;
  direction: string;
  invoiceNumber?: string;
  issueDate?: string;
  dueDate?: string;
  supplierName?: string;
  supplierVatNumber?: string;
  clientName?: string;
  clientVatNumber?: string;
  amountNet?: number;
  amountVat?: number;
  amountTotal?: number;
  confidence?: number;
  extractedAt?: string;
  confirmedAt?: string;
  paidAt?: string;
  s3Key?: string;
}

interface Stats {
  byMonth: { month: string; income: number; expenses: number }[];
  totals: { income: number; expenses: number; net: number; unpaid: number };
}


// ── Shared hook ──────────────────────────────────────────────────────────────

function useInvoicesApi() {
  const { user, idToken } = useAuth();
  const tenantId = user?.tenantId ?? 'default';
  const base = `${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}`;

  const updateStatus = useCallback(async (invoiceId: string, status: string) => {
    const res = await fetch(`${base}/invoices/${encodeURIComponent(invoiceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || res.statusText);
    }
    return res.json();
  }, [base, idToken]);

  const updateInvoiceFields = useCallback(async (invoiceId: string, body: Record<string, unknown>) => {
    const res = await fetch(`${base}/invoices/${encodeURIComponent(invoiceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || res.statusText);
    }
    return res.json();
  }, [base, idToken]);

  const getViewUrl = useCallback(async (invoiceId: string): Promise<string> => {
    const res = await fetch(`${base}/invoices/${encodeURIComponent(invoiceId)}/view-url`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) throw new Error('Failed to get view URL');
    const d = await res.json();
    return d.url;
  }, [base, idToken]);

  const deleteInvoice = useCallback(async (invoiceId: string) => {
    const res = await fetch(`${base}/invoices/${encodeURIComponent(invoiceId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || res.statusText);
    }
    return res.json();
  }, [base, idToken]);

  return { tenantId, idToken, base, updateStatus, updateInvoiceFields, getViewUrl, deleteInvoice };
}

// ── Invoices Tab ─────────────────────────────────────────────────────────────

function InvoicesTab() {
  const { idToken, base, updateStatus, getViewUrl, deleteInvoice } = useInvoicesApi();
  const [items, setItems]         = useState<Invoice[]>([]);
  const [total, setTotal]         = useState(0);
  const [loading, setLoading]     = useState(false);
  const [search, setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [dirFilter, setDirFilter] = useState<string | null>(null);
  const [dates, setDates]         = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);
  const [page, setPage]           = useState(0);
  const [selected, setSelected]   = useState<string[]>([]);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [viewing, setViewing]     = useState<Invoice | null>(null);
  const [viewUrl, setViewUrl]     = useState<string | null>(null);
  const [viewUrlLoading, setViewUrlLoading] = useState(false);

  const fetchInvoices = useCallback(async (p = 0) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(p), pageSize: '20' });
      if (statusFilter) qs.set('statuses', statusFilter); // single pick from confirmed/paid
      else              qs.set('statuses', 'confirmed,paid');
      if (dirFilter)    qs.set('direction', dirFilter);
      if (search)       qs.set('search', search);
      if (dates?.[0])   qs.set('dateFrom', dates[0].format('YYYY-MM-DD'));
      if (dates?.[1])   qs.set('dateTo',   dates[1].format('YYYY-MM-DD'));
      const res = await fetch(`${base}/invoices?${qs}`, { headers: { Authorization: `Bearer ${idToken}` } });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setItems(data.items || []);
      setTotal(data.total || 0);
      setPage(p);
    } catch {
      message.error('Failed to load invoices');
    } finally {
      setLoading(false);
    }
  }, [base, idToken, statusFilter, dirFilter, search, dates]);

  useEffect(() => { fetchInvoices(0); }, [statusFilter, dirFilter, dates]);

  const openViewer = async (inv: Invoice) => {
    setViewing(inv);
    setViewUrl(null);
    setViewUrlLoading(true);
    try {
      const url = await getViewUrl(inv.invoiceId);
      setViewUrl(url);
    } catch {
      message.error('Could not load document URL');
    } finally {
      setViewUrlLoading(false);
    }
  };

  const handleBulkConfirm = async () => {
    setBulkLoading(true);
    let ok = 0;
    for (const id of selected) {
      try { await updateStatus(id, 'confirmed'); ok++; } catch {}
    }
    setBulkLoading(false);
    if (ok > 0) { message.success(`${ok} потвърдени`); setSelected([]); fetchInvoices(page); }
  };

  const columns = [
    {
      title: 'Фактура №',
      dataIndex: 'invoiceNumber',
      key: 'invoiceNumber',
      sorter: (a: Invoice, b: Invoice) => (a.invoiceNumber || '').localeCompare(b.invoiceNumber || ''),
      render: (v?: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Дата',
      dataIndex: 'issueDate',
      key: 'issueDate',
      sorter: (a: Invoice, b: Invoice) => (a.issueDate || '').localeCompare(b.issueDate || ''),
      render: fmtDate,
    },
    {
      title: 'Посока',
      dataIndex: 'direction',
      key: 'direction',
      sorter: (a: Invoice, b: Invoice) => a.direction.localeCompare(b.direction),
      render: (v: string) => <Tag color={DIR_COLOR[v] ?? 'default'}>{t.direction(v)}</Tag>,
    },
    {
      title: 'Тип',
      dataIndex: 'documentType',
      key: 'documentType',
      sorter: (a: Invoice, b: Invoice) => a.documentType.localeCompare(b.documentType),
      render: (v: string) => <Tag>{t.invoiceType(v)}</Tag>,
    },
    {
      title: 'Доставчик',
      dataIndex: 'supplierName',
      key: 'supplierName',
      sorter: (a: Invoice, b: Invoice) => (a.supplierName || '').localeCompare(b.supplierName || ''),
      render: (v?: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Клиент',
      dataIndex: 'clientName',
      key: 'clientName',
      sorter: (a: Invoice, b: Invoice) => (a.clientName || '').localeCompare(b.clientName || ''),
      render: (v?: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Сума (EUR)',
      dataIndex: 'amountTotal',
      key: 'amountTotal',
      align: 'right' as const,
      sorter: (a: Invoice, b: Invoice) => (a.amountTotal ?? 0) - (b.amountTotal ?? 0),
      render: (v?: number) => fmtEur(v),
    },
    {
      title: 'Статус',
      dataIndex: 'status',
      key: 'status',
      sorter: (a: Invoice, b: Invoice) => a.status.localeCompare(b.status),
      render: (v: string) => <Tag color={STATUS_COLOR[v] ?? 'default'}>{t.status(v)}</Tag>,
    },
    {
      title: '',
      key: 'actions',
      width: 90,
      render: (_: unknown, record: Invoice) => (
        <Space size={0}>
          <Button
            type="text"
            icon={<EyeOutlined />}
            onClick={() => openViewer(record)}
            title="Преглед"
            style={{ color: BLUE }}
          />
          <Popconfirm
            title="Изтрий фактурата и всички файлове?"
            onConfirm={async () => { try { await deleteInvoice(record.invoiceId); message.success('Изтрита'); fetchInvoices(page); } catch(e) { message.error(e instanceof Error ? e.message : 'Грешка'); } }}
            okText="Изтрий"
            okButtonProps={{ danger: true }}
          >
            <Button type="text" icon={<DeleteOutlined />} danger title="Изтрий" />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const extractedSelected = selected.filter(id => items.find(i => i.invoiceId === id)?.status === 'extracted');

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <Input
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          placeholder="Търсене по №, доставчик, клиент…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onPressEnter={() => fetchInvoices(0)}
          allowClear
          onClear={() => { setSearch(''); fetchInvoices(0); }}
          style={{ width: 280 }}
        />
        <Select
          placeholder="Всички статуси"
          allowClear
          value={statusFilter}
          onChange={v => setStatusFilter(v ?? null)}
          style={{ width: 160 }}
          options={[
            { value: 'confirmed', label: t.status('confirmed') },
            { value: 'paid',      label: t.status('paid') },
          ]}
        />
        <Select
          placeholder="Всички посоки"
          allowClear
          value={dirFilter}
          onChange={v => setDirFilter(v ?? null)}
          style={{ width: 150 }}
          options={[
            { value: 'incoming', label: t.direction('incoming') },
            { value: 'outgoing', label: t.direction('outgoing') },
          ]}
        />
        <RangePicker
          value={dates}
          onChange={v => setDates(v as [dayjs.Dayjs | null, dayjs.Dayjs | null] | null)}
          format="DD MMM YYYY"
          placeholder={['От дата', 'До дата']}
          style={{ width: 260 }}
        />
        <Button onClick={() => fetchInvoices(0)} loading={loading}>Търсене</Button>
        {extractedSelected.length > 0 && (
          <Popconfirm
            title={`Потвърди ${extractedSelected.length} фактури?`}
            onConfirm={handleBulkConfirm}
            okText="Потвърди всички"
          >
            <Button icon={<CheckSquareOutlined />} type="primary" loading={bulkLoading}>
              Масово потвърждение ({extractedSelected.length})
            </Button>
          </Popconfirm>
        )}
      </div>
      <Table
        loading={loading}
        dataSource={items}
        rowKey="invoiceId"
        columns={columns}
        rowSelection={{ selectedRowKeys: selected, onChange: keys => setSelected(keys as string[]) }}
        pagination={{
          current: page + 1,
          pageSize: 20,
          total,
          hideOnSinglePage: true,
          showSizeChanger: false,
          showTotal: tot => `${tot} фактури`,
          onChange: p => fetchInvoices(p - 1),
        }}
        bordered
        size="small"
      />

      {/* View drawer */}
      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Детайли фактура</span>}
        placement="right"
        open={!!viewing}
        onClose={() => setViewing(null)}
        width={520}
        closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
        styles={DRAWER_STYLES}
      >
        {viewing && (
          <>
            <Descriptions column={1} bordered size="small" labelStyle={{ width: 150, color: BLUE }}>
              <Descriptions.Item label="Фактура №">{viewing.invoiceNumber || '—'}</Descriptions.Item>
              <Descriptions.Item label="Тип"><Tag>{t.invoiceType(viewing.documentType)}</Tag></Descriptions.Item>
              <Descriptions.Item label="Посока"><Tag color={DIR_COLOR[viewing.direction]}>{t.direction(viewing.direction)}</Tag></Descriptions.Item>
              <Descriptions.Item label="Статус"><Tag color={STATUS_COLOR[viewing.status]}>{t.status(viewing.status)}</Tag></Descriptions.Item>
              <Descriptions.Item label="Дата издаване">{fmtDate(viewing.issueDate)}</Descriptions.Item>
              <Descriptions.Item label="Дата плащане">{fmtDate(viewing.dueDate)}</Descriptions.Item>
              <Descriptions.Item label="Доставчик">{viewing.supplierName || '—'}</Descriptions.Item>
              <Descriptions.Item label="ДДС на доставчик">{viewing.supplierVatNumber || '—'}</Descriptions.Item>
              <Descriptions.Item label="Клиент">{viewing.clientName || '—'}</Descriptions.Item>
              <Descriptions.Item label="ДДС на клиент">{viewing.clientVatNumber || '—'}</Descriptions.Item>
              <Descriptions.Item label="Нето">{fmtEur(viewing.amountNet)}</Descriptions.Item>
              <Descriptions.Item label="ДДС">{fmtEur(viewing.amountVat)}</Descriptions.Item>
              <Descriptions.Item label="Общо"><strong>{fmtEur(viewing.amountTotal)}</strong></Descriptions.Item>
              <Descriptions.Item label="Точност">{viewing.confidence != null ? `${Math.round(viewing.confidence * 100)}%` : '—'}</Descriptions.Item>
            </Descriptions>
            <div style={{ marginTop: 16 }}>
              {viewUrlLoading ? (
                <Spin size="small" />
              ) : viewUrl ? (
                <Button
                  type="primary"
                  icon={<EyeOutlined />}
                  href={viewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Виж оригинален документ
                </Button>
              ) : null}
            </div>
          </>
        )}
      </Drawer>
    </>
  );
}

// ── Pending Review Tab ────────────────────────────────────────────────────────

function PendingReviewTab() {
  const { idToken, base, updateStatus, updateInvoiceFields, getViewUrl } = useInvoicesApi();
  const [items, setItems]           = useState<Invoice[]>([]);
  const [loading, setLoading]       = useState(false);
  const [search, setSearch]         = useState('');
  const [reviewing, setReviewing]   = useState<Invoice | null>(null);
  const [viewUrl, setViewUrl]       = useState<string | null>(null);
  const [viewUrlLoading, setViewUrlLoading] = useState(false);
  const [actionLoading, setActionLoading]   = useState(false);
  const [selected, setSelected]     = useState<string[]>([]);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [reviewForm] = Form.useForm();

  const fetchPending = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ statuses: 'review_needed,extracted', pageSize: '100' });
      const res = await fetch(`${base}/invoices?${qs}`, { headers: { Authorization: `Bearer ${idToken}` } });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setItems(data.items || []);
    } catch {
      message.error('Failed to load pending invoices');
    } finally {
      setLoading(false);
    }
  }, [base, idToken]);

  useEffect(() => { fetchPending(); }, []);

  const openReview = async (inv: Invoice) => {
    setReviewing(inv);
    reviewForm.setFieldsValue({
      invoiceNumber:     inv.invoiceNumber     ?? null,
      documentType:      inv.documentType      ?? 'invoice',
      direction:         inv.direction         ?? 'incoming',
      issueDate:         inv.issueDate ? dayjs(inv.issueDate) : null,
      dueDate:           inv.dueDate   ? dayjs(inv.dueDate)   : null,
      supplierName:      inv.supplierName      ?? null,
      supplierVatNumber: inv.supplierVatNumber ?? null,
      clientName:        inv.clientName        ?? null,
      clientVatNumber:   inv.clientVatNumber   ?? null,
      amountNet:         inv.amountNet         ?? null,
      amountVat:         inv.amountVat         ?? null,
      amountTotal:       inv.amountTotal       ?? null,
    });
    setViewUrl(null);
    setViewUrlLoading(true);
    try {
      const url = await getViewUrl(inv.invoiceId);
      setViewUrl(url);
    } catch {
      message.error('Could not load document URL');
    } finally {
      setViewUrlLoading(false);
    }
  };

  const doConfirm = async (values: Record<string, unknown>) => {
    if (!reviewing) return;
    setActionLoading(true);
    try {
      const payload: Record<string, unknown> = { status: 'confirmed' };
      for (const f of ['invoiceNumber', 'documentType', 'direction', 'supplierName', 'supplierVatNumber', 'clientName', 'clientVatNumber']) {
        if (values[f] != null && values[f] !== '') payload[f] = values[f];
      }
      if (values.issueDate) payload.issueDate = (values.issueDate as dayjs.Dayjs).format('YYYY-MM-DD');
      if (values.dueDate)   payload.dueDate   = (values.dueDate   as dayjs.Dayjs).format('YYYY-MM-DD');
      for (const f of ['amountNet', 'amountVat', 'amountTotal']) {
        if (values[f] != null) payload[f] = values[f];
      }
      await updateInvoiceFields(reviewing.invoiceId, payload);
      message.success('Маркирана като фактура');
      setReviewing(null);
      fetchPending();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  const doReject = async (invoiceId: string) => {
    setActionLoading(true);
    try {
      await updateStatus(invoiceId, 'rejected');
      message.success('Отхвърлена');
      setReviewing(null);
      fetchPending();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleBulkConfirm = async () => {
    setBulkLoading(true);
    let ok = 0;
    for (const id of selected) {
      try { await updateStatus(id, 'confirmed'); ok++; } catch {}
    }
    setBulkLoading(false);
    if (ok > 0) { message.success(`${ok} потвърдени`); setSelected([]); fetchPending(); }
  };

  const filtered = items.filter(i => {
    const q = search.toLowerCase();
    return !q ||
      (i.invoiceNumber  || '').toLowerCase().includes(q) ||
      (i.supplierName   || '').toLowerCase().includes(q) ||
      (i.clientName     || '').toLowerCase().includes(q);
  });

  const columns = [
    {
      title: 'Фактура №',
      dataIndex: 'invoiceNumber',
      sorter: (a: Invoice, b: Invoice) => (a.invoiceNumber || '').localeCompare(b.invoiceNumber || ''),
      render: (v?: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Дата',
      dataIndex: 'issueDate',
      sorter: (a: Invoice, b: Invoice) => (a.issueDate || '').localeCompare(b.issueDate || ''),
      render: fmtDate,
    },
    {
      title: 'Доставчик',
      dataIndex: 'supplierName',
      sorter: (a: Invoice, b: Invoice) => (a.supplierName || '').localeCompare(b.supplierName || ''),
      render: (v?: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Сума (EUR)',
      dataIndex: 'amountTotal',
      align: 'right' as const,
      sorter: (a: Invoice, b: Invoice) => (a.amountTotal ?? 0) - (b.amountTotal ?? 0),
      render: (v?: number) => fmtEur(v),
    },
    {
      title: 'Точност',
      dataIndex: 'confidence',
      sorter: (a: Invoice, b: Invoice) => (a.confidence ?? 0) - (b.confidence ?? 0),
      render: (v?: number) => v != null ? (
        <Tag color={v >= 0.5 ? 'orange' : 'red'}>{Math.round(v * 100)}%</Tag>
      ) : '—',
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_: unknown, record: Invoice) => (
        <Button
          type="text"
          icon={<EyeOutlined />}
          onClick={() => openReview(record)}
          style={{ color: BLUE }}
        />
      ),
    },
  ];

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <Input
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          placeholder="Търсене по №, доставчик, клиент…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          allowClear
          style={{ width: 280 }}
        />
        {selected.length > 0 && (
          <Popconfirm
            title={`Потвърди ${selected.length} фактури като валидни?`}
            onConfirm={handleBulkConfirm}
            okText="Потвърди всички"
          >
            <Button icon={<CheckSquareOutlined />} type="primary" loading={bulkLoading}>
              Масово потвърждение ({selected.length})
            </Button>
          </Popconfirm>
        )}
      </div>
      <Table
        loading={loading}
        dataSource={filtered}
        rowKey="invoiceId"
        columns={columns}
        rowSelection={{ selectedRowKeys: selected, onChange: keys => setSelected(keys as string[]) }}
        pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false, showTotal: tot => `${tot} чакащи` }}
        bordered
        size="small"
      />

      {/* Review drawer */}
      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Преглед на документ</span>}
        placement="right"
        open={!!reviewing}
        onClose={() => setReviewing(null)}
        width={520}
        closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
        styles={DRAWER_STYLES}
        footer={
          reviewing && (
            <Space style={{ float: 'right' }}>
              <Popconfirm
                title="Маркирай като невалидна фактура? Записът ще бъде отхвърлен."
                onConfirm={() => doReject(reviewing.invoiceId)}
                okText="Да, отхвърли"
                okButtonProps={{ danger: true }}
              >
                <Button icon={<CloseOutlined />} danger loading={actionLoading}>
                  Не е фактура
                </Button>
              </Popconfirm>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                loading={actionLoading}
                onClick={() => reviewForm.submit()}
              >
                Потвърди фактура
              </Button>
            </Space>
          )
        }
      >
        {reviewing && (
          <>
            {reviewing.confidence != null && (
              <div style={{ marginBottom: 12 }}>
                <Tag color={reviewing.confidence >= 0.7 ? 'blue' : reviewing.confidence >= 0.5 ? 'orange' : 'red'}>
                  Точност: {Math.round(reviewing.confidence * 100)}%
                </Tag>
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                  Извлечена на {fmtDate(reviewing.extractedAt)} — поправи полетата преди потвърждение
                </Text>
              </div>
            )}
            <Form
              form={reviewForm}
              layout="vertical"
              size="small"
              onFinish={doConfirm}
            >
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item name="invoiceNumber" label="Фактура №">
                    <Input placeholder="напр. ФАК-001" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="documentType" label="Тип">
                    <Select options={[
                      { value: 'invoice',     label: t.invoiceType('invoice') },
                      { value: 'proforma',    label: t.invoiceType('proforma') },
                      { value: 'credit_note', label: t.invoiceType('credit_note') },
                    ]} />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item name="direction" label="Посока">
                    <Select options={[
                      { value: 'incoming', label: t.direction('incoming') },
                      { value: 'outgoing', label: t.direction('outgoing') },
                    ]} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="issueDate" label="Дата издаване">
                    <DatePicker style={{ width: '100%' }} format="DD MMM YYYY" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item name="dueDate" label="Дата плащане">
                    <DatePicker style={{ width: '100%' }} format="DD MMM YYYY" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item name="supplierName" label="Доставчик">
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="supplierVatNumber" label="ДДС доставчик">
                    <Input placeholder="напр. BG123456789" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item name="clientName" label="Клиент">
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="clientVatNumber" label="ДДС клиент">
                    <Input />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={12}>
                <Col span={8}>
                  <Form.Item name="amountNet" label="Нето">
                    <InputNumber style={{ width: '100%' }} precision={2} prefix="€" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="amountVat" label="ДДС">
                    <InputNumber style={{ width: '100%' }} precision={2} prefix="€" />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="amountTotal" label="Общо">
                    <InputNumber style={{ width: '100%' }} precision={2} prefix="€" />
                  </Form.Item>
                </Col>
              </Row>
            </Form>
            <div style={{ marginTop: 8 }}>
              {viewUrlLoading ? (
                <Spin size="small" />
              ) : viewUrl ? (
                <Button
                  icon={<EyeOutlined />}
                  href={viewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="small"
                >
                  Виж оригинален документ
                </Button>
              ) : null}
            </div>
          </>
        )}
      </Drawer>
    </>
  );
}

// ── Stats Tab ─────────────────────────────────────────────────────────────────

function StatsTab() {
  const { idToken, base } = useInvoicesApi();
  const [stats, setStats]   = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [dates, setDates]   = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (dates?.[0]) qs.set('dateFrom', dates[0].format('YYYY-MM-DD'));
      if (dates?.[1]) qs.set('dateTo',   dates[1].format('YYYY-MM-DD'));
      const res = await fetch(`${base}/invoices/stats?${qs}`, { headers: { Authorization: `Bearer ${idToken}` } });
      if (!res.ok) throw new Error(res.statusText);
      setStats(await res.json());
    } catch {
      message.error('Failed to load stats');
    } finally {
      setLoading(false);
    }
  }, [base, idToken, dates]);

  useEffect(() => { fetchStats(); }, []);

  const chartData = (stats?.byMonth || []).map(m => ({
    name: m.month,
    Приходи: m.income,
    Разходи: m.expenses,
  }));

  return (
    <Spin spinning={loading}>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <RangePicker
          value={dates}
          onChange={v => setDates(v as [dayjs.Dayjs | null, dayjs.Dayjs | null] | null)}
          format="DD MMM YYYY"
          placeholder={['От дата', 'До дата']}
          style={{ width: 260 }}
        />
        <Button onClick={fetchStats} loading={loading}>Приложи</Button>
      </div>

      {stats && (
        <>
          <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
            <Col xs={12} sm={6}>
              <div style={{ background: '#f0f4fb', borderRadius: 8, padding: '16px 20px', borderLeft: `4px solid ${GOLD}` }}>
                <Statistic
                  title={<span style={{ color: '#475569', fontSize: 13 }}>Приходи</span>}
                  value={stats.totals.income}
                  precision={2}
                  prefix="€"
                  valueStyle={{ color: BLUE, fontSize: 20, fontWeight: 700 }}
                />
              </div>
            </Col>
            <Col xs={12} sm={6}>
              <div style={{ background: '#f0f4fb', borderRadius: 8, padding: '16px 20px', borderLeft: '4px solid #e85d04' }}>
                <Statistic
                  title={<span style={{ color: '#475569', fontSize: 13 }}>Разходи</span>}
                  value={stats.totals.expenses}
                  precision={2}
                  prefix="€"
                  valueStyle={{ color: '#c0392b', fontSize: 20, fontWeight: 700 }}
                />
              </div>
            </Col>
            <Col xs={12} sm={6}>
              <div style={{ background: '#f0f4fb', borderRadius: 8, padding: '16px 20px', borderLeft: `4px solid ${stats.totals.net >= 0 ? '#27ae60' : '#c0392b'}` }}>
                <Statistic
                  title={<span style={{ color: '#475569', fontSize: 13 }}>Нето</span>}
                  value={stats.totals.net}
                  precision={2}
                  prefix="€"
                  valueStyle={{ color: stats.totals.net >= 0 ? '#27ae60' : '#c0392b', fontSize: 20, fontWeight: 700 }}
                />
              </div>
            </Col>
            <Col xs={12} sm={6}>
              <div style={{ background: '#fff8e6', borderRadius: 8, padding: '16px 20px', borderLeft: `4px solid ${GOLD_DARK}` }}>
                <Statistic
                  title={<span style={{ color: '#475569', fontSize: 13 }}>Неплатени (потвърдени)</span>}
                  value={stats.totals.unpaid}
                  precision={2}
                  prefix="€"
                  valueStyle={{ color: GOLD_DARK, fontSize: 20, fontWeight: 700 }}
                />
              </div>
            </Col>
          </Row>

          <div style={{ background: '#fff', borderRadius: 8, padding: 20, border: '1px solid #f0f4fb' }}>
            <Text strong style={{ display: 'block', marginBottom: 16, color: BLUE }}>Приходи vs Разходи по месец</Text>
            {chartData.length === 0 ? (
              <Text type="secondary">Няма данни за избрания период.</Text>
            ) : (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={chartData} margin={{ top: 4, right: 16, left: 16, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f4fb" />
                  <XAxis dataKey="name" tick={{ fill: '#475569', fontSize: 12 }} />
                  <YAxis tick={{ fill: '#475569', fontSize: 12 }} tickFormatter={v => `€${v >= 1000 ? `${(v/1000).toFixed(0)}k` : v}`} />
                  <Tooltip formatter={(v) => fmtEur(typeof v === 'number' ? v : undefined)} />
                  <Legend />
                  <Bar dataKey="Приходи" fill={GOLD}      radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Разходи" fill="#e85d04"   radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </>
      )}
    </Spin>
  );
}

// ── Profile Tab ───────────────────────────────────────────────────────────────

function ProfileTab() {
  const { idToken, base } = useInvoicesApi();
  const [loading, setLoading]     = useState(false);
  const [saving, setSaving]       = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    setLoading(true);
    fetch(`${base}/profile`, { headers: { Authorization: `Bearer ${idToken}` } })
      .then(r => r.json())
      .then(d => { form.setFieldsValue({ ...d, aliases: (d.aliases || []).join(', ') }); })
      .catch(() => message.error('Failed to load profile'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (values: { legalName: string; vatNumber: string; bulstat: string; aliases: string }) => {
    setSaving(true);
    try {
      const aliases = (values.aliases || '').split(',').map((s: string) => s.trim()).filter(Boolean);
      const res = await fetch(`${base}/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ ...values, aliases }),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      message.success('Профилът е записан');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Spin spinning={loading}>
      <div style={{ maxWidth: 520 }}>
        <Text type="secondary" style={{ display: 'block', marginBottom: 20 }}>
          Правната идентичност се използва от тръбопровода за извличане на фактури за определяне на посоката.
        </Text>
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item name="legalName" label="Правно наименование" rules={[{ required: true, message: 'Required' }]}>
            <Input placeholder="Правно наименование на компанията" />
          </Form.Item>
          <Form.Item name="vatNumber" label="ДДС номер">
            <Input placeholder="напр. BG123456789" />
          </Form.Item>
          <Form.Item name="bulstat" label="Булстат / рег. номер">
            <Input placeholder="напр. 123456789" />
          </Form.Item>
          <Form.Item name="aliases" label="Алиаси" extra="Разделен със запетаи списък от алтернативни имена на компанията">
            <Input placeholder="напр. Acme, ACME Corp, Acme Ltd." />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={saving}>Запиши профил</Button>
          </Form.Item>
        </Form>
      </div>
    </Spin>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InvoicesPage() {
  const { tenantId, idToken } = useInvoicesApi();
  const [activeTab, setActiveTab] = useState('invoices');
  const [uploadOpen, setUploadOpen] = useState(false);

  const tabs = [
    {
      key: 'invoices',
      label: (
        <Space size={6}>
          <FileTextOutlined />
          Фактури
        </Space>
      ),
      children: <InvoicesTab />,
    },
    {
      key: 'pending',
      label: (
        <Space size={6}>
          <EyeOutlined />
          За преглед
        </Space>
      ),
      children: <PendingReviewTab />,
    },
    {
      key: 'stats',
      label: 'Статистика',
      children: <StatsTab />,
    },
    {
      key: 'profile',
      label: (
        <Space size={6}>
          <SettingOutlined />
          Профил
        </Space>
      ),
      children: <ProfileTab />,
    },
  ];

  return (
    <div style={{ padding: '24px 32px', height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <Space size={10}>
          <FileTextOutlined style={{ fontSize: 22, color: BLUE }} />
          <Title level={4} style={{ margin: 0, color: BLUE }}>Фактури</Title>
        </Space>
        <Button type="primary" icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>
          Качи фактури
        </Button>
      </div>
      <UploadDrawer
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSuccess={() => {}}
        tenantId={tenantId}
        idToken={idToken}
        lockedCategory="invoice"
      />
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabs}
        destroyInactiveTabPane={false}
      />
    </div>
  );
}
