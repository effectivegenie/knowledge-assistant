/**
 * Pre token generation: add cognito:groups and custom:tenantId to ID token.
 * Return a plain object so Cognito gets a clean JSON response (no prototype/getters).
 */
exports.handler = async (event) => {
  console.log('PreTokenGen invoked', {
    triggerSource: event.triggerSource,
    version: event.version,
    userName: event.userName,
    hasGroupConfig: !!event.request?.groupConfiguration,
    hasUserAttributes: !!event.request?.userAttributes,
  });

  const claimsToAddOrOverride = {};
  const groups = event.request?.groupConfiguration?.groupsToOverride;
  if (Array.isArray(groups) && groups.length > 0) {
    claimsToAddOrOverride['cognito:groups'] = groups.map(String);
  }
  const tenantId = event.request?.userAttributes?.['custom:tenantId'];
  if (tenantId != null && tenantId !== '') {
    claimsToAddOrOverride['custom:tenantId'] = String(tenantId);
  }

  console.log('claimsToAddOrOverride', JSON.stringify(claimsToAddOrOverride));

  const result = {
    version: event.version,
    triggerSource: event.triggerSource,
    region: event.region,
    userPoolId: event.userPoolId,
    userName: event.userName,
    request: event.request,
    response: {
      claimsOverrideDetails: {
        claimsToAddOrOverride,
      },
    },
  };

  try {
    const serialized = JSON.stringify(result);
    console.log('Return payload length', serialized.length);
  } catch (e) {
    console.error('JSON.stringify failed', e);
    throw e;
  }

  return result;
};
