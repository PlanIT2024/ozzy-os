# Phase 1 implementation report

Phase 1 implementation is complete on `bitos-supabase-sync`. Live proof is
deliberately deferred until the user switches the installed checkout. SQL
migrations have not been applied; installed units and secrets were not edited.

Implementation commits:

- `8c29dee`: migrations 0002 and 0003.
- `e3e0899`: mirror module, lifecycle hooks, startup scrubbing, service template,
  dependency pin and offline tests.

## Files and behavior

- `docs/bitos-sync-map.md`: inventory committed before code (`afc35f9`).
  Supplied migration `0001_bit_os_core.sql` was committed separately
  (`a586bbf`) before implementation. Migration 0002 is exactly the requested
  four statements. Migration 0003 adds replay-safe event IDs and preserves the
  existing lease trigger with an early return for previously inserted IDs.
  No JavaScript applies migrations.
- `src/bitos/client.js`: exact flag gate, lazy brain-only client creation,
  disabled auth persistence/refresh, five-second fetch timeout.
- `src/bitos/outbox.js`: private JSONL in `<root>/data`, 5,000 entry cap,
  oldest-drop warning once per process, asynchronous/coalesced atomic disk
  snapshots, startup replay, persisted retry state and exponential backoff
  from one second to five minutes. Entries persist during slow network calls.
- `src/bitos/redact.js`: reuses Transcript.safeText; removes environment
  credentials, token patterns, environment assignments, file/command/output
  contents and image bytes. Typed actions retain only length.
- `src/bitos/sync.js`: startup captures settings into a private frozen snapshot
  and deletes all SUPABASE_ and BITOS_ names from process.env and the supplied
  environment before downstream construction/imports. Public methods are
  fire-and-forget, with stable deterministic
  owner/relay node UUIDs recorded in `data/bitos-node-ids.json`, stable task
  UUIDs per workspace/conversation. Owner-offline startup reset follows old
  replay and precedes new connections. Heartbeats throttle to 60 seconds;
  a one-second sweep marks nodes offline after 90 seconds without messages.
- `src/brain/index.js`, `nodeHub.js`, `runner.js`, `discord.js`, `screens.js`,
  `controls.js`, `permissions.js`: additive lifecycle calls for connects,
  disconnects, task statuses, owner requests/buttons, grants, dispatched input,
  screenshots and model/tool outcomes. Relay, encryption and node code unchanged.
- `deploy/systemd/bit-brain.service`: optional `.env.brain` after `.env`.
  Node template unchanged. `.gitignore` explicitly ignores `.env.brain`,
  retains `.env.*`, and permits `.env.example`.
- `package.json`, `package-lock.json`: exact Supabase dependency pin.
- `test/bitos-foundation.test.js`, `test/bitos-integration.test.js`: offline
  fake-client tests, schema column checks and service/credential isolation.

Tasks use executor bit, source typed, configured workspace/owner UUIDs,
external_ref.discord_thread_id and node IDs when targeted. Statuses map to
running, waiting_on_you, done or cancelled; failure reasons/types are events.
Approvals use pending/approved/denied/expired. All six risk enums are accepted;
unknown/low/medium map to risky, high/critical to destructive. Current ordinary
cards use risky. Approval reads/subscriptions do not exist.

Screen leases use watch and the existing 15-minute expiry; control leases use
control and the existing locally computed expiry (up to 10 minutes). Different
overlapping leases rejected by the database trigger are logged and dropped
without changing local grants. Ends update revoked_at/revoked_reason.
Screenshot paths remain null; no upload exists. Events retain local lease IDs
inside payloads rather than an FK that could reference a rejected insertion.

Individual SDK assistant message IDs are logged as model calls when supplied.
Aggregate run cost is recorded once, as a note when individual calls exist,
otherwise on the run model-call row. Unknown individual costs are zero.
Prompts, responses and tool results are never mirrored. Bash is disabled in
this repo; there is no actual shell executor to hook.

