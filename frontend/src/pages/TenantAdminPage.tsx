import { useState, useEffect, useRef } from 'react';
import { Table, Button, Form, Input, Drawer, Space, Typography, message, Tag, Popconfirm, Upload, Select } from 'antd';
import type { UploadProps } from 'antd';
import { PlusOutlined, UserOutlined, DeleteOutlined, UploadOutlined, InboxOutlined, SearchOutlined, EditOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';
import { adminApiUrl } from '../config';

const { Dragger } = Upload;
const { Title, Text } = Typography;

const BUSINESS_GROUPS = [
  'financial', 'accounting', 'operations', 'marketing', 'IT',
  'warehouse', 'security', 'logistics', 'sales',
];

// Options for user assignment (business groups only)
const GROUP_OPTIONS = BUSINESS_GROUPS.map(g => ({ label: g, value: g }));

// Options for document tagging (business groups + general)
const DOCUMENT_TAG_OPTIONS = [
  { label: 'general — accessible to all users', value: 'general' },
  ...BUSINESS_GROUPS.map(g => ({ label: g, value: g })),
];

interface TenantUser {
  username: string;
  email?: string;
  status?: string;
  createdAt?: string;
  businessGroups?: string[];
}

const STATUS_COLOR: Record<string, string> = {
  CONFIRMED: 'green',
  FORCE_CHANGE_PASSWORD: 'orange',
  UNCONFIRMED: 'red',
};

export default function TenantAdminPage() {
  const { user, idToken } = useAuth();
  const tenantId = user?.tenantId ?? 'default';
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [userSearch, setUserSearch] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [uploadDrawerOpen, setUploadDrawerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const [editUser, setEditUser] = useState<TenantUser | null>(null);
  const [editGroupsSubmitting, setEditGroupsSubmitting] = useState(false);
  const [editGroupsForm] = Form.useForm();
  const uploadGroupsRef = useRef<string[]>([]);
  const [uploadGroups, setUploadGroups] = useState<string[]>([]);

  const fetchUsers = async () => {
    if (!adminApiUrl || adminApiUrl.startsWith('REPLACE')) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}/users`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setUsers(data.users || []);
    } catch {
      message.error('Failed to load users');
      setUsers([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, [idToken, tenantId]);

  const handleCreate = async (values: { email: string; temporaryPassword: string; businessGroups?: string[] }) => {
    setSubmitting(true);
    try {
      const res = await fetch(`${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
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
      fetchUsers();
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
        { method: 'DELETE', headers: { Authorization: `Bearer ${idToken}` } },
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || res.statusText);
      }
      message.success(`User deleted`);
      fetchUsers();
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
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ businessGroups: values.businessGroups ?? [] }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      message.success('Groups updated');
      setEditUser(null);
      fetchUsers();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to update groups');
    } finally {
      setEditGroupsSubmitting(false);
    }
  };

  const uploadProps: UploadProps = {
    multiple: true,
    customRequest: async ({ file, onSuccess, onError, onProgress }) => {
      const f = file as File;
      const currentGroups = uploadGroupsRef.current;
      try {
        const res = await fetch(`${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}/upload-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ filename: f.name, groups: currentGroups }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        const { url, metadataUrl } = data;

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress?.({ percent: Math.round((e.loaded / e.total) * 100) });
          };
          xhr.onload = () => {
            if (xhr.status === 200 || xhr.status === 204) resolve();
            else reject(new Error(`S3 upload failed: ${xhr.status}`));
          };
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.open('PUT', url);
          xhr.setRequestHeader('Content-Type', f.type || 'application/octet-stream');
          xhr.send(f);
        });

        // Upload metadata file with group tags
        if (metadataUrl && currentGroups.length > 0) {
          const metadata = JSON.stringify({ metadataAttributes: { groups: currentGroups } });
          await fetch(metadataUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: metadata,
          });
        }

        onSuccess?.(null);
      } catch (e) {
        onError?.(e as Error);
      }
    },
  };

  const filteredUsers = users.filter(u => {
    const q = userSearch.toLowerCase();
    return !q || (u.email ?? '').toLowerCase().includes(q) || (u.status ?? '').toLowerCase().includes(q);
  });

  const columns = [
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
      render: (status: string) => (
        <Tag color={STATUS_COLOR[status] ?? 'default'}>{status ?? '—'}</Tag>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      sorter: (a: TenantUser, b: TenantUser) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime(),
      render: (t: string) => t ? new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
    },
    {
      title: 'Groups',
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
      title: 'Actions',
      key: 'actions',
      width: 90,
      render: (_: unknown, record: TenantUser) => (
        <Space size={4}>
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => openEditUser(record)}
            style={{ color: '#1e3a5f' }}
            title="Edit groups"
          />
          <Popconfirm
            title={`Delete user "${record.email || record.username}"?`}
            description="The user will be permanently removed from Cognito."
            onConfirm={() => handleDelete(record.username)}
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
          <UserOutlined style={{ fontSize: 22, color: '#1e3a5f' }} />
          <Title level={4} style={{ margin: 0, color: '#1e3a5f' }}>
            Users
            <Text type="secondary" style={{ fontSize: 14, fontWeight: 400, marginLeft: 8 }}>
              {tenantId}
            </Text>
          </Title>
        </Space>
        <Space>
          <Button icon={<UploadOutlined />} onClick={() => setUploadDrawerOpen(true)}>
            Upload documents
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)}>
            Add user
          </Button>
        </Space>
      </div>

      <Input
        prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
        placeholder="Search by email or status…"
        value={userSearch}
        onChange={e => setUserSearch(e.target.value)}
        allowClear
        style={{ marginBottom: 12, maxWidth: 320 }}
      />
      <Table
        loading={loading}
        dataSource={filteredUsers}
        rowKey="username"
        columns={columns}
        pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
        style={{ width: '100%' }}
        bordered
      />

      {/* Upload Documents Drawer */}
      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Upload documents</span>}
        placement="right"
        open={uploadDrawerOpen}
        onClose={() => setUploadDrawerOpen(false)}
        width={420}
        closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
        styles={{
          header: { background: '#1e3a5f', borderBottom: '2px solid #e6a800', padding: '16px 20px' },
          body: { paddingTop: 24 },
        }}
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          Files will be uploaded to the <strong>{tenantId}</strong> knowledge base folder and indexed automatically.
        </Text>
        <div style={{ marginBottom: 16 }}>
          <Text strong style={{ display: 'block', marginBottom: 6 }}>Access groups</Text>
          <Select
            mode="multiple"
            options={DOCUMENT_TAG_OPTIONS}
            value={uploadGroups}
            onChange={(vals) => {
              setUploadGroups(vals);
              uploadGroupsRef.current = vals;
            }}
            placeholder="Select groups that can access these documents"
            style={{ width: '100%' }}
            allowClear
          />
          <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
            Leave empty to make documents accessible to all groups.
          </Text>
        </div>
        <Dragger {...uploadProps}>
          <p className="ant-upload-drag-icon">
            <InboxOutlined style={{ color: '#1e3a5f', fontSize: 48 }} />
          </p>
          <p className="ant-upload-text">Click or drag files to upload</p>
          <p className="ant-upload-hint">Supports PDF, DOCX, TXT, MD, HTML and other text documents. Multiple files allowed.</p>
        </Dragger>
      </Drawer>

      {/* Edit User Groups Drawer */}
      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Edit groups</span>}
        placement="right"
        open={!!editUser}
        onClose={() => { setEditUser(null); editGroupsForm.resetFields(); }}
        width={360}
        closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
        styles={{
          header: { background: '#1e3a5f', borderBottom: '2px solid #e6a800', padding: '16px 20px' },
          body: { paddingTop: 24 },
          footer: { borderTop: '1px solid #f0f4fb' },
        }}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={() => { setEditUser(null); editGroupsForm.resetFields(); }}>Cancel</Button>
            <Button type="primary" loading={editGroupsSubmitting} onClick={() => editGroupsForm.submit()}>Save</Button>
          </Space>
        }
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
          User: <strong>{editUser?.email || editUser?.username}</strong>
        </Text>
        <Form form={editGroupsForm} layout="vertical" onFinish={handleUpdateGroups}>
          <Form.Item name="businessGroups" label="Business groups">
            <Select
              mode="multiple"
              options={GROUP_OPTIONS}
              placeholder="Select business groups"
              allowClear
            />
          </Form.Item>
        </Form>
      </Drawer>

      {/* Add User Drawer */}
      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Add user</span>}
        placement="right"
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); form.resetFields(); }}
        width={360}
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
          <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email', message: 'Valid email required' }]}>
            <Input placeholder="user@example.com" />
          </Form.Item>
          <Form.Item name="temporaryPassword" label="Temporary password" rules={[{ required: true, min: 8, message: 'Min 8 characters' }]}>
            <Input.Password placeholder="Min 8 characters" />
          </Form.Item>
          <Form.Item name="businessGroups" label="Business groups">
            <Select
              mode="multiple"
              options={GROUP_OPTIONS}
              placeholder="Select business groups (optional)"
              allowClear
            />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}
