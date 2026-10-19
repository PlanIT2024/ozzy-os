# Dashboard chat — sections 1–6

Implemented locally; migration 0007 is **prepared, not applied**. No live proof,
service restart, production database write, push, or deployment was performed.
The existing Git-connected Pages project remains the deployment target.

## Migration and security

Apply `supabase/migrations/0007_dashboard_chat.sql` manually only after review.
Then run the read-only queries in `docs/dashboard-chat-verification.sql`.

The migration is transactional and idempotent. It creates owner/workspace-bound
conversations and chat messages, enables RLS, replaces policies on those dedicated
tables, grants narrowly scoped client privileges, adds both tables to Realtime,
and ends with a PostgREST schema reload notification. Composite foreign keys
prevent a message from binding another owner's conversation or workspace.
Clients can insert only owner messages with NULL cards, pending status and
1–8000 characters. They cannot update/delete messages or author bIT cards/replies.
Conversations permit owner title updates only; there is no client delete path.

`agent_runs.started_at` is nullable, without a default or backfill. Client inserts
must leave it NULL. The existing whole-row update guard still permits only the
owner's stop flag transition and rejects forged timestamps, including a timestamp
change combined with Stop. The dispatcher writes the first matching authenticated
node `agent.event kind:started`, using a conditional NULL update; replays preserve
that timestamp. Older rows without a timestamp show no elapsed time.

Task tools use the brain service role, with explicit workspace membership checks:
viewer can list; member/admin/owner can create/update. Queries constrain task and
project workspace, and machines must be owned or shared into the workspace.
Unknown fields and batches over 20 are rejected. `chat_apply_task`, executable
only by the service role, repeats authorization and commits the task mutation
and its chat audit event atomically. Every created task sets created_by to the
owner's auth ID and source to bit. Audit payloads include conversation_id,
owner_id, previous fields and changed fields. A failed audit insert rolls back
the task edit. Updates use an expected timestamp to reject concurrent changes.

The model sees only create_task/update_task/list_tasks. There is no general DB
or approval-decision tool. Approval-named tools and extra decision fields are
denied. Approval buttons still use App's existing session-authenticated handler,
ApprovalCard's node-owner check and five-second command confirmation. Chat text
such as approve/yes/do it never invokes that handler; pending cards are repeated.

## Brain and restart behavior

Enable the new adapter with `BITOS_DASHBOARD_CHAT=1` in the **brain-only**
configuration after applying/verifying 0007. It also requires the existing
BITOS_SUPABASE=1 and BITOS_OWNER_USER_ID/service-role configuration. The flag is
off by default so deploying code before its migration cannot begin processing.
Do not put service credentials into a dashboard environment file.

Existing Discord keys remain raw IDs, with no data-file migration. The dashboard
uses dash:<conversationId>. SDK sessions, transcripts, web taint and grants remain
keyed independently. Discord adapter and node code are unchanged. Screen/control
configuration, leases and their caps are unchanged. The optional Runner output
callback receives partial top-level text; only callers requesting it enable SDK
partial messages. Discord continues receiving the returned final text. The same
Runner supplies persona, mood, budget, permissions and taint checks. Dashboard
turns do not create synthetic Discord-thread tasks through the legacy mirror.
Actions without a supported owner approval path fail closed.

The adapter ignores other owners, rereads notification IDs authoritatively,
validates the conversation/workspace binding and membership, and catches up only
unprocessed owner messages from the last ten minutes on startup/reconnect.
`data/dashboard-chat-processed.json` persists claims before model/tool execution.
Stable reply IDs independently prevent another reply if the local ledger is lost.
An interrupted claimed turn is marked error, never automatically rerun. Older
interrupted claims are repaired without executing the model. This is at-most-once
execution, not resumption of a partially completed turn: already committed task
changes remain, and their audit events identify their conversation. A card that
was not yet checkpointed before a crash can be absent from the interrupted reply.

Approval notices use stable IDs to post once per approval in the most recently
updated conversation in its workspace. Existing pending approvals are picked up
at startup and when an owner creates a conversation. Approval notifications have
a separate queue so model generation cannot block delivery of their cards.

## UI and Undo

Chat reuses the existing BitPanel, after Pending approvals and Current activity.
The desktop shell is 480px wide and remains viewport-clamped. Mobile retains its
100dvh safe-area sheet and body scroll lock. The header orb reflects presence;
there is no new spinner or panel. Recent conversations, New chat, composer,
Enter/Shift+Enter and final-reply aria-live announcements are included. Realtime
updates message text and approval cards. Expired/decided cards in message history
show their current status; their decision controls disappear. ApprovalCard itself
is unchanged in this phase.

Created-task Undo sets cancelled; the task remains under Cancelled tasks.
Update Undo restores only the previous changed fields saved in the card.
Both use the signed-in client's existing tasks RLS, scoped workspace/task ID and
expected updated_at. A permission failure or intervening task change reports
Undo unavailable rather than overwriting newer work. There is no task deletion.
Task links open the existing task panel/board flow. Active-run elapsed time uses
started_at and reads “running m:ss”; no timestamp means no elapsed label.

## Writes

These are chat/task row writes; debounced presence state-change writes are separate.
For a normal successful reply, with N intermediate streaming/card checkpoints:

- Brain: 1 streaming-message insert + N throttled updates + 1 final done/error
  update + 1 conversation recency update = **3 + N writes**.
- Owner: 1 message insert = **4 + N total** in an existing conversation.
- New conversation: +1 insert. Each task mutation: +2 row writes (task + audit)
  atomically inside one RPC. Each new approval notice: +1 message insert.
- Updates to a streaming reply are serialized and at least 750ms apart, including
  its final status. No animation ticks write. A fast reply without intermediate
  checkpoints uses 3 brain writes; three created tasks add 6 row writes.
- Chat idle writes: **0/hour**. Existing presence publication still heartbeats
  **60 writes/hour**, plus actual state changes. Local SDK/ledger file writes are
  not Supabase writes. Interrupted-turn repair can add one error write.

## Verification

- `npm run build --prefix apps/dashboard`: TypeScript, Vite and credential scan.
- `npm test --prefix apps/dashboard`: **26 dashboard unit tests passed**.
- `npm test`: **265 repository tests passed**, including task scope/roles/batches/audits,
  owner filtering, reconnect catch-up, restart deduplication, interrupted claims,
  streaming throttling/concurrency, approval refusal, raw Discord session resume,
  and session/taint/grant isolation.
- `node scripts/check-dashboard-chat-sql.mjs`: disposable local PostgreSQL 16,
  migrations 0001–0007, replay of 0007, actual RLS/privilege/trigger assertions,
  service-only RPC, audit rollback, and the existing Stop path. No hosted database.
- `BIT_PANEL_WEBKIT=1 npm run test:browser --prefix apps/dashboard`: Chromium and
  WebKit, **16 browser scenarios passed**; existing panel regressions plus chat at 320/390/768/1280, shared command
  confirmation/decision callback, live decisions/expiry, create/update Undo,
  task link, composer, null start timestamp and reply announcements.

Browser screenshots and bounds are in `docs/proof/dashboard-chat/`. These are
local deterministic fixtures, not phone/desktop live proof. Live steps 1–5 in the
chat prompt are intentionally deferred until after migration review/application.
