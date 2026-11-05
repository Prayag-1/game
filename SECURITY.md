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
   session itself is stored on the server.
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
- Ledger invariant: the entries for every round sum to zero, and a periodic
  job checks it across the whole ledger.

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
  on average. Bots hold chips from a house account in the same ledger, so
  their wins and losses are recorded too, and a player who is steadily up
  against bots shows up in the data.
- Grants are rate-limited per account, per device and per IP, and only come
  in once an account has played some rounds.
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
  allowlist, and a CSRF token tied to the session.
- **Websockets are not covered by CORS or by SameSite in every browser.** The
  server checks `Origin` on every websocket upgrade against an exact
  allowlist and refuses anything else, including no `Origin` at all. The
  session is checked on upgrade as well, not just on the first message.
- The session id is stored server-side as its hash, so a database leak does
  not hand out live sessions. Sessions are rotated on login and expire.

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
- The ledger table: the application's database role has `INSERT` and
  `SELECT` only, with no `UPDATE` or `DELETE`, and a trigger refuses either
  one. Amounts are integers (`bigint`) with a `CHECK` that they are not zero.
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
