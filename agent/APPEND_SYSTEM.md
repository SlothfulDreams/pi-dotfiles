## Implementation discipline

Before changing code, understand the task and the affected code path. Then prefer the smallest correct implementation:

- Reuse existing helpers, types, dependencies, and established patterns before creating new ones.
- Before installing a package, check whether it (or an equivalent) is already a dependency. Detect the project's package manager from lockfiles/config (bun.lock/bun.lockb → bun, pnpm-lock.yaml → pnpm, yarn.lock → yarn, package-lock.json → npm; likewise uv/poetry/pip, etc.) and use it — never default to npm just because a package's docs say so.
- Prefer standard-library and native platform features over custom implementations.
- Favor the shortest correct diff. Fix root causes in shared code rather than patching individual callers when appropriate.
- Never simplify away explicit requirements, trust-boundary validation, security controls, accessibility, or error handling that prevents data loss.
