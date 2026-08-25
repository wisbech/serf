# Serf Improvement Plan
## Containerization, Budget Control, and Funnel-Based Problem Gauging

### Prepared: 2026-07-01
### Status: Draft — pending user review

---

## 1. The Concerns, Restated

You raised three interrelated problems with the current serf system:

1. **Environment leakage / permission friction**: The actor keeps hitting opencode permission prompts for `/tmp` and external directories. Containerization was suggested so the agent has no access outside its sandbox, eliminating prompts and making behavior reproducible.
2. **Budget hammer is not taken seriously**: The `BudgetTracker` exists but actors and the master loop treat it as advisory. Long runs consume tokens without a hard funnel that gauges whether a task is even tractable before committing full resources.
3. **Tokenmaxxing / no funnel approach**: Tasks are thrown at a single powerful agent without a cheap triage phase. We risk burning large context windows on problems that should be rejected, narrowed, or escalated to the user after a cheap first pass.

These are not separate bugs. They are symptoms of one design gap: **serf has no staged execution model**. Every task immediately enters the most expensive mode (herdr + full context + retries). The environment is wide open. There is no cheaper filter before the expensive work begins.

---

## 2. First-Principles Deconstruction

### What is actually happening?

| Stated component | Actual constituents |
|------------------|---------------------|
| "Actor runs in a worktree" | Actor runs in a git worktree that still sees the host filesystem, home directory, `/tmp`, global tools, and network. The worktree is an isolation of *git state*, not *runtime state*. |
| "Budget tracker prevents tokenmaxxing" | A token/cost counter that logs usage and stops when exceeded. It does not shape *which* work happens, only how long it can continue. |
| "GAN critic enforces quality" | One critic pass or a few multipass runs at the *end* of an attempt. It does not catch over-scoped or ill-defined tasks early. |
| "Master loop processes tasks" | FIFO pull from board with retry loop. No triage, no difficulty estimate, no escalation path before launch. |

### Fundamental truths (irreducible)

1. **LLM calls cost tokens and time** — this is a real budget with a hard ceiling.
2. **Not every task is well-defined** — some cards are vague, impossible, or require user clarification.
3. **Agents behave differently in constrained environments** — smaller context, narrower filesystem access, and explicit tool boundaries reduce drift and permission noise.
4. **Reproducibility requires controlled inputs** — if `/tmp`, `~/.config`, and host network are reachable, the agent's behavior depends on host state.
5. **Critic needs evidence** — the anti-cheating work we already did is correct, but it can only evaluate what the actor produces, not whether the task should have been attempted.

---

## 3. Proposed Architecture: Funnel + Sandbox + Hard Budget

The honest fix is to add **three gates** before the expensive actor-critic loop runs:

```
Incoming task
    │
    ▼
┌─────────────────────────────────────┐
│ Gate 0: Triage (cheap, <5% budget)  │  ← classify, scope, estimate, maybe reject/ask user
└─────────────────────────────────────┘
    │ pass
    ▼
┌─────────────────────────────────────┐
│ Gate 1: Plan critique (cheap)       │  ← actor writes plan, critic checks feasibility
└─────────────────────────────────────┘
    │ pass
    ▼
┌─────────────────────────────────────┐
│ Gate 2: Sandbox run (bounded)       │  ← container or chroot worktree, hard timeout/token cap
└─────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────┐
│ Gate 3: Full execution (remaining    │  ← only if sandbox evidence justifies it
│ budget, with periodic checkpoints)  │
└─────────────────────────────────────┘
```

This replaces the current "one big hammer" model with a funnel that spends cheap tokens to avoid wasting expensive tokens.

---

## 4. Gate 0: Triage (Cheap, Mandatory)

**Goal**: Decide, in one cheap LLM call (or a few), whether the card is ready to execute.

**Inputs**: Card title, goal, lever, acceptance, project context (`.serf/plan.md`, `.serf/config.json`, recent events).

