import { useState, useEffect } from 'react';
import { Card, Table, Button, Form, Input, Modal, Space, Typography, message } from 'antd';
import { PlusOutlined, TeamOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';
import { adminApiUrl } from '../config';

const { Title } = Typography;

interface Tenant {
  tenantId: string;
  name: string;
  createdAt?: string;
}

export default function AdminPage() {
  const { idToken } = useAuth();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
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
    } catch (e) {
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
      message.success(`Tenant "${values.name}" created. Admin: ${values.adminEmail}`);
      form.resetFields();
      setModalOpen(false);
      fetchTenants();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to create tenant');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      <Space style={{ marginBottom: 24 }}>
        <TeamOutlined style={{ fontSize: 24 }} />
        <Title level={3} style={{ margin: 0 }}>Tenants</Title>
      </Space>
      <Card>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)} style={{ marginBottom: 16 }}>
          Create tenant
        </Button>
        <Table
          loading={loading}
          dataSource={tenants}
          rowKey="tenantId"
          columns={[
            { title: 'Tenant ID', dataIndex: 'tenantId', key: 'tenantId' },
            { title: 'Name', dataIndex: 'name', key: 'name' },
            { title: 'Created', dataIndex: 'createdAt', key: 'createdAt', render: (t: string) => t ? new Date(t).toLocaleDateString() : '-' },
          ]}
          pagination={false}
        />
      </Card>
      <Modal
        title="Create tenant"
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields(); }}
        footer={null}
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="tenantId" label="Tenant ID" rules={[{ required: true }]}>
            <Input placeholder="e.g. acme" />
          </Form.Item>
          <Form.Item name="name" label="Display name" rules={[{ required: true }]}>
            <Input placeholder="e.g. Acme Corp" />
          </Form.Item>
          <Form.Item name="adminEmail" label="Tenant admin email" rules={[{ required: true, type: 'email' }]}>
            <Input placeholder="admin@acme.com" />
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
