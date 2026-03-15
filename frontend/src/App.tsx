import { useState, useEffect } from 'react';
import { Layout, Card, Form, Input, Button, Spin, Typography, Space, Menu, Drawer, message, ConfigProvider } from 'antd';
import { MailOutlined, LockOutlined, LogoutOutlined, TeamOutlined, UserOutlined, MessageOutlined, MenuOutlined } from '@ant-design/icons';
import { useAuth } from './auth/AuthContext';
import ChatWidget from './components/ChatWidget';
import AdminPage from './pages/AdminPage';
import TenantAdminPage from './pages/TenantAdminPage';

const { Header, Content } = Layout;
const { Text } = Typography;

const AUTH_BLUE = '#1e3a5f';
const AUTH_BLUE_LIGHT = '#2c5282';
const AUTH_BLUE_MUTED = '#475569';
const AUTH_GOLD = '#c99200';
const AUTH_THEME = {
  token: {
    colorPrimary: '#e6a800',
    colorPrimaryHover: '#f0b429',
    colorPrimaryActive: '#cc9200',
    colorText: AUTH_BLUE,
    colorTextSecondary: AUTH_BLUE_LIGHT,
    colorTextTertiary: AUTH_BLUE_MUTED,
    colorTextPlaceholder: AUTH_BLUE_MUTED,
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
              style={{ width: 300, height: 300, objectFit: 'contain', marginBottom: 20 }}
            />
            <Typography.Title
              level={2}
              style={{ margin: 0, color: AUTH_BLUE, fontWeight: 700, fontSize: 26, letterSpacing: '-0.02em' }}
            >
              Knowledge Genie
            </Typography.Title>
            <Text style={{ color: AUTH_GOLD, fontSize: 15, fontWeight: 500, marginTop: 6, display: 'block' }}>
              Sign in
            </Text>
          </div>
          <Form form={form} onFinish={handleSignIn} layout="vertical">
            <Form.Item
              name="email"
              label={<span style={{ color: AUTH_BLUE }}>Email</span>}
              rules={[
                { required: true, message: 'Please enter your email' },
                { type: 'email', message: 'Please enter a valid email' },
              ]}
            >
              <Input prefix={<MailOutlined style={{ color: AUTH_BLUE_MUTED }} />} size="large" placeholder="Email" />
            </Form.Item>
            <Form.Item
              name="password"
              label={<span style={{ color: AUTH_BLUE }}>Password</span>}
              rules={[{ required: true, message: 'Please enter your password' }]}
            >
              <Input.Password prefix={<LockOutlined style={{ color: AUTH_BLUE_MUTED }} />} size="large" placeholder="Password" />
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
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Set smart default once roles are known
  useEffect(() => {
    if (isRootAdmin) setView('admin');
    else if (isTenantAdmin) setView('tenant-admin');
  }, [isRootAdmin, isTenantAdmin]);

  if (isLoading) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!isAuthenticated) return <AuthPage />;

  // RootAdmin: Tenants only. TenantAdmin: Chat + Users. Regular: Chat only.
  const menuItems = isRootAdmin
    ? [{ key: 'admin', icon: <TeamOutlined />, label: 'Tenants' }]
    : [
        { key: 'chat', icon: <MessageOutlined />, label: 'Chat' },
        ...(isTenantAdmin ? [{ key: 'tenant-admin', icon: <UserOutlined />, label: 'Users' }] : []),
      ];

  const handleMenuClick = ({ key }: { key: string }) => {
    setView(key as View);
    setDrawerOpen(false);
  };

  return (
    <Layout style={{ height: '100vh' }}>
      <Header
        style={{
          background: AUTH_BLUE,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 20px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          zIndex: 10,
        }}
      >
        <Space size={12}>
          <Button
            type="text"
            icon={<MenuOutlined style={{ fontSize: 18, color: '#fff' }} />}
            onClick={() => setDrawerOpen(true)}
            style={{ padding: '4px 8px' }}
          />
          <img
            src="/genie-logo-final-2-no-text.png"
            alt="Knowledge Genie"
            style={{ height: 40, objectFit: 'contain', borderRadius: 6, display: 'block' }}
          />
          <span style={{ color: '#fff', fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em' }}>
            Knowledge Genie
          </span>
        </Space>
        <Space size={8}>
          <Text style={{ color: 'rgba(255,255,255,0.65)', fontSize: 13 }}>{user?.email}</Text>
          <Button
            type="text"
            icon={<LogoutOutlined />}
            onClick={signOut}
            style={{ color: 'rgba(255,255,255,0.85)' }}
          >
            Sign Out
          </Button>
        </Space>
      </Header>

      <Drawer
        title={
          <Space size={10}>
            <img src="/genie-logo-final-2-no-text.png" alt="" style={{ height: 28, objectFit: 'contain' }} />
            <span style={{ fontWeight: 700, fontSize: 15 }}>Knowledge Genie</span>
          </Space>
        }
        placement="left"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={220}
        styles={{ body: { padding: 0 } }}
      >
        <Menu
          mode="inline"
          selectedKeys={[view]}
          onClick={handleMenuClick}
          items={menuItems}
          style={{ border: 'none', paddingTop: 8 }}
        />
        <div style={{ position: 'absolute', bottom: 16, left: 16, right: 16 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{user?.email}</Text>
        </div>
      </Drawer>

      <Content style={{ flex: 1, overflow: 'hidden' }}>
        {view === 'chat' && <ChatWidget />}
        {view === 'admin' && <AdminPage />}
        {view === 'tenant-admin' && <TenantAdminPage />}
      </Content>
    </Layout>
  );
}
