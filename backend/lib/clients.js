import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { TextractClient } from "@aws-sdk/client-textract";

// The SDK uses the local AWS profile or Lambda execution role. No credentials
// are read from application input, embedded in code, or returned to the browser.
export const db = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }));
export const bedrock = new BedrockRuntimeClient({ maxAttempts: 1 });
export const s3 = new S3Client({ maxAttempts: 2 });
export const textract = new TextractClient({ maxAttempts: 2 });
