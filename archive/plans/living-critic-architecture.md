# The Living Critic: Making Serf a Genius Dark Factory Loop Harness

## Date
2026-06-24

## Status
Proposal — awaiting implementation. Synthesizes ENPIRE (NVIDIA/CMU/Berkeley 2026) with the GeniusMachine's five-mechanism self-improvement analysis and the companion recommendation at `.serf/knowledge/skills/serf-loop-upgrade-recommendation.md`.

## The Problem (observed in this codebase)

The critic does not come in and act in the loop. It is a function call, not an agent.

In `src/v2/master.ts:226` the loop invokes `critique(card.task, execResult.output, card.acceptance)` inline, reads a single verdict, and branches on a self-assessed confidence score:

```
src/v2/master.ts:226   const { verdict } = await critique(card.task, execResult.output, card.acceptance);
src/v2/master.ts:229   const outcome = classifyVerdict(verdict);
src/v2/critic.ts:99    isHighConfidenceFail(verdict)  → verdict.verdict === "fail" && verdict.confidence > 0.7
src/v2/critic.ts:103   isPass(verdict)                → verdict.verdict === "pass" && verdict.confidence > 0.7
```

Five structural defects follow from this:

1. **No verification of successful tasks.** The critic only fires when `master.ts` calls it. Once a verdict says `pass` + `confidence > 0.7` (`master.ts:231`), nobody re-checks. A lenient pass is locked in.
2. **No calibration over time.** Each `critique()` call (`src/v2/critic.ts:78`) is stateless. The critic never reads its own past verdicts. It cannot detect that it has drifted lenient or harsh.
3. **No curiosity.** The critic has no way to say "I'm uncertain here, look deeper." `isLowConfidence` (`critic.ts:107`) routes uncertainty to human review and stops — it does not trigger deeper evaluation.
4. **Confidence is PQD.** `verdict.confidence` is an LLM self-assessed float that has stopped being recognized as a representation of quality. The GeniusMachine field notes confirmed this: scores clustered at 0.82-0.85 with a 0.5 task passed despite being underdeveloped (`.serf/knowledge/failures/self-critique-not-adversarial-enough.md`, here and in GeniusMachine).
5. **No taste encoding.** The user has no seat at a decision boundary. `Card.feedback` (`board.ts:21`) accepts only `accept | refine` — a binary after the fact, not a preference at the edge where the system is uncertain.

## The Reference: ENPIRE

ENPIRE (NVIDIA GEAR / CMU / UC Berkeley, 2026) is a harness for coding agents that achieves 99% pass@8 on real-world dexterous manipulation (PushT, pin insertion, zip-tie cutting, GPU insertion) by closing one loop:

```
EN  Environment    auto-reset, auto-verify, auto-log — the environment decides pass/fail
PI  Policy Improvement   generate/revise policy code from rewards, videos, traces, failures
R   Rollout         run budgeted trials, preserve state/action/video/result for audit
E   Evolution       compare branches, reuse successful recipes, prune failed hypotheses
```

The load-bearing sentence from the paper: *"The missing abstraction to automate robotics research is a repeatable feedback loop for real-world policy improvement: reset the scene, execute a policy, verify the outcome, and refine the next iteration."*

The missing abstraction in serf is the same shape: a repeatable feedback loop for continuous quality improvement, not triggered evaluation. ENPIRE makes the environment the critic (binary reward, no subjective score). We cannot go fully binary — serf outputs are prose/code, not robot trials — but we can steal the architecture: make verification continuous, multi-pass, and self-calibrating, and make the critic a subscriber rather than a callee.

## Mapping ENPIRE to Serf

| ENPIRE module | Serf current (file:line) | Serf proposed |
|---|---|---|
| EN (Environment) | `board.ts` Card + `acceptance: string[]` | Card + acceptance + optional runnable test + auto-reset of card to in-progress on retry |
| PI (Policy Improvement) | `executor.ts:82` `buildAgentPrompt` feeds `spawnAgent` | unchanged — agent still executes; feedback now carries curiosity points, not just "issues" |
| R (Rollout) | `master.ts:226` single `critique()` call | `criticMultipass()` — N independent passes, agreement rate replaces confidence |
| E (Evolution) | `master.ts:259` `maybeSpawnSerf` (spawns on friction only) | `evolution.ts` — compare branches across attempts, reuse winning recipes, prune losing serf identities, track Mean Token Utilization |

