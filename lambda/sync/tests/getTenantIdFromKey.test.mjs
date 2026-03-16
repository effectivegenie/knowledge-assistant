import { describe, it, expect, vi } from 'vitest';

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({ send: vi.fn() })),
  GetItemCommand: vi.fn(),
}));
vi.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: vi.fn(() => ({ send: vi.fn() })),
  StartIngestionJobCommand: vi.fn(),
}));

import { getTenantIdFromKey } from '../index.mjs';

describe('getTenantIdFromKey', () => {
  it('extracts the first path segment as tenantId', () => {
    expect(getTenantIdFromKey('acme/document.pdf')).toBe('acme');
  });

  it('works with nested paths', () => {
    expect(getTenantIdFromKey('acme/subfolder/file.txt')).toBe('acme');
  });

  it('returns "default" for null', () => {
    expect(getTenantIdFromKey(null)).toBe('default');
  });

  it('returns "default" for undefined', () => {
    expect(getTenantIdFromKey(undefined)).toBe('default');
  });

  it('returns "default" for empty string', () => {
    expect(getTenantIdFromKey('')).toBe('default');
  });

  it('returns "default" for a non-string value', () => {
    expect(getTenantIdFromKey(42)).toBe('default');
  });

  it('handles URL-encoded keys (raw S3 key)', () => {
    expect(getTenantIdFromKey('my-tenant/file%20name.pdf')).toBe('my-tenant');
  });

  it('handles single segment (no slash)', () => {
    expect(getTenantIdFromKey('filename.pdf')).toBe('filename.pdf');
  });

  it('handles leading slash by filtering empty segments', () => {
    expect(getTenantIdFromKey('/acme/file.pdf')).toBe('acme');
  });
});
