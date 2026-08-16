# Plan Mode Extension

Read-only exploration mode for safe code analysis. Accepted plans are handed to
[`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo)
for execution tracking.

## Features

- **Write tools disabled**: Disables `edit` and `write` during planning
- **Todo tool deferred**: Disables `todo` during planning and restores it for execution
- **Bash allowlist**: Only read-only bash commands are allowed
- **Plan extraction**: Extracts numbered steps from `Plan:` sections
- **Bordered plan card**: Shows the complete plan in a purple card
- **Execution handoff**: Creates and updates tasks through the `todo` tool
- **Save to file**: Optional `PLAN.md` export from the decision dialog
- **Image-aware refinement**: Refine in the main composer so feedback can include pasted images
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
- `/todos` - Provided by `rpiv-todo`; displays execution progress

## Usage

1. Enable plan mode with `Shift+Tab`, `/plan`, or the `--plan` flag.
2. Ask the agent to analyze code and create a plan.
3. The agent outputs numbered steps under a `Plan:` header:

```text
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. Review the plan card and choose execute, stay, refine, or save to `PLAN.md`.
5. When execution is selected, full tool access is restored and the agent creates
   one `todo` task for each plan step.
6. The agent moves each task through `pending`, `in_progress`, and `completed`.
   The `rpiv-todo` overlay and `/todos` command show progress.

## How It Works

### Plan Mode

- `edit`, `write`, and `todo` are disabled.
- Bash commands are filtered through the read-only allowlist.
- A hidden context message asks the agent for a numbered `Plan:` section.
- Lifecycle hooks parse that response and render the review card.

### Execution Mode

- The tool set that was active before plan mode is restored.
- A hidden follow-up asks the agent to create one task per plan step using the
  `todo` tool.
- `rpiv-todo` owns task status, persistence, the live overlay, and `/todos`.
- The old `[DONE:n]` text parser and plan-mode progress widget are not used.

### Command Allowlist

Safe commands include file inspection, search, directory listing, read-only Git
operations, package information, and system information. Commands that modify
files, Git state, packages, processes, or the operating system are blocked.
