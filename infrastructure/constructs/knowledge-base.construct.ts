import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { bedrock, s3vectors } from '@cdklabs/generative-ai-cdk-constructs';
import { Construct } from 'constructs';

export interface KnowledgeBaseProps {
  docsBucket: s3.Bucket;
}

export class KnowledgeBaseConstruct extends Construct {
  public readonly knowledgeBase: bedrock.VectorKnowledgeBase;
  public readonly docsDataSource: bedrock.S3DataSource;

  constructor(scope: Construct, id: string, props: KnowledgeBaseProps) {
    super(scope, id);

    const embeddingsModel = bedrock.BedrockFoundationModel.TITAN_EMBED_TEXT_V2_1024;

    const vectorBucket = new s3vectors.VectorBucket(this, 'VectorBucket');
    const vectorIndex = new s3vectors.VectorIndex(this, 'VectorIndex', {
      vectorBucket,
      dimension: embeddingsModel.vectorDimensions!,
      nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT'],
    });

    this.knowledgeBase = new bedrock.VectorKnowledgeBase(this, 'KnowledgeBase', {
      embeddingsModel,
      vectorStore: vectorIndex,
      instruction: 'Use this knowledge base to answer questions based on the uploaded documents.',
    });

    // Grant KB execution role permission to delete vectors (required for data source deletion)
    this.knowledgeBase.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3vectors:DeleteVectors', 's3vectors:ListVectors'],
      resources: [vectorIndex.vectorIndexArn],
    }));

    this.docsDataSource = new bedrock.S3DataSource(this, 'DocsDataSource', {
      bucket: props.docsBucket,
      knowledgeBase: this.knowledgeBase,
      dataSourceName: 'documents',
    });
  }
}
