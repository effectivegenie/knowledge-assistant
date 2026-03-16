import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { Construct } from 'constructs';

export interface MonitoringProps {
  // Key Lambda functions to monitor for errors
  chatFn: lambda.Function;
  invoicesFn: lambda.Function;
  contractsFn: lambda.Function;
  invoiceProcessorFn: lambda.Function;
  contractProcessorFn: lambda.Function;
  // HTTP API for 5xx monitoring
  httpApi: apigwv2.CfnApi;
}

export class MonitoringConstruct extends Construct {
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);

    const { chatFn, invoicesFn, contractsFn, invoiceProcessorFn, contractProcessorFn, httpApi } = props;

    // ── Lambda error alarms ───────────────────────────────────────────────────
    const lambdaAlarms: cloudwatch.Alarm[] = [];

    const criticalFunctions: [string, lambda.Function][] = [
      ['Chat', chatFn],
      ['Invoices', invoicesFn],
      ['Contracts', contractsFn],
      ['InvoiceProcessor', invoiceProcessorFn],
      ['ContractProcessor', contractProcessorFn],
    ];

    for (const [name, fn] of criticalFunctions) {
      const alarm = new cloudwatch.Alarm(this, `${name}ErrorAlarm`, {
        alarmName: `knowledge-assistant-${name.toLowerCase()}-errors`,
        alarmDescription: `Lambda ${name} has errors`,
        metric: fn.metricErrors({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      lambdaAlarms.push(alarm);
    }

    // ── API Gateway 5xx alarm ─────────────────────────────────────────────────
    const apiErrorAlarm = new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      alarmName: 'knowledge-assistant-api-5xx',
      alarmDescription: 'HTTP API returning 5xx errors',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5XXError',
        dimensionsMap: { ApiId: httpApi.ref },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ── Dashboard ─────────────────────────────────────────────────────────────
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'KnowledgeAssistant',
    });

    this.dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'Alarm Status',
        alarms: [...lambdaAlarms, apiErrorAlarm],
        width: 24,
        height: 4,
      }),
      ...criticalFunctions.map(([name, fn]) =>
        new cloudwatch.GraphWidget({
          title: `${name} — Invocations / Errors`,
          left: [fn.metricInvocations({ period: cdk.Duration.minutes(5) })],
          right: [fn.metricErrors({ period: cdk.Duration.minutes(5) })],
          width: 8,
          height: 6,
        })
      ),
      new cloudwatch.GraphWidget({
        title: 'API Gateway — 4xx / 5xx',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '4XXError',
            dimensionsMap: { ApiId: httpApi.ref },
            period: cdk.Duration.minutes(5),
            statistic: 'Sum',
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '5XXError',
            dimensionsMap: { ApiId: httpApi.ref },
            period: cdk.Duration.minutes(5),
            statistic: 'Sum',
          }),
        ],
        width: 8,
        height: 6,
      }),
    );
  }
}
