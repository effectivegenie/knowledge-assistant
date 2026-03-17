import { useState, useEffect, useCallback } from 'react';
import { Layout, Card, Form, Input, Button, Spin, Typography, Space, Menu, Drawer, message, ConfigProvider } from 'antd';
import { MailOutlined, LockOutlined, LogoutOutlined, TeamOutlined, UserOutlined, MessageOutlined, MenuOutlined, KeyOutlined, FileTextOutlined, FileProtectOutlined, FolderOutlined, DashboardOutlined } from '@ant-design/icons';
import { useAuth } from './auth/AuthContext';
import ChatWidget from './components/ChatWidget';
import AdminPage from './pages/AdminPage';
import TenantAdminPage from './pages/TenantAdminPage';
import InvoicesPage from './pages/InvoicesPage';
import ContractsPage from './pages/ContractsPage';
import DocumentsPage from './pages/DocumentsPage';
import DashboardPage from './pages/DashboardPage';

const { Header, Content, Sider } = Layout;
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

type View = 'chat' | 'admin' | 'dashboard' | 'tenant-admin' | 'invoices' | 'contracts' | 'documents';

function useIsDesktopLandscape() {
  const query = '(min-width: 1024px), (min-width: 768px) and (orientation: landscape)';
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : true
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return matches;
}

