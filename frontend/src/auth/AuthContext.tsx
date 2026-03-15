import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from 'react';
import {
  signIn as cognitoSignIn,
  signUp as cognitoSignUp,
  confirmSignUp as cognitoConfirmSignUp,
  signOut as cognitoSignOut,
  completeNewPassword as cognitoCompleteNewPassword,
  getCurrentSession,
} from './cognito';

interface User {
  email: string;
  sub: string;
  tenantId: string;
  groups: string[];
}

interface AuthContextType {
  user: User | null;
  idToken: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  needsNewPassword: boolean;
  isRootAdmin: boolean;
  isTenantAdmin: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  completeNewPassword: (newPassword: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  confirmSignUp: (email: string, code: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

function parseIdToken(token: string): { email: string; sub: string; tenantId: string; groups: string[] } {
  const payload = JSON.parse(atob(token.split('.')[1]));
  const groups = payload['cognito:groups'];
  return {
    email: payload.email,
    sub: payload.sub,
    tenantId: payload['custom:tenantId'] || 'default',
    groups: Array.isArray(groups) ? groups : groups ? [groups] : [],
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [needsNewPassword, setNeedsNewPassword] = useState(false);

  useEffect(() => {
    getCurrentSession()
      .then((session) => {
        if (session) {
          const token = session.getIdToken().getJwtToken();
          setIdToken(token);
          setUser(parseIdToken(token));
        }
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await cognitoSignIn(email, password);
    if (result === 'NEW_PASSWORD_REQUIRED') {
      setNeedsNewPassword(true);
      return;
    }
    const token = result.getIdToken().getJwtToken();
    setIdToken(token);
    setUser(parseIdToken(token));
  }, []);

  const completeNewPassword = useCallback(async (newPassword: string) => {
    const session = await cognitoCompleteNewPassword(newPassword);
    setNeedsNewPassword(false);
    const token = session.getIdToken().getJwtToken();
    setIdToken(token);
    setUser(parseIdToken(token));
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    await cognitoSignUp(email, password);
  }, []);

  const confirmSignUp = useCallback(async (email: string, code: string) => {
    await cognitoConfirmSignUp(email, code);
  }, []);

  const signOut = useCallback(() => {
    cognitoSignOut();
    setUser(null);
    setIdToken(null);
    setNeedsNewPassword(false);
  }, []);

  const value: AuthContextType = {
    user,
    idToken,
    isLoading,
    isAuthenticated: !!user,
    needsNewPassword,
    isRootAdmin: !!user?.groups?.includes('RootAdmin'),
    isTenantAdmin: !!user?.groups?.includes('TenantAdmin'),
    signIn,
    completeNewPassword,
    signUp,
    confirmSignUp,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
