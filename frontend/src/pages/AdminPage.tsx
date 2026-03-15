import { useState, useEffect } from 'react';
import { Table, Button, Form, Input, Drawer, Space, Typography, message, Tag, Popconfirm } from 'antd';
import { PlusOutlined, TeamOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';
import { adminApiUrl } from '../config';

const { Title, Text } = Typography;

interface Tenant {
  tenantId: string;
  name: string;
  createdAt?: string;
}

const DRAWER_HEADER = {
  header: { background: '#1e3a5f', borderBottom: '2px solid #e6a800', padding: '16px 20px' },
  body:   { paddingTop: 24 },
  footer: { borderTop: '1px solid #f0f4fb' },
};

export default function AdminPage() {
  const { idToken } = useAuth();
  const [tenants, setTenants]         = useState<Tenant[]>([]);
  const [loading, setLoading]         = useState(true);
  const [createOpen, setCreateOpen]   = useState(false);
  const [editTenant, setEditTenant]   = useState<Tenant | null>(null);
  const [submitting, setSubmitting]   = useState(false);
  const [createForm] = Form.useForm();
  const [editForm]   = Form.useForm();

  const headers = { Authorization: `Bearer ${idToken}` };

  const fetchTenants = async () => {
    if (!adminApiUrl || adminApiUrl.startsWith('REPLACE')) { setLoading(false); return; }
    setLoading(true);
    try {
      const res = await fetch(`${adminApiUrl}/tenants`, { headers });
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

  useEffect(() => { fetchTenants(); }, [idToken]);

  const handleCreate = async (values: { tenantId: string; name: string; adminEmail: string; temporaryPassword: string }) => {
    setSubmitting(true);
    try {
      const res = await fetch(`${adminApiUrl}/tenants`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
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
      createForm.resetFields();
      setCreateOpen(false);
      fetchTenants();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to create tenant');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async (values: { name: string }) => {
    if (!editTenant) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${adminApiUrl}/tenants/${encodeURIComponent(editTenant.tenantId)}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: values.name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      message.success('Tenant updated');
      setEditTenant(null);
      fetchTenants();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to update tenant');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (tenantId: string) => {
    try {
      const res = await fetch(`${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}`, {
        method: 'DELETE',
        headers,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || res.statusText);
      }
      message.success(`Tenant "${tenantId}" deleted`);
      fetchTenants();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to delete tenant');
    }
  };

  const openEdit = (tenant: Tenant) => {
    setEditTenant(tenant);
    editForm.setFieldsValue({ name: tenant.name });
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
    {
      title: 'Actions',
      key: 'actions',
      width: 100,
      render: (_: unknown, record: Tenant) => (
        <Space size={4}>
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => openEdit(record)}
            style={{ color: '#1e3a5f' }}
          />
          <Popconfirm
            title={`Delete tenant "${record.tenantId}"?`}
            description="This will remove the tenant record and all its Cognito users."
            onConfirm={() => handleDelete(record.tenantId)}
            okText="Delete"
            okButtonProps={{ danger: true }}
            cancelText="Cancel"
          >
            <Button type="text" icon={<DeleteOutlined />} danger />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: '24px 32px', height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <Space size={10}>
          <TeamOutlined style={{ fontSize: 22, color: '#1e3a5f' }} />
          <Title level={4} style={{ margin: 0, color: '#1e3a5f' }}>Tenants</Title>
        </Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
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

      {/* ── Create Drawer ── */}
      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Create tenant</span>}
        placement="right"
        open={createOpen}
        onClose={() => { setCreateOpen(false); createForm.resetFields(); }}
        width={400}
        closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
        styles={DRAWER_HEADER}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={() => { setCreateOpen(false); createForm.resetFields(); }}>Cancel</Button>
            <Button type="primary" loading={submitting} onClick={() => createForm.submit()}>Create</Button>
          </Space>
        }
      >
        <Form form={createForm} layout="vertical" onFinish={handleCreate}>
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

      {/* ── Edit Drawer ── */}
      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Edit tenant</span>}
        placement="right"
        open={!!editTenant}
        onClose={() => setEditTenant(null)}
        width={360}
        closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
        styles={DRAWER_HEADER}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={() => setEditTenant(null)}>Cancel</Button>
            <Button type="primary" loading={submitting} onClick={() => editForm.submit()}>Save</Button>
          </Space>
        }
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 20 }}>
          Tenant ID: <Tag color="blue">{editTenant?.tenantId}</Tag>
        </Text>
        <Form form={editForm} layout="vertical" onFinish={handleEdit}>
          <Form.Item name="name" label="Display name" rules={[{ required: true, message: 'Required' }]}>
            <Input placeholder="Display name" />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}
