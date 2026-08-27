# Plan Mode Extension

Read-only exploration mode for safe code analysis. Plans are delivered through
the `propose_plan` tool (structured steps, no text parsing) and accepted plans
are handed to [`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo)
for execution tracking.

## Features

- **Write tools disabled**: Disables `edit` and `write` during planning
- **Todo tool deferred**: Disables `todo` during planning and restores it for execution
- **Bash allowlist**: Only read-only bash commands are allowed
- **Structured plans**: The agent calls `propose_plan` with an ordered step list
- **Bordered plan card**: The tool call renders the full plan in a purple card
- **In-call approval**: The approve/stay/save dialog runs inside the tool call and
  the decision flows back to the agent as the tool result
- **Same-run execution**: Approval restores full tool access and execution
  continues immediately in the same run
- **Context-safe**: The plan lives in the tool call in the transcript, so it
  survives toggling plan mode off and stays prompt-cache friendly
- **Save to file**: Optional `PLAN.md` export from the approval dialog
- **Session persistence**: Planning state survives session resume

## Requirements

Install the todo extension:

```sh
pi install npm:@juicesharp/rpiv-todo
```

Restart Pi or run `/reload` after installation.

## Commands

- `/plan` - Toggle plan mode
- `Shift+Tab` - Toggle between plan and regular mode
- `--plan` flag - Start in plan mode (wins over persisted state on resume)
- `/todos` - Provided by `rpiv-todo`; displays execution progress

## Usage

1. Enable plan mode with `Shift+Tab`, `/plan`, or the `--plan` flag.
2. Ask the agent to analyze code and design a change.
3. When the plan is ready, the agent calls `propose_plan` with the step list,
   which renders the plan card and opens the approval dialog:
   - **Execute the plan** - plan mode turns off, tools are restored, and the
     agent executes immediately with one `todo` task per step
   - **Execute the plan (fresh context)** - Claude Code-style: the session is
     replaced with a fresh one seeded only with the plan, then execution starts
     with a clean context window
   - **Stay in plan mode** - the turn ends; type feedback to refine the plan
   - **Save plan to PLAN.md** - writes the plan to disk and stays in plan mode
4. During execution the agent moves each task through `pending`, `in_progress`,
   and `completed`. The `rpiv-todo` overlay and `/todos` command show progress.

Refinement is just conversation: the proposed plan is part of the transcript
(inside the tool call), so replying with feedback leads to a new `propose_plan`
call with the revised steps.

## How It Works

### Plan Mode

- `edit`, `write`, and `todo` are disabled; `propose_plan` is enabled.
- Bash commands are filtered through the read-only allowlist.
- A small hidden context message states the restrictions and instructs the
  agent to deliver plans via `propose_plan`.

### Approval

- `propose_plan` receives `{ steps: string[] }` - no regex extraction.
- The tool renders the card via `renderCall` and blocks on the approval dialog.
- On approval it restores tools and returns execution instructions as the tool
  result; the agent continues in the same run (tool changes take effect on the
  next model request).
- On fresh-context approval the tool terminates the run and triggers the
  internal `/plan-execute-fresh` command (tool contexts lack session-control
  methods, command contexts have them). The command waits for idle, then
  creates a new session - parented to the old one - seeded with a single user
  message containing the plan, and execution starts there.
- On stay/save the tool returns `terminate: true` to end the turn cleanly.

### Command Allowlist

Bash commands are validated Claude Code-style: the command is split on unquoted
operators (`;`, `|`, `&`, newline) and **every** segment must match the
read-only allowlist, so `ls; sh evil.sh` and `curl ... | sh` are blocked while
`curl ... | jq .` and `cd src && rg foo` pass. Command substitution
(`$(...)`, backticks), process substitution, and output redirection make the
whole command unsafe; stderr-only redirects (`2>/dev/null`, `2>&1`) are
allowed. Quoting is respected, so `grep "=>" src` is fine.

Safe segments include file inspection, search, directory listing, read-only Git
operations, package information, and system information. Destructive variants
of allowlisted commands (`git commit`, `npm install`, `find -delete`/`-exec`,
`sed -i`, ...) are blocked.
