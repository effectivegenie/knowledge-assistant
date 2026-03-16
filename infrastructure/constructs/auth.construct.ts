import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';

export class AuthConstruct extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly preTokenGenFn: lambda.Function;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.preTokenGenFn = new lambda.Function(this, 'PreTokenGenFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/pre-token-gen')),
      timeout: cdk.Duration.seconds(5),
    });

    this.userPool = new cognito.UserPool(this, 'UserPool', {
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
        preTokenGeneration: this.preTokenGenFn,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.preTokenGenFn.addPermission('CognitoInvoke', {
      principal: new iam.ServicePrincipal('cognito-idp.amazonaws.com'),
      sourceArn: this.userPool.userPoolArn,
    });

    new cognito.CfnUserPoolGroup(this, 'RootAdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'RootAdmin',
      description: 'Global admin; can create tenants',
    });

    new cognito.CfnUserPoolGroup(this, 'TenantAdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'TenantAdmin',
      description: 'Tenant admin; can manage users in their tenant',
    });

    const businessGroups = [
      { id: 'financial',   description: 'Financial department' },
      { id: 'accounting',  description: 'Accounting department' },
      { id: 'operations',  description: 'Operations department' },
      { id: 'marketing',   description: 'Marketing department' },
      { id: 'IT',          description: 'IT department' },
      { id: 'warehouse',   description: 'Warehouse department' },
      { id: 'security',    description: 'Security department' },
      { id: 'logistics',   description: 'Logistics department' },
      { id: 'sales',       description: 'Sales department' },
      { id: 'design',      description: 'Design department' },
      { id: 'HR',          description: 'Human Resources department' },
    ];
    for (const g of businessGroups) {
      new cognito.CfnUserPoolGroup(this, `BusinessGroup${g.id.charAt(0).toUpperCase() + g.id.slice(1)}`, {
        userPoolId: this.userPool.userPoolId,
        groupName: g.id,
        description: g.description,
      });
    }

    this.userPoolClient = this.userPool.addClient('WebClient', {
      authFlows: { userSrp: true },
      generateSecret: false,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
    });
  }
}
