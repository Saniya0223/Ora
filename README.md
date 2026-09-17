# CampusFlow

A single, current academic action plan from notices, PDFs, and Google Classroom.

**Implemented: Phase 1 foundation only.** The Next.js app shell, four DynamoDB
table definitions, private S3 bucket definition, Lambda health endpoint, and
strict data/Bedrock contracts are ready for verification. Ingestion, scheduling,
OCR, Classroom, and cloud deployment belong to later phases.

The [implementation guide](docs/campusflow-implementation.md) is the source of
truth. [Phase 1 decisions](docs/phase-1-decisions.md) record the approved runtime
update, data conventions, prerequisites, and unresolved contract questions.

## Run locally

Use Node.js 22 (22.16 or newer) and npm. From the repository root:

```powershell
npm.cmd ci
npm.cmd run dev
```

Open http://localhost:3000. On shells without PowerShell's script-execution
restriction, `npm` works in place of `npm.cmd`. No cloud credentials or `.env`
file are needed to view the app shell.

## Verify

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
sam validate --lint --template-file template.yaml --region us-east-1
sam build --template-file template.yaml
```

The region above is only a local validation argument; it does not select a
deployment region or create AWS resources. Tests use Node's built-in test runner
and never call paid services. SAM build packages the Node Lambda without Docker.

Once Docker is running, the packaged health endpoint can also be invoked with:

```powershell
npm.cmd run sam:local
Invoke-RestMethod http://localhost:3001/health
```

Expected response: `{"status":"ok","service":"campusflow"}`. This endpoint
does not verify external service availability.

Phase 1 verification completed on 2026-09-17: all 15 Node tests, TypeScript
checking, the production Next.js build, SAM lint validation and native packaging,
direct invocation of the packaged health handler, and HTTP checks of the
production homepage and compiled stylesheet passed. The corrected lockfile
includes Linux SWC dependencies for Amplify and package integrity hashes; npm
audit reported zero known vulnerabilities. A headless screenshot attempt was
blocked by local browser/GPU restrictions. Docker-based invocation and live AWS
or Google integration were not verified.

## Structure

```text
app/                         Next.js App Router and Tailwind app shell
backend/handlers/health.js   API Gateway/Lambda health handler
backend/lib/contracts.js     DynamoDB item and Bedrock response validation
backend/prompts/             Three unchanged prompt templates from the guide
backend/tests/               Contract and health checks
docs/                        Specification and implementation decisions
template.yaml                SAM API, Lambda, four tables, and private S3 bucket
```

## Configuration and secrets

- `.env.example` contains only the future public API URL. For later frontend
  wiring, copy it to `.env.local` and use the deployed API URL or SAM local URL.
- `backend/.env.example` documents future backend values; it is not automatically
  loaded by Lambda or SAM. SAM environment variables and a gitignored
  `backend/env.local.json` will be wired when the handlers need them.
- Authenticate locally with an AWS profile; use Lambda execution roles in AWS.
  Never put AWS access keys in source files or frontend environment variables.
- Enter Google OAuth secrets only in backend configuration. Never use
  `NEXT_PUBLIC_*` for secrets. Classroom tokens stay in the specified encrypted
  DynamoDB profile item, never browser responses or logs.
- The health function has no DynamoDB, S3, Bedrock, Textract, or Google access.
  Add narrow IAM permissions alongside the relevant handlers in later phases.
- No resources have been deployed. AWS access, region/model selection, Google
  setup, and the Amplify repository connection remain external prerequisites.

Next: Phase 2 implements manual text ingestion and truth resolution.
