import { useState, useEffect, useCallback } from 'react';
import {
  Tabs, Table, Button, Input, InputNumber, Tag, Space, Typography, Drawer, Descriptions,
  Row, Col, Statistic, DatePicker, Popconfirm, message, Spin, Select, Form,
} from 'antd';
import {
  SearchOutlined, FileProtectOutlined, EyeOutlined, CheckOutlined,
  CloseOutlined, DeleteOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useAuth } from '../auth/AuthContext';
import { adminApiUrl } from '../config';
import { t, contractActivityLabel } from '../i18n';

const { Title, Text } = Typography;

const BLUE      = '#1e3a5f';
const GOLD      = '#e6a800';

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

const fmtDate = (d?: string | null) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const CONTRACT_TYPE_OPTIONS = [
  'services', 'rental', 'supply', 'employment', 'nda', 'framework', 'other',
];

interface Contract {
  contractId: string;
  tenantId: string;
  status: string;
  documentType: string;
  contractNumber?: string;
  signingDate?: string;
  startDate?: string;
  endDate?: string;
  clientName?: string;
  clientVatNumber?: string;
  counterpartyName?: string;
  counterpartyVatNumber?: string;
  value?: number;
  currency?: string;
  contractType?: string;
  confidence?: number;
  extractedAt?: string;
  confirmedAt?: string;
  s3Key?: string;
}

interface ContractStats {
  active: number;
  expiringSoon: number;
  expired: number;
  pending: number;
}

// ── Shared hook ──────────────────────────────────────────────────────────────

