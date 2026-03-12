import { useState } from 'react';
import {
  Layout,
  Card,
  Form,
  Input,
  Button,
  Tabs,
  Spin,
  Typography,
  Space,
  Alert,
  message,
} from 'antd';
import {
  RobotOutlined,
  MailOutlined,
  LockOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import { useAuth } from './auth/AuthContext';
import ChatWidget from './components/ChatWidget';

const { Header, Content } = Layout;
const { Title, Text } = Typography;

function AuthPage() {
  const { signIn, signUp, confirmSignUp } = useAuth();
  const [signInForm] = Form.useForm();
  const [signUpForm] = Form.useForm();
  const [confirmForm] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  const handleSignIn = async (values: { email: string; password: string }) => {
    setLoading(true);
    try {
      await signIn(values.email, values.password);
      message.success('Signed in successfully');
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error ? err.message : 'Sign in failed';
      message.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async (values: { email: string; password: string }) => {
    setLoading(true);
    try {
      await signUp(values.email, values.password);
      setPendingEmail(values.email);
      message.success('Account created! Check your email for a confirmation code.');
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error ? err.message : 'Sign up failed';
      message.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (values: { code: string }) => {
    if (!pendingEmail) return;
    setLoading(true);
    try {
      await confirmSignUp(pendingEmail, values.code);
      setPendingEmail(null);
      message.success('Email confirmed! You can now sign in.');
    } catch (err: unknown) {
      const errorMsg =
        err instanceof Error ? err.message : 'Confirmation failed';
      message.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  if (pendingEmail) {
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
          <Space
            direction="vertical"
            size="large"
            style={{ width: '100%' }}
          >
            <div style={{ textAlign: 'center' }}>
              <RobotOutlined
                style={{ fontSize: 32, color: '#1677ff', marginBottom: 8 }}
              />
              <Title level={4} style={{ margin: 0 }}>
                Confirm Your Email
              </Title>
            </div>

            <Alert
              message="Check your email for a verification code"
              description={`We sent a code to ${pendingEmail}`}
              type="info"
              showIcon
            />

            <Form form={confirmForm} onFinish={handleConfirm} layout="vertical">
              <Form.Item
                name="code"
                rules={[
                  { required: true, message: 'Please enter the verification code' },
                ]}
              >
                <Input
                  size="large"
                  placeholder="Verification code"
                  maxLength={6}
                />
              </Form.Item>
              <Form.Item style={{ marginBottom: 0 }}>
                <Button
                  type="primary"
                  htmlType="submit"
                  block
                  size="large"
                  loading={loading}
                >
                  Confirm
                </Button>
              </Form.Item>
              <Button
                type="link"
                block
                onClick={() => setPendingEmail(null)}
                style={{ marginTop: 8 }}
              >
                Back to Sign In
              </Button>
            </Form>
          </Space>
        </Card>
      </div>
    );
  }

  const tabItems = [
    {
      key: 'signin',
      label: 'Sign In',
      children: (
        <Form form={signInForm} onFinish={handleSignIn} layout="vertical">
          <Form.Item
            name="email"
            rules={[
              { required: true, message: 'Please enter your email' },
              { type: 'email', message: 'Please enter a valid email' },
            ]}
          >
            <Input
              prefix={<MailOutlined />}
              size="large"
              placeholder="Email"
            />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[{ required: true, message: 'Please enter your password' }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              size="large"
              placeholder="Password"
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button
              type="primary"
              htmlType="submit"
              block
              size="large"
              loading={loading}
            >
              Sign In
            </Button>
          </Form.Item>
        </Form>
      ),
    },
    {
      key: 'signup',
      label: 'Sign Up',
      children: (
        <Form form={signUpForm} onFinish={handleSignUp} layout="vertical">
          <Form.Item
            name="email"
            rules={[
              { required: true, message: 'Please enter your email' },
              { type: 'email', message: 'Please enter a valid email' },
            ]}
          >
            <Input
              prefix={<MailOutlined />}
              size="large"
              placeholder="Email"
            />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[
              { required: true, message: 'Please enter a password' },
              { min: 8, message: 'Password must be at least 8 characters' },
            ]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              size="large"
              placeholder="Password"
            />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            dependencies={['password']}
            rules={[
              { required: true, message: 'Please confirm your password' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('Passwords do not match'));
                },
              }),
            ]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              size="large"
              placeholder="Confirm password"
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button
              type="primary"
              htmlType="submit"
              block
              size="large"
              loading={loading}
            >
              Sign Up
            </Button>
          </Form.Item>
        </Form>
      ),
    },
  ];

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
          <RobotOutlined
            style={{ fontSize: 36, color: '#1677ff', marginBottom: 8 }}
          />
          <Title level={3} style={{ margin: 0 }}>
            Knowledge Assistant
          </Title>
          <Text type="secondary">Sign in to start chatting</Text>
        </div>
        <Tabs items={tabItems} centered />
      </Card>
    </div>
  );
}

export default function App() {
  const { isLoading, isAuthenticated, user, signOut } = useAuth();

  if (isLoading) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Spin size="large" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AuthPage />;
  }

  return (
    <Layout style={{ height: '100vh' }}>
      <Header
        style={{
          background: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          boxShadow: '0 1px 4px rgba(0, 0, 0, 0.08)',
          zIndex: 10,
        }}
      >
        <Space>
          <RobotOutlined style={{ fontSize: 22, color: '#1677ff' }} />
          <span style={{ fontSize: 18, fontWeight: 600 }}>
            Knowledge Assistant
          </span>
        </Space>
        <Space>
          <Text type="secondary">{user?.email}</Text>
          <Button
            icon={<LogoutOutlined />}
            onClick={signOut}
          >
            Sign Out
          </Button>
        </Space>
      </Header>
      <Content
        style={{
          flex: 1,
          display: 'flex',
          overflow: 'hidden',
        }}
      >
        <ChatWidget />
      </Content>
    </Layout>
  );
}
