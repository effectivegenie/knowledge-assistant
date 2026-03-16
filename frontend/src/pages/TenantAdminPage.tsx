import { useState, useEffect, useRef } from 'react';
import { Table, Button, Form, Input, Drawer, Space, Typography, message, Tag, Popconfirm, Upload, Select } from 'antd';
import type { UploadFile, TableProps } from 'antd';
import { PlusOutlined, UserOutlined, DeleteOutlined, UploadOutlined, InboxOutlined, SearchOutlined, EditOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';
import { adminApiUrl } from '../config';

const { Dragger } = Upload;
const { Title, Text } = Typography;

const BUSINESS_GROUPS = [
  'financial', 'accounting', 'operations', 'marketing', 'IT',
  'warehouse', 'security', 'logistics', 'sales', 'design', 'HR',
];

// Options for user assignment (business groups only)
const GROUP_OPTIONS = BUSINESS_GROUPS.map(g => ({ label: g, value: g }));

// Options for document tagging (business groups + general)
const DOCUMENT_TAG_OPTIONS = [
  { label: 'general — accessible to all users', value: 'general' },
  ...BUSINESS_GROUPS.map(g => ({ label: g, value: g })),
];

// Accepted MIME types for document upload
const ACCEPTED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'text/markdown', 'text/html', 'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff', 'image/bmp',
]);
const ACCEPTED_EXT = /\.(pdf|docx?|txt|md|html?|csv|xlsx?|pptx?|jpe?g|png|gif|webp|tiff?|bmp)$/i;

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
  const [uploadDrawerOpen, setUploadDrawerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  const [editUser, setEditUser] = useState<TenantUser | null>(null);
  const [editGroupsSubmitting, setEditGroupsSubmitting] = useState(false);
  const [editGroupsForm] = Form.useForm();

  // Upload state
  const [uploadFileList, setUploadFileList] = useState<UploadFile[]>([]);
  const [uploadGroups, setUploadGroups] = useState<string[]>([]);
  const [uploadCategory, setUploadCategory] = useState<'general' | 'invoice'>('general');
  const [uploading, setUploading] = useState(false);

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

  const resetUploadDrawer = () => {
    setUploadDrawerOpen(false);
    setUploadFileList([]);
    setUploadGroups([]);
    setUploadCategory('general');
  };

  const handleUpload = async () => {
    if (uploadFileList.length === 0) return;
    setUploading(true);
    let successCount = 0;
    for (const fileWrapper of uploadFileList) {
      const f = fileWrapper as unknown as File;
      try {
        // If no groups selected, default to 'general' so the listContains filter matches
      const effectiveGroups = uploadGroups.length > 0 ? uploadGroups : ['general'];
      const res = await fetch(`${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}/upload-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ filename: f.name, groups: effectiveGroups, category: uploadCategory }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        const { url, metadataUrl, category } = data;

        // Upload metadata BEFORE document so it's already in S3 when ingestion runs.
        // tenantId is used for tenant isolation in the KB retrieve filter (equals operator,
        // which works with S3 Vectors). groups is used for post-retrieval access control.
        const metadata = JSON.stringify({ metadataAttributes: { tenantId, groups: effectiveGroups, category } });
        await fetch(metadataUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: metadata,
        });

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.onload = () => {
            if (xhr.status === 200 || xhr.status === 204) resolve();
            else reject(new Error(`S3 upload failed: ${xhr.status}`));
          };
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.open('PUT', url);
          xhr.setRequestHeader('Content-Type', f.type || 'application/octet-stream');
          xhr.send(f);
        });

        successCount++;
      } catch (e) {
        message.error(`Failed to upload ${f.name}: ${e instanceof Error ? e.message : 'Unknown error'}`);
      }
    }
    setUploading(false);
    if (successCount > 0) {
      message.success(`${successCount} file${successCount !== 1 ? 's' : ''} uploaded`);
      resetUploadDrawer();
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
      render: (status: string) => (
        <Tag color={STATUS_COLOR[status] ?? 'default'}>{status ?? '—'}</Tag>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      sorter: true,
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
          showTotal: (t) => `${t} user${t !== 1 ? 's' : ''}`,
          hideOnSinglePage: true,
          showSizeChanger: false,
        }}
        style={{ width: '100%' }}
        bordered
      />

      {/* ── Upload Documents Drawer ── */}
      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Upload documents</span>}
        placement="right"
        open={uploadDrawerOpen}
        onClose={resetUploadDrawer}
        width={440}
        closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
        styles={DRAWER_STYLES}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={resetUploadDrawer} disabled={uploading}>Cancel</Button>
            <Button
              type="primary"
              icon={<UploadOutlined />}
              loading={uploading}
              disabled={uploadFileList.length === 0}
              onClick={handleUpload}
            >
              Upload{uploadFileList.length > 0 ? ` (${uploadFileList.length})` : ''}
            </Button>
          </Space>
        }
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          Files will be uploaded to the <strong>{tenantId}</strong> knowledge base and indexed automatically.
        </Text>
        <div style={{ marginBottom: 16 }}>
          <Text strong style={{ display: 'block', marginBottom: 6 }}>Document category</Text>
          <Select
            value={uploadCategory}
            onChange={(v) => setUploadCategory(v)}
            style={{ width: '100%' }}
            options={[
              { value: 'general', label: 'General — knowledge base only' },
              { value: 'invoice', label: 'Invoice — knowledge base + invoice processing' },
            ]}
          />
          <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
            Invoice documents are automatically processed by Textract for data extraction.
          </Text>
        </div>
        <div style={{ marginBottom: 16 }}>
          <Text strong style={{ display: 'block', marginBottom: 6 }}>Access groups</Text>
          <Select
            mode="multiple"
            options={DOCUMENT_TAG_OPTIONS}
            value={uploadGroups}
            onChange={setUploadGroups}
            placeholder="Select groups that can access these documents"
            style={{ width: '100%' }}
            allowClear
          />
          <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
            Leave empty to make documents accessible to all groups.
          </Text>
        </div>
        <Dragger
          multiple
          fileList={uploadFileList}
          beforeUpload={(file) => {
            const valid = ACCEPTED_MIME.has(file.type) || ACCEPTED_EXT.test(file.name);
            if (!valid) {
              message.error(`${file.name}: unsupported file type`);
              return Upload.LIST_IGNORE;
            }
            setUploadFileList(prev => [...prev, file as unknown as UploadFile]);
            return false;
          }}
          onRemove={(file) => {
            setUploadFileList(prev => prev.filter(f => f.uid !== file.uid));
          }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined style={{ color: '#1e3a5f', fontSize: 48 }} />
          </p>
          <p className="ant-upload-text">Click or drag files to upload</p>
          <p className="ant-upload-hint">
            PDF, Word, Excel, PowerPoint, CSV, HTML, Markdown, plain text, images.
          </p>
        </Dragger>
      </Drawer>

      {/* ── Edit User Groups Drawer ── */}
      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Edit groups</span>}
        placement="right"
        open={!!editUser}
        onClose={() => { setEditUser(null); editGroupsForm.resetFields(); }}
        width={360}
        closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
        styles={DRAWER_STYLES}
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

      {/* ── Add User Drawer ── */}
      <Drawer
        title={<span style={{ color: '#fff', fontWeight: 700 }}>Add user</span>}
        placement="right"
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); form.resetFields(); }}
        width={360}
        closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
        styles={DRAWER_STYLES}
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
