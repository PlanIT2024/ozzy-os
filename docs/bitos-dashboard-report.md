# bIT OS dashboard v1

Built on `bitos-dashboard` in `apps/dashboard/` with Vite, React, TypeScript and Supabase. Email/password sessions persist across reloads. Only the dashboard URL and publishable key are used; all access uses existing RLS as the signed-in user. No migrations or server endpoints were added. Protected brain/node/bIT/relay/service/environment files were unchanged.

Includes a remembered per-user workspace picker from memberships; all visible machines with OS, capabilities, status and relative last-seen time; project create/rename/archive; inbox quick-add and five-column task board; modal task editing with project, goal, node, status and due date; read-only executor/Discord thread metadata; pending approvals with “Decide in Discord for now”; and the latest 50 workspace events with time, kind, summary, model and dollar cost converted from cents. Cancelled tasks remain accessible below the board.

Online machines with a heartbeat older than three minutes, missing or invalid are grey/stale. A timer refreshes relative time/freshness every 30 seconds. Dark is the default; the light system preference is respected. Layout becomes one column below 640px. A native modal dialog contains keyboard focus during task editing.

Approvals/events use `tasks!inner(workspace_id)` since those tables have no workspace column. Goals join projects. Nodes intentionally have no workspace filter, showing every node RLS permits. Realtime watches nodes, tasks, approvals and task_events, with a workspace filter for tasks and workspace-scoped refetches for joined tables. Subscriptions are removed on sign-out/workspace change. Late responses are ignored after scope changes. Errors are visible and Refresh provides manual recovery. RLS governs write permission, including viewer accounts.

## Exact versions and publish dates

Verified with `npm view <package> time --json` on 2026-10-12. All selected releases predate 2026-09-28. The lockfile fixes transitive resolution. `.npmrc` enables the legacy peer resolver to avoid npm 10.9.8's optional-peer resolution crash; normal `npm ci` uses it too.

| Package | Exact version | Published (UTC) |
| --- | --- | --- |
| react | 19.3.0 | 2026-09-09T17:21:30.071Z |
| react-dom | 19.3.0 | 2026-09-09T17:17:39.744Z |
| @supabase/supabase-js | 2.117.2 | 2026-09-25T10:08:51.684Z |
| @types/react | 19.3.0 | 2026-09-09T18:08:49.750Z |
| @types/react-dom | 19.3.0 | 2026-09-09T18:07:51.886Z |
| typescript | 5.9.3 | 2025-09-30T21:19:38.784Z |
| vite | 7.3.6 | 2026-06-25T01:51:49.605Z |
| vitest | 4.1.11 | 2026-08-18T14:27:07.240Z |

Supabase is pinned to 2.117.2, matching the brain. The scanner recursively checks every output file after build. It rejects `sb_secret_[A-Za-z0-9_-]{16,}`, JWTs beginning with `eyJ` whose decoded payload has `role: "service_role"` (including an empty signature), and the literal `SUPABASE_SERVICE_ROLE_KEY`. Bare SDK prefix strings and bare role text are allowed; no bundle rewriting is used. `.env.local` and `dist/` are ignored; the placeholder `.env.example` is tracked.

## Validation

- Dashboard `npm test`: 2 files, 8 tests passed, no network. Covers online/stale/offline/sleeping, missing/invalid heartbeats, the three-minute boundary, all task columns, cancelled exclusion, quick-add payload, read-only approvals, and recursive planted-secret detection with CLI failure for all three secret types, the 16-character suffix boundary, unsigned service-role JWTs, and acceptance of SDK prefix validation, public JWTs and malformed token-like text.
- Dashboard `npm run build`: TypeScript, Vite production bundle and strict credential scan passed.
- Root `npm test`: 153 tests passed. Existing subprocess/socket fixtures required execution outside the restricted sandbox.
- `node --check apps/dashboard/scripts/rls-smoke.mjs`: passed.
- Dev server: started on port 5173 and returned HTTP 200 at http://127.0.0.1:5173/; Vite printed only a Local URL and no Network address.
- Browser interaction and live Supabase RLS checks were not run. The owner runs the live smoke test below.

## Dev server

From the repository root (validated with Node 22.23.1):

```bash
cd apps/dashboard
npm ci
cp .env.example .env.local
```

Edit `apps/dashboard/.env.local` with your Supabase project URL and publishable key. Then, from `apps/dashboard`:

```bash
npm run dev
```

Open **http://127.0.0.1:5173** (localhost on machines resolving it to IPv4). Both Vite `server.host` and `preview.host` are `127.0.0.1`; the dev command has no host override and uses strict port 5173. The server is accessible only from the host machine. Sign in with your existing Supabase email/password.

## Live RLS smoke test

After configuring `.env.local`, from the repository root:

```bash
cd apps/dashboard
npm run rls-smoke
```

Use an interactive terminal. Enter your email and password (hidden) at the prompts; credentials are not saved and tokens are never printed. Multiple writable memberships trigger a workspace selection prompt.

The script checks anonymous nodes/tasks/workspaces each return zero rows; authenticates; checks OZZY-AI visibility; inserts a typed inbox task; requires RLS error code 42501 for task_events/approvals insert attempts; and deletes the test task in a finally block. It prints a PASS/FAIL table and exits nonzero on failure. Unexpected successful child inserts are removed by task cascade. If cleanup fails, remove the “Dashboard RLS smoke test” task manually. Authentication/connectivity failures fail the run instead of counting as policy success.

## npm audit (follow-up, 2026-10-12)

`cd apps/dashboard && npm audit --json` reports **1 low**, **0 moderate**, **0 high**, **0 critical** vulnerabilities; it exits 1 because a finding is present. The affected transitive development dependency is `esbuild` 0.27.7. Advisory [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr), “esbuild allows arbitrary file read when running the development server on Windows,” covers `>=0.27.3 <0.28.1`. npm reports a fix is available. No audit fixes were applied.
