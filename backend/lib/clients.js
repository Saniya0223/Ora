import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// The SDK uses the local AWS profile or Lambda execution role. No credentials
// are read from application input, embedded in code, or returned to the browser.
export const db = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }));
export const bedrock = new BedrockRuntimeClient({ maxAttempts: 1 });
