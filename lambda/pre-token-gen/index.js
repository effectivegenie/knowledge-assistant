/**
 * Pre token generation: add cognito:groups and custom:tenantId to ID token.
 * Supports both legacy (claimsOverrideDetails) and V2 (claimsAndScopeOverrideDetails).
 * Uses callback to maximize Cognito compatibility.
 */
exports.handler = (event, context, callback) => {
  console.log('PreTokenGen invoked', {
    triggerSource: event.triggerSource,
    version: event.version,
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

  const response = {
    claimsOverrideDetails: {
      claimsToAddOrOverride,
    },
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: {
        claimsToAddOrOverride,
      },
    },
  };

  const result = {
    version: event.version,
    triggerSource: event.triggerSource,
    region: event.region,
    userPoolId: event.userPoolId,
    userName: event.userName,
    request: event.request,
    response,
  };

  console.log('Returning response keys:', Object.keys(response));
  callback(null, result);
};
