# Serf Rewrite Plan — 2026-07-03

> Kill the v1/v2 versioning debt. One flat `src/`. SOLID transport. Get the factory working end-to-end.

## Why a rewrite

The `v2/` prefix is organizational debt. It implies a v1 that no longer exists in source, and it has shaped decisions — "don't touch v2, it's the current one" — that preserved cruft. The codebase has accumulated:

- **Two agent command builders** that disagree (`executor.ts:25` AGENTS vs `herdr.ts:290` buildAgentCmd).
- **Two execution paths** in master.ts that fork on every function (`processWithHerdr` vs `processDirect`, `if (useHerdr)` scattered through `runPlanPhase`).
- **Dead interactive TUI injection** (`sendInput`, `sendPrompt`, `waitForDone` pane-scraping) that never worked reliably.
- **Duplicate code** in `executor.ts` (`case "pi"` appears twice at lines 417 and 420).
- **810-line master.ts** that mixes funnel logic, herdr harness lifecycle, worktree management, curiosity handling, and friction-spawned serfs.
- **628-line index.ts** with inline `require()` calls and duplicate help text lines.

The funnel logic (triage → plan → execution → critic → arbiter → deliberation) is sound and tested. The transport is broken. A clean rewrite separates them permanently.

## What we keep (proven, tested, unchanged or lightly refactored)

| Module | Lines | Action | Why |
|--------|-------|--------|-----|
| `board.ts` | 262 | Move to `src/board.ts` | Clean markdown-card kanban. 11 tests pass. |
| `serf.ts` | 147 | Move to `src/serf.ts` | Identity system works. |
| `budget.ts` | 68 | Move to `src/budget.ts` | Phase-locked budget is well-designed. |
| `triage.ts` | 146 | Move to `src/triage.ts` | Gate 0 works. |
| `plan-critic.ts` | 51 | Move to `src/plan-critic.ts` | Gate 1 works. |
| `work-critic.ts` | 28 | Move to `src/work-critic.ts` | Thin wrapper, fine. |
| `arbiter.ts` | 60 | Move to `src/arbiter.ts` | Deterministic policy engine. |
| `deliberation.ts` | 144 | Move to `src/deliberation.ts` | Master-critic loop. |
| `critic.ts` | 239 | Move to `src/critic.ts` | GAN critic prompt + verdict parser. |
| `critic_multipass.ts` | 129 | Move to `src/critic-multipass.ts` | Multi-pass wrapper. |
| `events.ts` | 60 | Move to `src/events.ts` | JSONL audit trail. |
| `paths.ts` | 11 | Move to `src/paths.ts` | Tiny, correct. |
| `sandbox.ts` | 118 | Move to `src/sandbox.ts` | macOS sandbox-exec profiles. |
| `strategies/` | 5 files | Move to `src/strategies/` | Autoimprove engine, pluggable. |
| `state.ts` | 60 | Keep at `src/state.ts` | Config loading. |
| `SERF.md` | 113 | Keep, minor edits | The protocol. |
| `scripts/health-check.ts` | — | Keep | Health check script. |

**Total kept: ~1,540 lines** — the funnel, the critic, the board, the budget, the identities. These are the parts that work.

## What we rewrite

### 1. `src/agent-command.ts` (NEW — ~80 lines)

Single source of truth for agent invocation. Replaces both `AGENTS` in executor.ts and `buildAgentCmd` in herdr.ts.

```typescript
export interface AgentInvocation {
  command: string;
  args: string[];
  promptViaStdin: boolean;   // opencode: true. claude/pi/codex: false (--print <text>).
  completionMarker: string;   // unified: "SERF_DONE_EXIT_CODE"
}

const REGISTRY: Record<string, (model?: string) => AgentInvocation> = {
  claude:   (m) => ({ command: "claude", args: m ? ["--print", "--model", m] : ["--print"], promptViaStdin: false, completionMarker: "SERF_DONE_EXIT_CODE" }),
  opencode: (m) => ({ command: "opencode", args: m ? ["run", "--model", m] : ["run"], promptViaStdin: true, completionMarker: "SERF_DONE_EXIT_CODE" }),
  aider:    (m) => ({ command: "aider", args: ["--yes-always", ...(m ? ["--model", m] : [])], promptViaStdin: false, completionMarker: "SERF_DONE_EXIT_CODE" }),
  pi:       (m) => ({ command: "pi", args: m ? ["--print", "--model", m] : ["--print"], promptViaStdin: false, completionMarker: "SERF_DONE_EXIT_CODE" }),
  codex:    (m) => ({ command: "codex", args: m ? ["--print", "--model", m] : ["--print"], promptViaStdin: false, completionMarker: "SERF_DONE_EXIT_CODE" }),
  hermes:   (m) => ({ command: "hermes", args: ["chat", "-q", ...(m ? ["-m", m] : []), "-Q"], promptViaStdin: false, completionMarker: "SERF_DONE_EXIT_CODE" }),
};

export function buildInvocation(agent: string, model?: string, profile?: SandboxProfile): AgentInvocation
export function listAgents(): string[]
export function isHeadless(agent: string): boolean
```

