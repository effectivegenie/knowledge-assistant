// Update these values with CDK deploy outputs (see cdk-outputs.json after running: npx cdk deploy)
export interface AppConfig {
  cognito: {
    userPoolId: string;
    userPoolClientId: string;
    region: string;
  };
  websocket: { url: string };
  adminApiUrl: string;
}

export const config: AppConfig = {
  cognito: {
    userPoolId: 'REPLACE_AFTER_CDK_DEPLOY',
    userPoolClientId: 'REPLACE_AFTER_CDK_DEPLOY',
    region: 'us-east-1',
  },
  websocket: {
    url: 'REPLACE_AFTER_CDK_DEPLOY',
  },
  adminApiUrl: 'REPLACE_AFTER_CDK_DEPLOY',
};
