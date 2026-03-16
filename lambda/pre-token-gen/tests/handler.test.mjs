import { describe, it, expect } from 'vitest';

// pre-token-gen uses CJS exports, import via createRequire
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { handler } = require('../index.js');

function makeEvent(userAttributes = {}) {
  return {
    version: '1',
    triggerSource: 'TokenGeneration_Authentication',
    region: 'us-east-1',
    userPoolId: 'us-east-1_TEST',
    userName: 'testuser',
    request: { userAttributes },
    response: {},
  };
}

describe('pre-token-gen handler', () => {
  it('adds custom:tenantId to claims when present', async () => {
    const event = makeEvent({ 'custom:tenantId': 'acme' });
    const result = await handler(event);
    expect(result.response.claimsOverrideDetails.claimsToAddOrOverride['custom:tenantId']).toBe('acme');
  });

  it('does not add custom:tenantId when attribute is missing', async () => {
    const event = makeEvent({});
    const result = await handler(event);
    expect(result.response.claimsOverrideDetails.claimsToAddOrOverride).not.toHaveProperty('custom:tenantId');
  });

  it('does not add custom:tenantId when attribute is empty string', async () => {
    const event = makeEvent({ 'custom:tenantId': '' });
    const result = await handler(event);
    expect(result.response.claimsOverrideDetails.claimsToAddOrOverride).not.toHaveProperty('custom:tenantId');
  });

  it('preserves all required event top-level fields in the response', async () => {
    const event = makeEvent({ 'custom:tenantId': 'acme' });
    const result = await handler(event);
    expect(result.version).toBe(event.version);
    expect(result.triggerSource).toBe(event.triggerSource);
    expect(result.userPoolId).toBe(event.userPoolId);
    expect(result.userName).toBe(event.userName);
  });

  it('coerces tenantId to string', async () => {
    const event = makeEvent({ 'custom:tenantId': 123 });
    const result = await handler(event);
    expect(result.response.claimsOverrideDetails.claimsToAddOrOverride['custom:tenantId']).toBe('123');
  });
});
