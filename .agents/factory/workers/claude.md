---
type: worker
probe: command -v claude
command: claude --dangerously-skip-permissions --model sonnet -p < {prompt_file}
---

# claude

Implementation worker. Which worker is the default IC is routing data, not a
worker-file fact — see [../routing.md](../routing.md). **`--model sonnet`** is pinned in the command
(the alias, not a dated id; never a `[1m]` variant). stdin IS the prompt — do
not add `< /dev/null`.


**`-p` mode has one turn.** Observed 2026-09-03: the worker started a long gate
(`pnpm -r test`) as a background task, printed "I'll stop polling and wait for the
background task notification before continuing", and the process exited — no result
file, edits left in the tree. In headless mode there is no next turn. Every brief
for this worker must say: run every gate command in the foreground and wait for it;
never background a command; never end the turn while a command is running.

Dispatch rule: run `probe` first — if it fails, this worker does not exist on
this machine; pick another file in this directory. Then substitute the
placeholders — `{prompt_file}` with the brief path, `{repo_path}` with the
absolute repo or worktree path — and dispatch per
[../protocol.md](../protocol.md), which appends the log redirect and
backgrounds the run. Change the flags here, never in a brief. The result
contract is defined in the same file.
