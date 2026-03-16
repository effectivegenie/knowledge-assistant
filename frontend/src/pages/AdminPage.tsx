import { useState, useEffect, useRef } from 'react';
import { Table, Button, Form, Input, Drawer, Space, Typography, message, Tag, Popconfirm } from 'antd';
import type { TableProps } from 'antd';
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

interface TableState {
  page: number;
  pageSize: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
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
  const [tenantTotal, setTenantTotal] = useState(0);
  const [loading, setLoading]         = useState(true);
  const [createOpen, setCreateOpen]   = useState(false);
  const [editTenant, setEditTenant]   = useState<Tenant | null>(null);
  const [submitting, setSubmitting]   = useState(false);
  const [createForm] = Form.useForm();
  const [editForm]   = Form.useForm();

  const [tenantSearch, setTenantSearch] = useState('');
  const [tenantTableState, setTenantTableState] = useState<TableState>({ page: 0, pageSize: 20, sortBy: 'name', sortOrder: 'asc' });
  const tenantSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Users drawer state
  const [usersTenant, setUsersTenant]     = useState<Tenant | null>(null);
  const [users, setUsers]                 = useState<TenantUser[]>([]);
  const [userTotal, setUserTotal]         = useState(0);
  const [usersLoading, setUsersLoading]   = useState(false);
  const [addUserOpen, setAddUserOpen]     = useState(false);
  const [userSubmitting, setUserSubmitting] = useState(false);
  const [userForm] = Form.useForm();
  const [userSearch, setUserSearch] = useState('');
  const [userTableState, setUserTableState] = useState<TableState>({ page: 0, pageSize: 20, sortBy: 'email', sortOrder: 'asc' });
  const userSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const headers = { Authorization: `Bearer ${idToken}` };