function AuthPage() {
  const { signIn } = useAuth();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleSignIn = async (values: { email: string; password: string }) => {
    setLoading(true);
    try {
      await signIn(values.email, values.password);
      message.success('Влязохте успешно');
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : 'Грешка при вход');
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
              Вход
            </Text>
          </div>
          <Form form={form} onFinish={handleSignIn} layout="vertical">
            <Form.Item name="email" label={<span style={{ color: BLUE }}>Имейл</span>}
              rules={[{ required: true, message: 'Въведи имейл' }, { type: 'email', message: 'Невалиден имейл' }]}>
              <Input prefix={<MailOutlined style={{ color: BLUE_MUTED }} />} size="large" placeholder="Имейл" />
            </Form.Item>
            <Form.Item name="password" label={<span style={{ color: BLUE }}>Парола</span>}
              rules={[{ required: true, message: 'Въведи парола' }]}>
              <Input.Password prefix={<LockOutlined style={{ color: BLUE_MUTED }} />} size="large" placeholder="Парола" />
            </Form.Item>
            <Form.Item style={{ marginBottom: 0 }}>
              <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                Вход
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
      message.success('Паролата е обновена — добре дошъл!');
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
              Нова парола
            </Typography.Title>
            <Text style={{ color: BLUE_MUTED, marginTop: 6, display: 'block' }}>
              Временната ти парола е изтекла. Избери нова.
            </Text>
          </div>
          <Form form={form} layout="vertical" onFinish={handleSubmit}>
            <Form.Item name="newPassword" label={<span style={{ color: BLUE }}>Нова парола</span>}
              rules={[{ required: true, min: 8, message: 'Минимум 8 символа' }]}>
              <Input.Password prefix={<LockOutlined style={{ color: BLUE_MUTED }} />} size="large" placeholder="Нова парола" />
            </Form.Item>
            <Form.Item name="confirm" label={<span style={{ color: BLUE }}>Потвърди паролата</span>}
              dependencies={['newPassword']}
              rules={[
                { required: true, message: 'Потвърди паролата' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('newPassword') === value) return Promise.resolve();
                    return Promise.reject(new Error('Паролите не съвпадат'));
                  },
                }),
              ]}>
              <Input.Password prefix={<LockOutlined style={{ color: BLUE_MUTED }} />} size="large" placeholder="Потвърди паролата" />
            </Form.Item>
            <Form.Item style={{ marginBottom: 8 }}>
              <Button type="primary" htmlType="submit" block size="large" loading={loading}>
                Запиши паролата и влез
              </Button>
            </Form.Item>
            <Button type="text" block onClick={signOut} style={{ color: BLUE_MUTED }}>
              Обратно към вход
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
  const [siderCollapsed, setSiderCollapsed] = useState(false);
  const [navTarget, setNavTarget] = useState<{ view: View; tab?: string } | null>(null);
  const isDesktopLandscape = useIsDesktopLandscape();

  const defaultView: View = isRootAdmin ? 'admin' : isTenantAdmin ? 'dashboard' : 'chat';

  const handleNavigate = useCallback((targetView: string, tab?: string) => {
    setView(targetView as View);
    setNavTarget(tab ? { view: targetView as View, tab } : null);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) { setView('chat'); return; }
    if (isRootAdmin) setView('admin');
    else if (isTenantAdmin) setView('dashboard');
    else setView('chat');
  }, [isAuthenticated, isRootAdmin, isTenantAdmin]);

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
    ? [{ key: 'admin', icon: <TeamOutlined />, label: 'Клиенти' }]
    : [
        { key: 'chat', icon: <MessageOutlined />, label: 'Чат' },
        ...(isTenantAdmin ? [
          { key: 'dashboard', icon: <DashboardOutlined />, label: 'Табло' },
          { key: 'tenant-admin', icon: <UserOutlined />, label: 'Потребители' },
          { key: 'invoices', icon: <FileTextOutlined />, label: 'Фактури' },
          { key: 'contracts', icon: <FileProtectOutlined />, label: 'Договори' },
          { key: 'documents', icon: <FolderOutlined />, label: 'Документи' },
        ] : []),
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
          height: isDesktopLandscape ? 56 : 90,
          lineHeight: 'normal',
          background: BLUE,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          borderBottom: `3px solid ${GOLD}`,
          zIndex: 10,
          flexShrink: 0,
        }}>
          <Space size={10}>
            <Button
              type="text"
              icon={<MenuOutlined style={{ fontSize: 18, color: '#fff' }} />}
              onClick={isDesktopLandscape
                ? () => setSiderCollapsed(c => !c)
                : () => setDrawerOpen(true)
              }
              style={{ padding: '4px 8px', height: 36 }}
            />
            {!isDesktopLandscape && (
              <img
                src="/genie-logo-final-2-no-text.png"
                alt="Knowledge Genie"
                onClick={() => setView(defaultView)}
                style={{ height: 76, objectFit: 'contain', display: 'block', cursor: 'pointer' }}
              />
            )}
          </Space>
          <Space size={8}>
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>{user?.email}</Text>
            <Button
              type="text"
              icon={<LogoutOutlined />}
              onClick={signOut}
              style={{ color: 'rgba(255,255,255,0.85)', fontWeight: 500 }}
            >
              Изход
            </Button>
          </Space>
        </Header>

        {/* ── Navigation Drawer (mobile / tablet portrait) ── */}
        <Drawer
          placement="left"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          width={312}
          title={
            <Space size={10}>
              <img src="/genie-logo-final-2-no-text.png" alt="" style={{ height: 108, objectFit: 'contain' }} />
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

        {/* ── Body: Sider (desktop) + Content ── */}
        <Layout style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
          {isDesktopLandscape && isAuthenticated && (
            <Sider
              width={220}
              collapsedWidth={56}
              collapsed={siderCollapsed}
              trigger={null}
              theme="light"
              style={{
                borderRight: `1px solid ${BLUE_TINT}`,
                boxShadow: '1px 0 4px rgba(30,58,95,0.06)',
                overflow: 'auto',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {/* Brand section */}
              <div
                onClick={() => setView(defaultView)}
                style={{
                  padding: siderCollapsed ? '20px 8px' : '20px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  background: '#dce8f5',
                  borderBottom: `1px solid #c5d9ee`,
                }}
              >
                <img
                  src="/genie-logo-final-2-no-text.png"
                  alt="Knowledge Genie"
                  style={{ height: siderCollapsed ? 36 : 192, objectFit: 'contain', transition: 'height 0.2s' }}
                />
              </div>
              <Menu
                mode="inline"
                selectedKeys={[view]}
                onClick={handleMenuClick}
                items={menuItems}
                style={{ border: 'none', paddingTop: 4, fontSize: 14, flex: 1 }}
              />
            </Sider>
          )}
          <Content style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
            {view === 'chat' && <ChatWidget />}
            {view === 'admin' && <AdminPage />}
            {view === 'dashboard' && <DashboardPage onNavigate={handleNavigate} />}
            {view === 'tenant-admin' && <TenantAdminPage />}
            {view === 'invoices' && <InvoicesPage initialTab={navTarget?.view === 'invoices' ? navTarget.tab : undefined} />}
            {view === 'contracts' && <ContractsPage initialTab={navTarget?.view === 'contracts' ? navTarget.tab : undefined} />}
            {view === 'documents' && <DocumentsPage />}
          </Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}