The piece serf is missing entirely is **E**. `maybeSpawnSerf` (`master.ts:259`) reacts to a single failure by spawning a specialist. It never compares the specialist's later performance against the generalist it replaced, never reuses a winning recipe across cards, and never prunes a serf that underperforms. ENPIRE's evolution module is exactly this branch-level bookkeeping.

## The Five Mechanisms (Glück, applied)

The GeniusMachine analysis (`how-can-a-genius-machine-leverage-itself-to-progra-mqr5zjj3.md`) identifies five mechanisms that compose into one recursive loop. Each maps to a concrete change in this codebase.

### Mechanism 1 — Generator/Critic with architectural separation

The KQ primitive: a generator produces a representation; a critic tests it against reality. Schmidhuber's controller/world-model (1990) makes the separation explicit — two networks, two objectives, adversarial tension. Their disagreement, not their agreement, drives improvement.

Current serf: `critic.ts:78` `critique()` calls the same `callLLM` (`llm.ts:64`) with a different prompt. Self-critique is lenient by construction. The fix is not "be more hostile in the prompt" — it is architectural: the critic must be a separate process that subscribes to events, not a function the loop calls.

### Mechanism 2 — Artificial curiosity (Schmidhuber 1990)

The system does not wait for external tasks to find its own defects. It generates its own. Curiosity = prediction error between the world model's forecast and the actual outcome. Large error = defective model region = the edge where learning happens.

Operationalized for serf: run the critic N times on the same output. The **disagreement rate between passes** is the curiosity signal. It is a measurable property of the system, not a theory about quality. High agreement = clear verdict. High disagreement = the system has found a boundary where its model is weak — exactly where human judgment is most valuable.

### Mechanism 3 — Epiplexity-guided selection (Finzi et al. 2025)

Not all feedback is equally learnable. High-entropy data is surprising but not necessarily transferable. High-epiplexity data contains structural content the system can incorporate. The `.serf/knowledge/` folder already embodies this: `skills/` (transferable patterns), `failures/` (diagnosed causes), `patterns/` (recurring solutions). The evolution module must prefer these over raw event-log noise when deciding what to learn from.

### Mechanism 4 — Hierarchical model improvement (Jordan)

PQD exists at three levels simultaneously. The loop must detect and resolve it at all three:

- **Task level** — serf output fails acceptance. Current loop handles this (`master.ts:229`).
- **Process level** — the serf's method (persona, lever, measurement) is itself a representation that may carry PQD. `maybeSpawnSerf` (`master.ts:259`) gestures at this but never reviews whether the spawn helped.
- **System level** — the critic's criteria, the board structure, the protocol are also representations. The discovery that self-critique is not adversarial enough (`failures/self-critique-not-adversarial-enough.md`) is a system-level PQD detection. Currently nothing in the loop acts on it.

Each level must generate feedback for the level above. This is the recursion that compounds.

### Mechanism 5 — Interpretable critics (KANs, Liu et al. 2024)

A black-box critic that outputs "fail" is useful. A glass-box critic that outputs "fail because your representation conflates X with Y" is the KQ operation: it makes the non-identity visible, which is precisely what enables correction. The per-criterion YES/NO/CANNOT_EVALUATE format already adopted in GeniusMachine's `critic.py` is a step toward this. Serf's `critic.ts` still uses the legacy generic-axes format (`critic.ts:26-30`: Accuracy / Completeness / Coherence / Reality contact). Adopting per-criterion evaluation is prerequisite to the rest.

