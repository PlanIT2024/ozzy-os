# Phase 2 proof — 2026-10-01

Branch: `phase2-always-on`, created from `main` at `102b52a`.

## Automated validation

`npm test`: **43 passed, 0 failed**. The suite includes the existing SDK/Discord/path-policy/budget tests plus:

- Real libsodium X25519 directional keys and XChaCha20-Poly1305 ciphertext. A test relay captures received bytes and confirms application plaintext/status never appears.
- Tampered ciphertext and modified routing AD rejected. Replayed and older counters rejected. Captured handshake finish/data fail against a fresh brain challenge after a simulated restart.
- Valid relay tokens cannot bypass an unknown node name, wrong E2E key or key/name mismatch.
- Brain↔node encrypted status over a real local relay, with case-insensitive identity matching and offline last-seen formatting.
- Real loopback E2E status and rejection of non-loopback brain bind configuration.
- Relay node-to-node routing blocked; second brain rejected; unknown tokens close with 4401; >8 MiB closes with 1009; rate limit and dead-pong cleanup exercised.
- Key files created/reused with 0600 mode; duplicate case-insensitive names/public keys rejected.
- Real temporary Git repos: approved skill commit contains only its folder, unrelated staged source/.env remain outside the commit, add/update messages are correct, memory batches honor one hour across restarts, and Git/push failures do not escape into the brain.
- Integrated simulated Discord owner ✅ → policy-approved write → PostToolUse → real Git commit → one-line notification callback.

The relay's own `npm ci --prefix relay --omit=dev` succeeds with its independent lockfile (0 reported vulnerabilities). Installed Linux units pass `systemd-analyze --user verify`.

## Live OZZY-AI service proof

Paired separate long-term brain/local-node keys under gitignored `data/keys`; migrated `.env` without printing or committing secrets. The existing Discord/API configuration was retained. `AUTO_PUSH` remains false.

`npm run service:install` enabled and started both user units. Journald confirmed:

```text
15:12:22 Started bit-brain.service
15:12:22 Started bit-node.service
15:12:23 bit-node OZZY-AI connected
15:12:23 node OZZY-AI authenticated online via local
15:12:24 Discord connected as bIT Agent#6243
```

The service processes remained active after the launching command/terminal session ended. `systemctl --user is-enabled` reported enabled for both, and `loginctl show-user ozzy -p Linger` reported `Linger=yes` (already configured).

A deliberate SIGKILL to **only the managed brain** produced:

```text
15:12:41 brain PID 166009 killed with SIGKILL
15:12:41 bit-node OZZY-AI disconnected
15:12:46 systemd scheduled restart; NRestarts=1
15:12:46 brain restarted as PID 166057
15:12:47 Discord connected as bIT Agent#6243
15:12:48 node OZZY-AI authenticated online via local
```

The new process owned the recovered `data/brain.lock` without manual deletion. The local node retained PID 166010 and reconnected automatically.

**Reboot was not performed.** Boot/logout prerequisites (enabled user units + linger) were verified; an actual reboot remains a manual acceptance check.

## Live local relay proof

Started `npm run relay` as a separate process bound to `127.0.0.1:8788`, with independent random brain/node tokens and only their hashes in the relay environment. Temporarily configured the actual systemd brain's outbound relay URL and trusted `Relay-Proof` public key. Started a separate `src/node/index.js` process with `NODE_TRANSPORT=relay` and its own key.

Observed:

```text
connect relay-proof role=node
connect brain role=brain
bit-node Relay-Proof connected
15:14:35 node Relay-Proof authenticated online via relay
15:14:36 node OZZY-AI authenticated online via local
```

This verifies simultaneous local and relay nodes in the permanent brain registry. Automated tests exercised the same registry's live status request and `/machines` formatter; a live Discord `/machines` invocation was not performed by the agent.

After proof, the temporary node/relay processes were stopped, `.env` restored to its permanent configuration, and the brain restarted. OZZY-AI reauthenticated locally. Final listener inspection showed only **127.0.0.1:8787**; no relay listener or public OZZY-AI listener remained.

## Approval/commit proof scope

The integrated automated test drives the actual Discord button relay and permission hook, writes a skill in a temporary repository, and verifies `bIT: add skill proof` changes only `bit/skills/proof/SKILL.md`. This does not fabricate owner approval in the live Discord server or add a test skill to personal memory. Live owner approval/API behavior remains a manual check if not separately exercised by Ozzy.

## Remaining manual actions and boundaries

- Deploy `relay/` to Railway yourself using its README, then pair remote machines and restart the brain. No Railway deployment or resource was created.
- On any fresh Linux setup, manually run the required `sudo loginctl enable-linger "$USER"`. OZZY-AI already has linger enabled.
- Reboot/log-out survival has configuration proof, not an actual host reboot.
- macOS LaunchAgent and Windows Task Scheduler instructions were prepared but not run on those OSes.
- E2E prevents relay impersonation/decryption; a compromised relay can still disrupt availability and observe routing/timing/size metadata. Static key agreement does not offer forward secrecy after endpoint private-key compromise.
- Local Phase 1 plaintext nodes must upgrade and pair keys; no plaintext fallback exists.
- Offline last-seen values currently persist only for the running brain process; after restart a never-reconnected node displays “never”.

The permanent brain and local node user services are left running. All temporary proof services were stopped. Personal memory and existing skills were not rewritten by this implementation.
