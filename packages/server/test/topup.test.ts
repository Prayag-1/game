import { describe, expect, it } from "vitest";
import { Ledger, MINT_ACCOUNT, Table, type LedgerEntry } from "../src/index.js";
import { TEST_RULES, harness } from "./harness.js";

const COOLDOWN = 60_000;
const topUpsFor = (entries: readonly LedgerEntry[], id: string) =>
  entries.filter((e) => e.reason === "topup" && e.playerId === id);

describe("human top-ups", () => {
  it("lets a human who busts claim once, refuses during the cooldown, and allows it again after", () => {
    const h = harness({ minChipsToSit: 100, standardBuyIn: 120, topUpCooldownMs: COOLDOWN });
    h.ok(h.table.join("A", { name: "A", buyIn: 5_000 }));
    h.ok(h.table.join("B", { name: "B", buyIn: 100 }));
    h.ok(h.table.join("C", { name: "C", buyIn: 5_000 }));
    h.ok(h.table.handle("A", { type: "sit", seat: "teeya" }));
    h.ok(h.table.handle("B", { type: "sit", seat: "chauka" }));
    h.ok(h.table.handle("C", { type: "sit", seat: "panja" }));
    expect(h.table.topUpOffer("B")).toEqual({ ok: false, reason: "topup-not-needed", availableAt: null });

    h.queue(3, 3, 3); // A hits three times: stakes 10, 20, 40
    h.advance(0);
    h.playRound("A");
    expect(h.table.balance("B")).toBe(90); // below the 100 needed to sit

    // Never automatic: B is offered a top-up, but nothing is written until B claims.
    expect(h.table.topUpOffer("B")).toEqual({ ok: true, chips: 30 });
    h.advance(1_000);
    expect(topUpsFor(h.table.ledger.entries(), "B")).toEqual([]);

    const firstClaimAt = h.now();
    expect(h.table.claimTopUp("B")).toEqual({ ok: true, chips: 30 });
    expect(h.table.balance("B")).toBe(120); // back to the standard buy-in
    expect(h.table.claimTopUp("B")).toEqual({ ok: false, reason: "topup-not-needed", availableAt: null });

    h.playRound("A"); // B pays 20: 100
    h.playRound("A"); // B pays 40: 60
    expect(h.table.balance("B")).toBe(60);

    // Busted again, but inside the cooldown.
    const availableAt = firstClaimAt + COOLDOWN;
    expect(h.now()).toBeLessThan(availableAt);
    expect(h.table.claimTopUp("B")).toEqual({ ok: false, reason: "topup-cooldown", availableAt });
    h.advance(availableAt - 1 - h.now());
    expect(h.table.claimTopUp("B")).toEqual({ ok: false, reason: "topup-cooldown", availableAt });
    expect(h.table.balance("B")).toBe(60);

    // And again once it is over.
    h.advance(1);
    expect(h.table.claimTopUp("B")).toEqual({ ok: true, chips: 60 });
    expect(h.table.balance("B")).toBe(120);

    // Each claim is one "topup" transfer from the mint.
    const entries = h.table.ledger.entries();
    expect(topUpsFor(entries, "B").map((e) => e.chips)).toEqual([30, 60]);
    expect(topUpsFor(entries, MINT_ACCOUNT).map((e) => e.chips)).toEqual([-30, -60]);
    expect(entries.reduce((a, e) => a + e.chips, 0)).toBe(0);
    h.table.ledger.verify();
  });

  it("limits claims per account, not per table", () => {
    let t = 1_000;
    const ledger = new Ledger();
    const options = { rules: TEST_RULES, minChipsToSit: 100, standardBuyIn: 120, topUpCooldownMs: COOLDOWN };
    const t1 = new Table({ tableId: "t1", ...options }, { now: () => t, ledger, seatFilling: null });
    const t2 = new Table({ tableId: "t2", ...options }, { now: () => t, ledger, seatFilling: null });
    h1(t1);
    h1(t2);
    expect(t1.claimTopUp("B")).toEqual({ ok: true, chips: 120 });
    ledger.append([
      { roundId: "elsewhere:1", playerId: "B", chips: -120, reason: "round", at: t },
      { roundId: "elsewhere:1", playerId: "X", chips: 120, reason: "round", at: t },
    ]);
    expect(t2.claimTopUp("B")).toEqual({ ok: false, reason: "topup-cooldown", availableAt: 1_000 + COOLDOWN });
    t += COOLDOWN;
    expect(t2.claimTopUp("B")).toEqual({ ok: true, chips: 120 });

    function h1(table: Table): void {
      const r = table.join("B", { name: "B" });
      if (!r.ok) throw new Error(r.reason);
    }
  });

  it("is for humans at the table only", () => {
    const h = harness({ minChipsToSit: 100 });
    h.ok(h.table.join("bot", { name: "bot", isBot: true, buyIn: 10 }));
    expect(h.table.claimTopUp("bot")).toEqual({ ok: false, reason: "not-human", availableAt: null });
    expect(h.table.claimTopUp("stranger")).toEqual({ ok: false, reason: "not-at-table", availableAt: null });
    expect(h.table.join(MINT_ACCOUNT, { name: "mint" })).toEqual({ ok: false, reason: "malformed" });
    expect(h.table.ledger.entries().filter((e) => e.reason === "topup")).toEqual([]);
  });

  it("defaults to the standard buy-in and a generous cooldown, and refuses a buy-in below the minimum", () => {
    const h = harness({ minChipsToSit: 100 });
    expect(h.table.standardBuyIn).toBe(25 * TEST_RULES.thini * TEST_RULES.maxStakeMultiplier);
    expect(h.table.topUpCooldownMs).toBe(15 * 60_000);
    expect(() => harness({ minChipsToSit: 100, standardBuyIn: 99 })).toThrow(RangeError);
  });
});
