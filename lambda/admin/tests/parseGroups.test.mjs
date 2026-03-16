import { describe, it, expect, vi } from 'vitest';

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({ send: vi.fn() })),
  ScanCommand: vi.fn(),
  PutItemCommand: vi.fn(),
  DeleteItemCommand: vi.fn(),
  UpdateItemCommand: vi.fn(),
  GetItemCommand: vi.fn(),
}));
vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: vi.fn(() => ({ send: vi.fn() })),
  AdminCreateUserCommand: vi.fn(),
  AdminAddUserToGroupCommand: vi.fn(),
  AdminDeleteUserCommand: vi.fn(),
  ListUsersCommand: vi.fn(),
}));
vi.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: vi.fn(() => ({ send: vi.fn() })),
  CreateDataSourceCommand: vi.fn(),
  DeleteDataSourceCommand: vi.fn(),
  StartIngestionJobCommand: vi.fn(),
}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: vi.fn() })),
  PutObjectCommand: vi.fn(),
  ListObjectsV2Command: vi.fn(),
  DeleteObjectsCommand: vi.fn(),
}));

import { parseGroups } from '../index.mjs';

describe('parseGroups', () => {
  it('returns empty array for null', () => {
    expect(parseGroups(null)).toEqual([]);
  });

  it('returns empty array for undefined', () => {
    expect(parseGroups(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseGroups('')).toEqual([]);
  });

  it('passes through an array unchanged', () => {
    expect(parseGroups(['RootAdmin', 'TenantAdmin'])).toEqual(['RootAdmin', 'TenantAdmin']);
  });

  it('parses a JSON array string', () => {
    expect(parseGroups('["RootAdmin","TenantAdmin"]')).toEqual(['RootAdmin', 'TenantAdmin']);
  });

  it('parses the API GW bracket format (unquoted, no JSON)', () => {
    expect(parseGroups('[RootAdmin]')).toEqual(['RootAdmin']);
  });

  it('parses multiple values in bracket format', () => {
    expect(parseGroups('[RootAdmin, TenantAdmin]')).toEqual(['RootAdmin', 'TenantAdmin']);
  });

  it('parses space-separated string', () => {
    expect(parseGroups('RootAdmin TenantAdmin')).toEqual(['RootAdmin', 'TenantAdmin']);
  });

  it('parses comma-separated string', () => {
    expect(parseGroups('RootAdmin,TenantAdmin')).toEqual(['RootAdmin', 'TenantAdmin']);
  });

  it('returns empty array for empty brackets', () => {
    expect(parseGroups('[]')).toEqual([]);
  });

  it('parses space-separated bracketed string (Cognito JWT claim format with multiple groups)', () => {
    const raw = '[operations warehouse marketing security TenantAdmin IT financial sales accounting logistics]';
    const result = parseGroups(raw);
    expect(result).toContain('TenantAdmin');
    expect(result).toContain('operations');
    expect(result).toHaveLength(10);
  });
});
