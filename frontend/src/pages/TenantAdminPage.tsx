import { useState, useEffect } from 'react';
import { Card, Table, Button, Form, Input, Modal, Space, Typography, message } from 'antd';
import { PlusOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';
import { config } from '../config';

const { Title } = Typography;

interface TenantUser {
  username: string;
  email?: string;
  status?: string;
  createdAt?: string;
}

export default function TenantAdminPage() {
  const { user, idToken } = useAuth();
  const tenantId = user?.tenantId ?? 'default';
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();

  const fetchUsers = async () => {
    if (!config.adminApiUrl || config.adminApiUrl.startsWith('REPLACE')) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${config.adminApiUrl}/tenants/${encodeURIComponent(tenantId)}/users`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      setUsers(data.users || []);
    } catch (e) {
      message.error('Failed to load users');
      setUsers([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, [idToken, tenantId]);

  const handleCreate = async (values: { email: string; temporaryPassword: string }) => {
    setSubmitting(true);
    try {
      const res = await fetch(`${config.adminApiUrl}/tenants/${encodeURIComponent(tenantId)}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          email: values.email.trim(),
          temporaryPassword: values.temporaryPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      message.success(`User ${values.email} created`);
      form.resetFields();
      setModalOpen(false);
      fetchUsers();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to create user');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      <Space style={{ marginBottom: 24 }}>
        <UserOutlined style={{ fontSize: 24 }} />
        <Title level={3} style={{ margin: 0 }}>Users in tenant: {tenantId}</Title>
      </Space>
      <Card>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)} style={{ marginBottom: 16 }}>
          Add user
        </Button>
        <Table
          loading={loading}
          dataSource={users}
          rowKey="username"
          columns={[
            { title: 'Email', dataIndex: 'email', key: 'email' },
            { title: 'Status', dataIndex: 'status', key: 'status' },
            { title: 'Created', dataIndex: 'createdAt', key: 'createdAt', render: (t: string) => t ? new Date(t).toLocaleDateString() : '-' },
          ]}
          pagination={false}
        />
      </Card>
      <Modal
        title="Add user"
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields(); }}
        footer={null}
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
            <Input placeholder="user@example.com" />
          </Form.Item>
          <Form.Item name="temporaryPassword" label="Temporary password" rules={[{ required: true, min: 8 }]}>
            <Input.Password placeholder="Min 8 characters" />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" loading={submitting}>Create</Button>
              <Button onClick={() => setModalOpen(false)}>Cancel</Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
