import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserAttribute,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { config } from '../config';

const userPool = new CognitoUserPool({
  UserPoolId: config.cognito.userPoolId,
  ClientId: config.cognito.userPoolClientId,
});

export function signUp(email: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const attributes = [
      new CognitoUserAttribute({ Name: 'email', Value: email }),
    ];

    userPool.signUp(email, password, attributes, [], (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export function confirmSignUp(email: string, code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cognitoUser = new CognitoUser({
      Username: email,
      Pool: userPool,
    });

    cognitoUser.confirmRegistration(code, true, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export function signIn(
  email: string,
  password: string,
): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    const cognitoUser = new CognitoUser({
      Username: email,
      Pool: userPool,
    });

    const authDetails = new AuthenticationDetails({
      Username: email,
      Password: password,
    });

    cognitoUser.authenticateUser(authDetails, {
      onSuccess: (session) => resolve(session),
      onFailure: (err) => reject(err),
    });
  });
}

export function signOut(): void {
  const currentUser = userPool.getCurrentUser();
  if (currentUser) {
    currentUser.signOut();
  }
}

export function getCurrentSession(): Promise<CognitoUserSession | null> {
  return new Promise((resolve) => {
    const currentUser = userPool.getCurrentUser();
    if (!currentUser) {
      resolve(null);
      return;
    }

    currentUser.getSession(
      (err: Error | null, session: CognitoUserSession | null) => {
        if (err || !session) {
          resolve(null);
          return;
        }
        resolve(session);
      },
    );
  });
}

export async function getIdToken(): Promise<string | null> {
  const session = await getCurrentSession();
  if (!session) return null;
  return session.getIdToken().getJwtToken();
}
