import { useState, useEffect, useRef } from 'react';
import { Table, Button, Form, Input, Drawer, Space, Typography, message, Tag, Popconfirm, Select } from 'antd';
import type { TableProps } from 'antd';
import { PlusOutlined, UserOutlined, DeleteOutlined, SearchOutlined, EditOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';
import { adminApiUrl } from '../config';

const { Title, Text } = Typography;

const BUSINESS_GROUPS = [
  'financial', 'accounting', 'operations', 'marketing', 'IT',
  'warehouse', 'security', 'logistics', 'sales', 'design', 'HR',
];

// Options for user assignment (business groups only)
const GROUP_OPTIONS = BUSINESS_GROUPS.map(g => ({ label: g, value: g }));
interface TenantUser {
  username: string;
  email?: string;
  status?: string;
  createdAt?: string;
  businessGroups?: string[];
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

const DRAWER_STYLES = {
  header: { background: '#1e3a5f', borderBottom: '2px solid #e6a800', padding: '16px 20px' },
  body:   { paddingTop: 24 },
  footer: { borderTop: '1px solid #f0f4fb' },
};

export default function TenantAdminPage() {
  const { user, idToken } = useAuth();
  const tenantId = user?.tenantId ?? 'default';
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [userSearch, setUserSearch] = useState('');
  const [userTableState, setUserTableState] = useState<TableState>({ page: 0, pageSize: 20, sortBy: 'email', sortOrder: 'asc' });
  const userSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  const [editUser, setEditUser] = useState<TenantUser | null>(null);
  const [editGroupsSubmitting, setEditGroupsSubmitting] = useState(false);
  const [editGroupsForm] = Form.useForm();

  const authHeaders = { Authorization: `Bearer ${idToken}` };

  const fetchUsers = async (state: TableState = userTableState, search: string = userSearch) => {
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
      const res = await fetch(`${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}/users?${qs}`, {
        headers: authHeaders,
      });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setUsers(data.items || []);
      setUserTotal(data.total || 0);
    } catch {
      message.error('Failed to load users');
      setUsers([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchUsers(); }, [idToken, tenantId]);

  const handleCreate = async (values: { email: string; temporaryPassword: string; businessGroups?: string[] }) => {
    setSubmitting(true);
    try {
      const res = await fetch(`${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          email: values.email.trim(),
          temporaryPassword: values.temporaryPassword,
          businessGroups: values.businessGroups ?? [],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      message.success(`User ${values.email} created`);
      form.resetFields();
      setDrawerOpen(false);
      fetchUsers(userTableState, userSearch);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to create user');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (username: string) => {
    try {
      const res = await fetch(
        `${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(username)}`,
        { method: 'DELETE', headers: authHeaders },
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || res.statusText);
      }
      message.success('User deleted');
      fetchUsers(userTableState, userSearch);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to delete user');
    }
  };

  const openEditUser = (record: TenantUser) => {
    setEditUser(record);
    editGroupsForm.setFieldsValue({ businessGroups: record.businessGroups ?? [] });
  };

  const handleUpdateGroups = async (values: { businessGroups: string[] }) => {
    if (!editUser) return;
    setEditGroupsSubmitting(true);
    try {
      const res = await fetch(
        `${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(editUser.username)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ businessGroups: values.businessGroups ?? [] }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      message.success('Groups updated');
      setEditUser(null);
      fetchUsers(userTableState, userSearch);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to update groups');
    } finally {
      setEditGroupsSubmitting(false);
    }
  };

  const handleTableChange: TableProps<TenantUser>['onChange'] = (pagination, _, sorter) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    const newState: TableState = {
      page: (pagination.current || 1) - 1,
      pageSize: pagination.pageSize || 20,
      sortBy: s.field ? String(s.field) : userTableState.sortBy,
      sortOrder: s.order === 'descend' ? 'desc' : 'asc',
    };
    setUserTableState(newState);
    fetchUsers(newState, userSearch);
  };

  const columns = [
    {
      title: 'Имейл',
      dataIndex: 'email',
      key: 'email',
      sorter: true,
      render: (email: string) => <Text strong>{email}</Text>,
    },
    {
      title: 'Статус',
      dataIndex: 'status',
      key: 'status',
      sorter: true,
      render: (status: string) => (
        <Tag color={STATUS_COLOR[status] ?? 'default'}>{status ?? '—'}</Tag>
      ),
    },
    {
      title: 'Създаден',
      dataIndex: 'createdAt',
      key: 'createdAt',
      sorter: true,
      render: (t: string) => t ? new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
    },
    {
      title: 'Групи',
      dataIndex: 'businessGroups',
      key: 'businessGroups',
      render: (groups: string[] | undefined) => (
        <Space size={4} wrap>
          {(groups ?? []).length === 0
            ? <Tag color="default">—</Tag>
            : (groups ?? []).map(g => <Tag key={g} color="geekblue">{g}</Tag>)
          }
        </Space>
      ),
    },
    {
      title: 'Действия',
      key: 'actions',
      width: 90,
      render: (_: unknown, record: TenantUser) => (
        <Space size={4}>
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => openEditUser(record)}
            style={{ color: '#1e3a5f' }}
            title="Редакция на групи"
          />
          <Popconfirm
            title={`Изтрий потребител "${record.email || record.username}"?`}
            description="Потребителят ще бъде премахнат окончателно от Cognito."
            onConfirm={() => handleDelete(record.username)}
            okText="Изтрий"
            okButtonProps={{ danger: true }}
            cancelText="Отказ"
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
          <UserOutlined style={{ fontSize: 22, color: '#1e3a5f' }} />
          <Title level={4} style={{ margin: 0, color: '#1e3a5f' }}>
            Потребители
            <Text type="secondary" style={{ fontSize: 14, fontWeight: 400, marginLeft: 8 }}>
              {tenantId}
            </Text>
          </Title>
        </Space>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)}>
          Добави потребител
        </Button>
      </div>

      <Input
        prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
        placeholder="Търси по имейл или статус…"
        value={userSearch}
        onChange={e => {
          const value = e.target.value;
          setUserSearch(value);
          if (userSearchTimer.current) clearTimeout(userSearchTimer.current);
          userSearchTimer.current = setTimeout(() => {
            const resetState = { ...userTableState, page: 0 };
            setUserTableState(resetState);
            fetchUsers(resetState, value);
          }, 400);
        }}
        allowClear
        onClear={() => {
          const resetState = { ...userTableState, page: 0 };
          setUserTableState(resetState);
          fetchUsers(resetState, '');
        }}
        style={{ marginBottom: 12, maxWidth: 320 }}
      />
      <Table
        loading={loading}
        dataSource={users}
        rowKey="username"
        columns={columns}
        onChange={handleTableChange}
        pagination={{
          current: userTableState.page + 1,
          pageSize: userTableState.pageSize,
          total: userTotal,
          showTotal: (t) => `${t} потребител${t !== 1 ? 'я' : ''}`,
          hideOnSinglePage: true,
          showSizeChanger: false,
        }}
        style={{ width: '100%' }}
        bordered
      />

      {/* ── Edit User Groups Drawer ── */}
      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Редакция на групи</span>}
        placement="right"
        open={!!editUser}
        onClose={() => { setEditUser(null); editGroupsForm.resetFields(); }}
        width={360}
        closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
        styles={DRAWER_STYLES}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={() => { setEditUser(null); editGroupsForm.resetFields(); }}>Отказ</Button>
            <Button type="primary" loading={editGroupsSubmitting} onClick={() => editGroupsForm.submit()}>Запиши</Button>
          </Space>
        }
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
          Потребител: <strong>{editUser?.email || editUser?.username}</strong>
        </Text>
        <Form form={editGroupsForm} layout="vertical" onFinish={handleUpdateGroups}>
          <Form.Item name="businessGroups" label="Бизнес групи">
            <Select
              mode="multiple"
              options={GROUP_OPTIONS}
              placeholder="Избери бизнес групи"
              allowClear
            />
          </Form.Item>
        </Form>
      </Drawer>

      {/* ── Add User Drawer ── */}
      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Добави потребител</span>}
        placement="right"
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); form.resetFields(); }}
        width={360}
        closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
        styles={DRAWER_STYLES}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={() => { setDrawerOpen(false); form.resetFields(); }}>Отказ</Button>
            <Button type="primary" loading={submitting} onClick={() => form.submit()}>Създай</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="email" label="Имейл" rules={[{ required: true, type: 'email', message: 'Невалиден имейл' }]}>
            <Input placeholder="user@example.com" />
          </Form.Item>
          <Form.Item name="temporaryPassword" label="Временна парола" rules={[{ required: true, min: 8, message: 'Минимум 8 символа' }]}>
            <Input.Password placeholder="Минимум 8 символа" />
          </Form.Item>
          <Form.Item name="businessGroups" label="Бизнес групи">
            <Select
              mode="multiple"
              options={GROUP_OPTIONS}
              placeholder="Избери бизнес групи (по избор)"
              allowClear
            />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}
