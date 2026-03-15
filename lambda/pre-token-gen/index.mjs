/**
 * Pre token generation: add cognito:groups and custom:tenantId to ID token
 * so the frontend and API Gateway JWT authorizer can use them.
 */
export const handler = async (event) => {
  if (!event.response.claimsOverrideDetails) {
    event.response.claimsOverrideDetails = {};
  }
  const details = event.response.claimsOverrideDetails;
  if (!details.claimsToAddOrOverride) details.claimsToAddOrOverride = {};
  const groups = event.request?.groupConfiguration?.groupsToOverride;
  if (groups && groups.length) {
    details.claimsToAddOrOverride['cognito:groups'] = groups;
  }
  const tenantId = event.request?.userAttributes?.['custom:tenantId'];
  if (tenantId) {
    details.claimsToAddOrOverride['custom:tenantId'] = tenantId;
  }
  return event;
};
