import { DEFAULT_HOUSE_RULES, type HouseRules, type SeatId } from "@kauda/rules";
import { verifyThrow, type CommitmentFactory } from "./fairness.js";
import { ISSUE_REASONS, MINT_ACCOUNT, type LedgerReason } from "./ledger.js";
import type { SeatFillPolicy } from "./seating.js";
import { Table, type RoundRecord } from "./table.js";

/**
 * Plays a table against itself on a virtual clock. Used by the `demo` script
 * and by tests. Rounds are read by draining table.records(), never from what
 * one tick returns: a round can settle on a tick or inside a bot's throw, and
 * reading only one of those would drop most rounds.
 */

export const HIT = "मा-र्यो";
export const MISS = "ति-र्यो";

export interface DemoOptions {
  readonly rounds: number;
  readonly out: (line: string) => void;
  readonly rules?: HouseRules;
  readonly buyIn?: number;
  /** Defaults to real crypto seeds. */
  readonly commitments?: CommitmentFactory;
  readonly botRandom?: () => number;
  /** Omit for the table's standard seat filling; null turns it off. */
  readonly seatFilling?: SeatFillPolicy | null;
}

export interface DemoSummary {
  readonly roundsPlayed: number;
  readonly hits: number;
  readonly misses: number;
  readonly pushes: number;
  readonly humanThrows: number;
  readonly botThrows: number;
  readonly ledgerEntries: number;
  readonly chipsAtStart: number;
  /** Chips the mint issued after the start: replacement bots' buy-ins and top-ups. */
  readonly chipsIssued: number;
  /** Chips departing bots returned to the mint after the start. */
  readonly chipsReturned: number;
  readonly botsAdded: number;
  /** Top-ups the human claimed after going broke. */
  readonly topUps: number;
  readonly chipsAtEnd: number;
  /** Minus the chips in existence. */
  readonly mintBalance: number;
  /** Every account, the mint included. Must be 0. */
  readonly allAccountsSum: number;
  /** Sum of every "round" entry over the session. Must be 0, whatever funding did. */
  readonly roundNet: number;
  /**
   * The ledger verifies, all accounts sum to 0, round entries net to 0, every
   * round sums to 0, and chipsAtEnd = chipsAtStart + chipsIssued - chipsReturned.
   */
  readonly conserved: boolean;
  /** Every throw matched the hash published when its betting opened. */
  readonly allVerified: boolean;
  readonly failures: readonly string[];
  /** True if play stopped early because fewer than two players could sit. */
  readonly stalled: boolean;
}

interface Person {
  readonly id: string;
  readonly name: string;
  readonly isBot: boolean;
  readonly seat?: SeatId;
}

const PEOPLE: readonly Person[] = [
  { id: "hari", name: "Hari (you)", isBot: false, seat: "teeya" },
  { id: "maya", name: "Maya", isBot: true, seat: "chauka" },
  { id: "bikash", name: "Bikash", isBot: true, seat: "panja" },
  { id: "sunita", name: "Sunita", isBot: true, seat: "chakka" },
  { id: "dawa", name: "Dawa", isBot: true },
  { id: "pema", name: "Pema", isBot: true },
];

const STEP_MS = 250;

