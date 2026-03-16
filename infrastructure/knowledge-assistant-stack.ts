import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import { StorageConstruct } from './constructs/storage.construct';
import { AuthConstruct } from './constructs/auth.construct';
import { KnowledgeBaseConstruct } from './constructs/knowledge-base.construct';
import { DatabaseConstruct } from './constructs/database.construct';
import { ComputeConstruct } from './constructs/compute.construct';
import { WebSocketApiConstruct } from './constructs/websocket-api.construct';
import { AdminApiConstruct } from './constructs/admin-api.construct';
import { FrontendConstruct } from './constructs/frontend.construct';
import { MonitoringConstruct } from './constructs/monitoring.construct';

export class KnowledgeAssistantStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const storage = new StorageConstruct(this, 'Storage');
    const auth = new AuthConstruct(this, 'Auth');
    const knowledgeBase = new KnowledgeBaseConstruct(this, 'KnowledgeBase', {
      docsBucket: storage.docsBucket,
    });
    const database = new DatabaseConstruct(this, 'Database');
    const compute = new ComputeConstruct(this, 'Compute', {
      docsBucket: storage.docsBucket,
      tenantsTable: database.tenantsTable,
      chatHistoryTable: database.chatHistoryTable,
      connectionsTable: database.connectionsTable,
      invoicesTable: database.invoicesTable,
      contractsTable: database.contractsTable,
      knowledgeBase: knowledgeBase.knowledgeBase,
      docsDataSource: knowledgeBase.docsDataSource,
      userPool: auth.userPool,
      userPoolClient: auth.userPoolClient,
    });
    const wsApi = new WebSocketApiConstruct(this, 'WebSocketApi', {
      connectFn: compute.connectFn,
      disconnectFn: compute.disconnectFn,
      chatFn: compute.chatFn,
      historyFn: compute.historyFn,
    });
    const adminApi = new AdminApiConstruct(this, 'AdminApi', {
      adminFn: compute.adminFn,
      tenantAdminFn: compute.tenantAdminFn,
      invoicesFn: compute.invoicesFn,
      contractsFn: compute.contractsFn,
      documentsFn: compute.documentsFn,
      userPool: auth.userPool,
      userPoolClient: auth.userPoolClient,
    });
    new MonitoringConstruct(this, 'Monitoring', {
      chatFn:              compute.chatFn,
      invoicesFn:          compute.invoicesFn,
      contractsFn:         compute.contractsFn,
      invoiceProcessorFn:  compute.invoiceProcessorFn,
      contractProcessorFn: compute.contractProcessorFn,
      httpApi:             adminApi.api,
    });

    const frontend = new FrontendConstruct(this, 'Frontend', {
      frontendBucket: storage.frontendBucket,
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'WebSocketUrl', { value: wsApi.wsUrl });
    new cdk.CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: auth.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'CloudFrontUrl', { value: frontend.distributionUrl });
    new cdk.CfnOutput(this, 'DocumentsBucketName', { value: storage.docsBucket.bucketName });
    new cdk.CfnOutput(this, 'FrontendBucketName', { value: storage.frontendBucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionId', { value: frontend.distribution.distributionId });
    new cdk.CfnOutput(this, 'KnowledgeBaseId', { value: knowledgeBase.knowledgeBase.knowledgeBaseId });
    new cdk.CfnOutput(this, 'AdminApiUrl', {
      value: adminApi.apiUrl,
      description: 'Admin REST API base URL (OpenAPI spec at docs/api.md)',
    });
  }
}
