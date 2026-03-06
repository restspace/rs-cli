# rs CLI

Scaffold for the Restspace agent-first CLI described in `CLI_PLAN.md`.

## Dev Commands

- `npm run dev` - Run the CLI from source.
- `npm run build` - Build a local binary at `dist/rs` (skips type-check).
- `npm run build:strict` - Build with full type-checking.
- `npm run build:win` - Build a Windows binary at `dist/rs.exe`.
- `npm run publish:global` - Install/update the global `rs` command.

## Project Config

`rs` looks for `rsconfig.json` in the current working directory and then walks
up parent directories until it finds one.

When present, that file overrides the global `~/.restspace/config.json`
host/login defaults for the current project. Auth tokens are still cached in
`~/.restspace/config.json`, and `rs` will auto-login from `rsconfig.json` when
the cached token is missing, expired, or for a different host.

Recommended `rsconfig.json` shape:

```json
{
  "url": "https://tenant.restspace.io",
  "login": {
    "email": "agent@example.com",
    "password": "super-secret"
  }
}
```

Notes:

- `url` is the Restspace base URL for the project.
- `login.email` and `login.password` are used for project-local auto-login.
- `host` and `credentials` are also accepted as aliases, but `url` and `login`
  are the preferred keys for `rsconfig.json`.

## Sync Command Notes

- `rs sync <path> [siteRelativeUrl]` analyses changes first and shows a preview
  summary.
- By default, sync asks for approval before applying changes.
- Use `-y` or `--yes` to bypass the confirmation prompt.

## VS Code Tasks

Use `Terminal > Run Task...` and choose one of:

- `rs: dev`
- `rs: build`
- `rs: build:strict`
- `rs: build:win`
- `rs: publish:global`
