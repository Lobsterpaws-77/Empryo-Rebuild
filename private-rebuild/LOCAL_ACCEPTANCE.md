# Local acceptance (Nick's Mac)

This file covers what the cloud run **could not prove**. Every automated
check below already passed in the cloud. The manual and live checks need
your machine, your accounts, and real models.

> **Important:** this repository is the SoulForge/Empryo **open core**
> (terminal and headless app, `@proxysoul/soulforge` 2.20.25). It is **not**
> the Empryo 3.8.7 desktop app. Nothing here changes the installed desktop
> app. The desktop Graph Node / Graph Judge fix is **blocked by missing
> source**, so **keep your temporary local hook in the desktop app**. See the
> final section.

---

## 0. Prerequisites

- macOS (arm64 or x64), `git`, and **Bun ≥ 1.3.13** (`curl -fsSL https://bun.sh/install | bash`).
  The cloud used Bun 1.3.11.
- Back up your existing config first. The fork reads and writes the same
  `~/.soulforge/` as any installed SoulForge or Empryo terminal build:
  `cp -R ~/.soulforge ~/.soulforge.backup-$(date +%Y%m%d)`.
  All new config keys are additive, and older builds ignore them.

## 1. Get and build the candidate (no old patches)

```bash
git clone https://github.com/Lobsterpaws-77/Empryo-Rebuild.git
cd Empryo-Rebuild
git checkout claude/gracious-hypatia-pgj1kg     # or the final SHA from README.md
bun install
bun run typecheck && bun run lint && bun test    # expect 14 structural_edit failures only if ast-grep is absent
bun run build                                    # → dist/
bun dist/index.js --version                      # expect "2.20.25 (<sha>)"; "+dev…dirty" means a dirty tree
```

- Run from source instead: `bun run dev` (TUI) or `bun run src/boot.tsx --headless "…"`.
- Standalone binary (optional): `bun run build:binary` builds `bin/soulforge`.
- Do **not** copy source patches from earlier experiments into this tree.

## 2. Credentials (existing flows only, unchanged by the rebuild)

Restore access with the flows you already use:
- `soulforge --set-key <provider> <key>` or `/keys`;
- `/codex login` for ChatGPT/Codex;
- the proxy add-on for a Claude subscription.

Then check with `soulforge --list-providers`. Provider authentication code
was not modified.

## 3. Automated checks to re-run locally

| Check | Command | Expected |
|---|---|---|
| Unit/integration | `bun test` | all pass except `structural_edit` (needs `ast-grep`) |
| Typecheck / lint | `bun run typecheck && bun run lint` | clean |
| Build | `bun run build` | "Built 3 artifacts" |
| Preflight | `bun dist/index.js --preflight` | prints the candidate id; FAIL until typecheck/test evidence exists (see §9) |

## 4. Live lane routing: model **and** effort (§8/§10)

Setup in `/router`:
- Code (ember) = model A, effort `max` (press `e` to cycle);
- Review (verify) = model B, effort `low`;
- Cleanup (desloppify) = model C, effort `medium`;
- turn on `/agent-features` → Verify Edits and De-sloppify.

Then:
1. Enable `/model-events`.
2. Ask for a small multi-file code change that makes the Forge `dispatch`
   code agents.
3. Worker cards show `[model · effort]`. Expect **code workers A · max,
   verifier B · low, cleanup C · medium**.
4. `/model-events` rows show `lane` / `effort` / `effortSource`
   (`lane` for explicit values).
5. Confirm effort was **actually sent**: run `/export api` (toggles API
   export on), repeat the dispatch, then inspect
   `.soulforge/api-export/subagents/<agent>/config.json`. The
   `providerOptions` must include the effort key (e.g. `anthropic: ["effort", …]`).
   *Before this rebuild, worker providerOptions were empty.*
6. Isolation: set ember `max` and leave verify unset → the verifier uses the
   **global** effort, not `max` and not `low`.
7. Scope: put a `taskRouter` in `<project>/.soulforge/config.json` with
   different efforts → workers follow the project scope that `/router`
   shows.

Provider caveat: OpenAI-compatible providers (groq, fireworks, ollama,
lmstudio, deepseek-chat, llmgateway, and non-Claude models over the proxy)
receive effort when the model is built, from the **global** config. On those
providers a lane effort can't differ from the global one. Codex CLI exposes
no effort. Claude (direct or proxy) and OpenAI/Google/xAI/OpenRouter/Bedrock
are per request.

## 5. Strict routing (§11)

Add to the project config:
```json
"taskRouter": { "ember": "<model A>",
  "strict": { "enabled": true, "lanes": {
    "ember":  { "models": ["<model A>"] },
    "verify": { "models": ["<model B>"], "fallbackModels": ["<model D>"],
                "efforts": ["high","max"], "effortViolation": "reject" } } } }
```
1. With verify = model B and effort `low`, the verifier is refused with
   `Strict routing: lane "verify" resolved effort low … not permitted`.
   A "Strict routing:" system message appears at turn start.