## The Proposed Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     EVENT STREAM (append-only JSONL)              │
│                   src/v2/events.ts — the nervous system           │
│                                                                  │
│  task.started ──┐                                                │
│  task.completed ┼──→ CriticDaemon (subscriber, new)             │
│  critic.verdict ─┤       │                                       │
│  critic.curiosity─┤      ├── on_task_started: pre-load criteria   │
│  user.preference─┤       ├── on_task_completed: verify independently│
│  knowledge.update─┘      ├── on_critic_verdict: calibrate          │
│                          ├── on_curiosity: multi-pass + preference│
│                          ├── on_knowledge: refine eval patterns    │
│                          └── on_schedule: audit past verdicts      │
│                                                                  │
│  ┌──────────┐    ┌────────────┐    ┌──────────┐                   │
│  │  Agent   │    │   Critic    │    │   User   │                   │
│  │(executes)│    │ (evaluates)│    │ (prefers)│                   │
│  └────┬─────┘    └─────┬──────┘    └────┬─────┘                   │
│       │  output         │  verdict        │  preference            │
│       ▼                 ▼                ▼                        │
│  ┌──────────────────────────────────────────────────────┐         │
│  │              KNOWLEDGE BASE (.serf/knowledge/)        │         │
│  │  skills/ patterns/ failures/ preferences/  (new)      │         │
│  └──────────────────────────────────────────────────────┘         │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐         │
│  │           CRITIC DAEMON (continuous, new)             │         │
│  │  1. Watch event stream (events.ts queryEvents)        │         │
│  │  2. On task completion: verify independently          │         │
│  │  3. On verdict: calibrate against own assessment     │         │
│  │  4. On curiosity: run multi-pass + emit preference    │         │
│  │  5. On preference: refine evaluation patterns        │         │
│  │  6. On schedule: audit past verdicts for drift       │         │
│  │  7. Propose threshold adjustments (meta tasks)       │         │
│  │  8. Generate evolution tasks (branch comparison)     │         │
│  └──────────────────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────────────────┘
```

## The Components (TypeScript, for this codebase)

### 1. Per-criterion critic — upgrade `src/v2/critic.ts`

Replace the generic-axes prompt (`critic.ts:15-38`) with per-criterion YES/NO/CANNOT_EVALUATE, mirroring GeniusMachine `critic.py:21-48`. This is the prerequisite for everything else — you cannot compute per-criterion disagreement from generic axes.

```typescript
// critic.ts — new prompt shape
export function buildCritiquePrompt(task: string, output: string, acceptance: string[]): string {
  const criteriaBlock = acceptance.map((c, i) => `CRITERION ${i+1}: ${c}`).join("\n");
  return `You are a hostile adversary. Find reasons to FAIL this output. You do NOT suggest improvements. You do NOT give partial credit. You ONLY identify divergences.

TASK: ${task}

ACCEPTANCE CRITERIA (each must be individually satisfied):
${criteriaBlock}

OUTPUT TO EVALUATE:
${output.slice(0, 3000)}

For EACH criterion answer YES (satisfied, with evidence) | NO (not satisfied, with evidence) | CANNOT_EVALUATE (cannot judge from output alone).

CRITERION 1: <criterion text>
ANSWER: YES | NO | CANNOT_EVALUATE
EVIDENCE: <specific quote or reference>

[...one block per criterion]

VERDICT: pass | fail
REASONING: <one sentence>`;
}
```

`parseVerdict` (`critic.ts:62`) gains a per-criterion path with the same confidence semantics as GeniusMachine `critic.py:161-232`: pass confidence = yes/evaluable; fail confidence = no/total floored at 0.7; all-CANNOT_EVALUATE = fail at 0.3. Keep the legacy regex path as fallback.

### 2. Multi-pass critic — new `src/v2/critic_multipass.ts`

```typescript
export interface MultiPassVerdict {
  finalVerdict: "pass" | "fail";
  agreementRate: number;        // replaces confidence — majority / n
  curiosity: number;            // 1 - agreementRate
  passCount: number;
  failCount: number;
  verdicts: CriticVerdict[];
  curiosityPoints: CuriosityPoint[];  // criteria with low agreement
  effort: "quick" | "standard" | "thorough" | "maximum";
}

export interface CuriosityPoint {
  criterion: string;
  agreement: number;            // per-criterion agreement rate
  answers: ("YES" | "NO" | "CANNOT_EVALUATE")[];
}

const EFFORT_PASSES = { quick: 1, standard: 3, thorough: 5, maximum: 10 };

