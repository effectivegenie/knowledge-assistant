/**
 * Pre token generation (legacy V1): add cognito:groups and custom:tenantId to ID token.
 * Returns ONLY claimsOverrideDetails – version '1' does not support claimsAndScopeOverrideDetails.
 */
exports.handler = async (event) => {
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

  const result = {
    version: event.version,
    triggerSource: event.triggerSource,
    region: event.region,
    userPoolId: event.userPoolId,
    userName: event.userName,
    request: JSON.parse(JSON.stringify(event.request || {})),
    response: {
      claimsOverrideDetails: {
        claimsToAddOrOverride,
      },
    },
  };

  let jsonStr;
  try {
    jsonStr = JSON.stringify(result);
  } catch (err) {
    console.error('JSON.stringify failed', err);
    throw err;
  }
  console.log('Return topLevelKeys', Object.keys(result));
  console.log('Return response keys', Object.keys(result.response));
  console.log('Return payload length', jsonStr.length);
  console.log('Return payload preview', jsonStr.substring(0, 800));

  return JSON.parse(jsonStr);
};
