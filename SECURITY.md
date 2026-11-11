# Security

Threat model for Kauda Online. The chips are virtual and have no cash value,
but players can still be cheated, chips can still be stolen or farmed, and the
site can still be used to attack its users. This file covers those risks.

## Hard rules

These are not negotiable. Any change that breaks one of them is a bug, however
convenient it is. If one of them ever has to change, change it in this file
first and give the reason.

1. **The server is the only authority on a throw, a balance or a stake.** No
   client message may declare a winner, report shell faces, set a balance or
   set a stake. A client may only *ask*: to sit, to stand, to bet an amount, to
   throw. The server decides what happens.
2. **Randomness comes from `crypto.randomBytes` or `crypto.randomInt`.**
   `Math.random` is banned everywhere except tests and purely cosmetic
   animation. Lint enforces this.
3. **Every inbound message is schema-validated, then checked against the
   table's current phase and the player's real balance.** A message that fails
   either check is rejected and logged. It is never coerced into a valid one.
4. **Chips are an append-only ledger.** A balance is derived from ledger
   entries and is never overwritten. Corrections are new entries, never edits.
5. **A username is not an identity.** Identity is a signed, `httpOnly`,
   `Secure`, `SameSite=Lax` cookie holding a 256-bit random session id. The
   session itself is stored on the server. (Built: see "Identity: guest
   sessions". `Secure` is set in production; the dev server is plain HTTP on
   127.0.0.1.)
6. **No user text is ever rendered as HTML.** No `innerHTML`, no
   `dangerouslySetInnerHTML`, no `document.write`, for any value a user
   created or could influence.
7. **No secrets in the web package.** Everything in `@kauda/web` and
   everything in a `VITE_*` variable is public.
8. **Every round is recorded with its seed**, so any disputed hand can be
   replayed exactly.

## Assets and attackers

What we protect, in order:

1. Fairness of the throw, and players' confidence that it is fair.
2. Chip balances: that nobody gains or loses chips except by playing.
3. Players' browsers and sessions.
4. Availability of the tables.

Who we expect:

- A player with browser devtools who edits client code or forges websocket
  messages.
- A player running several accounts, or a script that plays for them.
- Someone outside the site who wants to attack its users (XSS, CSRF).
- A compromised dependency.
- The operator. Players should not have to take our word that the throw is
  fair. See "A rigged server".

## How a round runs

Several threats are answered by the order of a round, so here it is once:

1. **Open.** The server generates `serverSeed = randomBytes(32)` and publishes
   `commit = SHA-256(serverSeed)` to the table. It does not publish the seed.
2. **Betting.** Seated players and chyakhe send bet requests. Each one is
   validated (rule 3) and, if accepted, the chips at risk are moved into the
   table's escrow account in the ledger before the bet counts.
3. **Lock.** The server closes betting. Any bet message that arrives after the
   lock is rejected, whatever its timestamp says.
4. **Throw.** Faces are derived from `HMAC-SHA256(serverSeed, roundId ||
   clientSeeds)`. The first 16 bits are the 16 shells, one bit each, so every
   shell is exactly fair with no modulo bias.
5. **Settle.** `@kauda/rules` settles the round. The ledger entries for the
   round, the escrow release, the seed, the client seeds and the faces are
   written in **one** database transaction.
6. **Reveal.** Only after that commit does the server broadcast the faces and
   `serverSeed`. Anyone can check that `SHA-256(serverSeed)` matches the
   commit and recompute the faces.

The client animation is cosmetic. It is handed the server's faces and must
come to rest on them. Physics in the client never decides a result.

Note for phase 2: `throwShells` in `@kauda/rules` currently takes a
`() => number` source. The server should derive faces from bits as described
above, so that replay is exact and no float conversion is involved.

## Where chips come from: the mint

Every chip traces back to one system account, the **mint**
(`system:mint`). The ledger is double entry: every batch of entries sums to
zero, so chips are only ever moved, never created or destroyed in place.

