# Architectural Decision Record: Serf Funnel and Actor-Critic Separation

## Status
Proposed — pending user review

## Context
Serf currently launches a single general-purpose coding agent (e.g. opencode) into a task with full context, full filesystem access, and a retry loop. The agent both plans and executes. A single critic pass evaluates the result. This creates three failure modes we have observed:

1. **Permission friction**: The agent touches `/tmp`, `~/.config`, and other host paths, triggering repeated permission prompts.
2. **Tokenmaxxing**: Every task enters the most expensive mode immediately, even when it is vague, out of scope, or too large.
3. **Weak post-hoc critique**: A single critic pass at the end can pass overconfident but incorrect work, and it cannot recover budget already spent.

## Decision
We will restructure serf as a **staged funnel** with separated, narrow roles:

```
Idea
  │
  ▼
Triage (rule-based, cheap)
  │
  ▼
Scope / Plan phase
  ├─ Actor: writes a concrete plan with goal, lever, file paths, verification
  └─ Plan Critic: adversarially rejects vague, incomplete, or infeasible plans
  │     (this is the main actor-critic battleground)
  │
  ▼
Execution phase
  ├─ Actor: implements ONLY the approved plan
  ├─ Autoimprove loop: tries variations / genetic / search strategies (optional)
  └─ Work Critic: evaluates actual file changes and test output against acceptance
  │
  ▼
Master Arbiter
  ├─ pass → merge, write knowledge
  ├─ fail → retry with feedback (bounded)
  └─ uncertain / high-stakes → escalate to user
```

## Roles

### Plan Critic
- Runs BEFORE any source file is edited.
- Input: task, goal, lever, acceptance criteria, proposed plan.
- Output: `pass`, `fail`, or `uncertain` with specific missing pieces.
- Must verify every acceptance criterion has a corresponding plan step with evidence path.

### Work Critic
- Runs AFTER implementation.
- Input: task, acceptance criteria, git diff, test output, actor output.
- Output: per-criterion verdict with evidence quotes.
- Must be evidence-first: no "looks good" verdicts allowed.
- Multipass by default (≥3 passes for non-trivial tasks).

### Autoimprove Loop
- Optional execution-time strategy runner.
- Can try prompt variations, code mutations, test-driven revisions, etc.
- Always ends with the Work Critic before returning to the Master Arbiter.
- Budget is strictly capped and charged to the execution phase.

### Master Arbiter
- Not an LLM. A deterministic policy engine.
- Decides: retry (with feedback), accept (merge), decompose, escalate to user.
- Never auto-accepts uncertain verdicts on high-stakes changes.

## Consequences

### Positive
- Expensive work only starts after scope is clear and a plan is approved.
- The actor-critic battle happens where it is cheapest and most useful: the plan.
- Autoimprove can be plugged in safely because the Work Critic gates its output.
- Permission prompts are isolated to containerized execution (Phase 2).

### Negative
- More moving parts in the master loop.
- Plan phase adds latency, but it is cheap latency that prevents wasted work.
- Requires maintaining two critic prompt formats and possibly two critic agents.

## Implementation Phases

### Phase 1 (now)
- Implement `PlanCritic` module.
- Implement `WorkCritic` wrapper around existing `critic.ts` with mandatory multipass.
- Implement `MasterArbiter` with clear escalation rules.
- Wire plan-then-execute into `master.ts`.
- Add phase-locked budgets.

### Phase 2
- Containerize the actor runtime so it only sees the project directory.
- Move autoimprove strategies into a pluggable `strategies/` folder.
- Add genetic-algorithm-style variation runner under Work Critic supervision.

### Phase 3
- Runtime commands: `/serf model`, `/serf provider`, `/serf status`.
- Knowledge compounding from every stage, not just completion.
- User-facing review UI for uncertain verdicts.

## Decision Owner
User (principal) + serf agent

## Date
2026-07-01

## Autoimprove Abstraction

The autoimprove layer is a **pluggable strategy engine**, not a hardcoded loop.

### Interface

```typescript
export interface AutoimproveStrategy {
  name: string;
  // Given the current attempt output, the task, and acceptance criteria,
  // produce the next input (e.g. revised prompt, mutated code, variant plan).
  nextAttempt(ctx: AutoimproveContext): Promise<AutoimproveAttempt>;
}

export interface AutoimproveContext {
  card: Card;
  attempt: number;
  maxAttempts: number;
  previousOutputs: string[];
  previousVerdicts: WorkCriticVerdict[];
  phaseBudget: CardBudget; // execution phase only
}

export interface AutoimproveAttempt {
  prompt: string;           // what to send to the actor
  strategyName: string;
  tokensUsed: number;
}
```

### Built-in Strategies

| Strategy | Description | When to use |
|----------|-------------|-------------|
| `baseline` | No autoimprove; single actor attempt. | Default. |
| `retry-with-feedback` | Pass critic feedback verbatim to the actor. | Current behavior. |
| `prompt-variation` | Rephrase the actor prompt with stronger constraints. | When critic reports missing evidence. |
| `test-driven` | Add a failing test first, then ask actor to make it pass. | When acceptance criteria are testable. |

### Engine Rules

1. The engine consumes only the **execution phase** budget.
2. Each iteration must end with the **Work Critic** before the Master Arbiter sees it.
3. The engine stops when a pass is found, budget is exhausted, or max attempts reached.
4. The Master Arbiter picks the best passing attempt or escalates if none pass.
5. New strategies can be added in `src/v2/strategies/` without touching the engine.

### Selection

Strategy is chosen by card metadata or config:
- Card field `## Strategy` overrides.
- `.serf/config.json` field `autoimproveStrategy` defaults to `baseline`.
- Master Arbiter can promote a card to a stronger strategy after a plan-critic review.

## Master-Critic Deliberation Loop

When the Work Critic returns `uncertain` or low-confidence `fail`, the Master does **not** immediately retry or escalate. Instead, it enters a structured deliberation with the Critic.

### Purpose
- Surface hidden assumptions in the task or acceptance criteria.
- Propose concrete resolutions (clarify criterion, relax criterion, add evidence, decompose).
- Only involve the user if Master and Critic cannot converge.

### Process

```
Work Critic returns uncertain/fail
           │
           ▼
   Master proposes 1-3 resolutions
           │
           ▼
   Critic evaluates each resolution
           │
           ▼
   If consensus → apply resolution (retry, decompose, accept partial)
   If gridlock  → write issue letter → move card to review
```

### Issue Letter Format

When gridlock occurs, the system writes `.serf/board/review/{card.id}-issue.md`:

```markdown
# Issue: {card.title}

## Date
2026-07-01T...

## Task
{card.task}

## Goal
{card.goal}

## Lever
{card.lever}

## Acceptance Criteria
...

## Critic Position
{Critic's concern}

## Master Position
{Master's proposed resolution}

## Gridlock Reason
{Why they cannot converge}

## Options for User
1. ...
2. ...
3. ...

## Recommended Option
{The one the master leans toward}

## Budget Impact
Triage: X / Limit tokens
Plan: X / Limit tokens
Execution: X / Limit tokens
```

This becomes the structured handoff to the user. The user can reply by editing the card, adding a comment, or moving it back to backlog with a decision.