The sandbox profile wraps the command (already handled correctly in sandbox.ts). No shell expansion of prompt content — prompts go via stdin heredoc (opencode) or as a literal arg (claude), never via `$(cat file)`.

### 2. `src/transport.ts` (NEW — ~200 lines)

The abstraction the master depends on. Two implementations.

```typescript
export interface Transport {
  run(prompt: string, opts: RunOpts): Promise<ActorRunResult>;
}

export interface RunOpts {
  cwd: string;
  timeoutMs: number;
  outputFile: string;       // where the agent writes results
  profile?: SandboxProfile;  // optional sandbox
  label?: string;            // for visibility
}

export interface ActorRunResult {
  output: string;
  tokensUsed: number;
  ok: boolean;
}
```

**`HeadlessTransport`** — lifts the working parts of `runHeadless` from executor.ts. Writes prompt to a temp file, builds a wrapper script, launches in a terminal (ghostty/Terminal/iTerm/tmux/fallback), waits for the output file with `SERF_DONE_EXIT_CODE`. This is what already works.

**`HerdrTransport`** — runs the **same wrapper script** but inside a herdr pane via `sendCommand(paneId, "bash wrapper.sh")` instead of `launchInTerminal`. The user sees streaming output. The command exits when done. The master reads the same output file. **No `sendInput`, no `sendPrompt`, no interactive TUI typing, no pane-buffer scraping.** The pane is a window, not an API.

Both transports share the wrapper-script builder and the output-file waiter (extracted as shared helpers). The only difference is the launch mechanism.

### 3. `src/visibility.ts` (NEW — ~60 lines)

Optional layer. The master never imports herdr directly.

```typescript
export interface VisibilityLayer {
  onTaskStart(card: Card): Promise<PaneHandle>;
  onTaskEnd(handle: PaneHandle, result: ActorRunResult): Promise<void>;
}

export class NoopVisibility implements VisibilityLayer { ... }

export class HerdrVisibility implements VisibilityLayer {
  // creates workspace, labels panes, reports agent state
  // uses herdr.ts socket client (renamed to herdr-client.ts)
}
```

### 4. `src/herdr-client.ts` (REWRITE — ~150 lines)

The raw socket client. Keep the working parts: `send`, `createWorkspace`, `splitPane`, `sendCommand`, `labelPane`, `closePane`, `closeWorkspace`, `isHerdrRunning`, `getAgentState`, `reportAgentState`.

**Delete:** `sendInput`, `sendPrompt`, `typeText`, `spawnAgent` (the interactive injection functions), `HerdrAgent` class, `buildAgentCmd`, `waitForDone` pane-scraping. These are the broken paths from the retrospective.

### 5. `src/master.ts` (REWRITE — ~400 lines, down from 810)

The master loop, cleaned up:

```
startMaster(options)
  → detect transport (herdr if running + configured, else headless)
  → detect visibility (herdr if running, else noop)
  → loop:
      if board empty: spawn master agent via transport
      for each card: processCard(card, budget, transport, visibility)
  → cleanup

processCard(card, budget, transport, visibility)
  → Gate 0: triage(card)           ← unchanged
  → create worktree                 ← unchanged
  → Gate 1: runPlanPhase(card, transport)  ← one path, not two
  → Gate 2: executeWithStrategy(card, budget, transport)
  → worktree merge/discard          ← unchanged
```

No `HerdrHarness` class. No `processWithHerdr` / `processDirect` split. No `if (useHerdr)` branches. `runPlanPhase` calls `transport.run(...)` once. `executeWithStrategy` calls `transport.run(...)` once per attempt.