2. Change `effortViolation` to `"clamp"` → it runs at `high`, and
   `/model-events` shows `effortSource: policy`.
3. Set verify's model to model D → it runs, with a "permitted fallback"
   note.
4. Unset `taskRouter.ember` (workers inherit the Forge model) → code
   workers are refused. There is **no silent substitute**.
5. Add a `forge` lane policy that excludes your active model → the turn is
   refused. With `modelFallback` configured, disallowed fallbacks are
   removed from the chain (see `/errors`).
6. Set `"enabled": false` → the old flexible behaviour returns.

## 6. Graph-shell / shell spawn on macOS (§9)

1. **Launch from the Dock/Finder**, or simulate a minimal PATH:
   `env -i HOME=$HOME PATH=/usr/bin bun dist/index.js`. Run a task that
   uses the `shell` or `project` tool. It must work, because the shell
   is spawned as `/bin/sh`.
2. `SOULFORGE_SHELL=/bin/zsh` → commands run under zsh. A relative or
   invalid value is ignored.
3. Run a command with a non-existent cwd (via the `project` tool's `cwd`)
   → the error names the **working directory**, not the shell.
4. The desktop app's own graph-shell node is **not** in this source. Keep
   its workaround until the desktop build carries a fix.

## 7. Activity, provider wait, stall (§13–§15)

1. During a long run, the line under the stream shows live harness state:
   "Reading …", "Running tests…", "Waiting on 2 workers — 1m 5s",
   "Waiting for your approval — 3s". It must never show an old tool name
   while waiting.
2. Provider wait: with a slow model or a large prompt, after 15s of
   silence the line reads **"Waiting on provider — no activity for Xs"**,
   in the warning colour. The watchdog behaviour itself is unchanged.
3. Toggle `/verbose` and `/reasoning`: the activity line stays, and only
   the stream rendering changes.
4. Worker cards: idle workers show their own wait state and retry reasons
   instead of "thinking...".
5. Headless: `bun dist/index.js --headless --events "…" | grep '"activity"'`
   → phase transitions, plus `heartbeat: true` lines while waiting.

## 8. Review → repair worker → recheck (§12)

1. Turn on `/agent-features` → Verify Edits **and** Repair on Review Fail.
   Set `/router` → Repair to a model (optional; unset = Code lane).
2. Ask for a change designed to fail review (e.g. an intentionally wrong
   spec in the task).
3. The dispatch output shows `### Verification` (FAIL), then
   `### Repair (round 1, repair lane)`, then `### Verification (recheck 1)`,
   then "PASS after 1 repair round(s)" or the coordinator guidance.
4. The repair worker card shows the repair lane's model and effort. The
   Forge itself must not edit the files during this loop.
5. Review also reports what it saw: only files edited by the dispatch's
   workers (Forge-authored edits are out of scope by design).

## 9. Provenance, evidence, preflight, diagnostics (§17–§21)

1. In a project: ask the Forge to run typecheck and tests, or have
   `project` run them.
2. `/preflight`: on a **clean** tree it should PASS, reporting "release
   candidate <sha>".
3. Edit a file → `/preflight` → evidence becomes `stale`, and the tree
   reports DEVELOPMENT BUILD.
4. Revert the edit → the same candidate id returns, and the old evidence
   is valid again.
5. Build from a dirty tree: `bun run build` prints the DEVELOPMENT BUILD
   warning, and `--version` shows `+dev.<sha>.dirty`.
6. `/diagnostics` (after enabling `/model-events`) → open
   `.soulforge/diagnostics/run-*.md`. Check dispatches (lane, model,
   effort), usage by model/lane, retries, timeline, gates.

## 10. Narration modes (§16)

1. `/narration` → **Quiet**: behaviour identical to before (silent tool
   loop).
2. **Normal**: a few one-to-two-sentence progress updates per turn, at
   phase changes and findings.
3. **Verbose**: one short line before significant actions.
4. In every mode, check there is no reasoning dump or self-talk. Harness
   activity lines keep working in every mode.
5. Headless: `--narration normal`.

## 11. MCP / local integrations

The rebuild didn't change MCP code. Run one MCP-backed tool you rely on to
confirm nothing regressed.

## 12. Decision point: retiring the temporary desktop hook

**Do not retire it.** The hook fixes the Empryo **desktop** Graph Node /
Graph Judge effort, and that code is not in this repository. This rebuild
makes the equivalent defect class structurally correct in the open core,
and gives desktop lanes a plug-in point (`registerRoutingLane`). But it can
only fix the desktop app once the desktop build adopts the change. Retire
the hook only after a desktop build passes §4-style checks for Graph Node
and Graph Judge **without** it.
