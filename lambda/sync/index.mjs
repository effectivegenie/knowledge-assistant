import { BedrockAgentClient, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent';

const client = new BedrockAgentClient({});

const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID;
const DATA_SOURCE_ID = process.env.DATA_SOURCE_ID;

export const handler = async (event) => {
  console.log('Received S3 event for KB sync:', JSON.stringify(event));

  if (!KNOWLEDGE_BASE_ID || !DATA_SOURCE_ID) {
    console.error('KNOWLEDGE_BASE_ID or DATA_SOURCE_ID is not set');
    return;
  }

  try {
    await client.send(new StartIngestionJobCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      dataSourceId: DATA_SOURCE_ID,
    }));

    console.log('Started ingestion job for knowledge base:', KNOWLEDGE_BASE_ID);
  } catch (err) {
    console.error('Failed to start ingestion job:', err);
    throw err;
  }
};

