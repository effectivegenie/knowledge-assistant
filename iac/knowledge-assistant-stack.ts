import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { bedrock, s3vectors } from '@cdklabs/generative-ai-cdk-constructs';
import { Construct } from 'constructs';
import * as path from 'path';

export class KnowledgeAssistantStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ==================== Storage ====================

    const docsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // ==================== Auth ====================

    const preTokenGenFn = new lambda.Function(this, 'PreTokenGenFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/pre-token-gen')),
      timeout: cdk.Duration.seconds(5),
    });

    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      customAttributes: {
        tenantId: new cognito.StringAttribute({ minLen: 1, maxLen: 128, mutable: true }),
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      lambdaTriggers: {
        preTokenGeneration: preTokenGenFn,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    preTokenGenFn.addPermission('CognitoInvoke', {
      principal: new iam.ServicePrincipal('cognito-idp.amazonaws.com'),
      sourceArn: userPool.userPoolArn,
    });

    const rootAdminGroup = new cognito.CfnUserPoolGroup(this, 'RootAdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'RootAdmin',
      description: 'Global admin; can create tenants',
    });

    const tenantAdminGroup = new cognito.CfnUserPoolGroup(this, 'TenantAdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'TenantAdmin',
      description: 'Tenant admin; can manage users in their tenant',
    });

    const userPoolClient = userPool.addClient('WebClient', {
      authFlows: { userSrp: true },
      generateSecret: false,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
    });

    // ==================== Knowledge Base ====================

    const embeddingsModel = bedrock.BedrockFoundationModel.TITAN_EMBED_TEXT_V2_1024;

    const vectorBucket = new s3vectors.VectorBucket(this, 'VectorBucket');
    const vectorIndex = new s3vectors.VectorIndex(this, 'VectorIndex', {
      vectorBucket,
      dimension: embeddingsModel.vectorDimensions!,
      nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT'],
    });

    const knowledgeBase = new bedrock.VectorKnowledgeBase(this, 'KnowledgeBase', {
      embeddingsModel,
      vectorStore: vectorIndex,
      instruction: 'Use this knowledge base to answer questions based on the uploaded documents.',
    });

    const docsDataSource = new bedrock.S3DataSource(this, 'DocsDataSource', {
      bucket: docsBucket,
      knowledgeBase,
      dataSourceName: 'documents',
    });

    // ==================== DynamoDB ====================

    const connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const chatHistoryTable = new dynamodb.Table(this, 'ChatHistoryTable', {
      partitionKey: { name: 'tenantUser', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const tenantsTable = new dynamodb.Table(this, 'TenantsTable', {
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ==================== Lambda Functions ====================

    const kbSyncFn = new lambda.Function(this, 'KnowledgeBaseSyncFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/sync')),
      timeout: cdk.Duration.minutes(1),
      memorySize: 256,
      environment: {
        TENANTS_TABLE: tenantsTable.tableName,
        DEFAULT_KNOWLEDGE_BASE_ID: knowledgeBase.knowledgeBaseId,
        DEFAULT_DATA_SOURCE_ID: docsDataSource.dataSourceId,
      },
    });
    tenantsTable.grantReadData(kbSyncFn);
    docsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(kbSyncFn),
    );
    kbSyncFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:StartIngestionJob'],
      resources: [`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`],
    }));

    const connectFn = new lambda.Function(this, 'ConnectFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/connect')),
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        USER_POOL_ID: userPool.userPoolId,
        APP_CLIENT_ID: userPoolClient.userPoolClientId,
      },
    });
    connectionsTable.grantWriteData(connectFn);

    const disconnectFn = new lambda.Function(this, 'DisconnectFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/disconnect')),
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
      },
    });
    connectionsTable.grantWriteData(disconnectFn);

    const chatFn = new lambda.Function(this, 'ChatFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/chat')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        CONNECTIONS_TABLE: connectionsTable.tableName,
        TENANTS_TABLE: tenantsTable.tableName,
        DEFAULT_KNOWLEDGE_BASE_ID: knowledgeBase.knowledgeBaseId,
        MODEL_PROVIDER: 'bedrock',
        MODEL_ID: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
        CHAT_TABLE: chatHistoryTable.tableName,
      },
    });
    connectionsTable.grantReadWriteData(chatFn);
    chatHistoryTable.grantReadWriteData(chatFn);
    tenantsTable.grantReadData(chatFn);
    chatFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModelWithResponseStream', 'bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0`,
      ],
    }));
    chatFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:Retrieve'],
      resources: [`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`],
    }));

    const historyFn = new lambda.Function(this, 'HistoryFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/history')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        CHAT_TABLE: chatHistoryTable.tableName,
      },
    });
    chatHistoryTable.grantReadWriteData(historyFn);
    chatFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModelWithResponseStream', 'bedrock:InvokeModel'],
      resources: [
        // Allow foundation models in the stack Region (for other models if needed)
        `arn:aws:bedrock:${this.region}::foundation-model/*`,
        // Explicitly allow Claude Haiku 4.5 in all regions used by the EU inference profile
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
      ],
    }));

    // ==================== WebSocket API ====================

    const wsApi = new apigwv2.CfnApi(this, 'ChatWebSocketApi', {
      name: 'KnowledgeAssistantChat',
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    });

    const connectIntegration = new apigwv2.CfnIntegration(this, 'ConnectIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${connectFn.functionArn}/invocations`,
    });

    const connectRoute = new apigwv2.CfnRoute(this, 'ConnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$connect',
      authorizationType: 'NONE',
      target: `integrations/${connectIntegration.ref}`,
    });

    const disconnectIntegration = new apigwv2.CfnIntegration(this, 'DisconnectIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${disconnectFn.functionArn}/invocations`,
    });

    const disconnectRoute = new apigwv2.CfnRoute(this, 'DisconnectRoute', {
      apiId: wsApi.ref,
      routeKey: '$disconnect',
      target: `integrations/${disconnectIntegration.ref}`,
    });

    const chatIntegration = new apigwv2.CfnIntegration(this, 'ChatIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${chatFn.functionArn}/invocations`,
    });

    const sendMessageRoute = new apigwv2.CfnRoute(this, 'SendMessageRoute', {
      apiId: wsApi.ref,
      routeKey: 'sendMessage',
      target: `integrations/${chatIntegration.ref}`,
    });

    const historyIntegration = new apigwv2.CfnIntegration(this, 'HistoryIntegration', {
      apiId: wsApi.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${historyFn.functionArn}/invocations`,
    });

    const historyRoute = new apigwv2.CfnRoute(this, 'HistoryRoute', {
      apiId: wsApi.ref,
      routeKey: 'history',
      target: `integrations/${historyIntegration.ref}`,
    });

    const clearHistoryRoute = new apigwv2.CfnRoute(this, 'ClearHistoryRoute', {
      apiId: wsApi.ref,
      routeKey: 'clear_history',
      target: `integrations/${historyIntegration.ref}`,
    });

    const deployment = new apigwv2.CfnDeployment(this, 'WsDeployment', {
      apiId: wsApi.ref,
    });
    deployment.node.addDependency(connectRoute);
    deployment.node.addDependency(disconnectRoute);
    deployment.node.addDependency(sendMessageRoute);
    deployment.node.addDependency(historyRoute);
    deployment.node.addDependency(clearHistoryRoute);

    const wsStage = new apigwv2.CfnStage(this, 'ProdStage', {
      apiId: wsApi.ref,
      stageName: 'prod',
      deploymentId: deployment.ref,
    });

    connectFn.addPermission('ApiGwConnect', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*/$connect`,
    });
    disconnectFn.addPermission('ApiGwDisconnect', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*/$disconnect`,
    });
    chatFn.addPermission('ApiGwChat', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*/sendMessage`,
    });

    historyFn.addPermission('ApiGwHistory', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*/history`,
    });
    historyFn.addPermission('ApiGwClearHistory', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/*/clear_history`,
    });

    chatFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [`arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/prod/*`],
    }));
    historyFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [`arn:aws:execute-api:${this.region}:${this.account}:${wsApi.ref}/prod/*`],
    }));

    // ==================== Admin API (REST) ====================

    const adminFn = new lambda.Function(this, 'AdminFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/admin')),
      timeout: cdk.Duration.seconds(60),
      environment: {
        TENANTS_TABLE: tenantsTable.tableName,
        USER_POOL_ID: userPool.userPoolId,
        DEFAULT_KNOWLEDGE_BASE_ID: knowledgeBase.knowledgeBaseId,
        DEFAULT_DATA_SOURCE_ID: docsDataSource.dataSourceId,
        DOCS_BUCKET_ARN: docsBucket.bucketArn,
      },
    });
    tenantsTable.grantReadWriteData(adminFn);
    adminFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminAddUserToGroup', 'cognito-idp:ListUsers'],
      resources: [userPool.userPoolArn],
    }));
    adminFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:CreateDataSource'],
      resources: [`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/${knowledgeBase.knowledgeBaseId}`],
    }));

    const tenantAdminFn = new lambda.Function(this, 'TenantAdminFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/tenant-admin')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        USER_POOL_ID: userPool.userPoolId,
      },
    });
    tenantAdminFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminCreateUser'],
      resources: [userPool.userPoolArn],
    }));

    const jwtAuthorizer = new HttpJwtAuthorizer('JwtAuthorizer', `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`, {
      jwtAudience: [userPoolClient.userPoolClientId],
    });
    const httpApi = new apigwv2.HttpApi(this, 'AdminHttpApi', {
      apiName: 'KnowledgeAssistantAdmin',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.OPTIONS],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      defaultAuthorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: '/tenants',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new apigwv2integrations.HttpLambdaIntegration('AdminIntegration', adminFn),
    });
    httpApi.addRoutes({
      path: '/tenants/{tenantId}/users',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new apigwv2integrations.HttpLambdaIntegration('TenantAdminIntegration', tenantAdminFn),
    });

    // ==================== CloudFront ====================

    const distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    // ==================== Outputs ====================

    const wsUrl = `wss://${wsApi.ref}.execute-api.${this.region}.amazonaws.com/prod`;
    new cdk.CfnOutput(this, 'WebSocketUrl', { value: wsUrl });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'CloudFrontUrl', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'DocumentsBucketName', { value: docsBucket.bucketName });
    new cdk.CfnOutput(this, 'FrontendBucketName', { value: frontendBucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'KnowledgeBaseId', { value: knowledgeBase.knowledgeBaseId });
    new cdk.CfnOutput(this, 'AdminApiUrl', { value: httpApi.url ?? '', description: 'Admin REST API URL (add /tenants)' });
  }
}