The friction-spawned serf logic (`maybeSpawnSerf`) stays but is simplified — it creates an identity file, not a pane. The pane was herdr-coupled and never worked.

### 6. `src/executor.ts` → DELETED (634 lines)

Replaced by `agent-command.ts` + `transport.ts` + shared wrapper-script builder. Nothing survives as a single file. The prompt builders (`buildMasterPrompt`, `buildPlanAgentPrompt`, `buildAgentPrompt`, `buildCriticAgentPrompt`, `buildCriticFollowupPrompt`, `buildCriticResolvePrompt`) move to `src/prompts.ts` (~280 lines).

### 7. `src/prompts.ts` (NEW — ~280 lines)

All prompt builders, extracted from executor.ts. Pure functions, no imports from herdr or transport. Easy to test.

### 8. `src/index.ts` (REWRITE — ~300 lines, down from 628)

Clean CLI. No inline `require()`. All imports at top. Typed commands. Deduplicated help text. The `serf .` shortcut stays.

Commands:
```
serf init                    → create .serf/
serf task "do something"     → add card to backlog
serf board                   → show kanban
serf start [--once] [--budget N] [--model M]  → run master
serf agents [list|use <name>]
serf providers [list|set <name>]
serf config [show|set <k> <v>]
serf health                  → build + test + typecheck
```

### 9. `src/providers.ts` (REFACTOR — ~200 lines)

Keep the detection logic. Remove the tangle of `preferredProvider` / `defaultModelForProvider` / `providerInstructions` into a cleaner interface. This is lower priority — it works, just messy.

### 10. `src/capabilities.ts` → merge into `src/init.ts`

The capability detection is only used during `serf init`. Merge it into the init flow. One fewer module.

### 11. `src/agent-config.ts` → merge into `src/sandbox.ts`

The agent-config seeding (writing `opencode.json` into the sandbox HOME) is sandbox-specific. It belongs with the sandbox module, not as a standalone file.

## New file structure

```
src/
├── index.ts              # CLI (~300 lines)
├── state.ts              # config loading (kept)
├── paths.ts              # getSerfDir, ensureDir (kept)
├── board.ts              # kanban cards (kept)
├── serf.ts               # identities (kept)
├── budget.ts             # phase-locked budget (kept)
├── events.ts             # JSONL audit (kept)
├── triage.ts             # Gate 0 (kept)
├── plan-critic.ts        # Gate 1 (kept)
├── work-critic.ts        # Gate 2 critic wrapper (kept)
├── critic.ts             # GAN critic prompt + parser (kept)
├── critic-multipass.ts   # multi-pass wrapper (kept)
├── arbiter.ts            # deterministic policy (kept)
├── deliberation.ts      # master-critic loop (kept)
├── sandbox.ts            # sandbox-exec profiles + agent-config seeding (merged)
├── providers.ts          # LLM provider detection (refactored)
├── prompts.ts            # all prompt builders (NEW, from executor.ts)
├── agent-command.ts      # single agent invocation registry (NEW)
├── transport.ts          # Transport interface + HeadlessTransport + HerdrTransport (NEW)
├── visibility.ts         # VisibilityLayer + NoopVisibility + HerdrVisibility (NEW)
├── herdr-client.ts       # raw socket client, no interactive injection (REWRITTEN)
├── master.ts             # master loop, no herdr coupling (REWRITTEN)
├── init.ts               # serf init flow + capability detection (NEW, merged)
└── strategies/
    ├── types.ts           # (kept)
    ├── index.ts           # (kept)
    ├── baseline.ts        # (kept)
    ├── retry-with-feedback.ts # (kept)
    └── prompt-variation.ts    # (kept)

tests/
├── board.test.ts          # (renamed from v2-board)
├── serf.test.ts           # (renamed)
├── budget.test.ts         # (renamed)
├── triage.test.ts         # (renamed)
├── critic.test.ts         # (renamed)
├── critic-multipass.test.ts
├── arbiter.test.ts        # (renamed)
├── deliberation.test.ts   # (renamed)
├── strategies.test.ts     # (renamed)
├── sandbox.test.ts        # (renamed)
├── providers.test.ts      # (renamed)
├── transport.test.ts      # NEW — fake transport, assert run() is called correctly
├── agent-command.test.ts  # NEW — assert invocations are correct per agent
└── prompts.test.ts       # NEW — assert prompts contain identity/goal/acceptance
```

## Implementation order

### Phase 1: Scaffolding (the seams)