| Reason | Moves chips | When |
| --- | --- | --- |
| `buyin` | mint -> human | A human buys in |
| `botBuyin` | mint -> bot | A bot joins, or seat filling seats a fresh bot |
| `topup` | mint -> human | A broke human claims a free top-up |
| `botResidual` | bot -> mint | A bot leaves the table with chips left |
| `round` | player -> player | Settlement. The mint never takes part |

Human and bot buy-ins have separate reasons so they can be reported apart,
for example to see how many chips the bots have absorbed from humans.

Player accounts may never go below zero. The mint may, and normally does: its
balance is exactly minus the number of chips in existence, so "how many chips
exist" is one number. A bot exists only for its table, so when it leaves its
residual chips go back to the mint instead of sitting orphaned on a dead
account.

**Master invariant: the sum of every account, the mint included, is exactly
0, always.** The table asserts it after every round and after every round
open, and the database enforces it at every commit (next section). The ledger refuses any batch that does not sum to zero, any round that
includes the mint, and any funding batch that is not one transfer between the
mint and one player, so there is no way to write a chip from nowhere or a
player-to-player gift. A second, independent check isolates settlement from
funding: the sum of all `round` entries over any period is 0, so a settlement
bug cannot hide behind a buy-in.

Top-ups exist because the game is exactly fair: a fair game between one finite
bankroll and bots that are re-funded forever is gambler's ruin, and the human
busts with probability 1 (median about 745 rounds from 2000 chips). A human
below the minimum to sit may claim a top-up back to the standard buy-in, once
per account per cooldown (15 minutes by default), measured from their last
`topup` entry. It is never automatic; the lobby shows it as a choice. It is
not anti-abuse, and is not meant to be: see "Chip farming by bots".

## The ledger in the database

Chips survive restarts in Postgres, through Drizzle (`packages/server/src/db/`).
Production uses node-postgres and `DATABASE_URL`; development and tests use
PGlite (Postgres compiled to WebAssembly) under `.data/`, which is never
committed. Both run the same SQL migrations, kept in `packages/server/drizzle/`.

| Table | What it holds |
| --- | --- |
| `accounts` | `id`, `display_name`, `kind` (`human`, `bot` or `mint`), `balance`, `created_at`. Exactly one `mint` row, created by the first migration |
| `ledger_entries` | `seq`, `account_id`, `round_id` (set exactly for `round`), `chips`, `reason`, `created_at`. Append-only |
| `rounds` | `id`, `table_id`, the thrower's seat and account, `commit_hash`, `seed`, `face_up`, `winning_seat`, `hit`, `stake`, `stake_multiplier`, `deltas`, and `replay` (occupants, bets, streak, faces and rules, so a round replays from the database alone; rule 8). Append-only |

The database enforces the rules itself, so a bug in the server cannot break
them:

- **Append-only.** Triggers raise on any `UPDATE`, `DELETE` or `TRUNCATE` of
  `ledger_entries` or `rounds`, and on deleting an account. A correction is a
  new entry.
- **Balances move only through the ledger.** A trigger on every
  `ledger_entries` insert adds its chips to the account's `balance` in the
  same transaction. A direct `UPDATE` of `balance` raises, and a new account
  starts at 0.
- **No overdraft.** `CHECK (balance >= 0 OR kind = 'mint')`. An entry that
  would take a player below zero fails, and its whole transaction with it.
  The mint may go negative; that is what it is for.
- **The books balance at every commit.** A deferred constraint trigger
  refuses to commit unless the entries of every round sum to 0 and every
  account, the mint included, sums to 0.
- **A round settles in one transaction**: the round row, an entry for every
  non-zero delta, and so every balance. The transaction also checks that the
  round's entries sum to 0 and rolls back if not. Nothing is ever half
  written. A funding move (`buyin`, `botBuyin`, `topup`, `botResidual`) is
  one transaction of two entries, the player and the mint.
- **`verify`** (`pnpm --filter @kauda/server db:verify`, and in the tests)
  recomputes every balance from `ledger_entries` and compares it with
  `accounts.balance`. It also checks that all accounts sum to 0, that every
  round's entries are exactly its recorded deltas, and that there is one
  mint. It is how to find corruption that got past the triggers, for example
  a manual fix made with triggers switched off.

