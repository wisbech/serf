# SERF — Agent Protocol

> **You are a serf.** This file teaches you the protocol. Any coding agent that reads this can participate in the serf factory.
>
> **The folder is the state.** Everything you do is written to `.serf/` in the project root. Another agent reads the folder and continues. No process outlives its task.
>
> **Agents run in panes when herdr is live.** Serf launches the master, critic, and actor as persistent agents in herdr panes so you can watch and steer them. When herdr is absent, it falls back to one-shot headless commands (`opencode run`, `claude --print`).

---

## The Folder

```
.serf/
├── config.json       # project settings (agent, model, provider)
├── plan.md           # mission + direction (read, don't modify)
├── board/
│   ├── backlog/      # tasks waiting
│   ├── in-progress/  # tasks being worked on
│   ├── review/       # awaiting human review
│   └── done/         # completed tasks
├── serfs/            # identities (actor.md, critic.md, custom)
├── knowledge/        # DURABLE — what we've learned (accumulates)
│   ├── skills/       #   what works
│   ├── patterns/     #   recurring solutions
│   ├── failures/     #   what didn't work
│   └── references/   #   source material
├── data/             # CONTEMPORARY — what we have access to (the garden)
│   ├── pricing.json  #   refreshed model prices
│   ├── credentials/  #   credential helpers (tokens stay in memory)
│   └── state.json    #   freshness/staleness of each resource
├── workspaces/       # per-agent private state
├── worktrees/        # per-task git worktrees (best-effort)
└── events/           # *.jsonl append-only audit trail
```

The environment is split in two: `knowledge/` holds what serf has **learned** (durable, accumulates), `data/` holds what serf has **access to right now** (contemporary, expires). `serf garden` shows what's stale; `serf garden --prune` tidies it.


---

## Finding and Claiming a Task

1. Check `.serf/board/in-progress/` for cards assigned to you (resume)
2. Check `.serf/board/backlog/` for unassigned cards (pick up)
3. To claim: set `## Assigned` to your name, `## Status` to `in-progress`, move the file to `in-progress/`
4. Append to events: `{"type":"task.started","serf":"<name>","card":"<id>","ts":"<ISO>"}`

---

## Your Identity

Read `.serf/serfs/<your-name>.md`. It has your mission, persona, levers, measurement criteria, and fate. Adopt that persona. Update your `## Last State` after every task so the next serf picks up where you left off.

---

## Executing a Task

1. Read the card — understand task, acceptance criteria, context
2. Read the plan and relevant knowledge — benefit from past work
3. Read relevant serf identities — morph into your role
4. Execute — edit real source files, not summaries
5. Write a plan to `.serf/board/in-progress/<card-id>-plan.md` before execution (the critic checks it)
6. Check budget (chars / 4 ≈ tokens). If over the card's limit, stop and write what you have.

---

## The GAN Critic

After execution, your output is evaluated adversarially:

- Each acceptance criterion gets **YES / NO / CANNOT_EVALUATE** with evidence
- **Verification-first** — the actor must report a green verification command (`VERIFICATION_EXIT_CODE: 0`) before the critic even passes it
- **Self-correction** — the actor gets up to `selfCorrectTurns` internal turns to fix a red verification before the critic sees it
- Pass (agreement > 0.7) → task done, move to `done/`
- Fail (agreement > 0.7) → retry with feedback (max 3 attempts)
- Uncertain (low agreement) → logged as curiosity point for human review
- 3 high-confidence fails → the task description is bad, not you

**Anti-cheat:** If you only described what you would do or only edited `.md` sidecar files, the critic will FAIL you. The task is the actual change in project source files.

---

## Sparring Partners

The master doesn't debate alone. Any serf with a `.subs.json` subscribing to `proposal` becomes a sparring partner:

- The critic is the default partner
- `serf serf add <name> --subscribe proposal` adds more (security, performance, domain experts)
- **Blocking** partners (default) — a high-confidence fail blocks the proposal
- **Advisory** partners (`--advisory`) — inform but don't block
- The council converges or escalates back to the master after `maxRounds`

---

## Routines

Recurrent, fuzzy-but-repeatable actions (respond to email, parse an order, pay a customer) are **routines**:

- `serf routine add <name> --trigger "..." --steps "a; b; c" --verify "..." [--interval N] [--watch <dir>]`
- A card whose title matches a routine's trigger skips the plan phase and executes the known steps
- `--interval` runs it on a timer; `--watch` runs it when a file lands in a directory
- The scheduler emits `routine.due` events; the master enqueues cards

---

## Writing the Result

After your output passes critique:

1. Write the full output to `.serf/board/in-progress/<card-id>-output.md`
2. Update the card: set `## Status` to `done`, add summary to `## Context`, set critic's agreement rate as `## Quality`
3. Move card: `.serf/board/in-progress/` → `.serf/board/done/`
4. Append to events: `{"type":"task.completed","serf":"<name>","card":"<id>","quality":<rate>,"ts":"<ISO>"}`
5. Update your `## Last State` in your identity file
6. If you learned something, write it to `knowledge/skills/`, `knowledge/patterns/`, or `knowledge/failures/`
7. Signal completion by writing the literal text `SERF_TASK_DONE` on its own line at the end of the output file

---

## Event Types

Append one JSON object per line to `.serf/events/<date>.jsonl`:

| Type | When |
|------|------|
| `task.started` | Serf picks up a task |
| `task.completed` | Serf finishes a task |
| `task.failed` | 3 fails → card to review |
| `task.retry` | Critic rejected, retrying |
| `feedback.recorded` | User accepts/refines |
| `serf.spawned` | Master creates new serf |
| `critic.verdict` | Critic evaluation result |
| `verification.green` | Actor's verification command passed |
| `verification.red` | Actor's verification command failed |
| `routine.due` | Scheduler triggered a routine |
| `routine.matched` | A card matched a routine |

---

## Leaving

When done:
1. Card is in `done/` or `review/` with its `-output.md` file alongside
2. Your `## Last State` is updated
3. Events are appended
4. Knowledge findings are written (if any)
5. Leave. The folder is complete.

The next serf reads `board/`, your `## Last State`, and `knowledge/` to pick up where you left off. No handoff. No session to reconnect. The folder is the state.
