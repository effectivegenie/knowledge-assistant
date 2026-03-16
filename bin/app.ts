#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { KnowledgeAssistantStack } from '../infrastructure/knowledge-assistant-stack';

const app = new cdk.App();
new KnowledgeAssistantStack(app, 'KnowledgeAssistantStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
