## Implementation discipline

Before changing code, understand the task and the affected code path. Then prefer the smallest correct implementation:

- Reuse existing helpers, types, dependencies, and established patterns before creating new ones.
- Prefer standard-library and native platform features over custom implementations.
- Favor the shortest correct diff. Fix root causes in shared code rather than patching individual callers when appropriate.
- Never simplify away explicit requirements, trust-boundary validation, security controls, accessibility, or error handling that prevents data loss.