## Migration 0003 and replay behavior

The RPC proposal was deleted. No RPC or extra receipt table is used.
`0003_replay_safe_writes.sql` contains exactly:

```sql
alter table task_events add column client_event_id uuid;
create unique index on task_events (client_event_id);

create or replace function enforce_one_active_lease() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from leases where id = new.id) then
    return new;
  end if;

  if exists (
    select 1 from leases l
    where l.node_id = new.node_id and l.revoked_at is null and l.expires_at > now()
  ) then
    raise exception 'Node % already has an active lease', new.node_id;
  end if;
  return new;
end $$;
```

Events generate a UUID client_event_id when queued, persist it in JSONL, and
upsert with `{ onConflict: 'client_event_id', ignoreDuplicates: true }`.
Database-generated bigint IDs remain untouched. Lease IDs are generated when
queued (or reuse the existing local grant UUID) and upsert with
`{ onConflict: 'id', ignoreDuplicates: true }`. Same-ID replays bypass the
active-lease check and then do nothing on the PK conflict; different overlapping
leases still hit the original check. Model cost is included in the final run
event before insertion, because immutable replay writes do not update events.

Tests simulate a database commit followed by a lost response, persist the
pending entry, restart, and replay. Each event and lease has exactly one row;
replay produces no database error. Existing distinct active-lease conflicts
continue to log and leave local behavior unchanged.

## SDK environment finding and startup scrubbing

The installed Claude Agent SDK is pinned to 0.3.284. **It does not merge
process.env into a supplied options.env.** When env is omitted it defaults to
process.env. The relevant local SDK source is:

