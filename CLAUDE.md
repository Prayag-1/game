# Kauda Online

Browser game of Kauda, the Nepali sixteen-shell game played at Tihar.
Source for the rules: https://kbhom.wordpress.com/2013/10/19/rules-for-kauda-कौडाको-नियम/

## Locked decisions

| Decision | Value |
| --- | --- |
| Table size | 4 inside seats + up to 8 outside bettors (chyakhe) = 12 |
| Inside seats | teeya (3), chauka (4), panja (5), chakka (6); bots fill empty seats |
| Chips | Virtual. Ledger is structured so paid chips could be added later; needs legal review first |
| Default language | Nepali, with an English toggle |
| Escalation | Ghanti, doubling and mar-taal all in, as switchable house rules |
| Device floor | Mid-range Android on Chrome, iOS Safari 16+ |
| Language and repo | TypeScript everywhere; pnpm + Turborepo monorepo |
| Client | React + Vite, Three.js via React Three Fiber, Rapier physics |
| Game server | Node + Colyseus |
| Voice chat | Dropped. Do not add LiveKit or any WebRTC dependency. |
| Data | Postgres + Drizzle for the ledger, Redis for presence |

## Security rules (short form)

The full threat model and reasoning are in `SECURITY.md`. These eight rules
are hard. Do not break them, even temporarily.

1. The server alone decides throws, balances and stakes. No client message
   declares a winner or sets a balance.
2. Randomness is `crypto.randomBytes` / `crypto.randomInt`. No `Math.random`
   outside tests and cosmetic animation.
3. Validate every inbound message against a schema, then against the table's
   current phase and the player's real balance.
4. Chips are an append-only ledger. Derive balances from entries, never
   overwrite them.
5. A username is not an identity. Identity is a signed, httpOnly,
   SameSite=Lax cookie holding a 256-bit random session id stored on the
   server.
6. Never render user text as HTML: no `innerHTML`, no
   `dangerouslySetInnerHTML`.
7. No secrets in `@kauda/web` or in any `VITE_*` variable.
8. Record every round with its seed so any hand can be replayed.

## The rules model, and why it is fair

A throw is 16 independent fair shells. The winning seat is the number of
face-up shells modulo 4, which reproduces every fact the article states:
4 up is chauka, 5 up is panja, and 0 or 16 up are chauka. That gives chauka
five of the seventeen outcomes and the others four each.

Exact odds over all 65536 throws:

| Seat | Ways | Probability |
| --- | --- | --- |
| chauka | 16512 | 25.1953% |
| panja | 16384 | 25.0000% |
| teeya | 16384 | 25.0000% |
| chakka | 16256 | 24.8047% |

Settlement: on a hit the thrower collects the current stake from each of the
three other seats; on a miss the thrower pays the current stake to the winning
seat only. A hit happens one time in four and a miss three times in four, so
collecting 3x and paying 1x is exactly even **at any stake level**. Doubling
therefore changes the swing of the game without touching its fairness, and the
multiplier cap exists to protect chip balances, not to balance the odds.

This also reconciles the article's two conflicting accounts of mar-taal. The
payout really is "multiplied by the number of wins", because the stake has
doubled once per win. Doubling and mar-taal are one mechanism described from
two sides, which is why the bullets tie doubling to the hit while the prose
ties it to the losers.

Ghanti is modelled as a fee the thrower pays on the first hit of a turn, split
among the other seated players. It is a transfer, never a rake, so the table
still sums to zero.

An earlier model that paid `thini x streak` on the miss gave the thrower a
+0.42 thini edge per turn and needed a ghanti of 5/3 thini to cancel. It was
dropped in favour of the model above, which needs no fudge factor.

## Still unverified in the source article

These are implemented as configurable, with the reading above as the default.
A player who actually plays should confirm them.

- Who receives the ghanti. The article never says.
- Whether ghanti falls on the first hit or the first loss. The bullet says hit.
- Whether the stake cap exists at all in the traditional game.
- What happens to shells that land off the mat.

## Conventions

- All chip amounts are integers. No floats anywhere in settlement.
- `@kauda/rules` is pure: no I/O, no randomness except an injected source.
- The server is the only authority on a throw. The client never rolls.
- Strict TypeScript, including `noUncheckedIndexedAccess`.
- Run `pnpm test` before every commit.
- Later phase, not built: an `auth_methods` table to link a Google or phone login to a guest account (today a guest is only its session cookie).

## Build order

1. Rules engine (`@kauda/rules`) — done
2. Table server plus bots
3. Auth, lobby and tables
4. 3D scene and the throw animation
5. Localisation and polish
6. Security hardening
7. Deploy and ops
