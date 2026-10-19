# Chat polish — migration 0008 pending

Local branch: `chat-polish`. No push, production migration, service restart, or
hosted database write is part of this change. Apply
[`0008_conversation_titles.sql`](../supabase/migrations/0008_conversation_titles.sql)
then run [`conversation-titles-verification.sql`](conversation-titles-verification.sql)
before deploying the code. The new client selects `title_set_by_owner`.

## Live results supplied by the owner

Steps 1–4 passed: tasks, Undo, update + Undo, and honesty. Steps 5 and 6 were
not supplied and remain unreported. Local browser fixtures below are separate
from live acceptance results. The existing uncommitted follow-up notes in the
main worktree's `dashboard-chat-report.md` have been left intact.

For “What exact number am I thinking of?”, the local SDK JSONL records the user
turn at `2026-10-19T19:05:36.396Z`, followed by
`mcp__presence__express` with `{face:"unsure"}`. No missing-tool-call persona fix
was needed. Both the brain reaction TTL and renderer duration are now 4 seconds;
the existing approval/offline priority and expression rate limit remain.

## Behavior

bIT messages render CommonMark (bold, italics, lists, links, inline/fenced code).
The [react-markdown renderer](https://github.com/remarkjs/react-markdown) builds
React elements with raw HTML disabled and a tag allowlist. Images and embeds
are excluded; script URLs are filtered. Links use `target="_blank"` and
`rel="noopener noreferrer"`. Owner messages remain literal text. The renderer
loads separately, keeping the main build below Vite's chunk warning threshold.
There is no “bIT is thinking…” text; the orb represents thinking.

The chat opens the most recently updated conversation; live row refreshes do
not replace an explicit selection. There is one New chat button, and a pencil
renames the selected conversation. The header reads “Chat with bIT”. Current
activity disappears when idle. Desktop chat is 600px wide and 760px tall, clamped
to the visible viewport. Pending approvals and activity sit inside the message
scroll region, so the orb/close header, conversation controls, and composer stay
pinned. The mobile sheet follows `visualViewport.height/offsetTop` on resize and
scroll, falling back to window height plus the existing dvh/safe-area CSS.

The brain sets an extractive title from the first owner message only after the
first successful reply. It normalizes markup/whitespace and bounds the title to
40 Unicode characters, without an extra model call. Each new conversation starts
as New chat. A conditional update checks both that default title and
`title_set_by_owner=false`, so a concurrent owner rename wins. Owner names can be
1–80 characters. Renaming to New chat still locks out future automatic naming.

0008 adds the non-null boolean flag with default false. It conservatively marks
legacy non-default titles owner-set once, preserving existing names. Replay does
not promote newly generated automatic titles. Authenticated UPDATE privileges
cover only title and the flag. The BEFORE UPDATE guard compares the whole row,
protecting all other columns even if broad UPDATE is accidentally granted later.
It runs before the server timestamp trigger, requires the owner flag and length
limit on client updates, and prevents the brain from changing an owner-set title
or clearing its flag. RLS and Realtime policies remain in force.

## Validation

- Root tests: 270 passed.
- Dashboard unit tests: 28 passed, including Markdown semantics and HTML/URL safety.
- TypeScript, Vite build, and bundle credential scan passed.
- Disposable local PostgreSQL 16: migrations 0001–0008, replay of 0007/0008,
  previous chat/RLS tests, auto/owner title limits, rename-to-default locking,
  owner isolation, recency updates, and whole-row trigger protection with broad
  client privileges. No migration was applied to the hosted database.
- Browser tests: 19 passed across Chromium and WebKit, exercising approval, Undo, streaming,
  resize and dismissal flows, plus safe Markdown, rename/recent-chat behavior,
  idle activity hiding, and pinned composer/header geometry at 390×844 with
  keyboard/toolbar visual viewports of 390×480 and 390×420 (32px offset).
  These are emulated viewport events with the composer focused, not physical
  iPhone keyboard/Safari observations. Screenshots and geometry are in
  [`proof/chat-polish/`](proof/chat-polish/).