- [sdk.mjs line 152](../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs#L152):
  query builds `yt=k?{...k}:{...process.env}` and passes `env:yt` to transport.
- [sdk.mjs line 146](../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs#L146):
  ProcessTransport defaults `env:c={...process.env}`, builds
  `Ft={command:Rt,args:bt,cwd:o,env:c,...}`, and its spawnLocalProcess forwards
  `env:o` directly to child_process.spawn. There is no spread of process.env
  over a supplied environment.

The brain captures its configuration once in `startBrainSync`, retains the
snapshot only in the mirror module for lazy client creation/retries and
credential redaction, then deletes every SUPABASE_ and BITOS_ name from
process.env and the supplied startup env. Discord and Runner/SDK imports now
occur after scrubbing. The runner's existing child-env allowlist is retained.
Thus even other brain subprocesses which inherit process.env cannot inherit
these settings.

The integration test exercises `runBrain` with fake settings, counts exactly
one read of each setting, verifies the captured values still reach lazy client
creation, and uses the real SDK ProcessTransport/spawnClaudeCodeProcess hook
with a real Node child. It asserts both the SDK's spawn environment and the
child's process.env contain zero SUPABASE_/BITOS_ names. The child exits before
any model network request. Real secrets are never used in this test.

## Dependency age and audit

Executed:

```sh
npm view @supabase/supabase-js time --json
npm audit --json
```

Newest stable non-canary/non-beta 2.x release at least 14 days before
2026-10-12: **2.117.2**, published **2026-09-25T10:08:51.684Z**. The exact pin
is retained. Version 2.117.3, published October 7, is too young.

Audit reports one high finding in transitive @modelcontextprotocol/sdk:
GHSA-6qxp-vccf-f47h, OAuth credentials could be sent to an authorization server
chosen by an MCP server; affected range >=1.12.0 <1.31.0, fix available.
No audit fix or forced/unrelated dependency upgrade was performed.

## Validation

`npm test`: **150 passed, zero failed**, including restart replay and real
SDK child-environment tests.
Final `git status --short` is empty after committing the implementation and
report; the branch has no untracked or modified files.
Tests cover flag unset/0 through Runner plus a Discord owner button; zero
client creation/calls; hello/throttled heartbeat/disconnect; restart node UUIDs;
90-second offline expiry; approval request/decision; thrown database errors
isolated from actual interaction handlers; exact schema columns; statuses/costs;
failure reason events; lease conflict/replay; redaction; durable retry/backoff
and bounded-cap warnings; disk persistence during a hung network request;
and brain/node service isolation. No test calls Supabase.

Executed, with no forbidden-reference matches or whitespace errors:

```sh
rg -n 'SUPABASE_SERVICE_ROLE_KEY|@supabase/supabase-js' src/node src/transport relay
git diff --check
```

No migration, real Discord task or service restart was performed. Existing
SDK tests use local API fixtures.
Database replay tests use a fake Supabase client; the migrations themselves
have not been executed against PostgreSQL in this phase.

## Exact manual SQL Editor steps

After switching the installed checkout to this branch, inspect the files:

```sh
cd ~/ozzy-os
cat supabase/migrations/0002_executor_and_refs.sql
cat supabase/migrations/0003_replay_safe_writes.sql
```

In Supabase Dashboard → SQL Editor → New query, with 0001 already applied,
paste and run these exact 0002 commands first:

```sql
create type task_executor as enum ('bit','claude_code','codex','cowork');
alter table tasks add column executor task_executor not null default 'bit';
alter table tasks add column external_ref jsonb not null default '{}';
create index on tasks ((external_ref->>'discord_thread_id'));
```

Open another query, paste and run the exact 0003 SQL block shown above.
Run each migration once. Do not run migrations from the brain or paste
service-role keys into SQL Editor. This phase needs existing profile and
workspace UUIDs for BITOS_OWNER_USER_ID and BITOS_DEFAULT_WORKSPACE_ID.

## Manual installed-unit update after switching the main checkout

Supabase settings remain exclusively in ~/ozzy-os/.env.brain, mode 600:
BITOS_SUPABASE, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
BITOS_OWNER_USER_ID, BITOS_DEFAULT_WORKSPACE_ID. Do not put values into the
shared .env, node unit or relay configuration. Owner/workspace UUIDs must
already exist in profiles/workspaces. The SDK child environment remains the
existing explicit allowlist, excluding Supabase settings.

The user should run these manual steps; review custom installed-unit changes
before copying:

```sh
cd ~/ozzy-os
chmod 600 .env.brain
cp deploy/systemd/bit-brain.service ~/.config/systemd/user/bit-brain.service
systemctl --user daemon-reload
systemctl --user cat bit-brain bit-node
```

The node template loads only .env; brain loads .env followed by optional
.env.brain. Apply SQL migrations manually in Supabase SQL Editor in order,
0001, then 0002, then 0003. Installed units target ~/ozzy-os, not this
worktree; no installed unit was edited here.

## Deferred live proof

Run after switching ~/ozzy-os to this branch, applying 0001/0002/0003,
and updating the brain unit above:

```sh
systemctl --user restart bit-brain bit-node
systemctl --user stop bit-node
# Check OZZY-AI becomes offline within 90 seconds in Table Editor.
systemctl --user start bit-node
# Set SUPABASE_URL=https://bitos-outage.invalid in .env.brain.
systemctl --user restart bit-brain
# Run an owner-approved Discord task; check normal flow and growing outbox.
wc -l ~/ozzy-os/data/bitos-outbox.jsonl
# Restore the valid SUPABASE_URL in .env.brain.
systemctl --user restart bit-brain
wc -l ~/ozzy-os/data/bitos-outbox.jsonl
rg -n 'SUPABASE_SERVICE_ROLE_KEY|@supabase/supabase-js' src/node src/transport relay
```

Table Editor proof must show OZZY-AI online, one small task with an owner
button, tasks/approvals/task_events summaries, offline transition and outbox
growth/drain. No live rows are claimed yet. Do not paste secrets, typed text,
screenshot pixels or file contents into proof output.