1. Create `src/agent-command.ts` — registry + `buildInvocation`. Test it.
2. Create `src/transport.ts` — interface + `HeadlessTransport` (lift from `runHeadless`). Test with a fake agent script.
3. Create `src/visibility.ts` — `NoopVisibility` + `HerdrVisibility` skeleton.
4. Create `src/prompts.ts` — extract all prompt builders from executor.ts. Pure functions.
5. Create `src/herdr-client.ts` — strip herdr.ts to the socket client + `sendCommand` only. Delete `HerdrAgent`, `sendInput`, `sendPrompt`, `waitForDone`.

### Phase 2: Rewrite master

6. Rewrite `src/master.ts` — inject `Transport` and `VisibilityLayer`. Delete `HerdrHarness`, `processWithHerdr`, `processDirect`. One `processCard` function. Test with a `FakeTransport` that returns canned output.
7. Verify the funnel (triage → plan → execute → critique → arbiter → deliberate) runs end-to-end with `FakeTransport` and a mock critic.

### Phase 3: Flatten

8. Move all `src/v2/*.ts` to `src/*.ts` (the kept modules). Update all imports.
9. Move `src/v2/strategies/` to `src/strategies/`.
10. Rename all `tests/v2-*.test.ts` to `tests/*.test.ts`. Update imports.
11. Delete `src/v2/` directory. Delete old `executor.ts`, old `herdr.ts`, old `master.ts`.
12. Merge `capabilities.ts` into `init.ts`. Merge `agent-config.ts` into `sandbox.ts`.

### Phase 4: CLI

13. Rewrite `src/index.ts` — clean imports, typed commands, deduplicated help.
14. Update `package.json` — version `3.0.0` (or just `1.0.0` — the version number doesn't matter, the clean structure does).
15. Update `SERF.md` — minor edits to match the new transport model (one-shot commands, herdr for visibility only).

### Phase 5: Verify

16. `bun test` — all tests pass.
17. `bun build src/index.ts --outdir dist --target bun` — build succeeds.
18. `serf init` in a temp project — `.serf/` created correctly.
19. `serf task "add a hello function"` → `serf start --once` — one task flows through the funnel end-to-end with a real agent.
20. With herdr running: same task, verify the pane shows the one-shot command executing and the output file appearing.

## Key design decisions

1. **No version prefix.** The directory is `src/`, not `src/v3/`. If we rewrite again, we rewrite in place. Version prefixes create "don't touch" zones.

2. **One transport contract.** `Transport.run()` is the only way the master talks to an agent. Headless and herdr are interchangeable implementations. The master never imports herdr.

3. **herdr is visibility, not control.** herdr panes run the same wrapper script as headless mode — they just happen to be visible. No interactive TUI injection. No pane-buffer scraping. The output file is the completion signal in both cases.

4. **Prompts are pure functions.** No imports from transport, herdr, or state. Easy to test, easy to modify.

5. **The funnel is unchanged.** Triage → plan → execute → critique → arbiter → deliberate. These modules move as-is. The rewrite is about the transport and the structure, not the funnel logic.

6. **Tests use a FakeTransport.** The master loop is unit-testable without a terminal, a real agent, or herdr. This was impossible before because `processWithHerdr` and `processDirect` were hardcoded to real spawns.

## What this does NOT include

- No containerization (Apple Container / NanoClaw). That's a future `ContainerTransport` — the seam is ready.
- No provider failover or multi-provider orchestration. One provider, one model, working.
- no strategy ring expansion. The `strategies/` folder is kept as-is.
- No UI changes. The CLI is the interface.

## Success criteria

- [ ] `src/v2/` directory does not exist.
- [ ] No file or test has a `v2` prefix.
- [ ] `master.ts` has zero imports from `herdr-client.ts`.
- [ ] `master.ts` has zero `if (useHerdr)` branches.
- [ ] `master.ts` is under 450 lines.
- [ ] `index.ts` is under 350 lines.
- [ ] `bun test` passes with a `FakeTransport` — no real agent needed for unit tests.
- [ ] `serf init && serf task "test" && serf start --once` completes a task end-to-end.
- [ ] With herdr running, the same task shows in a pane and completes.
- [ ] `executor.ts` does not exist.
- [ ] `HerdrAgent` class does not exist.
- [ ] `sendInput`, `sendPrompt`, `typeText` do not exist in herdr-client.ts.