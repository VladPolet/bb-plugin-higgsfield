# bb-plugin-higgsfield

**Higgsfield Credits** for [BB](https://getbb.app): your Higgsfield credit
balance, next reset, burn forecast, and per-model consumption in the BB
sidebar. Community plugin, not affiliated with Higgsfield.

## Install

Install from the BB Community marketplace, or from source:

```
bb plugin install git:https://github.com/VladPolet/bb-plugin-higgsfield.git
```

Requires the Higgsfield CLI on the BB host. Sign in from the dashboard or with
`higgsfield auth login`.

## Architecture

- `host.ts` — `bb.host` worker on the user's machine; runs the `higgsfield`
  CLI with `--json` (account status, transactions, generate list, workspace
  status, auth login/logout).
- `contract.ts` — typed server↔host RPC contract and `authChanged` signal.
- `normalize.ts` — tolerant parsing of CLI JSON plus usage aggregation.
- `server.ts` — `dashboard`/`login`/`logout` RPC, `bb higgsfield` CLI,
  60s cache.
- `app.tsx` — the sidebar dashboard page.

## Derived data

- **Billing cycle**: the last `grant` row labelled "Subscription Credits"
  starts the cycle; the next reset is one calendar month later, and the next
  grant is assumed equal to the last one. The "Subscription Credits Reset"
  `deduct` row is unused credits expiring, not usage.
- **Generations**: one `spend` row per generation; `refund` rows are failed
  generations and net against the model's credits.
- **Media type**: from `higgsfield model list` (cached 12h), matched by
  display name / job type, with a keyword fallback.
- **Colors**: top 7 models by spend get sticky categorical slots (persisted,
  so colors never repaint on refresh or filter); the rest fold into "Other".

## Auth

Delegated to Higgsfield's OAuth 2.0 PKCE flow in the CLI. Google sign-in is
offered on Higgsfield's login page. No client IDs or tokens live in the plugin.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `cliPath` | `higgsfield` | CLI command or absolute path |
| `maxPages` | `10` | Max 100-row transaction pages per refresh (history is read back up to 95 days) |

## License

MIT

## Develop

```
npm install --include=dev
npm run typecheck && npm test
bb plugin install .
bb plugin dev
```

If a number is missing, compare `bb higgsfield raw status` with the field
lists in `normalize.ts`.
