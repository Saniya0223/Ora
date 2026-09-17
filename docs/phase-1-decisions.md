# Phase 1 decisions and remaining questions

The original guide was read completely before work began. Its repository copy is
[campusflow-implementation.md](campusflow-implementation.md). The original file in
Downloads was not modified. The user authorized Phase 1 after reviewing the
preparation plan, including the recommended Node.js 22 runtime.

## Foundation choices

- Lambda runtime: Node.js 22. This replaces the guide's deprecated Node.js 20.
- Frontend: Next.js 15.5.24 (Amplify-supported major), React 19.1.9, Tailwind 4.
- Next.js's transitive PostCSS is overridden to 8.5.28 to resolve the advisories
  reported by npm audit without moving to an Amplify-unsupported Next.js major.
- Frontend uses TypeScript; Lambda files use native JavaScript ES modules. No
  backend transpilation or generic service layer is needed.
- One npm workspace and lockfile. The backend has its own package manifest so
  SAM can package it independently without shipping frontend dependencies.
- The three prompt files are verbatim copies of section 8. Tests detect drift.
- DynamoDB logical and physical table names and partition/sort keys match the
  guide. Only key attributes are declared in SAM: DynamoDB does not enforce other
  item fields, so the application validators define those fields.
- The only implemented API is `GET /health`. It is a liveness check, not a check
  of AWS credentials, Bedrock access, database contents, or Google authorization.
- The frontend is an empty app shell. Its empty states are static; it does not
  fetch data or claim to have connected integrations yet.
- No business handler, AWS client, Scheduler, OAuth flow, or deployment is
  created prematurely. Add each alongside the feature that uses it.

## Data conventions within the existing shapes

- The demo application will use `demo-user`; the schemas retain String user IDs.
- `classroomTokens` is absent until OAuth connects the account. When present,
  all three specified fields are required; `expiresAt` is Unix epoch milliseconds,
  matching the Google SDK's expiry-date convention. Never return this map to the
  frontend or include it in logs.
- Timetable slots are same-day intervals with `endTime > startTime`. Their
  `Tutorial` type remains distinct from the AcademicEvents type enumeration.
- Prompt 1 keeps its exact local `YYYY-MM-DDTHH:mm` format. The stored event
  schema accepts ISO datetimes with or without an offset as allowed by the guide.
  Sync checkpoints require absolute timestamps. Use Asia/Kolkata for the demo's
  local time interpretation when implementing ingestion and scheduling.
- Hours must be finite and nonnegative. Do not cap `priorityScore` at 1: the
  guide's urgency expression can exceed 1 for an overdue event.
- Strict model validators reject extra fields, type coercion, markdown fences,
  and malformed dates. They do not invent missing information or repair model
  output silently. Application code must still check event existence and ownership.

## Resolve when implementing the relevant phase

1. **Truth resolution:** Prompt 1 returns one action, and still requires the full
   `eventDetails` object for IGNORE and CANCEL. It cannot directly describe a
   multi-event document or an unknown deadline. Preserve the contract until an
   explicit resolution is agreed; never fabricate a date to pass validation.
   Also settle matching beyond the 14-day ACTIVE lookup, replay handling, and
   how profile program/year/section are supplied for applicability filtering.
2. **Scheduling:** Prompt 2 has `allocateHours`, but ScheduleBlocks requires
   `allocatedHours` plus `eventId`. An hours-field adapter is straightforward;
   stable event identity must stay owned by code, not guessed from narrative
   text. Keep code-computed allocations authoritative and agree on a daily
   study-capacity default. No mapping or allocation algorithm is implemented yet.
3. **Timetable:** the guide describes both saving first and confirming before
   saving. Implement preview/edit followed by an explicit save once this phase
   begins. Do not persist uncertain rows as the confirmed timetable.
4. **PDFs:** multipage Textract processing requires an asynchronous job/status
   flow; settle its API behavior before implementing PDF ingestion. Do not
   silently limit the feature to single-page uploads.
5. **Classroom:** configure exact callback URLs, request offline access, handle
   reconnects, paginate, and advance sync checkpoints only after successful
   processing. Account for UTC coursework deadlines. CourseWork IDs are unique
   per course: resolve source identity for coursework and announcements without
   silently changing the guide's `sourceRef` convention.

## External prerequisites

- Authenticate the AWS CLI, select a region, and verify deployment permissions.
- Select an available Claude Sonnet model or inference profile, complete any
  required Anthropic account setup, and verify invocation access.
- Configure Google Cloud and test accounts before Phase 5.
- Docker is installed but its engine was not reachable in this session. It is
  needed for SAM local execution or container builds, not ordinary Node tests.
- Tables and the upload bucket have Retain policies. A future stack deletion
  will preserve them. Exact physical table names mean one such stack per AWS
  account/region unless a future naming change is agreed.

## References checked during preparation

- [Lambda runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html)
- [Amplify Next.js support](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html)
- [Next.js release notes](https://nextjs.org/blog)
- [Textract document limits](https://docs.aws.amazon.com/textract/latest/dg/limits-document.html)
- [Bedrock model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
- [Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
