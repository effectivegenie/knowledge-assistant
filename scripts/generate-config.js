const fs = require('fs');
const path = require('path');

const outputsFile = path.join(__dirname, '..', 'cdk-outputs.json');

if (!fs.existsSync(outputsFile)) {
  console.error('Error: cdk-outputs.json not found. Run "cdk deploy" first.');
  process.exit(1);
}

const outputs = JSON.parse(fs.readFileSync(outputsFile, 'utf-8'));
const stack = outputs.KnowledgeAssistantStack;

if (!stack) {
  console.error('Error: KnowledgeAssistantStack not found in cdk-outputs.json');
  process.exit(1);
}

const regionMatch = stack.WebSocketUrl.match(/execute-api\.(.+?)\.amazonaws/);
const region = regionMatch ? regionMatch[1] : process.env.AWS_REGION || 'us-east-1';

const config = `export const config = {
  cognito: {
    userPoolId: '${stack.UserPoolId}',
    userPoolClientId: '${stack.UserPoolClientId}',
    region: '${region}',
  },
  websocket: {
    url: '${stack.WebSocketUrl}',
  },
};
`;

const configPath = path.join(__dirname, '..', 'frontend', 'src', 'config.ts');
fs.writeFileSync(configPath, config);
console.log('Frontend config generated:');
console.log(`  UserPoolId:       ${stack.UserPoolId}`);
console.log(`  UserPoolClientId: ${stack.UserPoolClientId}`);
console.log(`  WebSocketUrl:     ${stack.WebSocketUrl}`);
console.log(`  Region:           ${region}`);
