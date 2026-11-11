# Kauda Online

A browser game of Kauda, the Nepali sixteen-shell game played at Tihar.

## Packages

| Package | What it is |
| --- | --- |
| `@kauda/rules` | The whole game as pure functions: the throw, the seat mapping and settlement. No I/O. The server treats it as the authority. |
| `@kauda/protocol` | Wire messages shared by client and server. |
| `@kauda/server` | The table as a pure state machine (phases, commit-reveal, the append-only ledger with its mint, command validation, bots, top-ups), wrapped by `KaudaRoom`, a Colyseus room that is only an adapter. It also serves the debug client (see below). |
| `@kauda/web` | Browser client. Not yet built. |

## Getting started

```bash
pnpm install
pnpm test
```

## Chips database

Balances, the ledger and every round live in Postgres through Drizzle
(`packages/server/src/db/`, migrations in `packages/server/drizzle/`).

- Without `DATABASE_URL`: PGlite, Postgres in process, stored under
  `packages/server/.data/` (gitignored). One process at a time per data
  directory. Delete the directory to start the economy from scratch.
- With `DATABASE_URL=postgres://…`: node-postgres against a real server.

```bash
pnpm --filter @kauda/server db:verify    # recompute every balance; all accounts must sum to 0
pnpm --filter @kauda/server db:migrate   # apply migrations (the dev server also does this on start)
pnpm --filter @kauda/server db:generate  # after editing src/db/schema.ts; commit the SQL
```

The rules the database enforces, and the single-writer rule, are in
`SECURITY.md` under "The ledger in the database".

## Debug client (developer only)

```bash
pnpm dev
```

Then open <http://127.0.0.1:3000/>. Set `PORT` to use another port.

`packages/server/debug-client/index.html` is a plain HTML page for clicking
through a real game over real sockets: seats, bets, throws, top-ups, the
commit-reveal check in the browser, and a "Simulate drop" button for the
disconnect rules. Killing wifi will not drop the connection, because the page
and the server talk over 127.0.0.1; use "Simulate drop", or close the tab.

You sign up as a guest: a name and a Cloudflare Turnstile check (test keys in
development, so it always passes), which creates an account with the standard
buy-in and a session cookie. A refresh brings you back as the same player;
Logout and a new guest give a fresh account. A guest has no password, so
clearing the browser's cookies loses the account.

After signing in you land in the lobby:

- **Quick Play** seats you at the public table with the most people that has
  room, or opens a new one.
- **Join** joins a particular public table from the list.
- **Create Private Table** makes a table with "default" or "simple" rules
  (simple means no doubling, no ghanti) and shows a link like
  `http://127.0.0.1:3000/?code=K7RM2Q` to send to friends. Opening the link
  goes straight to that table after sign-in.
- **Join by Code** joins a private table by its code.

**Leave Table** returns you to the lobby. Empty tables go away: public ones
after 2 minutes, private ones after 10 minutes, and the code dies with the
table.

> **For your own machine only. Never expose it to a network.** It runs over
> plain HTTP on 127.0.0.1, with a development signing key and Turnstile test
> keys. The session design itself is described in `SECURITY.md`, "Identity:
> guest sessions".

## Chips

Chips are virtual and carry no cash value.
