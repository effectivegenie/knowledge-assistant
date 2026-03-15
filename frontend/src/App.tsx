import { useState, useEffect } from 'react';
import { Layout, Card, Form, Input, Button, Spin, Typography, Space, Menu, Drawer, message, ConfigProvider } from 'antd';
import { MailOutlined, LockOutlined, LogoutOutlined, TeamOutlined, UserOutlined, MessageOutlined, MenuOutlined, KeyOutlined } from '@ant-design/icons';
import { useAuth } from './auth/AuthContext';
import ChatWidget from './components/ChatWidget';
import AdminPage from './pages/AdminPage';
import TenantAdminPage from './pages/TenantAdminPage';

const { Header, Content } = Layout;
const { Text } = Typography;

const BLUE        = '#1e3a5f';
const BLUE_LIGHT  = '#2c5282';
const BLUE_MUTED  = '#475569';
const GOLD        = '#e6a800';
const GOLD_DARK   = '#c99200';
const GOLD_HOVER  = '#f0b429';
const GOLD_TINT   = '#fff8e6';
const BLUE_TINT   = '#f0f4fb';

// Applied to the login screen
const AUTH_THEME = {
  token: {
    colorPrimary: GOLD,
    colorPrimaryHover: GOLD_HOVER,
    colorPrimaryActive: GOLD_DARK,
    colorText: BLUE,
    colorTextSecondary: BLUE_LIGHT,
    colorTextTertiary: BLUE_MUTED,
    colorTextPlaceholder: BLUE_MUTED,
  },
};

