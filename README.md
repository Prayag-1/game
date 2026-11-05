# Kauda Online

A browser game of Kauda, the Nepali sixteen-shell game played at Tihar.

## Packages

| Package | What it is |
| --- | --- |
| `@kauda/rules` | The whole game as pure functions: the throw, the seat mapping and settlement. No I/O. The server treats it as the authority. |
| `@kauda/protocol` | Wire messages shared by client and server. |
| `@kauda/server` | The table as a pure state machine: phases, commit-reveal, the append-only ledger, command validation and bots. No sockets yet; Colyseus wraps it next. |
| `@kauda/web` | Browser client. Not yet built. |

## Getting started

```bash
pnpm install
pnpm test
```

## Chips

Chips are virtual and carry no cash value.
