import { useState, useEffect } from 'react';
import { Table, Button, Form, Input, Drawer, Space, Typography, message, Tag } from 'antd';
import { PlusOutlined, TeamOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';
import { adminApiUrl } from '../config';

const { Title, Text } = Typography;

interface Tenant {
  tenantId: string;
  name: string;
  createdAt?: string;
}

export default function AdminPage() {
  const { idToken } = useAuth();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  const fetchTenants = async () => {
    if (!adminApiUrl || adminApiUrl.startsWith('REPLACE')) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${adminApiUrl}/tenants`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setTenants(data.tenants || []);
    } catch {
      message.error('Failed to load tenants');
      setTenants([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTenants();
  }, [idToken]);

  const handleCreate = async (values: { tenantId: string; name: string; adminEmail: string; temporaryPassword: string }) => {
    setSubmitting(true);
    try {
      const res = await fetch(`${adminApiUrl}/tenants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          tenantId: values.tenantId.trim(),
          name: values.name.trim(),
          adminEmail: values.adminEmail.trim(),
          temporaryPassword: values.temporaryPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      message.success(`Tenant "${values.name}" created`);
      form.resetFields();
      setDrawerOpen(false);
      fetchTenants();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to create tenant');
    } finally {
      setSubmitting(false);
    }
  };

  const columns = [
    {
      title: 'Tenant ID',
      dataIndex: 'tenantId',
      key: 'tenantId',
      render: (id: string) => <Tag color="blue">{id}</Tag>,
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (t: string) => t ? new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
    },
  ];

  return (
    <div style={{ padding: '24px 32px', height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <Space size={10}>
          <TeamOutlined style={{ fontSize: 22, color: '#1e3a5f' }} />
          <Title level={4} style={{ margin: 0, color: '#1e3a5f' }}>Tenants</Title>
        </Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)}>
          New tenant
        </Button>
      </div>

      <Table
        loading={loading}
        dataSource={tenants}
        rowKey="tenantId"
        columns={columns}
        pagination={false}
        style={{ width: '100%' }}
        bordered
      />

      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Create tenant</span>}
        placement="right"
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); form.resetFields(); }}
        width={400}
        closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
        styles={{
          header: { background: '#1e3a5f', borderBottom: '2px solid #e6a800', padding: '16px 20px' },
          body: { paddingTop: 24 },
          footer: { borderTop: '1px solid #f0f4fb' },
        }}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={() => { setDrawerOpen(false); form.resetFields(); }}>Cancel</Button>
            <Button type="primary" loading={submitting} onClick={() => form.submit()}>Create</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="tenantId" label="Tenant ID" rules={[{ required: true, message: 'Required' }]}
            extra="Lowercase letters, numbers, hyphens only">
            <Input placeholder="e.g. acme" />
          </Form.Item>
          <Form.Item name="name" label="Display name" rules={[{ required: true, message: 'Required' }]}>
            <Input placeholder="e.g. Acme Corp" />
          </Form.Item>
          <Form.Item name="adminEmail" label="Admin email" rules={[{ required: true, type: 'email', message: 'Valid email required' }]}>
            <Input placeholder="admin@acme.com" />
          </Form.Item>
          <Form.Item name="temporaryPassword" label="Temporary password" rules={[{ required: true, min: 8, message: 'Min 8 characters' }]}>
            <Input.Password placeholder="Min 8 characters" />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}
