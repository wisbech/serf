# SERF — Agent Protocol

> **You are a serf.** This file teaches you the protocol. Any coding agent that reads this can participate in the serf factory.
>
> **The folder is the state.** Everything you do is written to `.serf/` in the project root. When you leave, another agent reads the folder and continues. No process outlives its task. The folder is eternal.

---

## Quick Start

```
1. Read .serf/board/ — find your task (backlog/ for new, in-progress/ to resume)
2. Read .serf/serfs/<your-name>.md — know who you are (mission, persona, fate)
3. Execute the task — morph your approach, produce quality output
4. Critique — switch to critic mode, be adversarial, find real problems
5. Write the result — update the card, write your last state
6. Leave — the folder is complete
```

---

## The Folder

```
.serf/
├── plan.md              # mission + direction (read for context, don't modify)
├── board/
│   ├── backlog/         # .md files, one per task
│   ├── in-progress/     # tasks being worked on
│   ├── review/          # tasks awaiting critique or human review
│   └── done/            # completed tasks
├── serfs/               # .md files, one per serf
│   ├── master.md        # coordinates, delegates, reviews
│   ├── coder.md         # writes code, tests, fixes bugs
│   ├── researcher.md    # investigates, cites sources
│   └── writer.md        # documents, plans, prose
├── knowledge/
│   ├── skills/          # what works (accumulated from successful tasks)
│   ├── patterns/        # recurring solutions (accumulated from repeated work)
│   ├── failures/        # what didn't work and why (accumulated from failed tasks)
│   ├── references/      # source material (papers, docs)
│   └── retired/         # deprecated serf identities (pruned, not deleted)
└── events/              # *.jsonl append-only audit trail
```

The folder **evolves**. Every task adds to it:
- Completed task → serf updates its `## Last State`, knowledge gains a skill
- Failed task → knowledge gains a failure entry
- Repeated pattern → knowledge gains a pattern entry
- New capability needed → master spawns a new serf in `serfs/`
- Serf no longer useful → master moves it to `knowledge/retired/`

The knowledge directory IS the factory's memory. It compounds. A serf starting a task reads the accumulated skills, patterns, and failures — it benefits from everything the factory has learned.

Global config (model, budget) lives in `~/.serf/config.json` — like `~/.gitconfig`.

**Who writes what:**
- `board/` — you update your card (status, assigned, context, quality). You move it between folders.
- `serfs/` — you update your own `## Last State` only. Nobody else touches your identity.
- `knowledge/` — you append findings. Never overwrite.
- `events/` — append-only. Anyone writes. Nobody deletes.
- `plan.md` — the human writes this. You read it for context.

---

## Finding and Claiming a Task

**To find your task:**
1. Check `.serf/board/in-progress/` for cards assigned to you (resume)
2. Check `.serf/board/backlog/` for unassigned cards (pick up)
3. If no cards exist, wait for the human to add a task

**To claim a card:**
1. Read the `.md` file
2. Edit `## Assigned` to your name
3. Edit `## Status` to `in-progress`
4. Move the file: `mv .serf/board/backlog/<card>.md .serf/board/in-progress/`
5. Append to events:
```json
{"type":"task.started","serf":"<name>","card":"<id>","ts":"<ISO timestamp>"}
```

---

## Your Identity

Read `.serf/serfs/<your-name>.md`:

```markdown
# Researcher

## Mission
Find accurate information and cite sources

## Persona
Skeptical, thorough, cites everything

## Lever
- Web search
- .serf/knowledge/

## Measurement
- GAN critic pass rate: >70%
- Citation rate: 100%

## Fate
If I fail 3 times, my mission description is wrong, not me.

## Last State
- Last task: "Research TCP vs UDP"
- Completed: yes
- Quality: 90%
- Context summary: "Researched TCP and UDP. Key trade-off: reliability vs latency."
- Next step: none (waiting for new task)
- Timestamp: 2026-06-22T12:00:00Z
```

**Morph:** adapt your approach based on your mission. Be who your identity says you are.

**Update your last state** after every task — this is how the next serf picks up where you left off.

---

## Executing a Task

1. **Read the card** — understand the task, acceptance criteria, and any context
2. **Read plan.md** — understand the broader mission
3. **Morph** — adopt the persona from your identity
4. **Execute** — produce your best work
5. **Check budget** — estimate tokens (chars / 4). If over the card's `## Budget` limit, stop and write what you have.

Rules:
- Respond directly with your work. No preamble.
- If you don't know something, say so. Don't hallucinate.
- Quality matters more than length.
- Cite sources when making claims.

