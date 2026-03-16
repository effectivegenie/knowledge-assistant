import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface AdminApiProps {
  adminFn: lambda.Function;
  tenantAdminFn: lambda.Function;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
}

/**
 * HTTP API v2 defined via an OpenAPI 3.0 spec.
 *
 * Routes, integrations, CORS, and the JWT authorizer are all declared in the
 * spec body — no separate CfnRoute / CfnIntegration resources needed.
 *
 * See docs/api.md for the full API reference.
 */
export class AdminApiConstruct extends Construct {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: AdminApiProps) {
    super(scope, id);

    const { adminFn, tenantAdminFn, userPool, userPoolClient } = props;
    const stack = cdk.Stack.of(this);
    const region = stack.region;

    const adminUri = `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${adminFn.functionArn}/invocations`;
    const tenantAdminUri = `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${tenantAdminFn.functionArn}/invocations`;

    const adminIntegration = {
      type: 'aws_proxy',
      httpMethod: 'POST',
      uri: adminUri,
      payloadFormatVersion: '2.0',
    };
    const tenantAdminIntegration = {
      type: 'aws_proxy',
      httpMethod: 'POST',
      uri: tenantAdminUri,
      payloadFormatVersion: '2.0',
    };

    const securedWith = [{ cognitoJwt: [] as string[] }];

