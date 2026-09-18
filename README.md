# CampusFlow

CampusFlow consolidates academic notices and a weekly timetable into a current,
prioritized plan for the fixed hackathon user, `demo-user`.

The source specification is [docs/campusflow-implementation.md](docs/campusflow-implementation.md).
It defines the schemas, AI contracts, UI direction, and project scope.

## Current implementation

- Next.js dashboard with manual notice entry, current events, daily plan,
  profile setup, and PDF/timetable review UI.
- Strict DynamoDB and provider-neutral AI JSON validation using the exact schema field names
  and prompt files from the implementation guide.
- Manual notice ingestion with deterministic replay protection, update/cancel
  history, and guarded AI truth resolution.
- Deterministic timeline priority scoring, 48-hour collision detection,
  timetable expansion, daily allocation, and validated AI narration.
- Private PDF upload preparation, asynchronous Textract text/table processing,
  and editable timetable confirmation before persistence.
- SAM infrastructure for the API, DynamoDB tables, private S3 bucket, Lambda
  handlers, and the required permissions for the implemented local features.

Google Classroom uses the same truth-resolution path as other sources. Its
external OAuth configuration and live service verification are documented
separately; no AWS resources have been deployed.

## Local checks

Use Node.js 22.16 or later, then run:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
sam validate --lint --template-file template.yaml --region us-east-1
```

The normal test suite uses mocks and does not invoke AWS, Textract, an AI
provider, or Google. An opt-in Ollama live check is documented below.

## Local Ollama AI

Download and run the official [Ollama Windows installer](https://ollama.com/download/windows),
reopen PowerShell, then download the local model:

```powershell
ollama --version
ollama pull qwen3:8b
ollama run qwen3:8b "Reply with exactly: CAMPUSFLOW_OLLAMA_OK"
```

Run CampusFlow's real prompt/contract checks against that model:

```powershell
$env:AI_PROVIDER="ollama"
$env:OLLAMA_BASE_URL="http://localhost:11434"
$env:OLLAMA_MODEL="qwen3:8b"
npm.cmd run test:ollama --workspace @campusflow/backend
```

For the complete local API, SAM runs Lambda code in Docker, so use the supplied
environment file whose Ollama URL is `http://host.docker.internal:11434`:

```powershell
sam build --template-file template.yaml
sam local start-api --region ap-south-1 --port 3001 --env-vars sam.local.ollama.example.json
```

In another PowerShell window:

```powershell
$env:NEXT_PUBLIC_API_BASE_URL="http://localhost:3001"
npm.cmd run dev
```

## Manual configuration and deployment

Follow [docs/manual-setup.md](docs/manual-setup.md) for AWS, Bedrock, Amplify,
and Google Classroom setup, including the required backend OAuth callback URL.
No cloud resources are created by local tests or builds.

## Project layout

```text
app/                         Next.js application
backend/handlers/            Lambda handlers
backend/lib/                 validation, ingestion, scheduling, document logic
backend/prompts/             exact shared AI prompt contracts
backend/tests/               Node test suite
docs/                        source implementation guide and decisions
template.yaml                SAM infrastructure
```
