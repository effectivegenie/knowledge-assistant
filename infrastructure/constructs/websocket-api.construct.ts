import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface WebSocketApiProps {
  connectFn: lambda.Function;
  disconnectFn: lambda.Function;
  chatFn: lambda.Function;
  historyFn: lambda.Function;
}

export class WebSocketApiConstruct extends Construct {
  public readonly wsUrl: string;

  constructor(scope: Construct, id: string, props: WebSocketApiProps) {
    super(scope, id);

    const { connectFn, disconnectFn, chatFn, historyFn } = props;
    const stack = cdk.Stack.of(this);

    const wsApi = new apigwv2.CfnApi(this, 'Api', {
      name: 'KnowledgeAssistantChat',
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    });

    const makeIntegration = (fn: lambda.Function, suffix: string) =>
      new apigwv2.CfnIntegration(this, `${suffix}Integration`, {
        apiId: wsApi.ref,
        integrationType: 'AWS_PROXY',
        integrationUri: `arn:aws:apigateway:${stack.region}:lambda:path/2015-03-31/functions/${fn.functionArn}/invocations`,
      });

    const connectInt = makeIntegration(connectFn, 'Connect');
    const disconnectInt = makeIntegration(disconnectFn, 'Disconnect');
    const chatInt = makeIntegration(chatFn, 'Chat');
    const historyInt = makeIntegration(historyFn, 'History');

    const connectRoute = new apigwv2.CfnRoute(this, 'ConnectRoute', {
      apiId: wsApi.ref, routeKey: '$connect', authorizationType: 'NONE',
      target: `integrations/${connectInt.ref}`,
    });
    const disconnectRoute = new apigwv2.CfnRoute(this, 'DisconnectRoute', {
      apiId: wsApi.ref, routeKey: '$disconnect',
      target: `integrations/${disconnectInt.ref}`,
    });
    const sendMessageRoute = new apigwv2.CfnRoute(this, 'SendMessageRoute', {
      apiId: wsApi.ref, routeKey: 'sendMessage',
      target: `integrations/${chatInt.ref}`,
    });
    const historyRoute = new apigwv2.CfnRoute(this, 'HistoryRoute', {
      apiId: wsApi.ref, routeKey: 'history',
      target: `integrations/${historyInt.ref}`,
    });
    const clearHistoryRoute = new apigwv2.CfnRoute(this, 'ClearHistoryRoute', {
      apiId: wsApi.ref, routeKey: 'clear_history',
      target: `integrations/${historyInt.ref}`,
    });

    const deployment = new apigwv2.CfnDeployment(this, 'Deployment', { apiId: wsApi.ref });
    deployment.node.addDependency(connectRoute, disconnectRoute, sendMessageRoute, historyRoute, clearHistoryRoute);

    const stage = new apigwv2.CfnStage(this, 'Stage', {
      apiId: wsApi.ref, stageName: 'prod', deploymentId: deployment.ref,
    });

    const apigwPrincipal = new iam.ServicePrincipal('apigateway.amazonaws.com');
    connectFn.addPermission('ApiGwConnect', { principal: apigwPrincipal,
      sourceArn: `arn:aws:execute-api:${stack.region}:${stack.account}:${wsApi.ref}/*/$connect` });
    disconnectFn.addPermission('ApiGwDisconnect', { principal: apigwPrincipal,
      sourceArn: `arn:aws:execute-api:${stack.region}:${stack.account}:${wsApi.ref}/*/$disconnect` });
    chatFn.addPermission('ApiGwChat', { principal: apigwPrincipal,
      sourceArn: `arn:aws:execute-api:${stack.region}:${stack.account}:${wsApi.ref}/*/sendMessage` });
    historyFn.addPermission('ApiGwHistory', { principal: apigwPrincipal,
      sourceArn: `arn:aws:execute-api:${stack.region}:${stack.account}:${wsApi.ref}/*/history` });
    historyFn.addPermission('ApiGwClearHistory', { principal: apigwPrincipal,
      sourceArn: `arn:aws:execute-api:${stack.region}:${stack.account}:${wsApi.ref}/*/clear_history` });

    const wsConnPolicy = new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [`arn:aws:execute-api:${stack.region}:${stack.account}:${wsApi.ref}/prod/*`],
    });
    chatFn.addToRolePolicy(wsConnPolicy);
    historyFn.addToRolePolicy(wsConnPolicy);

    this.wsUrl = `wss://${wsApi.ref}.execute-api.${stack.region}.amazonaws.com/prod`;
  }
}
