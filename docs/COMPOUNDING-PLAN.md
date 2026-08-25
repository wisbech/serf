# Serf Compounding Plan — Final

> The folder gets smarter. That's the whole idea.

## The loop

```
Actor (small model) fails
  → writes a trace to the skill folder
  → Master + Critic read the trace, talk, propose an approach
  → Skill-serf executes the approach
      → tests pass → building block + lesson in STATE.md
      → tests fail → back to Master + Critic
```

That's it. Four steps. The folder accumulates the results.

## The folder

```
.serf/
├── STATE.md                              ← what happened, what's known, what's open
├── serfs/
│   ├── master.md                         ← editable: what master reads/writes
│   ├── critic.md                         ← editable: what critic checks for
│   └── actor.md                          ← editable: how actor approaches tasks
├── knowledge/skills/
│   └── <name>/                           ← one folder per recurring need
│       ├── CONTEXT.md                    ← when to consult this skill
│       ├── lessons.md                    ← what works (fuzzy)
│       ├── failure-modes.md              ← what doesn't (fuzzy)
│       ├── traces/                       ← what happened (evidence)
│       │   └── <date>-<card>.md
│       └── src/                          ← working code (deterministic)
│           ├── helper.ts
│           └── helper.test.ts
└── config.json                           ← models, tiers, settings
```

## STATE.md

```markdown
# Serf State

## Verified facts
- prc is in dollars, not cents. Verified via SELECT MIN(prc), MAX(prc).

## General rules
- When querying time-bucketed metrics, always include timezone.

## Open failures
- 2026-07-04: checkout flakes ~1 in 50. → skill: fix-flaky-test

## Building blocks
- add-api-endpoint/src/route-helper.ts — tests pass
- database-migration/src/batch-creator.ts — tests pass

## Harness edits
- 2026-07-04: actor.md — "check file exists before writing" (fixes missing-artifact)
- 2026-07-03: triage-rules — "flag tasks needing DB access" (fixes scope-miss)

## Lessons learned
- PowerShell TLS 1.2 issue on Windows CI. Use bash.

## Last session
2026-07-04 · 3 done, 1 escalated, 1 building block promoted.
```

## The trace

When an actor fails, it writes a markdown file to the skill folder's `traces/` directory:

```markdown
# Trace: add-hello-endpoint — 2026-07-04

## Model
ornith:9b

## Task
Add a hello world endpoint to src/server.ts

## What I tried
1. Read src/server.ts
2. Added a GET /hello route
3. Ran bun test

## What went wrong
Test failed — forgot to register the route in src/routes/index.ts

## Failure reason
Missing route registration. Multi-file edit needed.
```

The actor prompt already asks for this format. The harness just writes it to the right folder.

## The conversation

Master and critic already run side by side in herdr panes. When a task fails and gets escalated, the harness feeds them the trace. They talk. They write their proposed approach to `.serf/tmp/proposed-approach.md`.

The proposed approach is either:
- **"Write a helper that does X"** → skill-serf writes code to `src/`, tests to `src/`
- **"Actors should check Y before doing Z"** → harness edit to `.serf/serfs/actor.md` or a rules file
- **"Break this into A, B, C"** → new cards on the board

## The skill-serf

A small-model serf spawned in a herdr pane below master/critic. It reads the proposed approach and executes it:

- If code: writes to `.serf/knowledge/skills/<name>/src/`, writes tests, runs `bun test`
- If harness edit: writes to the editable surface file, runs the existing test suite

**The gate**: `bun test` passes in the skill folder AND `bun test` passes in the serf root. If both pass, promote. If either fails, the skill-serf's output goes back to master/critic as a new trace.

## The allocator

The harness estimates task complexity from the card (acceptance count, task length, keywords) and picks the cheapest model. On failure, bump up a tier. After 2 failures, escalate to master/critic's model.

```
trivial  → ornith:9b (small)
simple   → ornith:9b
moderate → qwen3:8b (medium)
complex  → kimi-k2.7-code:cloud (large)
```

Configured in `.serf/config.json`. Not hardcoded.

## The editable surfaces

These are files in `.serf/` that the self-improvement loop can modify without touching code:

| Surface | File | What it controls |
|---|---|---|
| Actor behavior | `.serf/serfs/actor.md` | How the actor approaches tasks |
| Critic behavior | `.serf/serfs/critic.md` | What the critic checks for |
| Master behavior | `.serf/serfs/master.md` | How the master surveys and proposes |
| Triage rules | `.serf/triage-rules.md` | What gets rejected/decomposed early |
| Critic rules | `.serf/critic-rules.md` | What the critic verifies |
| Pre-checks | `.serf/scripts/pre-check.sh` | Run before actor execution |

The serf modules (`triage.ts`, `critic.ts`, `prompts.ts`) read these files at runtime. A harness edit = a change to one of these files. The gate: existing tests still pass.

## What compounds

- **Traces** — evidence of what happened, linked across sessions
- **Lessons** — fuzzy knowledge that actors consult before starting
- **Building blocks** — tested code that actors import
- **Harness edits** — rule changes that fix systemic weaknesses
- **STATE.md** — the index that ties it together

Each session reads STATE.md and relevant skills at start. Each session writes STATE.md at end. The folder is the state. The state compounds.

## Implementation

1. **STATE.md** — `src/state-file.ts`, wire into master prompt (read at start, write at end)
2. **Skill folders** — `src/skills.ts`, create on failure, maintain by skill-serf
3. **Traces** — actor prompt already asks for the format, harness writes to skill folder
4. **Allocator** — `src/allocator.ts`, estimate + allocate + escalate
5. **Skill-serf execution** — spawn serf with proposed approach, gate on `bun test`
6. **Harness edits** — master/critic propose, skill-serf writes to editable surface, gate on `bun test`

Steps 1-3 are the memory. Steps 4-5 are the funnel. Step 6 is the self-improvement. Each is independently useful.