**Outputs**:
- `ready` → proceed to Gate 1
- `needs-clarification` → move card to review, write a specific question for the user
- `out-of-scope` → reject, record why, close card
- `decompose` → split into 2–4 smaller cards and add them to backlog
- `explore-first` → spawn a cheap research task before implementation

**Budget rule**: Triage costs no more than 5% of the card's budget. If the card has no budget, default to a small triage limit (e.g., 1k tokens). Triage failure consumes the card budget and moves the card to review with a user-facing reason.

**Why this matters**: It stops tokenmaxxing at the source. Vague tasks like "improve the system" get decomposed or clarified before an actor burns context on them.

---

## 5. Gate 1: Plan Critique (Cheap)

**Goal**: Verify the actor's plan is feasible and complete *before* it edits files.

**Current state**: `buildPlanCritiquePrompt` exists but is not wired into the main loop.

**Proposed change**:
1. Actor writes plan to `.serf/board/in-progress/<id>-plan.md`.
2. Critic evaluates the plan against the acceptance criteria.
3. If the plan fails, reject immediately with feedback (cheap retry on plan only).
4. If the plan passes, lock it and proceed to Gate 2.

**Budget rule**: Plan + critique together cost no more than 10% of the card budget.

**Why this matters**: Catches scope creep and missing steps before file edits. Also gives the user a readable plan if the task later fails.

---

## 6. Gate 2: Sandbox Run (Bounded)

**Goal**: Let the actor run in a constrained environment where it cannot access host paths, so there are no permission prompts and behavior is reproducible.

### Option A: Apple Container / NanoClaw (preferred, matches your constraints)

Use the same approach PAI uses elsewhere: a lightweight container runtime that does not require Docker. On macOS this can be an Apple Container or a minimal rootless chroot/sandbox with the project directory bind-mounted read-write, `/tmp` redirected inside the container, and no access to `~/.config`, `~/.ssh`, or other host paths.

**Minimum viable implementation**:
- Create a per-task container image derived from a base that has `bun`/`node`/`git` preinstalled.
- Mount only:
  - the project root (read-write for the worktree)
  - a fresh `/tmp` inside the container
  - no `~` or host config
- Run the actor inside the container.
- Collect output files from the mounted project directory.

**What this solves**:
- No opencode `/tmp` prompts.
- No accidental writes to `~/.config`, `~/.serf`, or global state.
- Reproducible environment: same `bun` version, same tools, regardless of host.

### Option B: chroot + bind mounts (simpler, less isolation)

If Apple Container is not immediately available, use a chroot with:
- A minimal root filesystem containing `bun`, `git`, `node`, and shell utilities.
- Bind mount the project directory and a fresh `/tmp`.
- No network access or limited network via firewall rules.

**Tradeoff**: Easier to set up, weaker isolation than a real container, but still eliminates most permission prompts and host state leakage.

### Option C: Process-level sandbox only (fallback)

If containerization is delayed, at least:
- Set `HOME` and `TMPDIR` to a per-task directory inside the worktree.
- Block known global paths in the actor prompt.
- Run tests with `bun test` inside the worktree only.

**Tradeoff**: Still relies on host tools and agent cooperation, but removes the `/tmp` prompt problem and is a fast interim fix.

---

## 7. Gate 3: Full Execution with Checkpoints

**Goal**: Run the actual implementation only after triage and plan pass, with periodic budget checks.

**Changes**:
- Give the actor a token/time budget for the *implementation phase only*, separate from triage and plan budgets.
- Every 3 minutes or every N tokens, the master checks remaining budget.
- If budget is exhausted mid-task, the actor is interrupted, the partial state is written to the card, and the card moves to review with a "budget exhausted" reason.
- The critic verdict is still required, but the critic is also budget-capped: low-budget critic = single pass; high-budget = multipass.

**Budget rule**: Implementation gets the remaining budget after triage and plan. A default card budget might be 10k tokens for triage, 20k for plan, 70k for execution+critic.

---

## 8. Budget Model That Is Taken Seriously

The current `BudgetTracker` counts tokens. We need it to *shape behavior*.

### Proposed budget schema per card

