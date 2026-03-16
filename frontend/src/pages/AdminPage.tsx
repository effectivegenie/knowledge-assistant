import { useState, useEffect } from 'react';
import { Table, Button, Form, Input, Drawer, Space, Typography, message, Tag, Popconfirm } from 'antd';
import { PlusOutlined, TeamOutlined, EditOutlined, DeleteOutlined, UserOutlined, SearchOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';
import { adminApiUrl } from '../config';

const { Title, Text } = Typography;

interface Tenant {
  tenantId: string;
  name: string;
  createdAt?: string;
}

interface TenantUser {
  username: string;
  email?: string;
  status?: string;
  createdAt?: string;
}

const STATUS_COLOR: Record<string, string> = {
  CONFIRMED: 'green',
  FORCE_CHANGE_PASSWORD: 'orange',
  UNCONFIRMED: 'red',
};

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

  const [tenantSearch, setTenantSearch] = useState('');

  // Users drawer state
  const [usersTenant, setUsersTenant]     = useState<Tenant | null>(null);
  const [users, setUsers]                 = useState<TenantUser[]>([]);
  const [usersLoading, setUsersLoading]   = useState(false);
  const [addUserOpen, setAddUserOpen]     = useState(false);
  const [userSubmitting, setUserSubmitting] = useState(false);
  const [userForm] = Form.useForm();
  const [userSearch, setUserSearch] = useState('');

  const headers = { Authorization: `Bearer ${idToken}` };

  const fetchTenants = async () => {
    if (!idToken) return;
    if (!adminApiUrl || adminApiUrl.startsWith('REPLACE')) { setLoading(false); return; }
    setLoading(true);
    try {
      const res = await fetch(`${adminApiUrl}/tenants`, { headers });
      if (!res.ok) {
        let errMsg = `${res.status} ${res.statusText}`;
        try { const d = await res.json(); if (d.error) errMsg = `${res.status}: ${d.error}`; } catch {}
        throw new Error(errMsg);
      }
      const data = await res.json();
      setTenants(data.tenants || []);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to load tenants');
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

  const openUsers = async (tenant: Tenant) => {
    setUsersTenant(tenant);
    setUsers([]);
    setUserSearch('');
    setUsersLoading(true);
    try {
      const res = await fetch(`${adminApiUrl}/tenants/${encodeURIComponent(tenant.tenantId)}/users`, { headers });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setUsers(data.users || []);
    } catch {
      message.error('Failed to load users');
    } finally {
      setUsersLoading(false);
    }
  };

  const refreshUsers = async (tenantId: string) => {
    setUsersLoading(true);
    try {
      const res = await fetch(`${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}/users`, { headers });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setUsers(data.users || []);
    } catch {
      message.error('Failed to load users');
    } finally {
      setUsersLoading(false);
    }
  };

  const handleCreateUser = async (values: { email: string; temporaryPassword: string }) => {
    if (!usersTenant) return;
    setUserSubmitting(true);
    try {
      const res = await fetch(`${adminApiUrl}/tenants/${encodeURIComponent(usersTenant.tenantId)}/users`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: values.email.trim(), temporaryPassword: values.temporaryPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      message.success(`User ${values.email} created`);
      userForm.resetFields();
      setAddUserOpen(false);
      refreshUsers(usersTenant.tenantId);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to create user');
    } finally {
      setUserSubmitting(false);
    }
  };

  const handleDeleteUser = async (username: string) => {
    if (!usersTenant) return;
    try {
      const res = await fetch(
        `${adminApiUrl}/tenants/${encodeURIComponent(usersTenant.tenantId)}/users/${encodeURIComponent(username)}`,
        { method: 'DELETE', headers },
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || res.statusText);
      }
      message.success('User deleted');
      refreshUsers(usersTenant.tenantId);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to delete user');
    }
  };

  const filteredTenants = tenants.filter(t => {
    const q = tenantSearch.toLowerCase();
    return !q || t.tenantId.toLowerCase().includes(q) || t.name.toLowerCase().includes(q);
  });

  const filteredUsers = users.filter(u => {
    const q = userSearch.toLowerCase();
    return !q || (u.email ?? '').toLowerCase().includes(q) || (u.status ?? '').toLowerCase().includes(q);
  });

  const userColumns = [
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
      sorter: (a: TenantUser, b: TenantUser) => (a.email ?? '').localeCompare(b.email ?? ''),
      render: (email: string) => <Text strong>{email}</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      sorter: (a: TenantUser, b: TenantUser) => (a.status ?? '').localeCompare(b.status ?? ''),
      render: (status: string) => <Tag color={STATUS_COLOR[status] ?? 'default'}>{status ?? '—'}</Tag>,
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      sorter: (a: TenantUser, b: TenantUser) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime(),
      render: (t: string) => t ? new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 80,
      render: (_: unknown, record: TenantUser) => (
        <Popconfirm
          title={`Delete user "${record.email || record.username}"?`}
          description="The user will be permanently removed from Cognito."
          onConfirm={() => handleDeleteUser(record.username)}
          okText="Delete"
          okButtonProps={{ danger: true }}
          cancelText="Cancel"
        >
          <Button type="text" icon={<DeleteOutlined />} danger />
        </Popconfirm>
      ),
    },
  ];

  const columns = [
    {
      title: 'Tenant ID',
      dataIndex: 'tenantId',
      key: 'tenantId',
      sorter: (a: Tenant, b: Tenant) => a.tenantId.localeCompare(b.tenantId),
      render: (id: string) => <Tag color="blue">{id}</Tag>,
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      sorter: (a: Tenant, b: Tenant) => a.name.localeCompare(b.name),
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      sorter: (a: Tenant, b: Tenant) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime(),
      render: (t: string) => t ? new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      render: (_: unknown, record: Tenant) => (
        <Space size={4}>
          <Button
            type="text"
            icon={<UserOutlined />}
            onClick={() => openUsers(record)}
            style={{ color: '#1e3a5f' }}
            title="Manage users"
          />
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <Space size={10}>
          <TeamOutlined style={{ fontSize: 22, color: '#1e3a5f' }} />
          <Title level={4} style={{ margin: 0, color: '#1e3a5f' }}>Tenants</Title>
        </Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          New tenant
        </Button>
      </div>

      <Input
        prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
        placeholder="Search by tenant ID or name…"
        value={tenantSearch}
        onChange={e => setTenantSearch(e.target.value)}
        allowClear
        style={{ marginBottom: 12, maxWidth: 320 }}
      />

      <Table
        loading={loading}
        dataSource={filteredTenants}
        rowKey="tenantId"
        columns={columns}
        pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
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

      {/* ── Users Drawer ── */}
      <Drawer
        title={
          <Space>
            <UserOutlined style={{ color: '#e6a800' }} />
            <span style={{ color: '#fff', fontWeight: 700 }}>Users</span>
            {usersTenant && <Tag color="blue" style={{ marginLeft: 4 }}>{usersTenant.tenantId}</Tag>}
          </Space>
        }
        placement="right"
        open={!!usersTenant}
        onClose={() => { setUsersTenant(null); setUsers([]); setAddUserOpen(false); userForm.resetFields(); setUserSearch(''); }}
        width={600}
        closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
        styles={DRAWER_HEADER}
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setAddUserOpen(true)}
            size="small"
          >
            Add user
          </Button>
        }
      >
        <Input
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          placeholder="Search by email or status…"
          value={userSearch}
          onChange={e => setUserSearch(e.target.value)}
          allowClear
          style={{ marginBottom: 12 }}
        />
        <Table
          loading={usersLoading}
          dataSource={filteredUsers}
          rowKey="username"
          columns={userColumns}
          pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
          bordered
          size="small"
        />

        {/* ── Add User nested Drawer ── */}
        <Drawer
          title={<span style={{ color: '#fff', fontWeight: 700 }}>Add user</span>}
          placement="right"
          open={addUserOpen}
          onClose={() => { setAddUserOpen(false); userForm.resetFields(); }}
          width={360}
          closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
          styles={DRAWER_HEADER}
          footer={
            <Space style={{ float: 'right' }}>
              <Button onClick={() => { setAddUserOpen(false); userForm.resetFields(); }}>Cancel</Button>
              <Button type="primary" loading={userSubmitting} onClick={() => userForm.submit()}>Create</Button>
            </Space>
          }
        >
          <Form form={userForm} layout="vertical" onFinish={handleCreateUser}>
            <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email', message: 'Valid email required' }]}>
              <Input placeholder="user@example.com" />
            </Form.Item>
            <Form.Item name="temporaryPassword" label="Temporary password" rules={[{ required: true, min: 8, message: 'Min 8 characters' }]}>
              <Input.Password placeholder="Min 8 characters" />
            </Form.Item>
          </Form>
        </Drawer>
      </Drawer>
    </div>
  );
}