export async function critiqueMultipass(
  task: string, output: string, acceptance: string[],
  effort: keyof typeof EFFORT_PASSES = "standard",
): Promise<{ verdict: MultiPassVerdict; results: CallLLMResult[] }> {
  const n = EFFORT_PASSES[effort];
  const verdicts: CriticVerdict[] = [];
  const results: CallLLMResult[] = [];
  for (let i = 0; i < n; i++) {
    const { verdict, result } = await critique(task, output, acceptance);
    verdicts.push(verdict);
    results.push(result);
  }
  const passCount = verdicts.filter(v => v.verdict === "pass").length;
  const failCount = n - passCount;
  const agreementRate = Math.max(passCount, failCount) / n;
  const curiosityPoints = computeCuriosityPoints(verdicts); // needs per-criterion parse
  return {
    verdict: {
      finalVerdict: passCount > failCount ? "pass" : "fail",
      agreementRate,
      curiosity: 1 - agreementRate,
      passCount, failCount, verdicts, curiosityPoints, effort,
    },
    results,
  };
}
```

Disagreement is self-anchoring (Glück): it does not require a higher model to validate it. It is a measurable property of the system. This is why it replaces `verdict.confidence`.

### 3. Curiosity signal + preference tasks — new `src/v2/preference.ts`

When `curiosity > curiosityThreshold` (default 0.5), the system does not route to human review and stop. It generates a preference task at the curiosity point and keeps the loop alive.

```typescript
export function generatePreferenceTask(
  card: Card, point: CuriosityPoint, outputA: string, outputB: string,
): Card {
  return addTask(
    `Preference: ${point.criterion.slice(0, 40)}`,
    `The critic is uncertain whether '${point.criterion}' is satisfied.\n\nOption A:\n${outputA.slice(0, 500)}\n\nOption B:\n${outputB.slice(0, 500)}\n\nWhich better satisfies '${point.criterion}'? Reply A, B, 'both fine', or 'neither'.`,
    [
      "Response is A, B, 'both fine', or 'neither'",
      "Preference is grounded in the specific criterion",
    ],
  );
}

export function recordPreference(criterion: string, preference: string): void {
  appendEvent("user.preference", { criterion, preference });
  // write to knowledge/patterns/preference-<slug>.md — taste accumulates as knowledge
}
```

Humans are reliable at comparative judgment, not absolute scoring (Thurstone). Each preference narrows the boundary for future evaluations at that criterion. This is where taste enters the system — not as a score, but as a preference at the exact point where the system is uncertain.

### 4. Critic daemon — new `src/v2/critic_daemon.ts`

A subscriber that watches the event stream and reacts autonomously. It does not replace the inline `critique()` call in `master.ts:226` — that stays as the first-pass fast path. The daemon adds the continuous layer on top.

```typescript
export class CriticDaemon {
  private handlers: Record<string, (e: SerfEvent) => void | Promise<void>> = {
    "task.completed": this.onTaskCompleted.bind(this),
    "critic.verdict": this.onCriticVerdict.bind(this),
    "user.preference": this.onUserPreference.bind(this),
    "knowledge.update": this.onKnowledgeUpdate.bind(this),
  };

  onTaskCompleted(e: SerfEvent): Promise<void> {
    // ENPIRE 'E' module: verify outcomes, don't just accept them.
    // Re-read the output + criteria. Run a multi-pass verification.
    // If disagreement with the loop's verdict: emit critic.verification event,
    // move card back to in-progress if the loop was lenient.
  }

  onCriticVerdict(e: SerfEvent): void {
    // Track calibration: compare this verdict with a sample of past verdicts.
    // Detect systematic drift (leniency/harshness) over a rolling window.
    // On drift: emit critic.calibration, generate a meta-task to adjust threshold.
  }

  async poll(since?: string): Promise<void> {
    const events = queryEvents(undefined, 100); // since last ts
    for (const e of events) {
      const h = this.handlers[e.type];
      if (h) await h(e);
    }
  }
}
```

The daemon runs as `serf watch` (new CLI command). It is the "living" part — the critic that watches continuously, verifies independently, calibrates against its own history, and generates evolution tasks. This is what closes the gap the user observed: the critic that "does not come in and act in the loop."

### 5. Evolution module — new `src/v2/evolution.ts`

ENPIRE's E module. Compares branches (different serf approaches to the same task family), reuses winning recipes, prunes losing identities.

```typescript
export interface BranchResult {
  serfName: string;
  cardId: string;
  agreementRate: number;
  curiosityPoints: number;
  tokensUsed: number;
  attempt: number;
}

export function compareBranches(a: BranchResult, b: BranchResult): {
  winner: "a" | "b";
  reason: string;
} {
  // ENPIRE compares by success rate. We compare by agreement rate, weighted
  // by token cost (Mean Token Utilization analogue).
  const scoreA = a.agreementRate / (a.tokensUsed || 1);
  const scoreB = b.agreementRate / (b.tokensUsed || 1);
  return {
    winner: scoreA >= scoreB ? "a" : "b",
    reason: `Agreement/token A=${scoreA.toFixed(6)} vs B=${scoreB.toFixed(6)}`,
  };
}