function useContractsApi() {
  const { user, idToken } = useAuth();
  const tenantId = user?.tenantId ?? 'default';
  const base = `${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}`;

  const updateStatus = useCallback(async (contractId: string, status: string) => {
    const res = await fetch(`${base}/contracts/${encodeURIComponent(contractId)}`, {
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

  const updateContractFields = useCallback(async (contractId: string, body: Record<string, unknown>) => {
    const res = await fetch(`${base}/contracts/${encodeURIComponent(contractId)}`, {
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

  const deleteContract = useCallback(async (contractId: string) => {
    const res = await fetch(`${base}/contracts/${encodeURIComponent(contractId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || res.statusText);
    }
    return res.json();
  }, [base, idToken]);

  const getViewUrl = useCallback(async (contractId: string): Promise<string> => {
    const res = await fetch(`${base}/contracts/${encodeURIComponent(contractId)}/view-url`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) throw new Error('Failed to get view URL');
    const d = await res.json();
    return d.url;
  }, [base, idToken]);

  return { tenantId, idToken, base, updateStatus, updateContractFields, deleteContract, getViewUrl };
}

// ── Contracts Tab ─────────────────────────────────────────────────────────────

function ContractsTab() {
  const { idToken, base, getViewUrl, deleteContract } = useContractsApi();
  const [items, setItems]     = useState<Contract[]>([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch]   = useState('');
  const [page, setPage]       = useState(0);
  const [viewing, setViewing] = useState<Contract | null>(null);
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [viewUrlLoading, setViewUrlLoading] = useState(false);

  const fetchContracts = useCallback(async (p = 0) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(p), pageSize: '20' });
      if (search) qs.set('search', search);
      const res = await fetch(`${base}/contracts?${qs}`, { headers: { Authorization: `Bearer ${idToken}` } });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setItems(data.items || []);
      setTotal(data.total || 0);
      setPage(p);
    } catch {
      message.error('Failed to load contracts');
    } finally {
      setLoading(false);
    }
  }, [base, idToken, search]);

  useEffect(() => { fetchContracts(0); }, []);

  const openViewer = async (c: Contract) => {
    setViewing(c);
    setViewUrl(null);
    setViewUrlLoading(true);
    try {
      const url = await getViewUrl(c.contractId);
      setViewUrl(url);
    } catch {
      message.error('Could not load document URL');
    } finally {
      setViewUrlLoading(false);
    }
  };

  const columns = [
    {
      title: 'Договор №',
      dataIndex: 'contractNumber',
      key: 'contractNumber',
      sorter: (a: Contract, b: Contract) => (a.contractNumber || '').localeCompare(b.contractNumber || ''),
      render: (v?: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Дата подписване',
      dataIndex: 'signingDate',
      key: 'signingDate',
      sorter: (a: Contract, b: Contract) => (a.signingDate || '').localeCompare(b.signingDate || ''),
      render: fmtDate,
    },
    {
      title: 'Краен срок',
      dataIndex: 'endDate',
      key: 'endDate',
      sorter: (a: Contract, b: Contract) => (a.endDate || '').localeCompare(b.endDate || ''),
      render: (v?: string) => {
        const { label, color } = contractActivityLabel(v);
        return (
          <Space size={4}>
            <Tag color={color}>{label}</Tag>
            {v && <Text type="secondary" style={{ fontSize: 12 }}>({fmtDate(v)})</Text>}
          </Space>
        );
      },
    },
    {
      title: 'Клиент',
      dataIndex: 'clientName',
      key: 'clientName',
      sorter: (a: Contract, b: Contract) => (a.clientName || '').localeCompare(b.clientName || ''),
      render: (v?: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Тип',
      dataIndex: 'contractType',
      key: 'contractType',
      sorter: (a: Contract, b: Contract) => (a.contractType || '').localeCompare(b.contractType || ''),
      render: (v?: string) => v ? <Tag>{t.contractType(v)}</Tag> : <Text type="secondary">—</Text>,
    },
    {
      title: 'Статус',
      dataIndex: 'status',
      key: 'status',
      sorter: (a: Contract, b: Contract) => a.status.localeCompare(b.status),
      render: (v: string) => <Tag color={STATUS_COLOR[v] ?? 'default'}>{t.status(v)}</Tag>,
    },
    {
      title: '',
      key: 'actions',
      width: 90,
      render: (_: unknown, record: Contract) => (
        <Space size={0}>
          <Button
            type="text"
            icon={<EyeOutlined />}
            onClick={() => openViewer(record)}
            title="Преглед"
            style={{ color: BLUE }}
          />
          <Popconfirm
            title="Изтрий договора и всички файлове?"
            onConfirm={async () => { try { await deleteContract(record.contractId); message.success('Изтрит'); fetchContracts(page); } catch(e) { message.error(e instanceof Error ? e.message : 'Грешка'); } }}
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
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <Input
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          placeholder="Търсене по №, клиент…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onPressEnter={() => fetchContracts(0)}
          allowClear
          onClear={() => { setSearch(''); fetchContracts(0); }}
          style={{ width: 280 }}
        />
        <Button onClick={() => fetchContracts(0)} loading={loading}>Търсене</Button>
      </div>
      <Table
        loading={loading}
        dataSource={items}
        rowKey="contractId"
        columns={columns}
        pagination={{
          current: page + 1,
          pageSize: 20,
          total,
          hideOnSinglePage: true,
          showSizeChanger: false,
          showTotal: tot => `${tot} договора`,
          onChange: p => fetchContracts(p - 1),
        }}
        bordered
        size="small"
      />

      {/* View drawer */}
      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Детайли договор</span>}
        placement="right"
        open={!!viewing}
        onClose={() => setViewing(null)}
        width={520}
        closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
        styles={DRAWER_STYLES}
      >
        {viewing && (
          <>
            <Descriptions column={1} bordered size="small" labelStyle={{ width: 160, color: BLUE }}>
              <Descriptions.Item label="Договор №">{viewing.contractNumber || '—'}</Descriptions.Item>
              <Descriptions.Item label="Тип документ"><Tag>{t.contractDocType(viewing.documentType)}</Tag></Descriptions.Item>
              <Descriptions.Item label="Тип договор">{viewing.contractType ? <Tag>{t.contractType(viewing.contractType)}</Tag> : '—'}</Descriptions.Item>
              <Descriptions.Item label="Статус"><Tag color={STATUS_COLOR[viewing.status]}>{t.status(viewing.status)}</Tag></Descriptions.Item>
              <Descriptions.Item label="Дата подписване">{fmtDate(viewing.signingDate)}</Descriptions.Item>
              <Descriptions.Item label="Начална дата">{fmtDate(viewing.startDate)}</Descriptions.Item>
              <Descriptions.Item label="Крайна дата">{fmtDate(viewing.endDate)}</Descriptions.Item>
              <Descriptions.Item label="Клиент">{viewing.clientName || '—'}</Descriptions.Item>
              <Descriptions.Item label="ДДС клиент">{viewing.clientVatNumber || '—'}</Descriptions.Item>
              <Descriptions.Item label="Насреща">{viewing.counterpartyName || '—'}</Descriptions.Item>
              <Descriptions.Item label="ДДС насреща">{viewing.counterpartyVatNumber || '—'}</Descriptions.Item>
              <Descriptions.Item label="Стойност">{viewing.value != null ? `${viewing.value} ${viewing.currency || ''}` : '—'}</Descriptions.Item>
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
  const { idToken, base, updateStatus, updateContractFields, getViewUrl } = useContractsApi();
  const [items, setItems]           = useState<Contract[]>([]);
  const [loading, setLoading]       = useState(false);
  const [search, setSearch]         = useState('');
  const [reviewing, setReviewing]   = useState<Contract | null>(null);
  const [viewUrl, setViewUrl]       = useState<string | null>(null);
  const [viewUrlLoading, setViewUrlLoading] = useState(false);
  const [actionLoading, setActionLoading]   = useState(false);
  const [reviewForm] = Form.useForm();

  const fetchPending = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ status: 'review_needed', pageSize: '100' });
      const res = await fetch(`${base}/contracts?${qs}`, { headers: { Authorization: `Bearer ${idToken}` } });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setItems(data.items || []);
    } catch {
      message.error('Failed to load pending contracts');
    } finally {
      setLoading(false);
    }
  }, [base, idToken]);

  useEffect(() => { fetchPending(); }, []);

  const openReview = async (c: Contract) => {
    setReviewing(c);
    reviewForm.setFieldsValue({
      contractNumber:       c.contractNumber       ?? null,
      documentType:         c.documentType         ?? 'contract',
      signingDate:          c.signingDate  ? dayjs(c.signingDate)  : null,
      startDate:            c.startDate    ? dayjs(c.startDate)    : null,
      endDate:              c.endDate      ? dayjs(c.endDate)      : null,
      contractType:         c.contractType         ?? null,
      clientName:           c.clientName           ?? null,
      clientVatNumber:      c.clientVatNumber      ?? null,
      counterpartyName:     c.counterpartyName     ?? null,
      counterpartyVatNumber:c.counterpartyVatNumber ?? null,
      value:                c.value                ?? null,
      currency:             c.currency             ?? 'BGN',
    });
    setViewUrl(null);
    setViewUrlLoading(true);
    try {
      const url = await getViewUrl(c.contractId);
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
      for (const f of ['contractNumber', 'documentType', 'contractType', 'clientName', 'clientVatNumber', 'counterpartyName', 'counterpartyVatNumber', 'currency']) {
        if (values[f] != null && values[f] !== '') payload[f] = values[f];
      }
      if (values.signingDate) payload.signingDate = (values.signingDate as dayjs.Dayjs).format('YYYY-MM-DD');
      if (values.startDate)   payload.startDate   = (values.startDate   as dayjs.Dayjs).format('YYYY-MM-DD');
      if (values.endDate)     payload.endDate     = (values.endDate     as dayjs.Dayjs).format('YYYY-MM-DD');
      if (values.value != null) payload.value = values.value;
      await updateContractFields(reviewing.contractId, payload);
      message.success('Договорът е потвърден');
      setReviewing(null);
      fetchPending();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  const doReject = async (contractId: string) => {
    setActionLoading(true);
    try {
      await updateStatus(contractId, 'rejected');
      message.success('Отхвърлен');
      setReviewing(null);
      fetchPending();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  const filtered = items.filter(i => {
    const q = search.toLowerCase();
    return !q ||
      (i.contractNumber   || '').toLowerCase().includes(q) ||
      (i.clientName       || '').toLowerCase().includes(q) ||
      (i.counterpartyName || '').toLowerCase().includes(q);
  });

  const columns = [
    {
      title: 'Договор №',
      dataIndex: 'contractNumber',
      sorter: (a: Contract, b: Contract) => (a.contractNumber || '').localeCompare(b.contractNumber || ''),
      render: (v?: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Дата',
      dataIndex: 'signingDate',
      sorter: (a: Contract, b: Contract) => (a.signingDate || '').localeCompare(b.signingDate || ''),
      render: fmtDate,
    },
    {
      title: 'Клиент',
      dataIndex: 'clientName',
      sorter: (a: Contract, b: Contract) => (a.clientName || '').localeCompare(b.clientName || ''),
      render: (v?: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: 'Точност',
      dataIndex: 'confidence',
      sorter: (a: Contract, b: Contract) => (a.confidence ?? 0) - (b.confidence ?? 0),
      render: (v?: number) => v != null ? (
        <Tag color={v >= 0.5 ? 'orange' : 'red'}>{Math.round(v * 100)}%</Tag>
      ) : '—',
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_: unknown, record: Contract) => (
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
          placeholder="Търсене по №, клиент…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          allowClear
          style={{ width: 280 }}
        />
      </div>
      <Table
        loading={loading}
        dataSource={filtered}
        rowKey="contractId"
        columns={columns}
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
                title="Маркирай като невалиден договор? Записът ще бъде отхвърлен."
                onConfirm={() => doReject(reviewing.contractId)}
                okText="Да, отхвърли"
                okButtonProps={{ danger: true }}
              >
                <Button icon={<CloseOutlined />} danger loading={actionLoading}>
                  Не е договор
                </Button>
              </Popconfirm>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                loading={actionLoading}
                onClick={() => reviewForm.submit()}
              >
                Потвърди договор
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
                  Извлечен на {fmtDate(reviewing.extractedAt)} — поправи полетата преди потвърждение
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
                  <Form.Item name="contractNumber" label="Договор №">
                    <Input placeholder="напр. ДОГ-001" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="documentType" label="Тип документ">
                    <Select options={[
                      { value: 'contract',  label: t.contractDocType('contract') },
                      { value: 'amendment', label: t.contractDocType('amendment') },
                      { value: 'annex',     label: t.contractDocType('annex') },
                    ]} />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item name="signingDate" label="Дата подписване">
                    <DatePicker style={{ width: '100%' }} format="DD MMM YYYY" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="startDate" label="Начална дата">
                    <DatePicker style={{ width: '100%' }} format="DD MMM YYYY" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item name="endDate" label="Крайна дата">
                    <DatePicker style={{ width: '100%' }} format="DD MMM YYYY" />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="contractType" label="Тип договор">
                    <Select options={CONTRACT_TYPE_OPTIONS.map(v => ({ value: v, label: t.contractType(v) }))} />
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
                    <Input placeholder="напр. BG123456789" />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item name="counterpartyName" label="Насреща">
                    <Input />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="counterpartyVatNumber" label="ДДС насреща">
                    <Input />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item name="value" label="Стойност">
                    <InputNumber style={{ width: '100%' }} precision={2} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="currency" label="Валута">
                    <Select options={[
                      { value: 'BGN', label: 'BGN' },
                      { value: 'EUR', label: 'EUR' },
                      { value: 'USD', label: 'USD' },
                    ]} />
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
  const { idToken, base } = useContractsApi();
  const [stats, setStats]     = useState<ContractStats | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${base}/contracts/stats`, { headers: { Authorization: `Bearer ${idToken}` } });
      if (!res.ok) throw new Error(res.statusText);
      setStats(await res.json());
    } catch {
      message.error('Failed to load stats');
    } finally {
      setLoading(false);
    }
  }, [base, idToken]);

  useEffect(() => { fetchStats(); }, []);

  return (
    <Spin spinning={loading}>
      {stats && (
        <Row gutter={[16, 16]}>
          <Col xs={12} sm={6}>
            <div style={{ background: '#f0f4fb', borderRadius: 8, padding: '16px 20px', borderLeft: '4px solid #27ae60' }}>
              <Statistic
                title={<span style={{ color: '#475569', fontSize: 13 }}>Активни</span>}
                value={stats.active}
                valueStyle={{ color: '#27ae60', fontSize: 20, fontWeight: 700 }}
              />
            </div>
          </Col>
          <Col xs={12} sm={6}>
            <div style={{ background: '#f0f4fb', borderRadius: 8, padding: '16px 20px', borderLeft: '4px solid #e85d04' }}>
              <Statistic
                title={<span style={{ color: '#475569', fontSize: 13 }}>Изтичат скоро</span>}
                value={stats.expiringSoon}
                valueStyle={{ color: '#e85d04', fontSize: 20, fontWeight: 700 }}
              />
            </div>
          </Col>
          <Col xs={12} sm={6}>
            <div style={{ background: '#f0f4fb', borderRadius: 8, padding: '16px 20px', borderLeft: '4px solid #c0392b' }}>
              <Statistic
                title={<span style={{ color: '#475569', fontSize: 13 }}>Изтекли</span>}
                value={stats.expired}
                valueStyle={{ color: '#c0392b', fontSize: 20, fontWeight: 700 }}
              />
            </div>
          </Col>
          <Col xs={12} sm={6}>
            <div style={{ background: '#f0f4fb', borderRadius: 8, padding: '16px 20px', borderLeft: '4px solid #1890ff' }}>
              <Statistic
                title={<span style={{ color: '#475569', fontSize: 13 }}>За преглед</span>}
                value={stats.pending}
                valueStyle={{ color: '#1890ff', fontSize: 20, fontWeight: 700 }}
              />
            </div>
          </Col>
        </Row>
      )}
    </Spin>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ContractsPage() {
  const [activeTab, setActiveTab] = useState('contracts');

  const tabs = [
    {
      key: 'contracts',
      label: (
        <Space size={6}>
          <FileProtectOutlined />
          Договори
        </Space>
      ),
      children: <ContractsTab />,
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
  ];

  return (
    <div style={{ padding: '24px 32px', height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20, gap: 10 }}>
        <FileProtectOutlined style={{ fontSize: 22, color: BLUE }} />
        <Title level={4} style={{ margin: 0, color: BLUE }}>Договори</Title>
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
