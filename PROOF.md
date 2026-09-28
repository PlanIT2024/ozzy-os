# Phase 1 proof report

Validation performed on OZZY-AI, 2026-09-28, using Node v22.23.1 and the locked dependencies. `npm test`: **10 passed, 0 failed**. Syntax checks passed. npm installation reported **0 vulnerabilities**. No PlanIT files were read or modified.

| Requested proof | Result actually observed |
| --- | --- |
| 1. Brain + node, `/machines` shows OZZY-AI online with status | **Local integration passed.** Started the actual hub and node code on a loopback ephemeral port; the `/machines` formatting function reported OZZY-AI online with real systeminformation data. Full Discord brain login and an actual slash invocation were not run. |
| 2. Ask about machines; Claude uses tools and answers in character | In-process MCP tools and persona injection implemented; real status transport passed. **Live Claude tool selection and character response unverified.** |
| 3. Remember teal, emit note, recall in new thread | **Simulated SDK integration passed.** The real policy allowed a temporary memory write, post-tool hook sent the note, and a fresh thread read teal from disk. Actual Claude choosing Write/Read is unverified. Repository profile remains `Owner: Ozzy`. |
| 4. Create skill, approval buttons, ❌ denies | **Discord interaction simulation passed.** Actual button builders, proposal attachment, owner filtering and denial tested; timeout tested with a shortened test clock. Live Discord delivery unverified. |
| 5. Editing source or `.env` is denied | **Policy tests passed.** Source, env, persona writes, traversal, symlinks and excluded tools denied. A real model's explanation remains unverified. |
| 6. Non-owner ignored | **Simulated adapter passed.** No thread, agent run or reply for a non-owner message. Non-owner approval clicks also cannot authorize writes. |
| 7. Mood and budget | **Local tests passed.** Saved hype survives a new Runner, sage schedule is checked at boundaries, cost deltas persist, local months roll over, and reaching cap prevents SDK calls. Live command display and model voice unverified. |

A live status sample reported Ubuntu 24.04.3 LTS, kernel 7.0.0-28-generic, 12 CPU cores, 50,304,323,584 bytes total memory, about 4.7% CPU load, and 255,424 seconds uptime. These are point-in-time observations, not current status.

Additional tests passed for invalid authentication, token-to-machine binding, heartbeat offline detection, reconnect after disconnection, status request timeout, disabled node methods, Unicode-safe response splitting, thread/session continuity, reset, path revalidation after approval, unsafe skill preprocessing, and quoted/escaped executable YAML keys.

## Why live acceptance is pending

No `.env` was present, and neither `ANTHROPIC_API_KEY` nor `DISCORD_TOKEN` was available in the process environment. No credentials were printed, API calls made, or Discord messages sent. Local tests used real networking/status collection with mocked SDK and Discord boundaries. No background brain/node service was left running.

## Manual acceptance after configuration

Follow README setup, register guild commands, and run `npm run brain` plus `npm run node`. Then:

1. Run `/machines` in #bit; check OZZY-AI online and live values.
2. Post `hey bIT, what machines do I have and how's this one doing?`; confirm a new thread, machine tools in `data/audit.log`, and an in-character answer.
3. Post `Remember that my favorite color is teal`; verify a memory file and `📝 noted`. Start a new top-level message: `what's my favorite color?`; verify teal and audited Read calls.
4. Ask for an ordinary instruction-only skill. Open the proposed change attachment, press ❌, and confirm no file was created. Repeat and leave unanswered to check the production ten-minute expiry if desired.
5. Ask to modify `src/brain/index.js` and `.env`; expect refusal and unchanged files. The model may decline without issuing a tool; attempted calls are audited as denied.
6. Send from another account; expect silence and no thread creation.
7. Run `/mood personality:hype`, then converse during daytime (night remains sage). Run `/budget`; compare the displayed amount to `data/budget.json`.

## Deliberate adaptations and limits

- Added `.claude/skills` discovery alias for SDK compatibility; canonical skills remain in `bit/skills`.
- Added a PreToolUse guard alongside canUseTool because SDK auto-allowed reads can bypass canUseTool.
- Added shared helpers, skill validation, tests and this report beyond the requested minimal layout.
- Added YAML validation; Phase 1 skills only accept descriptive metadata, excluding `allowed-tools`, hooks, shell preprocessing and subagent configuration.
- Global query serialization and fail-closed unknown-cost recovery protect the monthly ledger. Provider cost reporting can allow one in-flight response to exceed the cap.
- The requested guild-scoped slash commands operate in the server. Owner DMs support ordinary messages; slash commands are not globally registered.
- Only Linux was executed here. Node code uses portable Node/systeminformation APIs; macOS and Windows need live verification on those machines.
- No optional systemd unit was installed, remote repository created, or branch pushed. Instructions and a unit example are in README.

## Phase 1 polish validation

Full suite: **27 passed, 0 failed**. Added a real, no-prompt SDK initialization test: the non-built-in skill list exactly matched the folders in the fixture `bit/skills`, with a competing user skill/settings source present. No model/API call was made by this test. The explicit skill allowlist, project-only source, bundled/synced skill disabling and rejection of other project configuration were exercised.

Additional passing checks: `~/.claude/**` and nested Claude configuration writes denied; owner chat (“approved”, “sounds good”) cannot resolve a pending skill write; non-owner buttons denied and owner ✅ accepted; concise machine summaries preserve raw status; Linux/macOS/Windows mount fixtures retain real storage and exclude pseudo mounts; node retry logs occur only on connection state changes; ready identity logging; login, gateway and disallowed-intent errors produce full diagnostics, non-zero exit status and lock cleanup. The existing >3-second slash test and real SIGINT/SIGTERM lock cleanup tests also passed.

These lifecycle and Discord interaction checks use test clients, not live messages. Existing local memory and skills were preserved and excluded from the polish commit.