    const openApiSpec = {
      openapi: '3.0.1',
      info: {
        title: 'KnowledgeAssistantAdmin',
        version: '1.0',
        description: 'Admin REST API for tenant and user management. See docs/api.md for full reference.',
      },
      'x-amazon-apigateway-cors': {
        allowOrigins: ['*'],
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
        maxAge: 86400,
      },
      components: {
        securitySchemes: {
          cognitoJwt: {
            type: 'apiKey',
            name: 'Authorization',
            in: 'header',
            'x-amazon-apigateway-authorizer': {
              type: 'jwt',
              jwtConfiguration: {
                issuer: `https://cognito-idp.${region}.amazonaws.com/${userPool.userPoolId}`,
                audience: [userPoolClient.userPoolClientId],
              },
              identitySource: '$request.header.Authorization',
            },
          },
        },
        schemas: {
          Error: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              detail: { type: 'string' },
            },
          },
          Tenant: {
            type: 'object',
            properties: {
              tenantId: { type: 'string' },
              name: { type: 'string' },
              createdAt: { type: 'string', format: 'date-time' },
              knowledgeBaseId: { type: 'string' },
              dataSourceId: { type: 'string' },
            },
          },
          TenantUser: {
            type: 'object',
            properties: {
              username: { type: 'string' },
              email: { type: 'string' },
              status: { type: 'string', enum: ['CONFIRMED', 'FORCE_CHANGE_PASSWORD', 'UNCONFIRMED'] },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
      paths: {
        '/tenants': {
          get: {
            operationId: 'listTenants',
            summary: 'List all tenants',
            description: 'RootAdmin only. Returns all tenants in the system.',
            security: securedWith,
            responses: {
              '200': { description: 'Tenant list', content: { 'application/json': { schema: { type: 'object', properties: { tenants: { type: 'array', items: { '$ref': '#/components/schemas/Tenant' } } } } } } },
              '403': { description: 'Forbidden' },
            },
            'x-amazon-apigateway-integration': adminIntegration,
          },
          post: {
            operationId: 'createTenant',
            summary: 'Create a new tenant',
            description: 'RootAdmin only. Creates tenant, Bedrock data source, S3 folder, and initial admin user.',
            security: securedWith,
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['tenantId', 'name', 'adminEmail', 'temporaryPassword'],
                    properties: {
                      tenantId: { type: 'string', description: 'Lowercase letters, numbers, hyphens' },
                      name: { type: 'string' },
                      adminEmail: { type: 'string', format: 'email' },
                      temporaryPassword: { type: 'string', minLength: 8 },
                    },
                  },
                },
              },
            },
            responses: {
              '200': { description: 'Tenant created' },
              '400': { description: 'Validation error', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
              '403': { description: 'Forbidden' },
            },
            'x-amazon-apigateway-integration': adminIntegration,
          },
        },
        '/tenants/{tenantId}': {
          put: {
            operationId: 'updateTenant',
            summary: 'Update tenant display name',
            security: securedWith,
            parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
            },
            responses: { '200': { description: 'Updated' }, '403': { description: 'Forbidden' }, '404': { description: 'Not found' } },
            'x-amazon-apigateway-integration': adminIntegration,
          },
          delete: {
            operationId: 'deleteTenant',
            summary: 'Delete tenant and all associated resources',
            description: 'Removes S3 objects, Bedrock data source, chat history, tenant record, and Cognito users.',
            security: securedWith,
            parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'Deleted' }, '403': { description: 'Forbidden' } },
            'x-amazon-apigateway-integration': adminIntegration,
          },
        },
        '/tenants/{tenantId}/users': {
          get: {
            operationId: 'listTenantUsers',
            summary: 'List users in a tenant',
            security: securedWith,
            parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
              '200': { description: 'User list', content: { 'application/json': { schema: { type: 'object', properties: { users: { type: 'array', items: { '$ref': '#/components/schemas/TenantUser' } } } } } } },
              '403': { description: 'Forbidden' },
            },
            'x-amazon-apigateway-integration': tenantAdminIntegration,
          },
          post: {
            operationId: 'createTenantUser',
            summary: 'Create a user in a tenant',
            security: securedWith,
            parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { type: 'object', required: ['email', 'temporaryPassword'], properties: { email: { type: 'string', format: 'email' }, temporaryPassword: { type: 'string', minLength: 8 } } } } },
            },
            responses: { '200': { description: 'User created' }, '400': { description: 'Error' }, '403': { description: 'Forbidden' } },
            'x-amazon-apigateway-integration': tenantAdminIntegration,
          },
        },
        '/tenants/{tenantId}/users/{username}': {
          delete: {
            operationId: 'deleteTenantUser',
            summary: 'Permanently delete a Cognito user',
            security: securedWith,
            parameters: [
              { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'username', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'Deleted' }, '403': { description: 'Forbidden' } },
            'x-amazon-apigateway-integration': tenantAdminIntegration,
          },
        },
        '/tenants/{tenantId}/upload-url': {
          post: {
            operationId: 'getUploadUrl',
            summary: 'Get a presigned S3 PUT URL for document upload',
            description: 'Returns a presigned URL (5 min TTL) for direct browser-to-S3 upload.',
            security: securedWith,
            parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { type: 'object', required: ['filename'], properties: { filename: { type: 'string' } } } } },
            },
            responses: {
              '200': { description: 'Presigned URL', content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string' }, key: { type: 'string' } } } } } },
              '400': { description: 'Missing filename' },
              '403': { description: 'Forbidden' },
            },
            'x-amazon-apigateway-integration': tenantAdminIntegration,
          },
        },
      },
    };

    const api = new apigwv2.CfnApi(this, 'Api', {
      body: openApiSpec,
      failOnWarnings: true,
    });

    new apigwv2.CfnStage(this, 'Stage', {
      apiId: api.ref,
      stageName: '$default',
      autoDeploy: true,
    });

    // Grant API Gateway permission to invoke each Lambda
    const apigwPrincipal = new iam.ServicePrincipal('apigateway.amazonaws.com');
    const sourceArnPrefix = `arn:aws:execute-api:${region}:${stack.account}:${api.ref}/*/*`;

    adminFn.addPermission('ApiGwAdminInvoke', { principal: apigwPrincipal, sourceArn: sourceArnPrefix });
    tenantAdminFn.addPermission('ApiGwTenantAdminInvoke', { principal: apigwPrincipal, sourceArn: sourceArnPrefix });

    this.apiUrl = `https://${api.ref}.execute-api.${region}.amazonaws.com`;
  }
}
