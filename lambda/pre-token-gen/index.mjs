/**
 * Pre token generation: add cognito:groups and custom:tenantId to ID token.
 * Cognito requires: do not replace event.response, only set claimsOverrideDetails.
 */
export const handler = async (event) => {
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