```json
{
  "budget": {
    "triage": 1000,
    "plan": 2000,
    "execution": 7000,
    "critic": 2000,
    "total": 12000
  }
}
```

### Hard rules

1. **No phase can borrow from another phase** without a new user-approved card.
2. **If triage rejects, the rest of the budget is not spent.**
3. **If plan critique fails twice, the card goes to review** — no execution budget is consumed.
4. **Master-level budget**: Sum across all cards in a "harvest" (session). If the harvest budget is exceeded, stop entirely and report to user.
5. **Daily/provider budget**: Configurable cap to prevent runaway usage across multiple `serf process` invocations.

### Visual feedback

Print remaining budget after each phase:
```
  Triage:    850 / 1,000 tokens
  Plan:      1,200 / 2,000 tokens
  Execution: 0 / 7,000 tokens
```

This makes the budget hammer visible and real.

---

## 9. What We Should Do Now (Practical Sequence)

Given the current codebase and your preferences, I recommend this order:

### Phase 1: Immediate relief (this week)

1. **Gate 0 triage** — implement a cheap triage function in `src/v2/triage.ts` and call it before creating a worktree. Add tests.
2. **Gate 1 plan critique** — wire `buildPlanCritiquePrompt` into `master.ts`. Actor must write a plan and get critique approval before editing source files. Add tests.
3. **Budget shaping** — update `BudgetTracker` and card schema to phase budgets. Enforce hard phase caps. Add tests.
4. **Environment variables for sandbox** — set `HOME` and `TMPDIR` to worktree-local paths in `executor.ts` / `herdr.ts` as a quick permission-prompt fix.

### Phase 2: Real sandbox (next)

5. **Containerize the actor runtime** — Apple Container or NanoClaw-style rootless container. The actor launches inside the container, only the project directory and a fresh `/tmp` are visible.
6. **Reproducible base image** — preinstall `bun`, `git`, and common runtimes so tests/builds behave identically.
7. **Herdr integration with containers** — ensure herdr can create panes whose working directory is inside a container, or switch to a simpler direct-mode container runner.

### Phase 3: Operational discipline

8. **Runtime commands** — implement `/serf model`, `/serf provider`, `/serf status` with budget display.
9. **Autoresearch strategy ring** — only after the funnel is solid.
10. **Knowledge writing on rejection** — already partially done; extend to triage and plan failures.

---

## 10. Risks and Honest Tradeoffs

| Risk | Mitigation |
|------|------------|
| Container setup is complex and may delay other features | Start with Phase 1 (triage/plan/budget) which gives 80% of the benefit without containers. |
| Triage may reject good tasks because it is too cautious | Make triage output visible to user and easy to override. Log why it rejected. |
| Plan critique adds latency to every task | It is cheap latency that prevents expensive wasted work. Make it optional for very small tasks (<3 acceptance criteria). |
| Containers break herdr pane integration | Keep direct mode as the default container path; herdr can be a later enhancement. |
| Budget caps may interrupt useful work | Budget is per-card; user can raise it. Partial results are preserved in review. |

---

## 11. Success Criteria for This Plan

- [ ] Triage rejects or decomposes at least 30% of vague incoming tasks without entering execution.
- [ ] Plan critique runs before any source file edit on every non-trivial card.
- [ ] Actor runs without permission prompts for `/tmp` or external directories (via container or env redirect).
- [ ] Budget is phase-locked and visible after each phase.
- [ ] A card cannot consume more than its declared budget; overrun moves it to review with reason.
- [ ] Average tokens per completed task drops by at least 40% after funnel is implemented.

---

## 12. Recommendation

The right next step is **not** to keep feeding the backlog into the current loop. The right next step is to build the funnel first. Specifically:

1. Add triage.
2. Enforce plan critique.
3. Phase-lock the budget.

These three changes will make the existing actor/critic loop dramatically more efficient and will reduce the pressure to containerize immediately. Containerization then becomes a clean Phase 2 upgrade that removes the remaining environment friction.

If you agree, I can start implementing Phase 1 now.