export function runDemo(options: DemoOptions): DemoSummary {
  const { rounds, out } = options;
  if (!Number.isSafeInteger(rounds) || rounds < 1) throw new RangeError("rounds must be a positive integer");
  const buyIn = options.buyIn ?? 2_000;

  let t = Date.UTC(2026, 10, 1, 18, 0, 0); // a Tihar evening; only the differences matter
  const table = new Table(
    { tableId: "demo", rules: options.rules ?? DEFAULT_HOUSE_RULES },
    {
      now: () => t,
      ...(options.commitments === undefined ? {} : { commitments: options.commitments }),
      ...(options.botRandom === undefined ? {} : { botRandom: options.botRandom }),
      ...(options.seatFilling === undefined ? {} : { seatFilling: options.seatFilling }),
    },
  );

  // Everyone ever seen at the table, so replacement bots get names in the log.
  const known = new Map<string, { name: string; isBot: boolean }>(
    PEOPLE.map((p) => [p.id, { name: p.name, isBot: p.isBot }]),
  );
  const name = (id: string | undefined): string => (id === undefined ? "-" : (known.get(id)?.name ?? id));

  for (const p of PEOPLE) {
    const joined = table.join(p.id, { name: p.name, isBot: p.isBot, buyIn });
    if (!joined.ok) throw new Error(`could not join ${p.id}: ${joined.reason}`);
    if (p.seat !== undefined) {
      const sat = table.handle(p.id, { type: "sit", seat: p.seat });
      if (!sat.ok) throw new Error(`could not seat ${p.id}: ${sat.reason}`);
    }
  }
  const chipsAtStart = table.ledger.totalInPlay();
  const entriesAtStart = table.ledger.entries().length;
  const filling = options.seatFilling === null ? "off" : "on";

  out(`Kauda demo: ${PEOPLE.filter((p) => p.seat).length} seated, ${PEOPLE.filter((p) => !p.seat).length} chyakhe bots, ${buyIn} chips each`);
  out(`House rules: thini ${table.rules.thini}, doubling ${table.rules.doubling ? "on" : "off"}, cap ${table.rules.maxStakeMultiplier}x, ghanti ${table.rules.ghantiChips}; seat filling ${filling}`);
  out("");

  const published = new Map<string, string>(); // roundId -> hash seen while betting was open
  const failures: string[] = [];
  let printed = 0;
  let hits = 0;
  let misses = 0;
  let pushes = 0;
  let humanThrows = 0;
  let botThrows = 0;
  let stalled = false;
  let topUps = 0;
  const human = PEOPLE.find((p) => !p.isBot);

  const observe = (): void => {
    const v = table.view();
    for (const p of [...Object.values(v.seats), ...v.chyakhe]) {
      if (p !== null && !known.has(p.playerId)) {
        known.set(p.playerId, { name: p.name, isBot: p.isBot });
        out(`      ${p.name} joins with ${p.chips} chips`);
      }
    }
    if (v.phase === "betting" && v.roundId !== null && v.commitHash !== null && !published.has(v.roundId)) {
      published.set(v.roundId, v.commitHash);
    }
  };

  const report = (r: RoundRecord): void => {
    const hash = published.get(r.roundId);
    const ok = hash !== undefined && hash === r.commitHash && verifyThrow(r.seed, hash, r.faces);
    if (!ok) failures.push(`${r.roundId}: ${hash === undefined ? "no hash was published" : "seed does not match the published hash"}`);
    const replayed = Table.replay(r);
    if (JSON.stringify(replayed.deltas) !== JSON.stringify(r.deltas)) failures.push(`${r.roundId}: replay disagrees`);
    if (Object.values(r.deltas).reduce((a, b) => a + b, 0) !== 0) failures.push(`${r.roundId}: does not sum to zero`);

    const throwerId = r.occupants[r.thrower];
    if (known.get(throwerId ?? "")?.isBot) botThrows += 1;
    else humanThrows += 1;

    const moved = Object.entries(r.deltas).filter(([, c]) => c !== 0);
    const push = !r.hit && moved.length === 0;
    if (r.hit) hits += 1;
    else if (push) pushes += 1;
    else misses += 1;

    const n = String(printed + 1).padStart(String(rounds).length, " ");
    const verdict = r.hit ? `${HIT} hit ` : `${MISS} miss`;
    out(
      `#${n} ${verdict}  ${name(throwerId).padEnd(12)} on ${r.thrower.padEnd(6)}  ` +
        `${String(r.faceUp).padStart(2)} up -> ${r.winningSeat.padEnd(6)}  stake ${String(r.stake).padStart(3)} (${r.multiplier}x)  ` +
        `${ok ? "verified" : "VERIFY FAILED"}`,
    );
    for (const b of r.chyakhe) out(`      bet: ${name(b.playerId)} ${b.chips} on ${b.seat}`);
    const swing = moved
      .sort((a, b) => b[1] - a[1])
      .map(([id, c]) => `${name(id)} ${c > 0 ? "+" : ""}${c}`)
      .join(", ");
    out(`      ${push ? "winning seat empty, no chips moved" : swing}`);
  };

  // Drain every settled round, however it settled.
  const drain = (): void => {
    const records = table.records();
    while (printed < records.length && printed < rounds) {
      const r = records[printed];
      if (r !== undefined) report(r);
      printed += 1;
    }
  };

  let waitingSince: number | null = null;
  for (let guard = 0; printed < rounds && guard < rounds * 200; guard += 1) {
    t += STEP_MS;
    table.tick();
    observe();
    // The human claims a top-up whenever one is on offer (the table never
    // tops anyone up by itself), and if they were stood up, asks for their
    // seat back; mid-round that is a reservation for the next round.
    if (human?.seat !== undefined) {
      const claim = table.claimTopUp(human.id);
      if (claim.ok) {
        topUps += 1;
        out(`      ${human.name} is below the minimum and claims a top-up of ${claim.chips} chips`);
      }
      if (table.seatOf(human.id) === null && table.balance(human.id) >= table.minChipsToSit) {
        table.handle(human.id, { type: "sit", seat: human.seat });
      }
    }
    // The human throws as soon as the throw is theirs.
    const v = table.view();
    if (v.phase === "throwing" && v.thrower !== null && v.seats[v.thrower]?.isBot === false) {
      const thrower = v.seats[v.thrower];
      if (thrower) table.handle(thrower.playerId, { type: "throw" });
    }
    drain();

    if (table.phase === "waiting") {
      waitingSince ??= t;
      if (t - waitingSince > 60_000) {
        stalled = true;
        break;
      }
    } else waitingSince = null;
  }

  // Conservation. Chips come only from the mint, and departing bots return
  // theirs to it; rounds only move chips between players. Counted from the
  // player side of each transfer.
  const entries = table.ledger.entries();
  const later = entries.slice(entriesAtStart).filter((e) => e.playerId !== MINT_ACCOUNT);
  const sumOf = (reasons: readonly LedgerReason[]): number =>
    later.filter((e) => reasons.includes(e.reason)).reduce((acc, e) => acc + e.chips, 0);
  const chipsIssued = sumOf(ISSUE_REASONS);
  const chipsReturned = -sumOf(["botResidual"]);
  const botsAdded = new Set(later.filter((e) => e.reason === "botBuyin").map((e) => e.playerId)).size;
  const chipsAtEnd = table.ledger.totalInPlay();
  const mintBalance = table.ledger.mintBalance();
  // Independent of the ledger's own cache: straight from the entries.
  const allAccountsSum = entries.reduce((acc, e) => acc + e.chips, 0);
  const roundNet = entries.filter((e) => e.reason === "round").reduce((acc, e) => acc + e.chips, 0);
  const everyone = new Set(entries.map((e) => e.playerId).filter((id) => id !== MINT_ACCOUNT));
  const balanceSum = [...everyone].reduce((acc, id) => acc + table.balance(id), 0);
  let ledgerOk = true;
  try {
    table.ledger.verify();
  } catch (e) {
    ledgerOk = false;
    failures.push(`ledger: ${(e as Error).message}`);
  }
  const conserved =
    ledgerOk &&
    allAccountsSum === 0 &&
    roundNet === 0 &&
    chipsAtEnd === chipsAtStart + chipsIssued - chipsReturned &&
    chipsAtEnd === -mintBalance &&
    balanceSum === chipsAtEnd &&
    !failures.some((f) => f.endsWith("does not sum to zero"));

  out("");
  out("Final standings");
  const v = table.view();
  const atTable = [
    ...(Object.entries(v.seats) as [SeatId, (typeof v.seats)[SeatId]][]).flatMap(([seat, p]) =>
      p === null ? [] : [{ p, where: seat as string }],
    ),
    ...v.chyakhe.map((p) => ({ p, where: "chyakhe" })),
  ].sort((a, b) => b.p.chips - a.p.chips);
  for (const { p, where } of atTable) {
    const started = PEOPLE.some((q) => q.id === p.playerId);
    const net = started ? `${p.chips - buyIn >= 0 ? "+" : ""}${p.chips - buyIn}` : "(replacement)";
    out(`  ${p.name.padEnd(14)} ${String(p.chips).padStart(6)}  ${net.padEnd(13)} ${where}${p.isBot ? ", bot" : ""}`);
  }
  const present = new Set(atTable.map((x) => x.p.playerId));
  const retired = [...everyone].filter((id) => !present.has(id));
  if (retired.length > 0) {
    const held = retired.reduce((acc, id) => acc + table.balance(id), 0);
    out(
      `  ${retired.length} bot${retired.length === 1 ? "" : "s"} left, returning ${chipsReturned} chips to the mint` +
        (held === 0 ? "" : `; ${held} still on retired accounts`),
    );
  }
  out("");
  out(`Rounds played   ${printed}${stalled ? " (stopped early: fewer than two players could cover the stake)" : ""}`);
  out(`Hits / misses   ${hits} ${HIT} / ${misses} ${MISS} / ${pushes} push`);
  out(`Thrown by       ${humanThrows} human, ${botThrows} bot`);
  out(`Ledger entries  ${entries.length}`);
  out(
    `Chips           ${chipsAtStart} at start` +
      (chipsIssued > 0 ? ` + ${chipsIssued} issued (${botsAdded} replacement bot${botsAdded === 1 ? "" : "s"}, ${topUps} top-up${topUps === 1 ? "" : "s"})` : "") +
      (chipsReturned > 0 ? ` - ${chipsReturned} returned` : "") +
      ` = ${chipsAtStart + chipsIssued - chipsReturned}; ${chipsAtEnd} at end`,
  );
  out(`Mint            ${mintBalance}; all accounts sum to ${allAccountsSum}; round entries net ${roundNet}`);
  out(`Conserved       ${conserved ? "yes" : "NO"}`);
  out(`Throws verified ${failures.length === 0 ? `all ${printed}` : `${failures.length} FAILED`}`);
  for (const f of failures) out(`  ! ${f}`);

  return {
    roundsPlayed: printed,
    hits,
    misses,
    pushes,
    humanThrows,
    botThrows,
    ledgerEntries: entries.length,
    chipsAtStart,
    chipsIssued,
    chipsReturned,
    botsAdded,
    topUps,
    chipsAtEnd,
    mintBalance,
    allAccountsSum,
    roundNet,
    conserved,
    allVerified: failures.length === 0,
    failures,
    stalled,
  };
}
