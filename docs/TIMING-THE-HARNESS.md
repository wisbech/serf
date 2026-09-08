# Timing the Harness — From Hard Timeouts to Adaptive Budgets

> Status: design note
> Date: 2026-09-08

## 1. The problem

Serf currently uses **hard timeouts** as a safety net: a 15-minute council cap, a 5-minute stale threshold, a 120s plan timeout. These are guesses. They prevent hangs, but they don't reflect how long a task *should* take, and they don't adapt to the task, the model, or the project.

The goal: serf should be a **self-evolving harness** that times itself against *observed reality*, not fixed constants — and that spawns the right bot for the work at hand.

## 2. How grok-build times things

From grok-build's model, the key insight is **turn-based, not wall-clock-based**:

- **`--max-turns N`** — the agent gets N *agentic turns* (each turn = one tool call + one model response). This is the primary budget. It's not "N seconds," it's "N decisions."
- **`--max-turns` is the hard stop** — the agent self-corrects within its turn budget, then stops. No wall-clock guessing.
- **`--always-approve`** — removes the human-in-the-loop latency, so turns are the only pacing.
- **`--reasoning-effort`** — lets you trade depth for speed per model.
- **`--session-id` / `--resume`** — a task can span sessions without losing context, so a "long" task isn't a timeout, it's a continuation.

The crucial difference: grok-build measures **progress in turns**, and a turn is a *discrete unit of work*. Serf measures **progress in wall-clock seconds**, which conflates "thinking" with "stuck."

## 3. What serf should adopt

### 3.1 Turn-based budgets instead of wall-clock timeouts

Replace the fixed `timeoutMs` with a **turn budget** per phase:

| Phase | Current (wall-clock) | Proposed (turns) |
|---|---|---|
| plan | 120s | 3 turns |
| execution | 600s | 8 turns |
| self-correct | 3 turns (already) | keep |
| council | 15m hard cap | `maxRounds` (already) + per-round turn cap |

A "turn" is: the agent made progress (wrote a file, ran a command, produced output). If the agent produces **no new output** for N turns, it's stuck — not thinking.

### 3.2 Progress-based staleness (not fixed 5-min)

Instead of "5 minutes with no change = stale," use: **"no new output for N consecutive turns = stuck."** This adapts naturally — a slow model on a hard task produces output every turn, so it's never falsely killed; a stuck agent produces nothing and is killed quickly.

### 3.3 Adaptive budgets from the track record

Serf already records every outcome (`track-record.ts`). Use it to **learn** how long each task type takes:

- Cluster tasks by keyword (already done in `maturity.ts`).
- Record `{ taskType, turnsUsed, outcome }` per run.
- Next time a similar task appears, set its budget to the **p90 of past successful runs** for that task type, not a global constant.

This is the "self-evolving" part: the harness learns its own timing from its own history.

### 3.4 Escalation on stuck, not on timeout

The current model: "timeout → fail." The better model: "stuck (no progress for N turns) → **escalate to a more capable serf**" (the debugger serf we already built), and only if *that* fails → file an issue. This matches the dev-team model: a junior dev who's stuck escalates to a senior, not a timeout.

## 4. The self-evolving harness

The vision: serf spawns the right bot for the work, times it against reality, and learns.

```
Task arrives
  → estimate task type (maturity.ts)
  → pick model from track record (allocator.ts: bestModelForTask)
  → set turn budget from p90 of past similar tasks
  → run actor (turn-bounded)
  → if stuck (no progress N turns) → debugger serf
  → if still stuck → file issue for a software serf
  → record outcome + turnsUsed → update track record
```

Each loop iteration makes the next one smarter: better model, better budget, better escalation.

## 5. Concrete changes (in priority order)

1. **Add a `turns` counter to `ActorRunResult`** — count discrete outputs (file writes, command runs) per run.
2. **Replace `timeoutMs` with `maxTurns`** in `RunOpts` — the transport stops the agent after N turns of no progress.
3. **Record `turnsUsed` in `track-record.ts`** alongside outcome.
4. **Add `p90TurnsForTask(taskType)`** to `maturity.ts` — read from track record.
5. **Wire the budget** in `processCard`: `maxTurns = p90TurnsForTask(card) || default`.
6. **Keep a generous wall-clock ceiling** as a *last resort* (not the primary), so a genuinely hung process can't block forever — but make it 10x the expected, not a guess.

## 6. What we keep

- The **hard timeout stays** as a safety net, but it becomes a *backstop* (10x expected), not the primary mechanism.
- The **debugger serf** and **issue filing** stay — they're the escalation path for "stuck," which is the real signal.

## 7. Open questions

1. **What counts as a "turn"?** A file write? A command run? A model response? (I'd say: any observable output — file write, command output, or a new message.)
2. **How to detect "no progress"?** Compare output file size / mtime between turns. If unchanged for N turns, stuck.
3. **Should the turn budget be per-phase or per-card?** (I'd say per-phase, so plan doesn't eat execution's budget.)

## 8. The north star

Serf should be the harness that **makes bots according to the need of the service** — spawning a lightweight actor for a routine, a debugger for a stuck task, a software serf for a hard one — and **times itself against its own history**, not against constants. The track record is the memory; the maturity ladder is the evolution; the turn budget is the clock.
