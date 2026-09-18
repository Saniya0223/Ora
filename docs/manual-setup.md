# Manual setup and deployment

## Prerequisites

Install Node.js 22.16 or newer, npm, AWS CLI, and AWS SAM CLI. Authenticate an
AWS profile that can deploy CloudFormation, Lambda, API Gateway, DynamoDB, S3,
IAM roles, and EventBridge Scheduler in the target region.

```powershell
aws sts get-caller-identity --region <aws-region>
npm.cmd ci
```

## Local AI with Ollama

Ollama is the free local provider. On Windows, download and run the official
[Ollama installer](https://ollama.com/download/windows) (`OllamaSetup.exe`),
reopen PowerShell, and then run:

```powershell
ollama --version
ollama pull qwen3:8b
ollama run qwen3:8b "Reply with exactly: CAMPUSFLOW_OLLAMA_OK"
$env:AI_PROVIDER="ollama"
$env:OLLAMA_BASE_URL="http://localhost:11434"
$env:OLLAMA_MODEL="qwen3:8b"
npm.cmd run test:ollama --workspace @campusflow/backend
```

The live check exercises CREATE, UPDATE, CANCEL, ambiguous-notice handling, JSON
contract validation, and planner narration with the real model. Ollama is local
only. `sam.local.ollama.example.json` uses Docker's Windows host name so SAM
containers can reach the host process. Production Lambda uses `bedrock`; it
cannot select laptop Ollama.

Provider configuration is explicit:

- `AI_PROVIDER=ollama` uses `OLLAMA_BASE_URL` and `OLLAMA_MODEL`.
- `AI_PROVIDER=bedrock` uses `BEDROCK_MODEL_ID` and the existing Converse API.

The current Bedrock deployment uses Amazon Nova Pro (`amazon.nova-pro-v1:0`). In `ap-south-1`, AWS
requires the APAC system inference profile, so `BedrockModelId` is
`apac.amazon.nova-pro-v1:0`. `BedrockInvokeArns` must include the account's APAC
inference profile ARN and the Nova Pro foundation model ARN in every destination
region listed by that profile. This is the Lambda IAM allow-list. Do not place
AWS keys or any secret in a frontend variable.

## Amplify

1. Connect this repository and the production branch in AWS Amplify.
2. Select a build image that uses Node.js 22.
3. Deploy once using [amplify.yml](../amplify.yml) and copy the HTTPS branch
   URL, such as `https://main.example.amplifyapp.com`.
4. After SAM outputs the API URL, set Amplify environment variable
   `NEXT_PUBLIC_API_BASE_URL` to that URL and redeploy the frontend.

Use the exact HTTPS branch URL without a trailing slash for the SAM
`FrontendOrigin` parameter. It controls API Gateway CORS, direct S3 upload
CORS, and the post-OAuth redirect.

## Initial SAM deployment

Copy [samconfig.example.toml](../samconfig.example.toml) to `samconfig.toml`
if desired; it is ignored by Git. Deploy with Google values blank first. This
does not create the Classroom scheduler.

```powershell
$env:npm_config_cache = "$PWD\.cache\npm"
sam build --template-file template.yaml
sam deploy --guided --template-file template.yaml
```

At the guided prompts, supply the Amplify URL as `FrontendOrigin`, select
`AIProvider=bedrock`, provide the Bedrock ID and ARN allow-list, and optionally
set `DailyStudyHours` (default `4`). Save the
`ApiBaseUrl` stack output and verify it:

```powershell
Invoke-RestMethod <ApiBaseUrl>/health
```

## Google Classroom OAuth

Create a Google Cloud project, enable Google Classroom API, configure the OAuth
consent screen as **Testing**, and add each demo account as a test user. Create
**Web application** credentials and add this authorized redirect URI:

```text
<ApiBaseUrl>/classroom/callback
```

The source guide refers to the frontend URL here, but the backend callback is
required because it receives and exchanges Google’s authorization code. This is
a technical implementation correction, not a schema or architecture change.

Set these SAM parameters on a second deployment:

- `GoogleClientId`
- `GoogleClientSecret`
- `GoogleRedirectUri` set to the exact callback URL above
- `OAuthStateSecret`, an independent random secret of at least 32 characters

Once all four values are set, the stack creates the 15-minute EventBridge
Scheduler. In CampusFlow, save the profile, connect Google Classroom, grant the
requested read-only scopes, and choose courses to sync. Tokens are stored only
in the encrypted-at-rest DynamoDB profile item and never returned to the UI.

## PDF imports

The upload bucket is private. The browser receives a five-minute presigned POST
for one `demo-user/uploads/<uuid>.pdf` object, limited to 10 MB. Its CORS origin
must equal the deployed Amplify URL. Notice PDFs go through Textract text
detection and normal ingestion. Timetable PDFs use Textract TABLES and Prompt 3;
the parsed rows remain editable until the student explicitly saves them.

## Limits

- PDFs are limited to 20 pages and 10 MB.
- Notice text is limited to 12,000 extracted characters.
- The demo has one hardcoded user and no browser authentication.
- Prompt 1 requires `eventDetails` even for `IGNORE` and `CANCEL`; invalid model
  output is rejected rather than guessed.
