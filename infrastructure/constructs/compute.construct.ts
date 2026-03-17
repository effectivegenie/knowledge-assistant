import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { bedrock } from '@cdklabs/generative-ai-cdk-constructs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ComputeProps {
  docsBucket: s3.Bucket;
  tenantsTable: dynamodb.Table;
  chatHistoryTable: dynamodb.Table;
  connectionsTable: dynamodb.Table;
  invoicesTable: dynamodb.Table;
  contractsTable: dynamodb.Table;
  knowledgeBase: bedrock.VectorKnowledgeBase;
  docsDataSource: bedrock.S3DataSource;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
}

export class ComputeConstruct extends Construct {
  public readonly kbSyncFn: lambda.Function;
  public readonly connectFn: lambda.Function;
  public readonly disconnectFn: lambda.Function;
  public readonly chatFn: lambda.Function;
  public readonly historyFn: lambda.Function;
  public readonly adminFn: lambda.Function;
  public readonly tenantAdminFn: lambda.Function;
  public readonly invoicesFn: lambda.Function;
  public readonly docConverterFn: lambda.Function;
  public readonly invoiceProcessorFn: lambda.Function;
  public readonly contractProcessorFn: lambda.Function;
  public readonly contractsFn: lambda.Function;
  public readonly documentsFn: lambda.Function;
  public readonly docClassifierFn: lambda.Function;

