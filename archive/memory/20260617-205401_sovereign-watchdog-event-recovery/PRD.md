---
task: Full Implementation of Sovereign Watchdog and Event-Driven Recovery
slug: 20260617-205401_sovereign-watchdog-event-recovery
effort: advanced
phase: observe
progress: 0/0
mode: interactive
started: 2026-06-17T20:51:38Z
updated: 2026-06-17T20:54:01Z
---

## Context

User requested a full implementation of a **Sovereign Watchdog & Event-Driven Recovery** for the Serf agent harness. They asked for a review *before* building, with suggestions. The current state:

- `src/infrastructure/watchdog/SerfWatchdog.ts` (164 lines) exists — polling-based watchdog: every 30s, pings each running serf; if ping fails, attempts restart up to 3 times; logs via Logger; publishes nothing.
- `src/domain/ports/EventStream.ts` exists as a pure port with a rich EventType union including `serf.died`, `serf.restarted`, `coherence.degradation_detected`, `prune.*`, `referral.*`, `strategy.*`.
- `src/domain/ports/Clock.ts`, `Transport.ts`, `ChainEdgeRepository.ts` all exist; ports-only layer is complete.
- PLAN_FINAL.md "Production" phase (Phase 5) covers "Error handling, watchdog, config" and names this area MEDIUM priority.
- No tests for the watchdog. No EventStream wiring to the watchdog. No "event-driven recovery" — current recovery is a fixed-delay 3-attempt restart loop.

**Sovereign Watchdog** in the plan's spirit (per Kuramoto/pruning/seasons work) means: the watchdog is not a separate external monitor — it is a peer serf-like entity that participates in the same event stream, observes system-level signals (ψ degradation, dead serfs, chain failures, LLM API failures, autoresearch non-convergence), and triggers recovery actions that themselves emit events. "Sovereign" = makes local decisions and only refers upward when it cannot self-resolve.

**Event-driven recovery** means: recovery actions are subscribed to events rather than running on a blind timer. E.g., `coherence.degradation_detected` triggers un-prune proposal; `serf.died` triggers restart with backoff and event-logged rationale; `harvest.failed` triggers chain rewrite; `autoresearch.no_convergence` triggers stop-at-20.

### Review & Suggestions (per user request — review before build)

See "Review" subsection below.

## Criteria

_To be populated after the review is approved and we move to ISC generation._

## Decisions

_To be populated during BUILD._

## Verification

_To be populated during VERIFY._

## Context › Review

### What's already there

**SerfWatchdog.ts (164 lines)** is the current state. Key behaviors:

