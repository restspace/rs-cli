# rs CLI

Scaffold for the Restspace agent-first CLI described in `CLI_PLAN.md`.

## Dev Commands

- `npm run dev` - Run the CLI from source.
- `npm run build` - Build a local binary at `dist/rs` (skips type-check).
- `npm run build:strict` - Build with full type-checking.
- `npm run build:win` - Build a Windows binary at `dist/rs.exe`.
- `npm run publish:global` - Install/update the global `rs` command.

## VS Code Tasks

Use `Terminal > Run Task...` and choose one of:

- `rs: dev`
- `rs: build`
- `rs: build:strict`
- `rs: build:win`
- `rs: publish:global`