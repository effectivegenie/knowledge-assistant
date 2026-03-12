import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from 'react';
import {
  signIn as cognitoSignIn,
  signUp as cognitoSignUp,
  confirmSignUp as cognitoConfirmSignUp,
  signOut as cognitoSignOut,
  getCurrentSession,
} from './cognito';

interface User {
  email: string;
  sub: string;
}

interface AuthContextType {
  user: User | null;
  idToken: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  confirmSignUp: (email: string, code: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

function parseIdToken(token: string): { email: string; sub: string } {
  const payload = JSON.parse(atob(token.split('.')[1]));
  return { email: payload.email, sub: payload.sub };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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
    const session = await cognitoSignIn(email, password);
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
  }, []);

  const value: AuthContextType = {
    user,
    idToken,
    isLoading,
    isAuthenticated: !!user,
    signIn,
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
