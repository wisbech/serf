# Interactive Task Intake: serf start "some task"

## Date
2026-06-25

## Status
Plan — awaiting discussion.

## The Problem

Currently `serf start` processes the board. `serf task "do something"` adds a card. But there's no way to *discuss* a task with the master agent before formalizing it. You either write a perfect task description upfront, or you get what you get.

The user wants: `serf start "some task"` → a conversation with the master/actor agent → the agent introduces itself, surveys the project, discusses what to do → together they formalize a task → the agent puts it on the board → the loop processes it.

## The Flow

```
$ serf start "add a login page"

  ═══ SERF DARK FACTORY ═══════════════════════
  Interactive mode — discussing task with master
  
  Master: Hi, I'm the master serf for this project.
  Let me look at what we're working with...
  
  [reads .serf/plan.md, .serf/knowledge/, scans project]
  
  Master: I see this is a serf project — a dark factory
  harness for coding agents. TypeScript + Bun. 41 tests
  passing. No login page exists yet. There's no frontend
  at all — this is a CLI tool.
  
  Master: When you say "add a login page" — do you mean:
  1. A web UI for the serf board (viewing tasks, etc)?
  2. Auth for a serf API/daemon?
  3. Something else?
  
  You: Let's do option 1 — a simple web UI for the board
  
  Master: Got it. I'll write a task for that. Let me
  survey the codebase to make the acceptance criteria
  specific...
  
  [scans src/index.ts, src/v2/board.ts]
  
  Master: Here's what I'll put on the board:
  
  Task: Add a web UI for viewing the serf board
  Acceptance:
  - GET /board returns HTML showing all cards grouped by column
  - Cards show title, quality, assigned serf
  - Page auto-refreshes or uses SSE for live updates
  - Served by `serf ui` command (new)
  - Tests cover board rendering
  
  Master: Does that look right? (y/n/edit)
  
  You: y
  
  Master: ✓ Task added to backlog: web-ui-for-board-...
  Run `serf start` to process it, or add more tasks.
```

## How It Works

### 1. `serf start` with no args (current behavior)
Processes the board as before. No change.

### 2. `serf start "some task"` (new — interactive)
Instead of immediately processing the board, the master agent enters a **dialogue mode**:

1. **Introduce itself** — read `.serf/plan.md`, `.serf/knowledge/`, scan the project structure. Write a short paragraph: "I'm the master serf for [project]. [N] files, [language]. [What the project does]. [What's on the board]."
2. **Interpret the task** — the user's loose description goes to the master agent. It explores curiously: "When you say X, do you mean A, B, or C?"
3. **Survey the codebase** — the master agent reads relevant files to make acceptance criteria specific and grounded in the actual code.
4. **Propose a task** — the master writes a formal task card (title, task description, acceptance criteria, context) and shows it to the user.
5. **User approves or edits** — `y` to accept, `n` to reject, `edit` to revise.
6. **Formalize** — on approval, `addTask()` puts the card on the board. Then `serf start` processes it (or waits if there are other tasks already queued).

### 3. The master prompt for interactive mode

The master needs a prompt that tells it to:
- Read the project and introduce itself
- Interpret the user's loose task description
- Ask clarifying questions if ambiguous
- Survey relevant code
- Write specific, falsifiable acceptance criteria
- Show the task to the user for approval

This is a `callLLM` call, not a spawned agent. The master is the loop itself — it doesn't need a pane. It uses the LLM to generate the task proposal, shows it, and waits for user input.

### 4. Multiple tasks

If the user wants to add multiple tasks:
```
$ serf start "add a login page, fix the test suite, and update the docs"

Master: I see three tasks. Let me formalize each one...
[master writes 3 cards, shows each for approval]
```

Or the user can run `serf start "task 1"` then `serf start "task 2"` separately.

## Implementation

### In `src/index.ts`

