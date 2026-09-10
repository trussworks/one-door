<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- harness:begin -->

## Quality guardrails (managed by repo-harness)

<!-- harness:stack:node -->

### node (npm)

| Check            | Command                        |
| ---------------- | ------------------------------ |
| Format           | `npm run format:check`         |
| Lint             | `npm run lint`                 |
| Typecheck        | `npm run typecheck`            |
| Test             | `npm run test`                 |
| Build            | `npm run build`                |
| Secret scan      | `npm run security`             |
| Dependency audit | `npm audit --audit-level=high` |

#### Rules for AI coding agents (node)

- Run every command above before declaring work complete; all must pass.
- Never weaken a guardrail to make it pass: no eslint-disable/ts-ignore/test.skip without a stated reason in the same change; never edit harness.json to un-enforce a failing check.
- New code ships with tests. Bug fixes ship with a regression test.
- Never commit secrets; the secret scan must stay green.
- Keep the lockfile committed and in sync with package.json.
- If a check fails for a pre-existing reason unrelated to your change, say so explicitly rather than "fixing" it by disabling the check.

<!-- harness:stack:node:end -->
<!-- harness:end -->
