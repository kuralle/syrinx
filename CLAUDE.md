<!-- plandesk:start -->
@.plandesk/skill.md
<!-- plandesk:end -->

<!-- plandesk-factory:start -->
## Plan Desk Factory — default operating mode

This repository runs on the Factory workflow. On any work request:
1. **Follow the factory workflow** — orient, then execute the [factory.md](.agents/factory/factory.md) cycle: pull → read → red gate → act → prove → observe → gate → report.
2. **Operate in autonomous-stand mode** — decompose the goal into verifiable moves, drive them to zero, and ship finished work without pausing for permission.
3. **Drive via harness tasks** — use `TaskCreate` / `TaskList` / `TaskUpdate` as the execution spine. One task per move; `in_progress` on start, `completed` the instant its done-condition holds.
4. **Prove before done** — re-run the claimed checks per [protocol.md](.agents/factory/protocol.md); exit codes are authoritative.

@.agents/factory/workflow.md
@.agents/factory/factory.md
@.agents/factory/autonomous-stand.md
<!-- plandesk-factory:end -->