  const fetchTenants = async (state: TableState = tenantTableState, search: string = tenantSearch) => {
    if (!idToken) return;
    if (!adminApiUrl || adminApiUrl.startsWith('REPLACE')) { setLoading(false); return; }
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        page: String(state.page),
        pageSize: String(state.pageSize),
        sortBy: state.sortBy,
        sortOrder: state.sortOrder,
        ...(search && { search }),
      });
      const res = await fetch(`${adminApiUrl}/tenants?${qs}`, { headers });
      if (!res.ok) {
        let errMsg = `${res.status} ${res.statusText}`;
        try { const d = await res.json(); if (d.error) errMsg = `${res.status}: ${d.error}`; } catch {}
        throw new Error(errMsg);
      }
      const data = await res.json();
      setTenants(data.items || []);
      setTenantTotal(data.total || 0);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to load tenants');
      setTenants([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTenants(); }, [idToken]);

  const fetchUsers = async (tenantId: string, state: TableState = userTableState, search: string = userSearch) => {
    setUsersLoading(true);
    try {
      const qs = new URLSearchParams({
        page: String(state.page),
        pageSize: String(state.pageSize),
        sortBy: state.sortBy,
        sortOrder: state.sortOrder,
        ...(search && { search }),
      });
      const res = await fetch(`${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}/users?${qs}`, { headers });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setUsers(data.items || []);
      setUserTotal(data.total || 0);
    } catch {
      message.error('Failed to load users');
    } finally {
      setUsersLoading(false);
    }
  };

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

  const closeUsers = () => {
    setUsersTenant(null);
    setUsers([]);
    setUserTotal(0);
    setAddUserOpen(false);
    userForm.resetFields();
    setUserSearch('');
    setUserTableState({ page: 0, pageSize: 20, sortBy: 'email', sortOrder: 'asc' });
  };

  const openUsers = async (tenant: Tenant) => {
    setUsersTenant(tenant);
    setUsers([]);
    setUserSearch('');
    const initState: TableState = { page: 0, pageSize: 20, sortBy: 'email', sortOrder: 'asc' };
    setUserTableState(initState);
    fetchUsers(tenant.tenantId, initState, '');
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
      fetchUsers(usersTenant.tenantId, userTableState, userSearch);
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
      fetchUsers(usersTenant.tenantId, userTableState, userSearch);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to delete user');
    }
  };

  const userColumns = [
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
      sorter: true,
      render: (email: string) => <Text strong>{email}</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      sorter: true,
      render: (status: string) => <Tag color={STATUS_COLOR[status] ?? 'default'}>{status ?? '—'}</Tag>,
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      sorter: true,
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

  const tenantColumns = [
    {
      title: 'Tenant ID',
      dataIndex: 'tenantId',
      key: 'tenantId',
      sorter: true,
      render: (id: string) => <Tag color="blue">{id}</Tag>,
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      sorter: true,
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      sorter: true,
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

  const handleTenantTableChange: TableProps<Tenant>['onChange'] = (pagination, _, sorter) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    const newState: TableState = {
      page: (pagination.current || 1) - 1,
      pageSize: pagination.pageSize || 20,
      sortBy: (s.field ? String(s.field) : tenantTableState.sortBy),
      sortOrder: s.order === 'descend' ? 'desc' : 'asc',
    };
    setTenantTableState(newState);
    fetchTenants(newState, tenantSearch);
  };

  const handleUserTableChange: TableProps<TenantUser>['onChange'] = (pagination, _, sorter) => {
    if (!usersTenant) return;
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    const newState: TableState = {
      page: (pagination.current || 1) - 1,
      pageSize: pagination.pageSize || 20,
      sortBy: (s.field ? String(s.field) : userTableState.sortBy),
      sortOrder: s.order === 'descend' ? 'desc' : 'asc',
    };
    setUserTableState(newState);
    fetchUsers(usersTenant.tenantId, newState, userSearch);
  };

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
        onChange={e => {
          const value = e.target.value;
          setTenantSearch(value);
          if (tenantSearchTimer.current) clearTimeout(tenantSearchTimer.current);
          tenantSearchTimer.current = setTimeout(() => {
            const resetState = { ...tenantTableState, page: 0 };
            setTenantTableState(resetState);
            fetchTenants(resetState, value);
          }, 400);
        }}
        allowClear
        onClear={() => {
          const resetState = { ...tenantTableState, page: 0 };
          setTenantTableState(resetState);
          fetchTenants(resetState, '');
        }}
        style={{ marginBottom: 12, maxWidth: 320 }}
      />

      <Table
        loading={loading}
        dataSource={tenants}
        rowKey="tenantId"
        columns={tenantColumns}
        onChange={handleTenantTableChange}
        pagination={{
          current: tenantTableState.page + 1,
          pageSize: tenantTableState.pageSize,
          total: tenantTotal,
          showTotal: (t) => `${t} tenant${t !== 1 ? 's' : ''}`,
          hideOnSinglePage: true,
          showSizeChanger: false,
        }}
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
        onClose={closeUsers}
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
          onChange={e => {
            const value = e.target.value;
            setUserSearch(value);
            if (!usersTenant) return;
            if (userSearchTimer.current) clearTimeout(userSearchTimer.current);
            userSearchTimer.current = setTimeout(() => {
              const resetState = { ...userTableState, page: 0 };
              setUserTableState(resetState);
              fetchUsers(usersTenant.tenantId, resetState, value);
            }, 400);
          }}
          allowClear
          onClear={() => {
            if (!usersTenant) return;
            const resetState = { ...userTableState, page: 0 };
            setUserTableState(resetState);
            fetchUsers(usersTenant.tenantId, resetState, '');
          }}
          style={{ marginBottom: 12 }}
        />
        <Table
          loading={usersLoading}
          dataSource={users}
          rowKey="username"
          columns={userColumns}
          onChange={handleUserTableChange}
          pagination={{
            current: userTableState.page + 1,
            pageSize: userTableState.pageSize,
            total: userTotal,
            showTotal: (t) => `${t} user${t !== 1 ? 's' : ''}`,
            hideOnSinglePage: true,
            showSizeChanger: false,
          }}
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
