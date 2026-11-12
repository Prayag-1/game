# Kauda Online

A browser game of Kauda, the Nepali sixteen-shell game played at Tihar.

## Packages

| Package | What it is |
| --- | --- |
| `@kauda/rules` | The whole game as pure functions: the throw, the seat mapping and settlement. No I/O. The server treats it as the authority. |
| `@kauda/protocol` | Wire messages shared by client and server. |
| `@kauda/server` | The table as a pure state machine (phases, commit-reveal, the append-only ledger with its mint, command validation, bots, top-ups), wrapped by `KaudaRoom`, a Colyseus room that is only an adapter. It also serves the built web client in production (`webClient.ts`). |
| `@kauda/web` | The browser client: React 19, Vite, Tailwind, Zustand, react-router, i18next (Nepali first), the Colyseus client. |

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

## Web client

```bash
pnpm dev
```

Then open <http://127.0.0.1:5173/>. That one command starts the game server
on 127.0.0.1:3000 and the Vite dev server on 127.0.0.1:5173.

Vite proxies `/session`, `/tables` and the `/ws` WebSocket to the game
server, so the page, the API and the socket all share one origin. They
have to, because the session cookie rides the WebSocket upgrade only on
the page's own origin. There is no CORS. In production the game server
serves the built `packages/web/dist` itself:

```bash
pnpm preview   # build the web client, serve it from the game server on http://127.0.0.1:3000/
```

`pnpm preview` serves it under the production Content-Security-Policy, with
no `unsafe-inline` and no `unsafe-eval` (`packages/server/src/webClient.ts`).
Only the Vite dev server relaxes the policy, because HMR needs inline scripts.

Nepali is the default; the header toggles English, and the choice is kept in
the browser. The Nepali strings still need a native speaker's review (see the
TODO at the top of `packages/web/src/locales/ne.json`).

### Playing

You sign up as a guest: a name and a Cloudflare Turnstile check (test keys in
development, so it always passes), which creates an account with the standard
buy-in and a session cookie. A refresh brings you back as the same player, at
the same seat; Logout and a new guest give a fresh account. A guest has no
password, so clearing the browser's cookies loses the account.

After signing in you land in the lobby:

- **Quick Play** seats you at the public table with the most people that has
  room, or opens a new one.
- **Join** joins a particular public table from the list.
- **Create Private Table** makes a table with full or simple rules (simple
  means no doubling, no ghanti) and shows a code and a link like
  `http://127.0.0.1:5173/?code=K7RM2Q` to send to friends. Opening the link
  goes straight to that table after sign-in.
- **Join by Code** joins a private table by its code.

At the table you start as a च्याँखे (outside bettor): pick an amount and bet on
any seat but the thrower's while betting is open. **Sit** takes a seat a
human may have (between rounds at once, mid-round as a reservation for the
next round). When the throw is yours, **Throw** lights up; a hit (मा-र्यो)
keeps the throw and doubles the stake, a miss (ति-र्यो) passes it
anticlockwise. **Top Up** appears when you are too poor to sit. The round log
shows who gained and lost, and **निष्पक्षता** (fairness) shows each round's
commitment before betting and the revealed seed after, checked in your
browser with sha256. Another tab of the same player takes over the
connection; the old one says so and can take it back.

**Leave Table** returns you to the lobby. Empty tables go away: public ones
after 2 minutes, private ones after 10 minutes, and the code dies with the
table.

The table screen has two layers: the game state around the edge, and the
`Stage` in the middle (`packages/web/src/components/table/Stage.tsx`), which
gets only props and draws the shells as circles until the 3D scene replaces it.

The Turnstile **site** key is fixed at build time from
`VITE_TURNSTILE_SITE_KEY`. Without it, the build uses Cloudflare's test key.
The secret key never enters `@kauda/web`. `pnpm --filter @kauda/web build`
lints first (it fails on `dangerouslySetInnerHTML` and `innerHTML`), then
scans the bundle for secrets.

Tests:

```bash
pnpm test                       # every package, including the web component tests
pnpm --filter @kauda/web e2e    # Playwright, Chromium: real game server, production build, strict CSP
```

Run `pnpm --filter @kauda/web e2e:install` once first to fetch Chromium. The
end-to-end run needs internet access to Cloudflare for the Turnstile widget.

## The game server in development

> **For your own machine only. Never expose it to a network.** The dev game
> server runs over plain HTTP on 127.0.0.1, with a development signing key and
> Turnstile test keys. The session design itself is described in
> `SECURITY.md`, "Identity: guest sessions".

Set `PORT` to move it off 3000 (then point Vite at it with
`KAUDA_GAME_SERVER=http://127.0.0.1:<port>`). `KAUDA_FAST_ROUNDS=1` shortens
every phase to a few seconds, as the Playwright tests do.

## Chips

Chips are virtual and carry no cash value.
