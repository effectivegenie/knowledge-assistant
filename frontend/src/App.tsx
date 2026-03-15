import { useState } from 'react';
import {
  Layout,
  Card,
  Form,
  Input,
  Button,
  Spin,
  Typography,
  Space,
  Menu,
  message,
} from 'antd';
import {
  RobotOutlined,
  MailOutlined,
  LockOutlined,
  LogoutOutlined,
  TeamOutlined,
  UserOutlined,
  MessageOutlined,
} from '@ant-design/icons';
import { useAuth } from './auth/AuthContext';
import ChatWidget from './components/ChatWidget';
import AdminPage from './pages/AdminPage';
import TenantAdminPage from './pages/TenantAdminPage';

const { Header, Content } = Layout;
const { Text } = Typography;

type View = 'chat' | 'admin' | 'tenant-admin';

function AuthPage() {
  const { signIn } = useAuth();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleSignIn = async (values: { email: string; password: string }) => {
    setLoading(true);
    try {
      await signIn(values.email, values.password);
      message.success('Signed in');
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #e6f4ff 0%, #ffffff 100%)',
      }}
    >
      <Card
        style={{
          width: 420,
          boxShadow: '0 4px 24px rgba(0, 0, 0, 0.08)',
          borderRadius: 12,
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <RobotOutlined style={{ fontSize: 36, color: '#1677ff', marginBottom: 8 }} />
          <Typography.Title level={3} style={{ margin: 0 }}>
            Knowledge Assistant
          </Typography.Title>
          <Text type="secondary">Sign in (no self-registration)</Text>
        </div>
        <Form form={form} onFinish={handleSignIn} layout="vertical">
          <Form.Item
            name="email"
            rules={[
              { required: true, message: 'Please enter your email' },
              { type: 'email', message: 'Please enter a valid email' },
            ]}
          >
            <Input prefix={<MailOutlined />} size="large" placeholder="Email" />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[{ required: true, message: 'Please enter your password' }]}
          >
            <Input.Password prefix={<LockOutlined />} size="large" placeholder="Password" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" block size="large" loading={loading}>
              Sign In
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}

export default function App() {
  const { isLoading, isAuthenticated, user, signOut, isRootAdmin, isTenantAdmin } = useAuth();
  const [view, setView] = useState<View>('chat');

  if (isLoading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AuthPage />;
  }

  const menuItems = [
    { key: 'chat', icon: <MessageOutlined />, label: 'Chat' },
    ...(isRootAdmin ? [{ key: 'admin', icon: <TeamOutlined />, label: 'Tenants' }] : []),
    ...(isTenantAdmin ? [{ key: 'tenant-admin', icon: <UserOutlined />, label: 'Tenant users' }] : []),
  ];

  return (
    <Layout style={{ height: '100vh' }}>
      <Header
        style={{
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px 0 0',
          boxShadow: '0 1px 4px rgba(0, 0, 0, 0.08)',
          zIndex: 10,
        }}
      >
        <Space>
          <RobotOutlined style={{ fontSize: 22, color: '#1677ff' }} />
          <span style={{ fontSize: 18, fontWeight: 600 }}>Knowledge Assistant</span>
          <Menu
            mode="horizontal"
            selectedKeys={[view]}
            onClick={({ key }) => setView(key as View)}
            items={menuItems}
            style={{ minWidth: 0, flex: 1, marginLeft: 24 }}
          />
        </Space>
        <Space>
          <Text type="secondary">{user?.email}</Text>
          <Button icon={<LogoutOutlined />} onClick={signOut}>
            Sign Out
          </Button>
        </Space>
      </Header>
      <Content style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {view === 'chat' && <ChatWidget />}
        {view === 'admin' && <AdminPage />}
        {view === 'tenant-admin' && <TenantAdminPage />}
      </Content>
    </Layout>
  );
}
