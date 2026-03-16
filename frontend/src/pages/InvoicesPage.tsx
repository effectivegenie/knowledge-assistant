import { useState, useEffect, useCallback } from 'react';
import {
  Tabs, Table, Button, Input, Tag, Space, Typography, Drawer, Descriptions,
  Row, Col, Statistic, DatePicker, Popconfirm, message, Spin, Select, Form,
} from 'antd';
import {
  SearchOutlined, FileTextOutlined, EyeOutlined, CheckOutlined,
  CloseOutlined, SettingOutlined, CheckSquareOutlined,
} from '@ant-design/icons';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import dayjs from 'dayjs';
import { useAuth } from '../auth/AuthContext';
import { adminApiUrl } from '../config';

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

  const getViewUrl = useCallback(async (invoiceId: string): Promise<string> => {
    const res = await fetch(`${base}/invoices/${encodeURIComponent(invoiceId)}/view-url`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) throw new Error('Failed to get view URL');
    const d = await res.json();
    return d.url;
  }, [base, idToken]);

  return { tenantId, idToken, base, updateStatus, getViewUrl };
}

// ── Invoices Tab ─────────────────────────────────────────────────────────────

function InvoicesTab() {
  const { idToken, base, updateStatus, getViewUrl } = useInvoicesApi();
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
      if (statusFilter) qs.set('status', statusFilter);
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
    if (ok > 0) { message.success(`${ok} invoice${ok !== 1 ? 's' : ''} confirmed`); setSelected([]); fetchInvoices(page); }
  };

  const columns = [
    {
      title: 'Invoice #',
      dataIndex: 'invoiceNumber',
      key: 'invoiceNumber',
      sorter: (a: Invoice, b: Invoice) => (a.invoiceNumber || '').localeCompare(b.invoiceNumber || ''),
      render: (v?: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Date',
      dataIndex: 'issueDate',
      key: 'issueDate',
      sorter: (a: Invoice, b: Invoice) => (a.issueDate || '').localeCompare(b.issueDate || ''),
      render: fmtDate,
    },
    {
      title: 'Direction',
      dataIndex: 'direction',
      key: 'direction',
      sorter: (a: Invoice, b: Invoice) => a.direction.localeCompare(b.direction),
      render: (v: string) => <Tag color={DIR_COLOR[v] ?? 'default'}>{v}</Tag>,
    },
    {
      title: 'Type',
      dataIndex: 'documentType',
      key: 'documentType',
      sorter: (a: Invoice, b: Invoice) => a.documentType.localeCompare(b.documentType),
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: 'Supplier',
      dataIndex: 'supplierName',
      key: 'supplierName',
      sorter: (a: Invoice, b: Invoice) => (a.supplierName || '').localeCompare(b.supplierName || ''),
      render: (v?: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Client',
      dataIndex: 'clientName',
      key: 'clientName',
      sorter: (a: Invoice, b: Invoice) => (a.clientName || '').localeCompare(b.clientName || ''),
      render: (v?: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Total (EUR)',
      dataIndex: 'amountTotal',
      key: 'amountTotal',
      align: 'right' as const,
      sorter: (a: Invoice, b: Invoice) => (a.amountTotal ?? 0) - (b.amountTotal ?? 0),
      render: (v?: number) => fmtEur(v),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      sorter: (a: Invoice, b: Invoice) => a.status.localeCompare(b.status),
      render: (v: string) => <Tag color={STATUS_COLOR[v] ?? 'default'}>{v.replace('_', ' ')}</Tag>,
    },
    {
      title: '',
      key: 'actions',
      width: 60,
      render: (_: unknown, record: Invoice) => (
        <Button
          type="text"
          icon={<EyeOutlined />}
          onClick={() => openViewer(record)}
          title="View document"
          style={{ color: BLUE }}
        />
      ),
    },
  ];

  const extractedSelected = selected.filter(id => items.find(i => i.invoiceId === id)?.status === 'extracted');

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <Input
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          placeholder="Search invoice #, supplier, client…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onPressEnter={() => fetchInvoices(0)}
          allowClear
          onClear={() => { setSearch(''); fetchInvoices(0); }}
          style={{ width: 280 }}
        />
        <Select
          placeholder="All statuses"
          allowClear
          value={statusFilter}
          onChange={v => setStatusFilter(v ?? null)}
          style={{ width: 160 }}
          options={[
            { value: 'extracted',    label: 'Extracted' },
            { value: 'confirmed',    label: 'Confirmed' },
            { value: 'paid',         label: 'Paid' },
            { value: 'rejected',     label: 'Rejected' },
          ]}
        />
        <Select
          placeholder="All directions"
          allowClear
          value={dirFilter}
          onChange={v => setDirFilter(v ?? null)}
          style={{ width: 150 }}
          options={[
            { value: 'incoming', label: 'Incoming' },
            { value: 'outgoing', label: 'Outgoing' },
          ]}
        />
        <RangePicker
          value={dates}
          onChange={v => setDates(v as [dayjs.Dayjs | null, dayjs.Dayjs | null] | null)}
          format="DD MMM YYYY"
          placeholder={['From date', 'To date']}
          style={{ width: 260 }}
        />
        <Button onClick={() => fetchInvoices(0)} loading={loading}>Search</Button>
        {extractedSelected.length > 0 && (
          <Popconfirm
            title={`Confirm ${extractedSelected.length} invoice${extractedSelected.length !== 1 ? 's' : ''}?`}
            onConfirm={handleBulkConfirm}
            okText="Confirm all"
          >
            <Button icon={<CheckSquareOutlined />} type="primary" loading={bulkLoading}>
              Bulk confirm ({extractedSelected.length})
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
          showTotal: t => `${t} invoice${t !== 1 ? 's' : ''}`,
          onChange: p => fetchInvoices(p - 1),
        }}
        bordered
        size="small"
      />

      {/* View drawer */}
      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Invoice details</span>}
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
              <Descriptions.Item label="Invoice #">{viewing.invoiceNumber || '—'}</Descriptions.Item>
              <Descriptions.Item label="Type"><Tag>{viewing.documentType}</Tag></Descriptions.Item>
              <Descriptions.Item label="Direction"><Tag color={DIR_COLOR[viewing.direction]}>{viewing.direction}</Tag></Descriptions.Item>
              <Descriptions.Item label="Status"><Tag color={STATUS_COLOR[viewing.status]}>{viewing.status.replace('_', ' ')}</Tag></Descriptions.Item>
              <Descriptions.Item label="Issue date">{fmtDate(viewing.issueDate)}</Descriptions.Item>
              <Descriptions.Item label="Due date">{fmtDate(viewing.dueDate)}</Descriptions.Item>
              <Descriptions.Item label="Supplier">{viewing.supplierName || '—'}</Descriptions.Item>
              <Descriptions.Item label="Supplier VAT">{viewing.supplierVatNumber || '—'}</Descriptions.Item>
              <Descriptions.Item label="Client">{viewing.clientName || '—'}</Descriptions.Item>
              <Descriptions.Item label="Client VAT">{viewing.clientVatNumber || '—'}</Descriptions.Item>
              <Descriptions.Item label="Net">{fmtEur(viewing.amountNet)}</Descriptions.Item>
              <Descriptions.Item label="VAT">{fmtEur(viewing.amountVat)}</Descriptions.Item>
              <Descriptions.Item label="Total"><strong>{fmtEur(viewing.amountTotal)}</strong></Descriptions.Item>
              <Descriptions.Item label="Confidence">{viewing.confidence != null ? `${Math.round(viewing.confidence * 100)}%` : '—'}</Descriptions.Item>
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
                  View original document
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
  const { idToken, base, updateStatus, getViewUrl } = useInvoicesApi();
  const [items, setItems]           = useState<Invoice[]>([]);
  const [loading, setLoading]       = useState(false);
  const [search, setSearch]         = useState('');
  const [reviewing, setReviewing]   = useState<Invoice | null>(null);
  const [viewUrl, setViewUrl]       = useState<string | null>(null);
  const [viewUrlLoading, setViewUrlLoading] = useState(false);
  const [actionLoading, setActionLoading]   = useState(false);
  const [selected, setSelected]     = useState<string[]>([]);
  const [bulkLoading, setBulkLoading] = useState(false);

  const fetchPending = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ status: 'review_needed', pageSize: '100' });
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

  const doAction = async (invoiceId: string, status: 'confirmed' | 'rejected') => {
    setActionLoading(true);
    try {
      await updateStatus(invoiceId, status);
      message.success(status === 'confirmed' ? 'Marked as invoice' : 'Rejected');
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
    if (ok > 0) { message.success(`${ok} confirmed`); setSelected([]); fetchPending(); }
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
      title: 'Invoice #',
      dataIndex: 'invoiceNumber',
      sorter: (a: Invoice, b: Invoice) => (a.invoiceNumber || '').localeCompare(b.invoiceNumber || ''),
      render: (v?: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Date',
      dataIndex: 'issueDate',
      sorter: (a: Invoice, b: Invoice) => (a.issueDate || '').localeCompare(b.issueDate || ''),
      render: fmtDate,
    },
    {
      title: 'Supplier',
      dataIndex: 'supplierName',
      sorter: (a: Invoice, b: Invoice) => (a.supplierName || '').localeCompare(b.supplierName || ''),
      render: (v?: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Total (EUR)',
      dataIndex: 'amountTotal',
      align: 'right' as const,
      sorter: (a: Invoice, b: Invoice) => (a.amountTotal ?? 0) - (b.amountTotal ?? 0),
      render: (v?: number) => fmtEur(v),
    },
    {
      title: 'Confidence',
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
          placeholder="Search invoice #, supplier, client…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          allowClear
          style={{ width: 280 }}
        />
        {selected.length > 0 && (
          <Popconfirm
            title={`Confirm ${selected.length} invoice${selected.length !== 1 ? 's' : ''} as valid?`}
            onConfirm={handleBulkConfirm}
            okText="Confirm all"
          >
            <Button icon={<CheckSquareOutlined />} type="primary" loading={bulkLoading}>
              Bulk confirm ({selected.length})
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
        pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false, showTotal: t => `${t} pending` }}
        bordered
        size="small"
      />

      {/* Review drawer */}
      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Review document</span>}
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
                title="Mark as not an invoice? The record will be rejected."
                onConfirm={() => doAction(reviewing.invoiceId, 'rejected')}
                okText="Yes, reject"
                okButtonProps={{ danger: true }}
              >
                <Button icon={<CloseOutlined />} danger loading={actionLoading}>
                  Not an invoice
                </Button>
              </Popconfirm>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                loading={actionLoading}
                onClick={() => doAction(reviewing.invoiceId, 'confirmed')}
              >
                Yes, it's an invoice
              </Button>
            </Space>
          )
        }
      >
        {reviewing && (
          <>
            <Descriptions column={1} bordered size="small" labelStyle={{ width: 150, color: BLUE }}>
              <Descriptions.Item label="Invoice #">{reviewing.invoiceNumber || '—'}</Descriptions.Item>
              <Descriptions.Item label="Type"><Tag>{reviewing.documentType}</Tag></Descriptions.Item>
              <Descriptions.Item label="Direction"><Tag color={DIR_COLOR[reviewing.direction]}>{reviewing.direction}</Tag></Descriptions.Item>
              <Descriptions.Item label="Issue date">{fmtDate(reviewing.issueDate)}</Descriptions.Item>
              <Descriptions.Item label="Due date">{fmtDate(reviewing.dueDate)}</Descriptions.Item>
              <Descriptions.Item label="Supplier">{reviewing.supplierName || '—'}</Descriptions.Item>
              <Descriptions.Item label="Supplier VAT">{reviewing.supplierVatNumber || '—'}</Descriptions.Item>
              <Descriptions.Item label="Client">{reviewing.clientName || '—'}</Descriptions.Item>
              <Descriptions.Item label="Net">{fmtEur(reviewing.amountNet)}</Descriptions.Item>
              <Descriptions.Item label="VAT">{fmtEur(reviewing.amountVat)}</Descriptions.Item>
              <Descriptions.Item label="Total"><strong>{fmtEur(reviewing.amountTotal)}</strong></Descriptions.Item>
              <Descriptions.Item label="Confidence">
                {reviewing.confidence != null ? (
                  <Tag color={reviewing.confidence >= 0.5 ? 'orange' : 'red'}>
                    {Math.round(reviewing.confidence * 100)}%
                  </Tag>
                ) : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Extracted at">{fmtDate(reviewing.extractedAt)}</Descriptions.Item>
            </Descriptions>
            <div style={{ marginTop: 16 }}>
              {viewUrlLoading ? (
                <Spin size="small" />
              ) : viewUrl ? (
                <Button
                  icon={<EyeOutlined />}
                  href={viewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View original document
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
    Income: m.income,
    Expenses: m.expenses,
  }));

  return (
    <Spin spinning={loading}>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <RangePicker
          value={dates}
          onChange={v => setDates(v as [dayjs.Dayjs | null, dayjs.Dayjs | null] | null)}
          format="DD MMM YYYY"
          placeholder={['From date', 'To date']}
          style={{ width: 260 }}
        />
        <Button onClick={fetchStats} loading={loading}>Apply</Button>
      </div>

      {stats && (
        <>
          <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
            <Col xs={12} sm={6}>
              <div style={{ background: '#f0f4fb', borderRadius: 8, padding: '16px 20px', borderLeft: `4px solid ${GOLD}` }}>
                <Statistic
                  title={<span style={{ color: '#475569', fontSize: 13 }}>Income</span>}
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
                  title={<span style={{ color: '#475569', fontSize: 13 }}>Expenses</span>}
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
                  title={<span style={{ color: '#475569', fontSize: 13 }}>Net</span>}
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
                  title={<span style={{ color: '#475569', fontSize: 13 }}>Unpaid (confirmed)</span>}
                  value={stats.totals.unpaid}
                  precision={2}
                  prefix="€"
                  valueStyle={{ color: GOLD_DARK, fontSize: 20, fontWeight: 700 }}
                />
              </div>
            </Col>
          </Row>

          <div style={{ background: '#fff', borderRadius: 8, padding: 20, border: '1px solid #f0f4fb' }}>
            <Text strong style={{ display: 'block', marginBottom: 16, color: BLUE }}>Income vs Expenses by month</Text>
            {chartData.length === 0 ? (
              <Text type="secondary">No data for the selected period.</Text>
            ) : (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={chartData} margin={{ top: 4, right: 16, left: 16, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f4fb" />
                  <XAxis dataKey="name" tick={{ fill: '#475569', fontSize: 12 }} />
                  <YAxis tick={{ fill: '#475569', fontSize: 12 }} tickFormatter={v => `€${v >= 1000 ? `${(v/1000).toFixed(0)}k` : v}`} />
                  <Tooltip formatter={(v) => fmtEur(typeof v === 'number' ? v : undefined)} />
                  <Legend />
                  <Bar dataKey="Income"   fill={GOLD}      radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Expenses" fill="#e85d04"   radius={[4, 4, 0, 0]} />
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
      message.success('Profile saved');
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
          Legal identity is used by the invoice extraction pipeline to determine invoice direction (incoming vs outgoing).
        </Text>
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item name="legalName" label="Legal name" rules={[{ required: true, message: 'Required' }]}>
            <Input placeholder="Company legal name" />
          </Form.Item>
          <Form.Item name="vatNumber" label="VAT number">
            <Input placeholder="e.g. BG123456789" />
          </Form.Item>
          <Form.Item name="bulstat" label="Bulstat / registration number">
            <Input placeholder="e.g. 123456789" />
          </Form.Item>
          <Form.Item name="aliases" label="Name aliases" extra="Comma-separated list of alternative company names used on documents">
            <Input placeholder="e.g. Acme, ACME Corp, Acme Ltd." />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={saving}>Save profile</Button>
          </Form.Item>
        </Form>
      </div>
    </Spin>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InvoicesPage() {
  const [activeTab, setActiveTab] = useState('invoices');

  const tabs = [
    {
      key: 'invoices',
      label: (
        <Space size={6}>
          <FileTextOutlined />
          Invoices
        </Space>
      ),
      children: <InvoicesTab />,
    },
    {
      key: 'pending',
      label: (
        <Space size={6}>
          <EyeOutlined />
          Pending Review
        </Space>
      ),
      children: <PendingReviewTab />,
    },
    {
      key: 'stats',
      label: 'Stats',
      children: <StatsTab />,
    },
    {
      key: 'profile',
      label: (
        <Space size={6}>
          <SettingOutlined />
          Company Profile
        </Space>
      ),
      children: <ProfileTab />,
    },
  ];

  return (
    <div style={{ padding: '24px 32px', height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20, gap: 10 }}>
        <FileTextOutlined style={{ fontSize: 22, color: BLUE }} />
        <Title level={4} style={{ margin: 0, color: BLUE }}>Invoices</Title>
      </div>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabs}
        destroyInactiveTabPane={false}
      />
    </div>
  );
}
