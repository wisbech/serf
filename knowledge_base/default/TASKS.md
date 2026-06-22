# Project Task Board
Last Updated: 2026-06-17

## 🎯 Mission Goal
Build a self-organizing agent harness that evolves autonomously via a Dark Software Factory loop.

## 🛠️ Priority Queue
The following tasks are the current focal points of the harness.

| Task | Goal | Principal Weight (Metric) | Lever (Action) | Status |
| :--- | :--- | :--- | :--- | :--- |
| **KnowledgeBase Integration** | Agents query project wiki before external search | $\downarrow$ Wasted Turns | Inject KB snippets into decompose/synthesize prompts | 🔄 In-Progress |
| **Reliable Idle Signal** | Replace screen-watching with `TASK_COMPLETE` | $\uparrow$ Determinism | Require explicit marker in serf identity prompt | ✅ Done |
| **Feedback Loop** | Implement `serf feedback` as the ultimate sensor | $\uparrow$ Ground Truth | Create CLI command $\rightarrow$ EventStream $\rightarrow$ QualityRepo | 🔄 In-Progress |
| **Budget Guardrails** | Prevent tokenmaxxing via cost-based stops | $\downarrow$ Token Burn | Implement `BudgetTracker` $\rightarrow$ Regroup logic | 🔄 In-Progress |
| **Substrate Migration** | Move from tmux to gRPC/Unix Sockets | $\uparrow$ Scalability | Replace `capturePane` with event-driven state | ⏳ Pending |
| **Dynamic Agency Weights** | Per-folder priority and swarm thresholds | $\uparrow$ Resource Efficiency | Implement `agency_weights.json` and read in `harvest.ts` | 🔄 In-Progress |

## ⚖️ Strategic Anchors
- **Principle 1**: If it didn't get recorded, it didn't happen.
- **Principle 2**: Data is precious, software is ephemeral.
- **Principle 3**: Use the `KnowledgeBase` as the first point of truth.
