/**
 * Pre token generation: add cognito:groups and custom:tenantId to ID token.
 * Return a plain object so Cognito gets a clean JSON response (no prototype/getters).
 */
exports.handler = async (event) => {
  const claimsToAddOrOverride = {};
  const groups = event.request?.groupConfiguration?.groupsToOverride;
  if (Array.isArray(groups) && groups.length > 0) {
    claimsToAddOrOverride['cognito:groups'] = groups.map(String);
  }
  const tenantId = event.request?.userAttributes?.['custom:tenantId'];
  if (tenantId != null && tenantId !== '') {
    claimsToAddOrOverride['custom:tenantId'] = String(tenantId);
  }

  return {
    ...event,
    response: {
      claimsOverrideDetails: {
        claimsToAddOrOverride,
      },
    },
  };
};