| Behavior | Current | Plan alignment |
|---|---|---|
| Trigger | `setInterval(30s)` blind poll | ❌ Not event-driven |
| Health check | `sendToSerf(session, "ping")` then `setTimeout(100ms)` then return `true` — **the ping is never actually verified; the function returns true unconditionally unless `sendToSerf` throws** | ❌ Bogus health check |
| Recovery | Create new tmux session via `createSerfSession`, write session file, log | ⚠️ Restarts but does not emit `serf.restarted` event, does not record context for postmortem |
| Restart cap | 3 attempts then gives up, logs error | ⚠️ No escalation — no `referral.board`, no alert webhook, no harvest retry wiring |
| Events | None — never touches `EventStream` | ❌ Violates Decision #7 "Event store is the backbone" |
| Clock | `new Date().toISOString()` directly | ❌ Violates Domain-zero-I/O (though it's infra, so technically OK, but untestable) |
| Tests | Zero | ❌ |
| Config | Hardcoded `DEFAULT_CONFIG` | ⚠️ No strategy.md integration, no per-cluster policy |
| Stats | In-memory only; survives across `check()` calls but not process restarts | ⚠️ No persistence |

### Critical problems (must fix in the implementation)

1. **`checkSerfHealth` is a no-op.** It sends "ping" then waits 100ms and returns `true`. The only failure mode is `sendToSerf` throwing. tmux will accept the keypress into a dead pane without throwing — so dead serfs will be reported healthy. **This is a correctness bug, not just a design gap.**
2. **No real liveness signal.** The plan names `waitForIdle` as the heuristic and explicitly flags it as a predicted bottleneck (review log item 2). The watchdog should use a stronger signal: pane content diff (did the pane change at all in the last N seconds?), or an explicit heartbeat file the serf writes, or the session's `lastActivity` timestamp.
3. **No event emission.** `serf.died` and `serf.restarted` are defined in `EventType` but never published. The dashboard, audit log, and pruning system all depend on these events.
4. **No escalation path.** After 3 failed restarts, the watchdog gives up. The plan's referral chain (`referral.local → referral.dept → referral.strategy → referral.board`) is not wired. A dead serf that can't be restarted should at minimum emit `prune.proposed` so the pruning system can decide whether to merge its role.
5. **No Clock port.** Using `new Date()` directly makes the watchdog untestable — the restart delay (5s) can't be fast-forwarded.
6. **No EventStream port.** The watchdog is the perfect first consumer of `EventStream.subscribe` — it should subscribe to `harvest.failed`, `coherence.degradation_detected`, `chain.step.completed` (to detect silent chains), etc. Right now it only knows about time passing.
7. **In-memory stats.** `restartCounts` and `stats` are lost on process restart. If the harness restarts, the watchdog forgets which serfs already failed 3 times — it will retry them forever. Must persist to disk (JSONL or state file).

### Architectural suggestions for the build

**A. Make the Watchdog a domain concept, not just infrastructure.**

Right now `SerfWatchdog` is purely in `src/infrastructure/`. The *policy* (when to restart, when to escalate, what counts as dead) is domain logic. Suggest split:

```
src/domain/watchdog/
  ├── WatchdogPolicy.ts     # pure: given (serfState, history, config, now) → Decision
  ├── WatchdogState.ts      # pure: restart counter state machine
  ├── RecoveryStrategy.ts   # pure: type union of recovery actions (restart | merge-role | refer-up | give-up)
  └── index.ts

src/infrastructure/watchdog/
  ├── SerfWatchdogRunner.ts   # was SerfWatchdog.ts; I/O only — polls, reads pane, calls policy, executes decision
  ├── HealthProbe.ts          # actual liveness check (pane-diff + heartbeat file + lastActivity age)
  └── RestartExecutor.ts      # tmux session recreate + session file write + event emit
```

This keeps the domain testable (policy decisions in pure functions) and the infrastructure thin.

**B. Make recovery event-driven, not just timer-driven.**

Keep a slow timer (60s) as a fallback "no events in a while, sanity check" — but wire the primary triggers as EventStream subscriptions:

| Event → Watchdog action |
|---|
| `harvest.failed` → record failure, check if responsible serf is still alive |
| `chain.step.completed` → reset that serf's "silent" counter |
| `serf.died` (from HealthProbe) → invoke WatchdogPolicy with "died" signal |
| `coherence.degradation_detected` → propose un-prune (this is plan-defined) |
| `prune.blocked` (Kuramoto check failed) → flag the would-be-retired serf as load-bearing |
| `autoresearch.no_convergence` → stop at 20 iterations (CLAUDE.md names this explicitly) |
| `llm.api.failed` (after RetryCircuitBreaker exhausts retries) → mark harvest failed, emit `harvest.failed` |

**C. Make "sovereign" mean local-first, refer-up-when-stuck.**

The watchdog should make as many decisions locally as possible:
- 1 failed restart → local, log it, continue
- 2 failed restarts → local, emit `prune.alerted` (observation), continue
- 3 failed restarts → local cap reached; **refer up** by emitting `referral.local` with evidence; the Strategy Evolver (when it exists) or a human receives it. Currently: just gives up silently. Replace with explicit handoff.
- Cluster ψ drops > 50% after a restart → emit `coherence.degradation_detected` and skip local recovery (plan says degradation skips levels).

**D. Persisted state.**

`~/.serf/watchdog/state.json` — `{ restartCounts: Record<serfName, {count, firstFailedAt, lastFailedAt}>, stats }`. Loaded on startup. This is the same pattern as `serf-identity.md` and `session.json` — per-entity state file.

**E. Tests.**

The plan says the domain layer should be testable with mocked ports. Watchdog tests should cover:
- Policy: dead serf with 0 prior restarts → Decision.restart
- Policy: dead serf with 3 prior restarts → Decision.referUp
- Policy: serf that just completed a chain step → Decision.healthy (don't restart)
- State machine: restart counter increments, resets after grace period
- HealthProbe: pane-diff detects dead serf (FakeTransport returns same pane content twice)
- HealthProbe: lastActivity age > threshold → dead
- Runner: emits `serf.died` then `serf.restarted` on successful restart
- Runner: emits `referral.local` when restart cap reached
- Runner: persists state across simulated restart (write state.json, reload, verify counts)

**F. Configuration surface.**

Per-cluster policy, not a single global config. The plan's `strategy.md` declares `grace_multiplier` per cluster. The watchdog should read that: a serf in a `grace_multiplier: 2.0` cluster gets 6 restart attempts, not 3. A serf in `grace_multiplier: 0.5` gets 1. This ties the watchdog into the strategy system instead of being a separate concern.

### What I'd build, in order

1. **Domain types** — `WatchdogPolicy`, `RecoveryStrategy`, `WatchdogState` (pure, no I/O). Tests.
2. **HealthProbe** (infrastructure) — uses `Transport.capturePane` + `Transport.waitForIdle` + reads `session.lastActivity` from state. Tests with `FakeTransport`.
3. **RestartExecutor** (infrastructure) — wraps `createSerfSession` + `writeSession` + `EventStream.append({type:"serf.restarted"})`. Tests with in-memory EventStream.
4. **SerfWatchdogRunner** (infrastructure) — the old `SerfWatchdog` renamed and slimmed. Owns the timer, owns EventStream subscriptions, calls policy, calls executor, persists state. Tests.
5. **Wire into CLI** — `serf watchdog status` (current stats), `serf watchdog start|stop`. Already partially there via the singleton export.
6. **EventStream integration** — subscribe to `harvest.failed`, `coherence.degradation_detected`, etc. This is what makes it "event-driven recovery" vs "timer-based restart".
7. **Migration** — delete the bogus `checkSerfHealth` (the 100ms-then-true function) and replace with `HealthProbe`. Existing callers of `watchdog.check()` keep working.

### Risks / open questions for you to decide

1. **Health signal strength.** Pane-diff is better than the current ping but still heuristic. A serf that's thinking (long LLM call) shows no pane change for 30s+. We need either (a) a heartbeat file the serf writes every N seconds (requires changing the serf prompt/system), or (b) a generous silence threshold (e.g., 120s of no pane change = dead). Which do you prefer?
2. **EventStream adapter.** The plan names `JsonlEventStream` but I see `src/infrastructure/EventBus.ts` and `src/infrastructure/adapters/JsonlEventStream.ts` both exist. Which is canonical? Should the watchdog use both (in-memory bus for subscriptions + JSONL for persistence)?
3. **"Sovereign" scope.** Do you want the watchdog to also own: (a) harvest retry on failure (CLAUDE.md says "Retry 2x, mark failed, continue" — currently not implemented anywhere I can see), (b) LLM API failure handling (RetryCircuitBreaker exists — should the watchdog subscribe to its events?), (c) all-serfs-dead alert (CLAUDE.md says "Alert, fail harvest")? Or just serf death/restart for now?
4. **Strategy.md integration.** Should the watchdog read `~/.serf/company/strategy.md` for `grace_multiplier` per cluster in this pass, or defer until the Strategy Evolver exists? I'd defer — the StrategyBoard isn't implemented yet.
5. **Domain layer split.** Do you agree with splitting `WatchdogPolicy` into `src/domain/watchdog/`? Alternative: keep it all in infrastructure with a pure helper module. The domain split is more aligned with the plan but adds files.

### Effort level proposal

**Advanced** (24-48 ISC, <16min budget). This is multi-file, multi-layer work (domain + infrastructure + tests + wiring). It touches the event system, the persistence layer, the CLI, and the existing watchdog. Standard (8 ISC) would under-scope it; Extended (16 ISC) would miss the event-driven subscription wiring and the domain/infra split.

### Capabilities I'd select (pending your approval)

- **FirstPrinciples** (OBSERVE) — decompose "sovereign watchdog" to its axioms: what is the minimum viable set of decisions a watchdog must make?
- **IterativeDepth** (THINK) — pressure-test the policy from multiple angles (what about partial failures? cascading failures? watchdog itself dying?)
- **RedTeam** (THINK) — attack the recovery strategy: what kills it? (watchdog dies → who watches the watchdog? infinite restart loop → resource exhaustion? partial pane change → false negative?)
- **CreateCLI** (BUILD) — the `serf watchdog status|start|stop` commands
- **/simplify** (VERIFY) — review the watchdog code for quality, reuse, efficiency after build