// Applied to the authenticated app shell and all child pages
const APP_THEME = {
  token: {
    colorPrimary: GOLD,
    colorPrimaryHover: GOLD_HOVER,
    colorPrimaryActive: GOLD_DARK,
    colorTextBase: BLUE,
    colorTextHeading: BLUE,
    colorTextSecondary: BLUE_LIGHT,
    colorTextTertiary: BLUE_MUTED,
    colorTextPlaceholder: BLUE_MUTED,
    colorLink: GOLD_DARK,
    colorLinkHover: GOLD,
  },
  components: {
    Button: {
      colorTextLightSolid: '#ffffff',   // white text on primary (gold) buttons
      primaryShadow: 'none',
    },
    Table: {
      headerColor: BLUE,
      headerBg: BLUE_TINT,
      headerSortActiveBg: '#e4ecf7',
      colorText: BLUE,
      rowHoverBg: '#f7f9fd',
    },
    Menu: {
      itemColor: BLUE,
      itemHoverColor: BLUE,
      itemHoverBg: BLUE_TINT,
      itemSelectedColor: BLUE,
      itemSelectedBg: GOLD_TINT,
      itemActiveBg: GOLD_TINT,
      activeBarBorderWidth: 3,
      activeBarColor: GOLD,
    },
    Drawer: {
      colorText: BLUE,
      colorTextHeading: BLUE,
    },
    Tag: {
      colorText: BLUE,
    },
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
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(160deg, #0d1b2a 0%, #1e3a5f 45%, #2c5282 100%)',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}>
        <Card style={{
          width: 440,
          boxShadow: '0 12px 48px rgba(0,0,0,0.25)',
          borderRadius: 16,
          border: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <img
              src="/genie-logo-final-2.png"
              alt="Knowledge Genie"
              style={{ width: 300, height: 300, objectFit: 'contain', marginBottom: 20 }}
            />
            <Typography.Title level={2} style={{ margin: 0, color: BLUE, fontWeight: 700, fontSize: 26, letterSpacing: '-0.02em' }}>
              Knowledge Genie
            </Typography.Title>
            <Text style={{ color: GOLD_DARK, fontSize: 15, fontWeight: 500, marginTop: 6, display: 'block' }}>
              Sign in
            </Text>
          </div>
          <Form form={form} onFinish={handleSignIn} layout="vertical">
            <Form.Item name="email" label={<span style={{ color: BLUE }}>Email</span>}
              rules={[{ required: true, message: 'Please enter your email' }, { type: 'email', message: 'Please enter a valid email' }]}>
              <Input prefix={<MailOutlined style={{ color: BLUE_MUTED }} />} size="large" placeholder="Email" />
            </Form.Item>
            <Form.Item name="password" label={<span style={{ color: BLUE }}>Password</span>}
              rules={[{ required: true, message: 'Please enter your password' }]}>
              <Input.Password prefix={<LockOutlined style={{ color: BLUE_MUTED }} />} size="large" placeholder="Password" />
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

function NewPasswordPage() {
  const { completeNewPassword, signOut } = useAuth();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (values: { newPassword: string; confirm: string }) => {
    setLoading(true);
    try {
      await completeNewPassword(values.newPassword);
      message.success('Password updated — welcome!');
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : 'Failed to set new password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ConfigProvider theme={AUTH_THEME}>
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(160deg, #0d1b2a 0%, #1e3a5f 45%, #2c5282 100%)',
      }}>
        <Card style={{ width: 440, boxShadow: '0 12px 48px rgba(0,0,0,0.25)', borderRadius: 16 }}>
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <KeyOutlined style={{ fontSize: 48, color: GOLD_DARK, marginBottom: 12, display: 'block' }} />
            <Typography.Title level={3} style={{ margin: 0, color: BLUE, fontWeight: 700 }}>
              Set a new password
            </Typography.Title>
            <Text style={{ color: BLUE_MUTED, marginTop: 6, display: 'block' }}>
              Your temporary password has expired. Please choose a new one.
            </Text>
          </div>
          <Form form={form} layout="vertical" onFinish={handleSubmit}>
            <Form.Item name="newPassword" label={<span style={{ color: BLUE }}>New password</span>}
              rules={[{ required: true, min: 8, message: 'Min 8 characters' }]}>
              <Input.Password prefix={<LockOutlined style={{ color: BLUE_MUTED }} />} size="large" placeholder="New password" />
            </Form.Item>
            <Form.Item name="confirm" label={<span style={{ color: BLUE }}>Confirm password</span>}
              dependencies={['newPassword']}
              rules={[
                { required: true, message: 'Please confirm your password' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('newPassword') === value) return Promise.resolve();
                    return Promise.reject(new Error('Passwords do not match'));
                  },
                }),
              ]}>
              <Input.Password prefix={<LockOutlined style={{ color: BLUE_MUTED }} />} size="large" placeholder="Confirm password" />
            </Form.Item>
            <Form.Item style={{ marginBottom: 8 }}>
              <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                Set password &amp; sign in
              </Button>
            </Form.Item>
            <Button type="text" block onClick={signOut} style={{ color: BLUE_MUTED }}>
              Back to sign in
            </Button>
          </Form>
        </Card>
      </div>
    </ConfigProvider>
  );
}

export default function App() {
  const { isLoading, isAuthenticated, needsNewPassword, user, signOut, isRootAdmin, isTenantAdmin } = useAuth();
  const [view, setView] = useState<View>('chat');
  const [drawerOpen, setDrawerOpen] = useState(false);

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

  if (!isAuthenticated && needsNewPassword) return <NewPasswordPage />;
  if (!isAuthenticated) return <AuthPage />;

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
    <ConfigProvider theme={APP_THEME}>
      <Layout style={{ height: '100vh' }}>
        {/* ── Header ── */}
        <Header style={{
          height: 140,
          lineHeight: '140px',
          background: BLUE,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          boxShadow: '0 2px 12px rgba(0,0,0,0.25)',
          borderBottom: `3px solid ${GOLD}`,
          zIndex: 10,
        }}>
          <Space size={14}>
            <Button
              type="text"
              icon={<MenuOutlined style={{ fontSize: 20, color: '#fff' }} />}
              onClick={() => setDrawerOpen(true)}
              style={{ padding: '4px 8px', height: 40 }}
            />
            <img
              src="/genie-logo-final-2-no-text.png"
              alt="Knowledge Genie"
              style={{ height: 128, objectFit: 'contain', display: 'block' }}
            />
            <span style={{ color: '#fff', fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em' }}>
              Knowledge Genie
            </span>
          </Space>
          <Space size={8}>
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>{user?.email}</Text>
            <Button
              type="text"
              icon={<LogoutOutlined />}
              onClick={signOut}
              style={{ color: 'rgba(255,255,255,0.85)', fontWeight: 500 }}
            >
              Sign Out
            </Button>
          </Space>
        </Header>

        {/* ── Navigation Drawer ── */}
        <Drawer
          placement="left"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          width={240}
          title={
            <Space size={10}>
              <img src="/genie-logo-final-2-no-text.png" alt="" style={{ height: 54, objectFit: 'contain' }} />
              <span style={{ fontWeight: 700, fontSize: 16, color: '#fff' }}>Knowledge Genie</span>
            </Space>
          }
          styles={{
            header: {
              background: BLUE,
              borderBottom: `2px solid ${GOLD}`,
              padding: '16px 20px',
            },
            body: { padding: 0, background: '#ffffff' },
            footer: { borderTop: `1px solid ${BLUE_TINT}`, padding: '12px 20px' },
          }}
          footer={
            <Text style={{ fontSize: 12, color: BLUE_MUTED }}>{user?.email}</Text>
          }
          closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
        >
          <Menu
            mode="inline"
            selectedKeys={[view]}
            onClick={handleMenuClick}
            items={menuItems}
            style={{ border: 'none', paddingTop: 12, fontSize: 15 }}
          />
        </Drawer>

        {/* ── Content ── */}
        <Content style={{ flex: 1, overflow: 'hidden' }}>
          {view === 'chat' && <ChatWidget />}
          {view === 'admin' && <AdminPage />}
          {view === 'tenant-admin' && <TenantAdminPage />}
        </Content>
      </Layout>
    </ConfigProvider>
  );
}