export function maybeRetireSerf(name: string, window: BranchResult[]): boolean {
  // If a serf consistently loses branch comparisons over a rolling window,
  // move its identity from serfs/ to knowledge/retired/. The master's
  // attention IS the pruning signal (SERF.md:246).
}
```

### 6. Meta-task generation — new `src/v2/meta.ts`

Mirrors GeniusMachine `meta.py:233`. After every N completed tasks, generate self-improvement task cards targeting the machine's own state: threshold adjustment, failure-pattern fixes, identity review. The loop processes these through the same `processCard` path — the machine programs itself by treating its own improvement as just another task.

```typescript
export function generateMetaTasks(completedCount: number, interval = 5): string[] {
  if (completedCount === 0 || completedCount % interval !== 0) return [];
  const verdicts = queryEvents("critic.verdict", 50);
  const failures = listKnowledgeFailures();
  const generated: string[] = [];
  const thresholdTask = generateThresholdTask(verdicts);   // tighten/loosen based on pass rate
  const failureTask = generateFailureTask(failures);       // fix recurring failure pattern
  const identityTask = generateIdentityReviewTask();        // review a serf's persona
  for (const t of [thresholdTask, failureTask, identityTask]) {
    if (t) { const c = addTask(t.title, t.task, t.acceptance); generated.push(c.id); }
  }
  return generated;
}
```

### 7. Threshold file — `.serf/critic/thresholds.md`

Replaces the hardcoded `0.7` in `critic.ts:99,103,107,114-116` with a configurable, self-adjusting threshold.

```markdown
# Critic Thresholds

## Agreement threshold
0.7

## Effort levels
- quick: 1 pass (routine tasks)
- standard: 3 passes (default)
- thorough: 5 passes (critical tasks)
- maximum: 10 passes with adversarial judges

## Curiosity threshold
0.5
Criteria with agreement rate below 0.5 are curiosity points
and generate preference collection tasks for the user.
```

### 8. Loop change — `src/v2/master.ts`

The core loop (`master.ts:197-255` `processDirect`) gains a three-way branch on agreement instead of confidence:

```
pick_task → execute → critiqueMultipass →
  if agreement >= 0.7 AND verdict == pass → done
  if agreement >= 0.7 AND verdict == fail → feedback, retry (max 3)
  if agreement < 0.5                    → generate preference task (curiosity point)
  if 0.5 <= agreement < 0.7             → preference task + retry with feedback
