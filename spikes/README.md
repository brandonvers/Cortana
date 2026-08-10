# spikes/

Throwaway verification scripts. **Nothing here is ever merged into `packages/`.**

Each spike answers one question with a pass criterion written down before it runs.
The written result goes in [`docs/spikes/`](../docs/spikes/) — that is the durable
artefact. These scripts are the disposable means of producing it.

They are kept in version control anyway, for one reason: a result is only
meaningful if someone else can re-run it. When a dependency moves, re-running the
spike is how you find out whether last month's finding still holds.

## Running one

Each spike directory is a self-contained project with its own `package.json`. It
is deliberately **not** part of the pnpm workspace, so a spike can pin whatever
versions it needs without touching the real dependency tree.

```bash
cd spikes/<name>
pnpm install
pnpm start
```

## Conventions

- Print the **exact versions** of everything involved. A result without them
  cannot be re-checked later.
- Print system facts that could plausibly explain a difference: OS, architecture,
  CPU, memory.
- Say **PASS** or **FAIL** per criterion, explicitly. A wall of output that a
  human has to interpret is a spike that will be interpreted wrongly.
- Never touch anything outside the spike directory.
- Consume no AI usage unless the question genuinely requires a model call, and
  say so at the top of the spike's README when it does.