### The single-writer rule

**While a player is at a table, every change to their chips goes through the
room of that table. Nothing else writes to their balance.** The table runs in
memory and synchronously, and its in-memory ledger is a cache of the database
for the players at that table:

- On join, the player's balance is loaded from the database. A new account
  gets the standard buy-in, recorded as a `buyin`.
- Everything that changes chips at the table (rounds, buy-ins, top-ups, a
  departing bot's residual) is written to the database in order, through one
  queue per table, and the table does not move on while a write is pending.
- **If a write fails, the table pauses for good.** Clients are told, the
  failure is logged loudly, and nothing after it is written or played. Chips
  are as of the last write that succeeded. Play never silently continues on
  state the database does not have.
- A player may be at only one table at a time, so only one room ever writes
  their chips. Today this is enforced inside one server process. **Before
  running more than one game server process, this needs a lock shared by all
  of them** (an advisory lock or a lease column in Postgres, or Redis).
  Until then, one process only.
- Anything else that will ever change a balance (an admin grant, a lobby
  top-up when the player is at no table) must first make sure the player is
  at no table, and must write through the same ledger.

## Threats

### Client-side result tampering

*Attack.* Edit the client or forge a message that says "I hit", "I won 500",
"my stake is 1" or "the faces were these".

*Defence.* Rule 1. The protocol has no message that carries a result, a
balance or a stake from client to server. The server computes all three. The
client only renders what it is told. A forged message of an unknown type fails
schema validation (rule 3) and is dropped.

### Predicting the throw

*Attack.* Work out the next throw before betting closes. With `Math.random`
this is practical: V8's generator can be recovered from a handful of outputs.

*Defence.* Rule 2. `serverSeed` is 256 bits from the OS CSPRNG and is not
revealed until after settlement. The commit is a hash, so it gives nothing
away. Faces are never sent to any client, including the thrower, before the
round has settled. No other state (round id, timestamps, counters) feeds the
throw in a guessable way, because it is all keyed by the secret seed.

### A rigged server

*Attack.* The operator, or someone who has broken into the server, picks
throws that favour one account, or picks a seed after seeing the bets.

*Defence.*

- Commit-reveal, as above. The seed is fixed before bets are taken and can be
  checked afterwards, so the server cannot choose it after seeing the bets.
- Client seeds. Each human at the table sends a random contribution during
  betting, and those go into the HMAC. Since the server committed first, it
  cannot grind for a seed that gives a particular result. Bots contribute
  nothing, because the operator controls them. **A table with no human client
  seed is not provably fair**, and the client should say so.
- Rule 8. The seed, client seeds and faces of every round are stored with the
  round's ledger entries. A replay tool recomputes the faces and settlement
  from those alone and flags any mismatch.
- Ledger invariants: the entries for every round sum to zero, the `round`
  entries across the whole ledger net to zero, and every account including
  the mint sums to zero. A periodic job checks all three across the whole
  ledger.

What this does not cover: an operator who changes the code that runs, for
example to leak seeds to one account. Commit-reveal shows that a throw matched
its seed, not that nobody else saw the seed. This is acceptable only because
the chips have no value. See the final section.

### Betting more than you hold

*Attack.* Bet, or sit with a stake, larger than your balance, so that a loss
leaves a negative balance or cannot be paid.

*Defence.* Rule 3, and escrow. Before a throw, the most each participant can
lose on it is moved from their account to the table's escrow account. For a
seat that is the current stake (the thrower pays at most one stake on a miss;
any other seat pays at most one stake on a hit), plus the ghanti if it can
fall due. For a chyakhe it is their bet. If the escrow entry would take the
balance below zero, the request is refused. A seated player who cannot cover
the next stake stands up and a bot takes the seat. The database also enforces
`balance >= 0` at the point of writing an escrow entry, so a bug in the server
cannot overdraw an account.

### Double-spend by racing two bets

*Attack.* Send two bets at once, at one table or at two, so that both pass the
balance check before either is recorded.

*Defence.*

- Within a table, Colyseus handles a room's messages one at a time, so two
  bets at one table cannot interleave.
- Across tables, today's defence is the single-writer rule above: a player is
  at one table at a time, so one room alone writes their chips, and the
  database's overdraft check is the backstop. The planned escrow below
  replaces that once there is more than one server process.
- Across tables, that is not enough. The balance check and the escrow entry
  happen in one database transaction that first takes a row lock on the
  account (`SELECT ... FOR UPDATE` on the account row). Concurrent bets on one
  account therefore queue, and the second one sees the first one's escrow.
- Every bet request carries a client-generated idempotency key, unique per
  account in the database, so a retried message cannot be applied twice.
- A player may sit at only one table at a time, as a seat or as a chyakhe.
  That limits the exposure even if one of the above has a bug.

### Betting after the result is known

*Attack.* Get a bet in after the faces are decided: by delaying a message,
replaying one, setting a timestamp in the past, or reading the result off the
websocket before the client shows it and betting at another table.

*Defence.* The phase machine is the only clock. A bet is accepted only while
the room's phase is `betting`, as the server sees it at the moment it handles
the message. Client timestamps are ignored. Faces are computed only after the
lock and broadcast only after settlement, so there is nothing to read early.
One table per player rules out using one table's result at another.

### Collusion between two accounts at one table

*Why this is structural here.* Each throw is one player against three, and a
miss pays only the winning seat. So two accounts at one table are often on
opposite sides of a payment, in both directions.

*What collusion cannot do.* The shells are random and nobody holds hidden
information, so a pair of accounts cannot raise their combined expected
result. Against the other two seats they still break even on average.

*What it can do.* Move chips from one account to another on purpose. Several
choices are left to players: whether to sit, which seat a chyakhe backs, how
much a chyakhe bets, and when to leave during a doubling run. Those let a
partner pick the size and timing of the payments, which is chip dumping. It
matters because it turns chips gathered on throwaway accounts (see the next
threat) into a balance on one main account, and because it could later be
used to sell chips for cash between players.

*Defence.*

- No way to transfer chips directly between players, ever. Playing is the
  only way chips move.
- Record the net flow between every pair of accounts. Flag pairs whose flow is
  large and lopsided compared with what random play would produce.
- Device and network signals: flag accounts that share a device fingerprint or
  IP and keep turning up at the same table.
- Chyakhe bet limits that scale with the table stake and with account age.
- Private tables are where this is easiest. Flagged pairs lose access to them
  and to leaderboards first.

### Chip farming by bots

*Attack.* Script many guest accounts to claim sign-up and daily chip grants,
then dump them into one account. Or script play against our own bots in the
hope of beating them.

*Defence.*

- Our bots play the same zero-edge game, so there is nothing to win from them
  on average. Bots are funded from the mint (`botBuyin`) and hand their
  residual back to it when they leave (`botResidual`), all in the same ledger,
  so their wins and losses are recorded too, and a player who is steadily up
  against bots shows up in the data as a net flow out of the mint.
- Today the only grant is the top-up, and it is limited only by a
  per-account cooldown. That is deliberate: with guest login a busted player
  can just create a new guest and get a fresh buy-in, so tighter gating buys
  nothing until real accounts exist. Once they do, grants should be
  rate-limited per account, per device and per IP, and only come in once an
  account has played some rounds.
- Guest accounts have a small balance ceiling and cannot sit at high-stake
  tables until they have played a while.
- Rate limits and proof-of-work or a challenge on account creation when
  sign-ups from one source spike.
- The chip-dumping detection above is what makes farming pointless: farmed
  chips stay stuck on the accounts that farmed them.

### XSS via usernames and chat

*Attack.* A username or chat line containing markup or script, shown to
everyone at the table and in the lobby.

*Defence.*

- Rule 6. React escapes text by default. That is enough, provided nobody
  reaches for `dangerouslySetInnerHTML`, which lint bans.
- Text drawn in the 3D scene goes to canvas or a texture, never to DOM HTML.
- Usernames are restricted at sign-up: NFC-normalised; letters (Devanagari and
  Latin), digits, space, `_` and `-`; 3 to 20 characters. No bidi control
  characters or zero-width characters, so a name cannot pose as someone else
  or flip the text around it.
- Chat is plain text with a length cap. Links are not made clickable.
- Content Security Policy: `default-src 'self'`, no `unsafe-inline` or
  `unsafe-eval` for scripts, `connect-src` limited to our own API, websocket
  and LiveKit hosts. `frame-ancestors 'none'`.
- Display names coming from LiveKit are treated as user text like any other.

### CSRF and cross-origin websockets

*Attack.* A page on another site makes the victim's browser send a request
with the session cookie, or opens a websocket to the game server that the
browser lets through with the victim's cookie.

*Defence.*

- `SameSite=Lax` stops cookies on cross-site POSTs and subresource requests.
  On its own it is not enough.
- No GET request changes state.
- Every state-changing HTTP request must carry an `Origin` header on the
  allowlist and a JSON body, or it is refused (built, for the session
  routes). A JSON body means a cross-site form cannot post, and a
  cross-origin fetch needs a preflight that CORS refuses. Still to do: a
  CSRF token tied to the session, once there are routes that act on a
  logged-in account's behalf beyond logging out.
- **Websockets are not covered by CORS or by SameSite in every browser.** The
  server checks `Origin` on every websocket upgrade against an exact
  allowlist and refuses anything else, including no `Origin` at all. The
  session is checked on upgrade as well, not just on the first message
  (built).
- The session id is stored server-side as its hash, so a database leak does
  not hand out live sessions (built). Sessions expire; see the next section.

### Identity: guest sessions

This is built, not planned (`packages/server/src/auth/`).

- **A session id** is 32 bytes from `crypto.randomBytes`. The cookie holds it
  with an HMAC-SHA256 signature, `<id>.<signature>`, both base64url. The
  `sessions` table stores only `sha256(id)`, with `account_id`,
  `created_at`, `last_seen_at`, `expires_at` and `revoked_at`.
- **The signing key** comes from `KAUDA_SESSION_SECRET` (at least 32 bytes,
  as hex), never committed. The server refuses to start in production
  without it. In development only, a random key is kept in `.data/`
  (gitignored). Changing the key logs everyone out.
- **The cookie** is `httpOnly`, `SameSite=Lax` and `Path=/`. In production it
  is also `Secure` and named with the `__Host-` prefix, which pins it to the
  exact host over HTTPS. Page scripts cannot read it.
- **Checks.** The signature and the session hash are compared in constant
  time. A cookie is refused if its signature is wrong, or if the session is
  unknown, revoked or expired.
- **Expiry slides:** 90 days from last use. A guest has no password and no
  other way in, so losing the cookie loses the account. Linking a real login
  method (an `auth_methods` table) is a later phase.
- **No session id is ever logged.** A test captures every log line through a
  whole flow and checks that the id appears in none of them.
- **Creating a guest** is `POST /session/guest` with `{ name, turnstileToken }`.
  - The Turnstile token is verified server-side with Cloudflare's siteverify.
    Any failure counts as a refusal.
  - The name must pass the username rules in "XSS via usernames and chat",
    or it is refused; it is never silently renamed.
  - It is rate-limited per IP: 5 per hour by default.
  - In one transaction it creates a human account, its standard buy-in from
    the mint, and the session.
  - Development uses Cloudflare's always-pass test keys; production must set
    `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`.
- **Other routes:** `POST /session/logout` revokes the session and clears the
  cookie. `GET /session/me` returns the account or 401.
- **Joining a room.** The room resolves identity only from the session cookie
  on the WebSocket upgrade. A join with no valid session is refused, and
  nothing the client puts in its join options is read. The same account
  connecting twice replaces the first connection.
- **One origin.** The page, the session routes and the WebSocket share one
  origin, which is why the cookie reaches the upgrade. Production must keep
  them on one origin too, or move to an explicit token handshake.

Known gaps, to close before this faces the internet:

- **Rate limits** live in memory, so they are per process; more than one
  process needs them in Redis.
- **Client IP behind a proxy.** The rate limit uses the socket's peer
  address. Behind a proxy it must read the proxy's own header, and only
  that. Colyseus itself trusts `X-Forwarded-For` for `AuthContext.ip`, which
  any client can forge, so that value is a hint, never a key for a limit.
- **Logout and live connections.** Logging out does not yet close the
  account's open connections. They end at their next reconnect.
- **Revoking every session** of an account (say, "log out everywhere") is
  not built yet.

### Denial of service

*Attack.* Flood messages, open many sockets, create many rooms, send huge
payloads, flood chat, or ask for LiveKit tokens over and over.

*Defence.*

- Size limits on every message and HTTP body, applied before parsing.
- Per-session and per-IP rate limits on messages, chat, room creation, bets
  and voice tokens. Clients that keep going over are disconnected.
- A cap on sockets per session and per IP, and on rooms per server.
- Turn timers in every room: a player who stalls is replaced by a bot, so one
  idle or hostile player cannot freeze a table.
- Redis presence entries expire, so dead connections do not pile up.
- A CDN or proxy in front of the HTTP endpoints. The game server is never the
  first thing exposed to the internet.

### Supply chain

*Attack.* A compromised or typosquatted npm package, or a malicious install
script.

*Defence.*

- `pnpm-lock.yaml` is committed, and CI installs with `--frozen-lockfile`.
- Install scripts are off by default. Only packages that need them are listed
  in `onlyBuiltDependencies`.
- Exact versions for runtime dependencies. Updates come through an automated
  PR that a human reviews, and a new package needs a reason in its PR.
- `@kauda/rules` has no runtime dependencies at all, and should stay that way.
- `pnpm audit` in CI. A high-severity finding fails the build.
- No third-party scripts from a CDN at runtime. Everything is bundled and
  served from our own origin, which the CSP enforces.
- CI tokens have the least access they need, and deploy credentials are not
  available to PR builds from forks.

### Secrets in the client

Rule 7. The LiveKit API secret, database credentials and the cookie-signing
key live only in the server's environment. The browser gets short-lived,
room-scoped LiveKit tokens minted by the server. CI fails the build if a
`VITE_*` variable name looks like a secret (`SECRET`, `KEY`, `TOKEN`,
`PASSWORD`) or if the built bundle contains a known secret value.

## Enforcement

The rules only hold if tooling checks them:

- ESLint: `no-restricted-properties` on `Math.random` outside `**/test/**` and
  animation code, and `react/no-danger`. `no-restricted-syntax` on assigning
  to `innerHTML` or `outerHTML`.
- The ledger tables, as built (see "The ledger in the database"): triggers
  refuse `UPDATE`, `DELETE` and `TRUNCATE` on `ledger_entries` and `rounds`,
  balances move only through the ledger trigger, a `CHECK` stops any player
  balance going below zero, and a deferred constraint trigger refuses any
  commit where a round or the books do not sum to zero. Amounts are integers
  (`bigint`) with a `CHECK` that they are not zero. Still to do for
  production: an application database role with `INSERT` and `SELECT` only
  on the ledger tables, so even the triggers cannot be dropped by the app.
- `db:verify` against the production database on a schedule, alerting on any
  problem.
- A protocol test that lists every client-to-server message type and fails if
  one gains a field named or typed like a result, balance or stake.
- A replay test that replays recorded rounds from their seeds in CI.

## If chips ever become purchasable

**This file is not enough for that.** Once chips can be bought, or exchanged
for anything of value, Kauda Online stops being a game with points and becomes
a service that handles money. That would bring in payment-card rules, fraud
and chargebacks, anti-money-laundering and know-your-customer duties, age
checks, and responsible-gambling duties, each with its own threat model.

The bigger problem is legal. The source article describes Kauda played for
money as illegal gambling in Nepal, the country whose players are the main
audience. Paid chips, chips that can be cashed out, or a tolerated
player-to-player market for them could make the site an illegal gambling
operation. That is why the ledger is designed so paid chips *could* be added,
and why adding them is blocked on legal review. Until that review has happened
and its result is written down here:

- Do not add any way to buy chips.
- Do not add any way to cash chips out, or to move them between players.
- Do not treat a design made for virtual chips (for example the trust model
  in "A rigged server") as good enough for real ones.
