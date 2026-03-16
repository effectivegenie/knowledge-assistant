import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface AdminApiProps {
  adminFn: lambda.Function;
  tenantAdminFn: lambda.Function;
  invoicesFn: lambda.Function;
  contractsFn: lambda.Function;
  documentsFn: lambda.Function;
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

    const { adminFn, tenantAdminFn, invoicesFn, contractsFn, documentsFn, userPool, userPoolClient } = props;
    const stack = cdk.Stack.of(this);
    const region = stack.region;

    const adminUri = `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${adminFn.functionArn}/invocations`;
    const tenantAdminUri = `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${tenantAdminFn.functionArn}/invocations`;
    const invoicesUri = `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${invoicesFn.functionArn}/invocations`;

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
    const invoicesIntegration = {
      type: 'aws_proxy',
      httpMethod: 'POST',
      uri: invoicesUri,
      payloadFormatVersion: '2.0',
    };

    const contractsUri = `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${contractsFn.functionArn}/invocations`;
    const documentsUri = `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${documentsFn.functionArn}/invocations`;

    const contractsIntegration = {
      type: 'aws_proxy',
      httpMethod: 'POST',
      uri: contractsUri,
      payloadFormatVersion: '2.0',
    };
    const documentsIntegration = {
      type: 'aws_proxy',
      httpMethod: 'POST',
      uri: documentsUri,
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
          put: {
            operationId: 'updateTenantUserGroups',
            summary: 'Update business groups for a tenant user',
            security: securedWith,
            parameters: [
              { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'username', in: 'path', required: true, schema: { type: 'string' } },
            ],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { type: 'object', properties: { businessGroups: { type: 'array', items: { type: 'string' } } } } } },
            },
            responses: { '200': { description: 'Updated' }, '400': { description: 'Validation error' }, '403': { description: 'Forbidden' } },
            'x-amazon-apigateway-integration': tenantAdminIntegration,
          },
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
              content: { 'application/json': { schema: { type: 'object', required: ['filename'], properties: { filename: { type: 'string' }, groups: { type: 'array', items: { type: 'string' } }, category: { type: 'string', enum: ['general', 'invoice'] } } } } },
            },
            responses: {
              '200': { description: 'Presigned URL', content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string' }, metadataUrl: { type: 'string' }, key: { type: 'string' }, category: { type: 'string' } } } } } },
              '400': { description: 'Missing filename' },
              '403': { description: 'Forbidden' },
            },
            'x-amazon-apigateway-integration': tenantAdminIntegration,
          },
        },
        '/tenants/{tenantId}/profile': {
          get: {
            operationId: 'getTenantProfile',
            summary: 'Get tenant legal identity',
            security: securedWith,
            parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'Tenant profile' }, '403': { description: 'Forbidden' } },
            'x-amazon-apigateway-integration': invoicesIntegration,
          },
          put: {
            operationId: 'updateTenantProfile',
            summary: 'Update tenant legal identity',
            security: securedWith,
            parameters: [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { type: 'object', properties: { legalName: { type: 'string' }, vatNumber: { type: 'string' }, bulstat: { type: 'string' }, aliases: { type: 'array', items: { type: 'string' } } } } } },
            },
            responses: { '200': { description: 'Updated' }, '403': { description: 'Forbidden' } },
            'x-amazon-apigateway-integration': invoicesIntegration,
          },
        },
        '/tenants/{tenantId}/invoices': {
          get: {
            operationId: 'listInvoices',
            summary: 'List invoices for a tenant',
            security: securedWith,
            parameters: [
              { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'page', in: 'query', schema: { type: 'integer', default: 0 } },
              { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 20 } },
              { name: 'status', in: 'query', schema: { type: 'string' } },
              { name: 'direction', in: 'query', schema: { type: 'string' } },
              { name: 'documentType', in: 'query', schema: { type: 'string' } },
              { name: 'dateFrom', in: 'query', schema: { type: 'string' } },
              { name: 'dateTo', in: 'query', schema: { type: 'string' } },
              { name: 'search', in: 'query', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'Invoice list' }, '403': { description: 'Forbidden' } },
            'x-amazon-apigateway-integration': invoicesIntegration,
          },
        },
        '/tenants/{tenantId}/invoices/stats': {
          get: {
            operationId: 'getInvoiceStats',
            summary: 'Get aggregated invoice stats',
            security: securedWith,
            parameters: [
              { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'dateFrom', in: 'query', schema: { type: 'string' } },
              { name: 'dateTo', in: 'query', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'Stats' }, '403': { description: 'Forbidden' } },
            'x-amazon-apigateway-integration': invoicesIntegration,
          },
        },
        '/tenants/{tenantId}/invoices/{invoiceId}': {
          put: {
            operationId: 'updateInvoice',
            summary: 'Update invoice status',
            security: securedWith,
            parameters: [
              { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'invoiceId', in: 'path', required: true, schema: { type: 'string' } },
            ],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } } } },
            },
            responses: { '200': { description: 'Updated' }, '403': { description: 'Forbidden' }, '404': { description: 'Not found' } },
            'x-amazon-apigateway-integration': invoicesIntegration,
          },
          delete: {
            operationId: 'deleteInvoice',
            summary: 'Delete invoice and associated S3 files',
            security: securedWith,
            parameters: [
              { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'invoiceId', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'Deleted' }, '403': { description: 'Forbidden' }, '404': { description: 'Not found' } },
            'x-amazon-apigateway-integration': invoicesIntegration,
          },
        },
        '/tenants/{tenantId}/invoices/{invoiceId}/view-url': {
          get: {
            operationId: 'getInvoiceViewUrl',
            summary: 'Get presigned S3 GET URL for original invoice document',
            security: securedWith,
            parameters: [
              { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'invoiceId', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'View URL' }, '403': { description: 'Forbidden' }, '404': { description: 'Not found' } },
            'x-amazon-apigateway-integration': invoicesIntegration,
          },
        },
        '/tenants/{tenantId}/contracts': {
          get: {
            operationId: 'listContracts',
            summary: 'List contracts for a tenant',
            security: securedWith,
            parameters: [
              { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'page', in: 'query', schema: { type: 'integer', default: 0 } },
              { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 20 } },
              { name: 'status', in: 'query', schema: { type: 'string' } },
              { name: 'contractType', in: 'query', schema: { type: 'string' } },
              { name: 'search', in: 'query', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'Contract list' }, '403': { description: 'Forbidden' } },
            'x-amazon-apigateway-integration': contractsIntegration,
          },
        },
        '/tenants/{tenantId}/contracts/stats': {
          get: {
            operationId: 'getContractStats',
            summary: 'Get aggregated contract stats',
            security: securedWith,
            parameters: [
              { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'Stats' }, '403': { description: 'Forbidden' } },
            'x-amazon-apigateway-integration': contractsIntegration,
          },
        },
        '/tenants/{tenantId}/contracts/{contractId}': {
          put: {
            operationId: 'updateContract',
            summary: 'Update contract status and fields',
            security: securedWith,
            parameters: [
              { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'contractId', in: 'path', required: true, schema: { type: 'string' } },
            ],
            requestBody: {
              required: true,
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            responses: { '200': { description: 'Updated' }, '403': { description: 'Forbidden' }, '404': { description: 'Not found' } },
            'x-amazon-apigateway-integration': contractsIntegration,
          },
          delete: {
            operationId: 'deleteContract',
            summary: 'Delete contract and associated S3 files',
            security: securedWith,
            parameters: [
              { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'contractId', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'Deleted' }, '403': { description: 'Forbidden' }, '404': { description: 'Not found' } },
            'x-amazon-apigateway-integration': contractsIntegration,
          },
        },
        '/tenants/{tenantId}/contracts/{contractId}/view-url': {
          get: {
            operationId: 'getContractViewUrl',
            summary: 'Get presigned S3 GET URL for original contract document',
            security: securedWith,
            parameters: [
              { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'contractId', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'View URL' }, '403': { description: 'Forbidden' }, '404': { description: 'Not found' } },
            'x-amazon-apigateway-integration': contractsIntegration,
          },
        },
        '/tenants/{tenantId}/documents': {
          get: {
            operationId: 'listDocuments',
            summary: 'List general documents for a tenant',
            security: securedWith,
            parameters: [
              { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'page', in: 'query', schema: { type: 'integer', default: 0 } },
              { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 20 } },
              { name: 'search', in: 'query', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'Document list' }, '403': { description: 'Forbidden' } },
            'x-amazon-apigateway-integration': documentsIntegration,
          },
          delete: {
            operationId: 'deleteDocument',
            summary: 'Delete a document and all S3 sidecars',
            security: securedWith,
            parameters: [
              { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'key', in: 'query', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'Deleted' }, '403': { description: 'Forbidden' } },
            'x-amazon-apigateway-integration': documentsIntegration,
          },
        },
        '/tenants/{tenantId}/documents/view-url': {
          get: {
            operationId: 'getDocumentViewUrl',
            summary: 'Get presigned S3 GET URL for a general document',
            security: securedWith,
            parameters: [
              { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'key', in: 'query', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'View URL' }, '403': { description: 'Forbidden' } },
            'x-amazon-apigateway-integration': documentsIntegration,
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
    invoicesFn.addPermission('ApiGwInvoicesInvoke', { principal: apigwPrincipal, sourceArn: sourceArnPrefix });
    contractsFn.addPermission('ApiGwContractsInvoke', { principal: apigwPrincipal, sourceArn: sourceArnPrefix });
    documentsFn.addPermission('ApiGwDocumentsInvoke', { principal: apigwPrincipal, sourceArn: sourceArnPrefix });

    this.apiUrl = `https://${api.ref}.execute-api.${region}.amazonaws.com`;
  }
}
