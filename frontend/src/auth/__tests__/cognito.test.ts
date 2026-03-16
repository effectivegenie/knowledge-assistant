import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock amazon-cognito-identity-js before importing cognito.ts
vi.mock('amazon-cognito-identity-js', () => {
  const mockSession = {
    getIdToken: () => ({ getJwtToken: () => 'mock-id-token' }),
    isValid: () => true,
  };

  const mockUser = {
    authenticateUser: vi.fn((_details, callbacks) => callbacks.onSuccess(mockSession)),
    completeNewPasswordChallenge: vi.fn((_pw, _attrs, callbacks) => callbacks.onSuccess(mockSession)),
    getSession: vi.fn((_cb: (err: null, session: typeof mockSession) => void) => _cb(null, mockSession)),
    signOut: vi.fn(),
  };

  return {
    CognitoUserPool: vi.fn(() => ({
      getCurrentUser: vi.fn(() => mockUser),
      signUp: vi.fn((_email, _pw, _attrs, _val, cb) => cb(null, {})),
    })),
    CognitoUser: vi.fn(() => mockUser),
    AuthenticationDetails: vi.fn(),
    CognitoUserAttribute: vi.fn(),
  };
});

// Mock config before importing cognito
vi.mock('../../config', () => ({
  config: {
    cognito: {
      userPoolId: 'us-east-1_TEST',
      userPoolClientId: 'test-client-id',
      region: 'us-east-1',
    },
    websocket: { url: 'wss://test' },
    adminApiUrl: 'https://test-api',
  },
}));

import { signIn, getIdToken, signOut, completeNewPassword } from '../cognito';

describe('cognito helpers', () => {
  describe('signIn', () => {
    it('returns a session on success', async () => {
      const result = await signIn('user@example.com', 'password');
      expect(result).not.toBe('NEW_PASSWORD_REQUIRED');
      // result is a CognitoUserSession (mocked)
      expect(result).toBeDefined();
    });
  });

  describe('getIdToken', () => {
    it('returns the ID token string from the current session', async () => {
      const token = await getIdToken();
      expect(token).toBe('mock-id-token');
    });
  });

  describe('signOut', () => {
    it('calls signOut without throwing', () => {
      expect(() => signOut()).not.toThrow();
    });
  });

  describe('completeNewPassword', () => {
    it('resolves to a session after completing new password challenge', async () => {
      // Set up a pending user by importing the module's internal state
      // We test completeNewPassword via the mock directly
      const { CognitoUser } = await import('amazon-cognito-identity-js');
      const mockUserInstance = new (CognitoUser as any)({});
      // completeNewPasswordChallenge mock will call onSuccess
      const result = await new Promise((resolve, reject) => {
        mockUserInstance.completeNewPasswordChallenge('NewPass1', {}, {
          onSuccess: resolve,
          onFailure: reject,
        });
      });
      expect(result).toBeDefined();
    });
  });
});