  constructor(scope: Construct, id: string, props: ComputeProps) {
    super(scope, id);

    const { docsBucket, tenantsTable, chatHistoryTable, connectionsTable, invoicesTable,
            contractsTable, knowledgeBase, docsDataSource, userPool, userPoolClient } = props;

    const stack = cdk.Stack.of(this);

    // ── KB Sync ──────────────────────────────────────────────────────────────
    this.kbSyncFn = new lambda.Function(this, 'KnowledgeBaseSyncFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/sync')),
      timeout: cdk.Duration.minutes(1),
      memorySize: 256,
      environment: {
        TENANTS_TABLE: tenantsTable.tableName,
        DEFAULT_KNOWLEDGE_BASE_ID: knowledgeBase.knowledgeBaseId,
        DEFAULT_DATA_SOURCE_ID: docsDataSource.dataSourceId,
      },
    });
    tenantsTable.grantReadData(this.kbSyncFn);
    this.kbSyncFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:StartIngestionJob'],
      resources: [`arn:aws:bedrock:${stack.region}:${stack.account}:knowledge-base/*`],
    }));

    // ── S3 → SNS fanout (OBJECT_CREATED) ─────────────────────────────────────
    // S3 does not allow two Lambda notifications with the same event type
    // unless they have non-overlapping prefix/suffix filters. Use an SNS topic
    // so multiple Lambdas can subscribe without conflicts.
    const objectCreatedTopic = new sns.Topic(this, 'ObjectCreatedTopic');
    docsBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.SnsDestination(objectCreatedTopic));
    objectCreatedTopic.addSubscription(new subs.LambdaSubscription(this.kbSyncFn));
    // document-processor is subscribed below, after the function is created

    // OBJECT_REMOVED goes directly to kbSyncFn (document-processor doesn't need it)
    docsBucket.addEventNotification(s3.EventType.OBJECT_REMOVED, new s3n.LambdaDestination(this.kbSyncFn));

    // Store reference to subscribe documentProcessorFn later
    const objectCreatedTopicRef = objectCreatedTopic;

    // ── Connect ──────────────────────────────────────────────────────────────
    this.connectFn = new lambda.Function(this, 'ConnectFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/connect')),
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        USER_POOL_ID: userPool.userPoolId,
        APP_CLIENT_ID: userPoolClient.userPoolClientId,
      },
    });
    connectionsTable.grantWriteData(this.connectFn);

    // ── Disconnect ───────────────────────────────────────────────────────────
    this.disconnectFn = new lambda.Function(this, 'DisconnectFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/disconnect')),
      environment: { CONNECTIONS_TABLE: connectionsTable.tableName },
    });
    connectionsTable.grantWriteData(this.disconnectFn);

    // ── Chat ─────────────────────────────────────────────────────────────────
    this.chatFn = new lambda.Function(this, 'ChatFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/chat')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        TENANTS_TABLE: tenantsTable.tableName,
        DEFAULT_KNOWLEDGE_BASE_ID: knowledgeBase.knowledgeBaseId,
        DOCS_BUCKET_NAME: docsBucket.bucketName,
        MODEL_PROVIDER: 'bedrock',
        MODEL_ID: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
        CHAT_TABLE: chatHistoryTable.tableName,
      },
    });
    connectionsTable.grantReadWriteData(this.chatFn);
    chatHistoryTable.grantReadWriteData(this.chatFn);
    tenantsTable.grantReadData(this.chatFn);
    this.chatFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModelWithResponseStream', 'bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0`,
        `arn:aws:bedrock:${stack.region}::foundation-model/*`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
      ],
    }));
    this.chatFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:Retrieve'],
      resources: [`arn:aws:bedrock:${stack.region}:${stack.account}:knowledge-base/*`],
    }));

    // ── History ──────────────────────────────────────────────────────────────
    this.historyFn = new lambda.Function(this, 'HistoryFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/history')),
      timeout: cdk.Duration.seconds(30),
      environment: { CHAT_TABLE: chatHistoryTable.tableName },
    });
    chatHistoryTable.grantReadWriteData(this.historyFn);

    // ── Admin ────────────────────────────────────────────────────────────────
    this.adminFn = new lambda.Function(this, 'AdminFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/admin')),
      timeout: cdk.Duration.seconds(60),
      environment: {
        TENANTS_TABLE: tenantsTable.tableName,
        CHAT_TABLE: chatHistoryTable.tableName,
        USER_POOL_ID: userPool.userPoolId,
        DEFAULT_KNOWLEDGE_BASE_ID: knowledgeBase.knowledgeBaseId,
        DEFAULT_DATA_SOURCE_ID: docsDataSource.dataSourceId,
        DOCS_BUCKET_ARN: docsBucket.bucketArn,
        DOCS_BUCKET_NAME: docsBucket.bucketName,
      },
    });
    tenantsTable.grantReadWriteData(this.adminFn);
    chatHistoryTable.grantReadWriteData(this.adminFn);
    docsBucket.grantReadWrite(this.adminFn);
    this.adminFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminAddUserToGroup',
                'cognito-idp:AdminDeleteUser', 'cognito-idp:ListUsers'],
      resources: [userPool.userPoolArn],
    }));
    this.adminFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:CreateDataSource', 'bedrock:DeleteDataSource', 'bedrock:StartIngestionJob'],
      resources: [`arn:aws:bedrock:${stack.region}:${stack.account}:knowledge-base/${knowledgeBase.knowledgeBaseId}`],
    }));

    // ── Tenant Admin ─────────────────────────────────────────────────────────
    this.tenantAdminFn = new lambda.Function(this, 'TenantAdminFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/tenant-admin')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        DOCS_BUCKET_NAME: docsBucket.bucketName,
      },
    });
    this.tenantAdminFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminCreateUser',
                'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup',
                'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminDeleteUser'],
      resources: [userPool.userPoolArn],
    }));
    docsBucket.grantPut(this.tenantAdminFn);

    // ── Invoices ─────────────────────────────────────────────────────────────
    this.invoicesFn = new lambda.Function(this, 'InvoicesFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/invoices')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        INVOICES_TABLE: invoicesTable.tableName,
        TENANTS_TABLE: tenantsTable.tableName,
        DOCS_BUCKET_NAME: docsBucket.bucketName,
      },
    });
    invoicesTable.grantReadWriteData(this.invoicesFn);
    tenantsTable.grantReadWriteData(this.invoicesFn);
    docsBucket.grantRead(this.invoicesFn);

    // ── Doc Converter ────────────────────────────────────────────────────────
    // Converts PDF/image files to plain text via Claude Vision and saves
    // a .kb.txt sidecar so Bedrock KB can ingest it successfully.
    this.docConverterFn = new lambda.Function(this, 'DocConverterFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/doc-converter')),
      timeout: cdk.Duration.minutes(3),
      memorySize: 512,
      environment: {
        MODEL_ID: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
    });
    docsBucket.grantReadWrite(this.docConverterFn);
    this.docConverterFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0`,
        `arn:aws:bedrock:${stack.region}::foundation-model/*`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
      ],
    }));
    objectCreatedTopicRef.addSubscription(new subs.LambdaSubscription(this.docConverterFn));

    // ── Invoice Processor ────────────────────────────────────────────────────
    this.invoiceProcessorFn = new lambda.Function(this, 'InvoiceProcessorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/invoice-processor')),
      timeout: cdk.Duration.minutes(3),
      memorySize: 512,
      environment: {
        INVOICES_TABLE: invoicesTable.tableName,
        TENANTS_TABLE: tenantsTable.tableName,
        MODEL_ID: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
    });
    invoicesTable.grantReadWriteData(this.invoiceProcessorFn);
    tenantsTable.grantReadData(this.invoiceProcessorFn);
    docsBucket.grantRead(this.invoiceProcessorFn);
    this.invoiceProcessorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0`,
        `arn:aws:bedrock:${stack.region}::foundation-model/*`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
      ],
    }));
    // Subscribe invoiceProcessorFn to the shared OBJECT_CREATED topic
    objectCreatedTopicRef.addSubscription(new subs.LambdaSubscription(this.invoiceProcessorFn));

    // ── Contract Processor ───────────────────────────────────────────────────────
    this.contractProcessorFn = new lambda.Function(this, 'ContractProcessorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/contract-processor')),
      timeout: cdk.Duration.minutes(3),
      memorySize: 512,
      environment: {
        CONTRACTS_TABLE: contractsTable.tableName,
        TENANTS_TABLE: tenantsTable.tableName,
        MODEL_ID: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
    });
    contractsTable.grantReadWriteData(this.contractProcessorFn);
    tenantsTable.grantReadData(this.contractProcessorFn);
    docsBucket.grantRead(this.contractProcessorFn);
    this.contractProcessorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0`,
        `arn:aws:bedrock:${stack.region}::foundation-model/*`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
      ],
    }));
    objectCreatedTopicRef.addSubscription(new subs.LambdaSubscription(this.contractProcessorFn));

    // ── Contracts ────────────────────────────────────────────────────────────────
    this.contractsFn = new lambda.Function(this, 'ContractsFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/contracts')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        CONTRACTS_TABLE: contractsTable.tableName,
        TENANTS_TABLE: tenantsTable.tableName,
        DOCS_BUCKET_NAME: docsBucket.bucketName,
      },
    });
    contractsTable.grantReadWriteData(this.contractsFn);
    tenantsTable.grantReadData(this.contractsFn);
    docsBucket.grantRead(this.contractsFn);

    // ── Documents ────────────────────────────────────────────────────────────────
    this.documentsFn = new lambda.Function(this, 'DocumentsFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/documents')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        DOCS_BUCKET_NAME: docsBucket.bucketName,
      },
    });
    docsBucket.grantRead(this.documentsFn);
    docsBucket.grantDelete(this.documentsFn);

    // ── Doc Classifier ───────────────────────────────────────────────────────
    // Auto-classifies general documents as invoice or contract using Claude
    // Vision. Only processes category=general uploads; already-categorised
    // files are handled by the dedicated invoice/contract processors.
    this.docClassifierFn = new lambda.Function(this, 'DocClassifierFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/doc-classifier')),
      timeout: cdk.Duration.minutes(3),
      memorySize: 512,
      environment: {
        INVOICES_TABLE:  invoicesTable.tableName,
        CONTRACTS_TABLE: contractsTable.tableName,
        TENANTS_TABLE:   tenantsTable.tableName,
        MODEL_ID:        'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
    });
    invoicesTable.grantReadWriteData(this.docClassifierFn);
    contractsTable.grantReadWriteData(this.docClassifierFn);
    tenantsTable.grantReadData(this.docClassifierFn);
    docsBucket.grantRead(this.docClassifierFn);
    docsBucket.grantPut(this.docClassifierFn);
    this.docClassifierFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0`,
        `arn:aws:bedrock:${stack.region}::foundation-model/*`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
      ],
    }));
    objectCreatedTopicRef.addSubscription(new subs.LambdaSubscription(this.docClassifierFn));
  }
}