```typescript
async function handleStart(args: string[]) {
  const { startMaster } = await import("./v2/master");
  
  const taskDescription = args.filter(a => !a.startsWith("--")).join(" ");
  
  if (taskDescription) {
    // Interactive mode — formalize task with master agent
    await interactiveTaskIntake(taskDescription);
  }
  
  // Then start the loop (processes the board, including the new task)
  await startMaster({ ...options });
}

async function interactiveTaskIntake(description: string): Promise<void> {
  const { callLLM } = await import("./v2/llm");
  const { addTask } = await import("./v2/board");
  
  // 1. Master surveys the project
  const surveyPrompt = `You are the master serf. A user wants to add a task: "${description}".
  
  Read .serf/plan.md for the mission. Scan the project directory structure. 
  Read key files (package.json, README, main entry points).
  
  Introduce yourself briefly. Then interpret the task — ask clarifying questions 
  if it's ambiguous. Propose a formal task card with specific, falsifiable acceptance criteria.
  
  Respond with:
  
  INTRO: <who you are, what the project is, what's going on>
  INTERPRETATION: <your understanding of the task, or clarifying questions>
  PROPOSED_TASK: <the formal task title>
  PROPOSED_ACCEPTANCE: <bullet list of acceptance criteria>
  CONTEXT: <relevant context from the codebase>`;
  
  const { text } = await callLLM(surveyPrompt);
  
  // 2. Parse the response
  const intro = text.match(/INTRO:\s*(.+?)(?=\n(?:INTERPRETATION|PROPOSED))/s)?.[1]?.trim();
  const interpretation = text.match(/INTERPRETATION:\s*(.+?)(?=\n(?:PROPOSED))/s)?.[1]?.trim();
  const proposedTask = text.match(/PROPOSED_TASK:\s*(.+)/)?.[1]?.trim();
  const proposedAcceptance = text.match(/PROPOSED_ACCEPTANCE:\s*(.+?)(?=\n(?:CONTEXT|$$))/s)?.[1]?.trim();
  
  // 3. Show to user
  console.log(`\n  Master: ${intro}\n`);
  console.log(`  Master: ${interpretation}\n`);
  console.log(`  Proposed task:`);
  console.log(`  Task: ${proposedTask}`);
  console.log(`  Acceptance:`);
  for (const line of proposedAcceptance?.split("\n") ?? []) {
    console.log(`  ${line.trim()}`);
  }
  
  // 4. Wait for approval
  const readline = require("readline").createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => readline.question("\n  Approve? (y/n/edit) ", a => { readline.close(); resolve(a.trim()); }));
  
  if (answer === "y" && proposedTask) {
    const acceptance = proposedAcceptance?.split("\n").map(l => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean) ?? ["GAN critic passes"];
    const card = addTask(proposedTask, proposedTask, acceptance);
    console.log(`\n  ✓ Task added to backlog: ${card.id}`);
  } else if (answer === "edit") {
    console.log("  Edit mode — not yet implemented. Re-run with a revised description.");
  } else {
    console.log("  Task not added.");
  }
}
```

### In `src/v2/master.ts`

No changes needed to `startMaster`. It processes the board as before. The interactive intake happens *before* the loop starts.

If the user runs `serf start "task"` and there are already cards on the board, the new task is added to the backlog, then `startMaster` processes all cards in order.

### Dialogue mode (optional, future)

If the user wants a back-and-forth (not just one-shot proposal), the interactive intake can loop:
```
Master: When you say "add a login page" — do you mean web UI or API auth?
You: web UI
Master: And should it show the board or also allow adding tasks?
You: just the board for now
Master: [proposes task]
```

This is a `while` loop around `callLLM` — each turn appends to the conversation. The loop exits when the user says `y` to the proposed task or `n` to cancel.

For the first version, one-shot is enough: the master proposes, the user approves or rejects. The dialogue loop is Phase 2.

## What This Enables

- **The user doesn't need to write perfect task descriptions.** They give a loose idea, the master formalizes it.
- **The master surveys the project before proposing.** The acceptance criteria are grounded in the actual codebase.
- **The user reviews before the task enters the board.** No surprise tasks.
- **The master introduces itself.** The user knows what serf is, what the project is, what's going on — straight from the coding agent.

## Implementation Phases

### Phase 1: One-shot intake (KISS)
1. Add `interactiveTaskIntake(description)` to `src/index.ts`
2. `serf start "some task"` calls it before `startMaster`
3. Master surveys project, proposes task, user approves/rejects
4. Task added to board, loop starts

### Phase 2: Dialogue intake (future)
1. Loop the intake — user can answer clarifying questions
2. Master revises the proposal based on answers
3. Continue until user approves or cancels

### Phase 3: Continuous dialogue (future)
1. `serf start` with no args but an empty board enters dialogue mode
2. Master asks "what would you like to work on?"
3. User describes, master formalizes, loop processes
4. After task completes, master asks "what's next?"

## Questions for Discussion

1. **Should the master use herdr panes for the dialogue?** No — the dialogue is between the master and the user, via stdout/stdin. The master is the loop, not an agent in a pane. herdr panes are for the actor and critic doing the work.

2. **Should the master write its introduction to a file?** It could write to `.serf/workspaces/master/.serf/introduction.md` so the next session can read it. But KISS — the introduction is generated each time from the project state. It's always current.

3. **What if `serf start "task"` is called when cards are already on the board?** The new task is added to the backlog (after approval), then `startMaster` processes all cards in order. The user can also use `serf task` to add without the dialogue, then `serf start` to process.

4. **Should the master read `.serf/knowledge/` during intake?** Yes — past skills, patterns, and failures inform the task proposal. If a similar task failed before, the master should reference that in the proposal.