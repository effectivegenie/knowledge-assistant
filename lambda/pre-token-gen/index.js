/**
 * Pre token generation: add cognito:groups and custom:tenantId to ID token.
 * Supports both legacy (claimsOverrideDetails) and V2 (claimsAndScopeOverrideDetails) response formats.
 */
exports.handler = async (event) => {
  if (!event.response) {
    event.response = {};
  }

  const claimsToAddOrOverride = {};
  const groups = event.request?.groupConfiguration?.groupsToOverride;
  if (Array.isArray(groups) && groups.length > 0) {
    claimsToAddOrOverride['cognito:groups'] = groups.map(String);
  }
  const tenantId = event.request?.userAttributes?.['custom:tenantId'];
  if (tenantId != null && tenantId !== '') {
    claimsToAddOrOverride['custom:tenantId'] = String(tenantId);
  }

  event.response.claimsOverrideDetails = {
    claimsToAddOrOverride,
  };

  return event;
};
