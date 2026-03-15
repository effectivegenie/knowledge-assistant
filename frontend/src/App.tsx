import { useState } from 'react';
import { Layout, Card, Form, Input, Button, Spin, Typography, Space, Menu, message, ConfigProvider } from 'antd';
import { MailOutlined, LockOutlined, LogoutOutlined, TeamOutlined, UserOutlined, MessageOutlined } from '@ant-design/icons';
import { useAuth } from './auth/AuthContext';
import ChatWidget from './components/ChatWidget';
import AdminPage from './pages/AdminPage';
import TenantAdminPage from './pages/TenantAdminPage';

const { Header, Content } = Layout;
const { Text } = Typography;

// Brand colors from logo: gold/amber + deep blue
const AUTH_THEME = {
  token: {
    colorPrimary: '#e6a800',
    colorPrimaryHover: '#f0b429',
    colorPrimaryActive: '#cc9200',
  },
};

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
    <ConfigProvider theme={AUTH_THEME}>
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(160deg, #0d1b2a 0%, #1e3a5f 45%, #2c5282 100%)',
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <Card
          style={{
            width: 440,
            boxShadow: '0 12px 48px rgba(0, 0, 0, 0.25)',
            borderRadius: 16,
            border: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <img
              src="/genie-logo-final-2.png"
              alt="Knowledge Genie"
              style={{ width: 200, height: 200, objectFit: 'contain', marginBottom: 16 }}
            />
            <Typography.Title
              level={2}
              style={{
                margin: 0,
                color: '#1e3a5f',
                fontWeight: 700,
                fontSize: 26,
                letterSpacing: '-0.02em',
              }}
            >
              Knowledge Genie
            </Typography.Title>
            <Text style={{ color: '#64748b', fontSize: 15, marginTop: 4, display: 'block' }}>
              Sign in
            </Text>
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
    </ConfigProvider>
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
          <img
            src="/genie-logo-final-2-no-text.png"
            alt="Knowledge Genie"
            style={{ width: 28, height: 28, objectFit: 'contain', borderRadius: 6 }}
          />
          <span style={{ fontSize: 18, fontWeight: 600 }}>Knowledge Genie</span>
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