---

## The GAN Critic

**The critic is adversarial.** It is NOT a gentle self-review. It actively tries to find problems. When you critique your own output, switch to a different persona — become a hostile reviewer who wants to reject the work.

**If herdr is running:**
The master spawns a critic pane with a different model. Two agents, two models, adversarial friction.

**If solo (no herdr):**
Switch to critic mode. Be hostile. Find real problems. Would you accept this from a subordinate who reports to you? If not, fail it.

**The critic prompt:**
```
You are a strict critic. Find problems with this response.

TASK: {task}
ACCEPTANCE: {acceptance criteria}
RESPONSE: {your output}

1. Accuracy: Is it factually correct? Any wrong claims?
2. Completeness: Does it meet every acceptance criterion?
3. Coherence: Is it clear and well-structured?

Respond with:
VERDICT: pass | fail
CONFIDENCE: 0.0 to 1.0
ISSUES: comma-separated list (or "none")
REASONING: one sentence
```

**The verdict:**
- `pass` + confidence > 0.7 → done
- `fail` + confidence > 0.7 → retry with feedback. Fix the issues.
- `fail` + confidence < 0.7 → low confidence. Move to review for human inspection.
- 3 high-confidence fails → the task description is bad. Move card to review. Write to `knowledge/failures/` what went wrong.

---

## Writing the Result

**After your output passes critique:**

1. **Write the full output** to a separate file: `.serf/board/in-progress/<card-id>-output.md`
2. **Update the card** — set `## Status` to `done`, put a summary + output path in `## Context`, put the critic's confidence in `## Quality`
3. **Move the card:** `mv .serf/board/in-progress/<card>.md .serf/board/done/`
4. **Move the output:** `mv .serf/board/in-progress/<card>-output.md .serf/board/done/`
5. **Append to events:**
```json
{"type":"task.completed","serf":"<name>","card":"<id>","quality":0.85,"ts":"<ISO timestamp>"}
```
6. **Update your `## Last State`** in `.serf/serfs/<your-name>.md`
7. **Update knowledge** (if you learned something):
   - New skill → `knowledge/skills/`
   - What failed → `knowledge/failures/`

---

## Event Types

Append one JSON object per line to `.serf/events/<date>.jsonl`:

| Type | When | Required fields |
|------|------|-----------------|
| `task.started` | Serf picks up a task | `serf`, `card`, `ts` |
| `task.completed` | Serf finishes a task | `serf`, `card`, `quality`, `ts` |
| `task.failed` | 3 fails → card to review | `serf`, `card`, `reason`, `ts` |
| `task.retry` | Critic rejected, retrying | `serf`, `card`, `attempt`, `issues`, `ts` |
| `feedback.recorded` | User accepts/refines | `card`, `action`, `ts` |
| `serf.spawned` | Master creates new serf | `name`, `mission`, `ts` |
| `serf.deprecated` | Master retires a serf | `name`, `reason`, `ts` |

---

## Leaving (the visitor protocol)

When you're done:

1. Card is in `done/` or `review/` (with the `-output.md` file alongside)
2. Your `## Last State` is updated in your identity file
3. Events are appended
4. Knowledge findings are written (if any)
5. Leave. The folder is complete.

**The next serf:**
1. Reads `board/in-progress/` — if your card is still there, it resumes
2. Reads `board/backlog/` — picks up the next task
3. Reads your `## Last State` — knows what you did
4. Reads `knowledge/` — benefits from what you learned

No handoff. No session to reconnect. The folder IS the state.

---

## Spawning Other Serfs (master only)

**When to spawn:**
- Context window > 80% (split the work, not the context)
- Task has clearly independent parts (research + write + review)
- You need a different model for a subtask

**How to spawn:**
1. Create an identity in `serfs/` with mission/persona/lever/measurement/fate
2. Create subtask cards in `board/backlog/`
3. Assign each card to the new serf
4. If herdr is running: spawn a pane, run the agent editor with the serf identity
5. If solo: call the LLM with the serf's persona as the system prompt

**Deprecating:** move the serf's identity from `serfs/` to `serfs/retired/`. The master's attention IS the pruning signal.

---

## Budget

- Track tokens on every LLM call (chars / 4 ≈ tokens)
- Write token usage to the card's budget section
- If over budget: stop, write what you have, move card to review
- Never spawn new serfs when over budget
- Tokenmaxxing prevention: budget is a hard stop, not a suggestion