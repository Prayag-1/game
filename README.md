# Kauda Online

A browser game of Kauda, the Nepali sixteen-shell game played at Tihar.

## Packages

| Package | What it is |
| --- | --- |
| `@kauda/rules` | The whole game as pure functions: the throw, the seat mapping and settlement. No I/O. The server treats it as the authority. |
| `@kauda/protocol` | Wire messages shared by client and server. |
| `@kauda/server` | The table as a pure state machine (phases, commit-reveal, the append-only ledger with its mint, command validation, bots, top-ups), wrapped by `KaudaRoom`, a Colyseus room that is only an adapter. `pnpm --filter @kauda/server serve` runs a localhost dev server with a stub identity that is not authentication. |
| `@kauda/web` | Browser client. Not yet built. |

## Getting started

```bash
pnpm install
pnpm test
```

## Chips

Chips are virtual and carry no cash value.