```

The 3-fail rule (`master.ts:190-192`) is preserved. The middle zone (0.5-0.7) now generates preference tasks instead of going straight to human review — the user gets a seat at the decision boundary.

### 9. CLI — `src/index.ts`

New commands:
```
serf watch      # start the critic daemon (continuous verification + calibration)
serf verify <card-id>   # independently verify a completed task
serf calibrate  # audit past verdicts for calibration drift
serf prefer <card-id> <A|B|both|neither> <criterion>   # record a preference
```

## What This Removes

1. **Confidence scores as the decision signal** — replaced by agreement rate (measurable, not self-assessed). The `0.7` constants in `critic.ts:99,103,107,114-116` become a configurable threshold driven by calibration.
2. **Single-pass evaluation** — replaced by N passes with a curiosity signal.
3. **The PQD of confidence** — the score "0.85" that looked like quality but was a model of quality.
4. **Stateless criticism** — the daemon gives the critic memory across tasks.
5. **Reactive-only spawning** — `maybeSpawnSerf` (`master.ts:259`) gains an evolution partner that prunes and compares.

## What This Preserves

1. **The KQ operation** — the critic still tests representation against reality.
2. **The folder IS the state** — no daemon database; the daemon reads the same `.serf/` the loop does.
3. **The 3-fail rule** — defective tasks still surface.
4. **Budget as hard stop** — `BudgetTracker` (`llm.ts:15`) still bounds every call, including multi-pass.
5. **herdr optional** — the daemon works in direct mode; herdr mode just gets an extra pane.

## What This Adds

1. **Curiosity signal** — disagreement between passes tells the system where it is uncertain.
2. **Taste encoding** — user preferences at decision boundaries, accumulated as `knowledge/patterns/preference-*.md`.
3. **Branch comparison** — evolution module from ENPIRE, comparing serf approaches.
4. **Effort levels** — quick/standard/thorough/maximum, matching the agent's own effort system.
5. **Mean Token Utilization** — ENPIRE's MTU analogue: tokens per successful task, tracked per branch.
6. **Continuous verification** — completed tasks get independently re-checked by the daemon.
7. **Calibration drift detection** — the critic audits its own past verdicts.
8. **Self-generated improvement tasks** — the machine programs itself by treating its own improvement as a task.

## Implementation Order

1. **`src/v2/critic.ts`** — adopt per-criterion YES/NO/CANNOT_EVALUATE prompt + parser (port from GeniusMachine `critic.py:21-232`). Prerequisite for everything.
2. **`src/v2/critic_multipass.ts`** — N-pass evaluation, agreement rate, curiosity points.
3. **`src/v2/master.ts`** — replace `critique()` with `critiqueMultipass()` at `master.ts:226`; three-way branch on agreement.
4. **`.serf/critic/thresholds.md`** — agreement + curiosity + effort config.
5. **`src/v2/preference.ts`** — A/B preference task generation + recording.
6. **`src/v2/critic_daemon.ts`** — event subscriber, continuous verification + calibration.
7. **`src/v2/evolution.ts`** — branch comparison, recipe reuse, serf retirement.
8. **`src/v2/meta.ts`** — meta-task generation after every N passes.
9. **`src/index.ts`** — `watch`, `verify`, `calibrate`, `prefer` commands.
10. **Tests** — `tests/v2-critic-multipass.test.ts`, `tests/v2-critic-daemon.test.ts`, `tests/v2-evolution.test.ts`, `tests/v2-preference.test.ts`.
11. **Knowledge** — write the new patterns this produces back to `.serf/knowledge/skills/`.

## The Threshold (Glück)

Glück identifies a threshold below which the operation fails to take hold: the actor does not perceive the non-identity, or perceives it and rationalizes it, or perceives it and is destabilized without forming a viable successor. For an artificial system, three components:

1. **Perception** — the system must detect PQD. Requires an architecturally separate, adversarially motivated critic — not the same model grading its own work with a different prompt.
2. **Honesty** — the system must not rationalize divergence away. The critic must test structural correspondence, not aesthetic quality. It must be immune to fluency, confidence, and surface coherence.
3. **Successor formation** — the system must produce a viable successor. Not just "this is wrong" but a representation that incorporates the divergence and survives the same test.

Current serf: partially meets (1) — the prompt is different but the model and process are the same. Fails (2) — confidence scores reward fluency. Meets (3) — the retry loop does form successors.

Crossing the threshold requires: architectural separation of critic from generator (the daemon), making the critic's objective PQD detection rather than surface evaluation (per-criterion YES/NO with evidence), and replacing self-assessed confidence with measurable disagreement.

## What Compounding Looks Like

Below the threshold: diminishing returns. The system gets slightly better at what it already does, but the frame remains fixed. This is the linear regime — addition without removal.

Above the threshold: increasing returns. Each correction changes the system's capacity to detect future defects. The compounding is not in the size of the improvement but in the system's ability to improve. "The capacity to improve improves" (Glück 2025).

First cycle: catches gross misalignment ("the acceptance criterion is circular"). Second cycle: catches subtler misalignment ("the critic evaluates surface fluency, not structural correspondence"). Third cycle: catches something subtler still ("the system's notion of 'structural correspondence' is itself a representation that may carry PQD"). Each cycle, PQD detection becomes finer. The compounding accelerates.

This is how serf becomes a genius dark factory loop harness: not by adding capabilities, but by removing the invisible constraints — starting with the constraint that the critic is a function call instead of an agent.

## References

- Glück, T.R. (2025). "The Genius Machine: Knowledge Quality and the Recursive Increase of Intelligence and Creative Power." immanait Strategy Series. Zenodo: 20579722.
- Xiao, W., Xie, J., Zhang, T., Lin, H., Fu, L., Xue, H., et al. (2026). "ENPIRE: Agentic Robot Policy Self-Improvement in the Real World." NVIDIA GEAR / CMU / UC Berkeley. https://research.nvidia.com/labs/gear/enpire/
- Finzi, M., Qiu, S., Jiang, Y., Izmailov, P., Kolter, J.Z., Wilson, A.G. (2025). "From Entropy to Epiplexity." arXiv:2601.03220.
- Jordan, M.I. et al. "Hierarchical Dirichlet Processes." Berkeley.
- Liu, Z. et al. (2024). "KAN: Kolmogorov-Arnold Networks." arXiv:2404.19756.
- Schmidhuber, J. (1990/2022). Controller/world-model architecture; artificial curiosity as intrinsic motivation. IDSIA.
- Companion recommendation: `.serf/knowledge/skills/serf-loop-upgrade-recommendation.md` (GeniusMachine).
- Five-mechanism analysis: `how-can-a-genius-machine-leverage-itself-to-progra-mqr5zjj3.md` (GeniusMachine).