import { useState, useEffect } from 'react';
import { Row, Col, Statistic, Typography, Skeleton, Empty, Alert } from 'antd';
import type { ReactNode } from 'react';
import {
  FolderOutlined, FileTextOutlined, FileProtectOutlined,
  WarningOutlined, ClockCircleOutlined, CheckCircleOutlined,
} from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';
import { adminApiUrl } from '../config';

const { Title, Text } = Typography;
const BLUE = '#1e3a5f';
const GOLD = '#e6a800';

interface DashboardData {
  documents: number;
  invoices: number;
  invoicesForReview: number;
  contractStats: { active: number; expiringSoon: number; expired: number; pending: number };
}

function StatCard({ title, value, color, icon, loading, onClick }: {
  title: string; value: number; color: string; icon: ReactNode; loading: boolean; onClick?: () => void;
}) {
  return (
    <div style={{
      background: '#fff',
      borderRadius: 12,
      padding: '20px 24px',
      border: '1px solid #f0f4fb',
      borderLeft: `4px solid ${color}`,
      boxShadow: '0 1px 6px rgba(30,58,95,0.07)',
      height: '100%',
      cursor: onClick ? 'pointer' : 'default',
    }}
    onClick={onClick}
    >
      {loading ? (
        <Skeleton active paragraph={{ rows: 1 }} title={{ width: '60%' }} />
      ) : (
        <Statistic
          title={
            <span style={{ color: '#475569', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              {icon}{title}
            </span>
          }
          value={value}
          valueStyle={{ color, fontSize: 28, fontWeight: 700, textDecoration: onClick ? 'underline' : 'none' }}
        />
      )}
    </div>
  );
}

export default function DashboardPage({ onNavigate }: { onNavigate?: (view: string, tab?: string) => void }) {
  const { user, idToken } = useAuth();
  const tenantId = user?.tenantId ?? 'default';
  const base = `${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}`;

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!idToken) return;
    setLoading(true);
    setError(false);
    const h = { Authorization: `Bearer ${idToken}` };

    Promise.all([
      fetch(`${base}/documents?pageSize=1`, { headers: h }).then(r => r.json()).catch(() => ({ total: 0 })),
      fetch(`${base}/invoices?pageSize=1`, { headers: h }).then(r => r.json()).catch(() => ({ total: 0 })),
      fetch(`${base}/invoices?statuses=review_needed,extracted&pageSize=1`, { headers: h }).then(r => r.json()).catch(() => ({ total: 0 })),
      fetch(`${base}/contracts/stats`, { headers: h }).then(r => r.json()).catch(() => ({ active: 0, expiringSoon: 0, expired: 0, pending: 0 })),
    ]).then(([docs, invoices, reviewInvoices, contractStats]) => {
      setData({
        documents:          docs.total           ?? 0,
        invoices:           invoices.total        ?? 0,
        invoicesForReview:  reviewInvoices.total  ?? 0,
        contractStats:      contractStats         ?? { active: 0, expiringSoon: 0, expired: 0, pending: 0 },
      });
    }).catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [idToken, tenantId]);

  const isEmpty = !loading && !error && data &&
    data.documents === 0 && data.invoices === 0 &&
    data.contractStats.active === 0 && data.contractStats.pending === 0;

  const cs = data?.contractStats ?? { active: 0, expiringSoon: 0, expired: 0, pending: 0 };

  return (
    <div style={{ padding: '16px 20px', height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 28 }}>
        <Title level={4} style={{ margin: 0, color: BLUE }}>Табло</Title>
        <Text type="secondary" style={{ fontSize: 13 }}>{tenantId}</Text>
      </div>

      {error && (
        <Alert
          message="Грешка при зареждане"
          description="Не можахме да заредим данните. Опитайте отново."
          type="error"
          showIcon
          style={{ marginBottom: 24, maxWidth: 480 }}
        />
      )}

      {isEmpty ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span style={{ color: '#888' }}>
              Все още нямате качени документи, фактури или договори.
            </span>
          }
          style={{ marginTop: 64 }}
        />
      ) : (
        <>
          <Text style={{ display: 'block', color: '#8c97a8', marginBottom: 12, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>
            Обобщение
          </Text>
          <Row gutter={[16, 16]} style={{ marginBottom: 32 }}>
            <Col xs={24} sm={12} lg={8}>
              <StatCard
                title="Документи"
                value={data?.documents ?? 0}
                color={BLUE}
                icon={<FolderOutlined />}
                loading={loading}
                onClick={() => onNavigate?.('documents')}
              />
            </Col>
            <Col xs={24} sm={12} lg={8}>
              <StatCard
                title="Фактури"
                value={data?.invoices ?? 0}
                color={GOLD}
                icon={<FileTextOutlined />}
                loading={loading}
                onClick={() => onNavigate?.('invoices', 'invoices')}
              />
            </Col>
            <Col xs={24} sm={12} lg={8}>
              <StatCard
                title="Активни договори"
                value={cs.active}
                color="#27ae60"
                icon={<CheckCircleOutlined />}
                loading={loading}
                onClick={() => onNavigate?.('contracts', 'contracts')}
              />
            </Col>
          </Row>

          <Text style={{ display: 'block', color: '#8c97a8', marginBottom: 12, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>
            Изискват внимание
          </Text>
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12} lg={6}>
              <StatCard
                title="Фактури за преглед"
                value={data?.invoicesForReview ?? 0}
                color={(data?.invoicesForReview ?? 0) > 0 ? '#e85d04' : '#8c8c8c'}
                icon={<WarningOutlined />}
                loading={loading}
                onClick={() => onNavigate?.('invoices', 'pending')}
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <StatCard
                title="Договори за преглед"
                value={cs.pending}
                color={cs.pending > 0 ? '#e85d04' : '#8c8c8c'}
                icon={<FileProtectOutlined />}
                loading={loading}
                onClick={() => onNavigate?.('contracts', 'pending')}
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <StatCard
                title="Изтичащи договори"
                value={cs.expiringSoon}
                color={cs.expiringSoon > 0 ? '#faad14' : '#8c8c8c'}
                icon={<ClockCircleOutlined />}
                loading={loading}
                onClick={() => onNavigate?.('contracts', 'contracts')}
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <StatCard
                title="Изтекли договори"
                value={cs.expired}
                color={cs.expired > 0 ? '#c0392b' : '#8c8c8c'}
                icon={<ClockCircleOutlined />}
                loading={loading}
                onClick={() => onNavigate?.('contracts', 'contracts')}
              />
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}
