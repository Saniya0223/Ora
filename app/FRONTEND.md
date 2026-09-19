# CampusFlow frontend

Four App Router screens use `NEXT_PUBLIC_API_BASE_URL`: Dashboard `/`, Tasks
`/tasks`, Planner `/planner`, and Add & Setup `/setup`. The API contract in
`docs/frontend-backend-contract.md` remains the authority. There are no mocked
product records or direct AI-provider calls in these screens.

## Run and check

Set `NEXT_PUBLIC_API_BASE_URL` in the existing frontend `.env.local`, or set it
only for the PowerShell process before starting Next.js. It must point to a
running backend that implements the contract and allows `http://localhost:3000`.

```powershell
npm.cmd run dev -- --port 3000
npm.cmd run test:frontend
npm.cmd run typecheck
npm.cmd run build
git diff --check
```

The backend checkpoint, backend tests, SAM template, infrastructure, providers,
and contract are not modified. `package.json` adds only `test:frontend`.
No new application dependency is required. Browser review tooling and screenshots
are isolated in ignored `.cache/frontend-browser` and `.cache/ui-review`.

## Behavior

- Task filtering/search and counts come from `/tasks`; selected IDs are in the URL.
- Source-managed task fields are disabled. Unknown estimates remain unknown.
- Task mutations refresh backend data. Progress and focus credits come from the server.
- The focus dock survives route navigation, restores from `/focus-sessions/active`,
  excludes paused time, and calls completion when the countdown reaches zero.
  A failed automatic completion can be retried using Finish; it does not fabricate credits.
- Planner blocks are rendered as returned, split visually across day boundaries,
  and arranged into columns when they overlap. No authoritative scheduling runs
  in the frontend. Capacity, unsized work, and deferred work remain visible.
- Partial Classroom synchronization is labelled separately from full success.
- Timetable imports require explicit review and confirmation. Existing slot IDs
  survive edits and whole-timetable saves. PDF processing can be checked again
  after the initial polling window instead of uploading the file again.
- Attachment uploads use the documented prepare / multipart upload / confirm flow.
- Profile editing is available in Add & Setup; there is no invented authentication.

## Live verification and limitations (2026-09-19)

The existing deployed API was used for browser integration testing because Docker
was not running for the configured local SAM API. This was a process environment
override; `.env.local` was not edited. The dev server's link is localhost:3000.

Verified with real responses: profile/dashboard/source status, real Classroom task
display, server task filters/search, manual task create/edit/complete/reopen/delete,
bookmarks, checklist, notes, attachment upload and signed download, focus
start/pause/resume/reload/finish/cancel, persisted study-time credits and idempotent
completion, planner day/week/study blocks/capacity warnings/ICS, preferences
load/save, course listing, manual Classroom sync, and pasted notice processing.
Temporary manual tasks and their attachments were deleted after verification.
Original Classroom task records were not edited by test controls.

The live timetable is empty. Next-class and class rendering have empty-state and
presentation-helper coverage, but a real timetable PDF import and save were not
live-verified. No placeholder classes are inserted into the product.

PDF upload preparation and the signed storage upload succeeded. The next call,
`POST /ingest` with `{ s3Key }`, consistently returned HTTP 503
`SERVICE_UNAVAILABLE`, before issuing a document job. Pasted-text `/ingest`
returned the expected IGNORE result. This backend service failure is displayed
in the frontend; no backend repair was attempted.

There is no configured lint script. Use the frontend unit tests, TypeScript,
production build, and browser checks. Regular `npm test` still targets backend
tests and is intentionally not part of this frontend-only validation.
