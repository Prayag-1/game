import { TURN_ORDER, type SeatId } from "@kauda/rules";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BetControls, betEnabled, type BetControlsProps } from "../src/components/table/BetControls";
import { Fairness } from "../src/components/table/Fairness";
import { SeatCard, type SeatCardProps } from "../src/components/table/SeatCard";
import { Stage } from "../src/components/table/Stage";
import { checkRound } from "../src/lib/fairness";
import type { RoundRecord } from "../src/lib/protocol";
import { ingest, useTable } from "../src/lib/tableStore";
import { seatSlots } from "../src/screens/Table";

// ---------------------------------------------------------------- seat card

const player = (over: Partial<SeatCardProps["player"] & object> = {}) => ({
  playerId: "p1",
  name: "Sita",
  isBot: false,
  connected: true,
  chips: 1500,
  ...over,
});

function seatCard(over: Partial<SeatCardProps> = {}) {
  const props: SeatCardProps = {
    seat: "panja",
    player: player(),
    isMe: false,
    isThrower: false,
    reservation: null,
    betsTotal: 0,
    canSit: false,
    sitDisabled: false,
    onSit: vi.fn(),
    onCancelReservation: vi.fn(),
    ...over,
  };
  render(<SeatCard {...props} />);
  return { props, card: screen.getByTestId(`seat-${props.seat}`) };
}

describe("seat card", () => {
  it("shows the seat's Nepali name and number, the occupant and their chips", () => {
    const { card } = seatCard();
    expect(within(card).getByRole("button", { name: "पञ्जा" })).toHaveAttribute("title", "Panja: seat 5");
    expect(card).toHaveTextContent("५ नम्बर");
    expect(within(card).getByTestId("occupant")).toHaveTextContent("Sita");
    expect(within(card).getByTestId("seat-chips")).toHaveTextContent("१,५०० चिप");
    expect(within(card).queryByText("बट")).toBeNull();
    expect(within(card).queryByTestId("thrower-mark")).toBeNull();
  });

  it("tags a bot, marks the thrower, and marks me", () => {
    const { card } = seatCard({ player: player({ isBot: true, name: "Bot 1" }), isThrower: true, isMe: true });
    expect(within(card).getByText("बट")).toBeInTheDocument();
    expect(within(card).getByTestId("thrower-mark")).toHaveTextContent("फाल्ने पालो");
    expect(card).toHaveAttribute("data-thrower", "true");
    expect(within(card).getByText("तपाईं")).toBeInTheDocument();
  });

  it("shows an empty seat with a Sit button that sits", async () => {
    const { props, card } = seatCard({ player: null, canSit: true });
    expect(within(card).getByTestId("occupant")).toHaveTextContent("खाली");
    await userEvent.click(within(card).getByRole("button", { name: "बस्नुहोस्" }));
    expect(props.onSit).toHaveBeenCalledOnce();
  });

  it("disables Sit when I cannot afford it, and hides it when I may not sit", () => {
    seatCard({ seat: "teeya", player: null, canSit: true, sitDisabled: true });
    expect(within(screen.getByTestId("seat-teeya")).getByRole("button", { name: "बस्नुहोस्" })).toBeDisabled();
    seatCard({ seat: "chauka", canSit: false });
    expect(within(screen.getByTestId("seat-chauka")).queryByRole("button", { name: "बस्नुहोस्" })).toBeNull();
  });

  it("shows a reservation distinctly: someone else's, and mine with a cancel button", async () => {
    seatCard({ seat: "teeya", player: player({ isBot: true }), reservation: { name: "Hari", mine: false } });
    const theirs = screen.getByTestId("seat-teeya");
    expect(within(theirs).getByTestId("reservation")).toHaveTextContent("Hari का लागि आरक्षित");
    expect(theirs.className).toContain("outline-dashed");

    const { props } = seatCard({ seat: "chakka", player: player({ isBot: true }), reservation: { name: "Me", mine: true }, canSit: true });
    const mine = screen.getByTestId("seat-chakka");
    expect(within(mine).getByTestId("reservation")).toHaveTextContent("अर्को पालोका लागि तपाईंको");
    expect(within(mine).queryByRole("button", { name: "बस्नुहोस्" })).toBeNull();
    await userEvent.click(within(mine).getByRole("button", { name: "आरक्षण रद्द" }));
    expect(props.onCancelReservation).toHaveBeenCalledOnce();
  });

  it("renders a hostile name as text", () => {
    const { card } = seatCard({ player: player({ name: "<img src=x onerror=alert(1)>" }) });
    expect(card.querySelector("img")).toBeNull();
    expect(within(card).getByTestId("occupant")).toHaveTextContent("<img src=x onerror=alert(1)>");
  });
});

// ------------------------------------------------------------- bet controls

const allOccupied = Object.fromEntries(TURN_ORDER.map((s) => [s, true])) as Record<SeatId, boolean>;
function betControls(over: Partial<BetControlsProps> = {}) {
  const props: BetControlsProps = {
    phase: "betting",
    thrower: "chauka",
    occupied: allOccupied,
    thini: 10,
    myChips: 100,
    myBet: null,
    chyakheEnabled: true,
    onBet: vi.fn(),
    onClear: vi.fn(),
    ...over,
  };
  render(<BetControls {...props} />);
  return props;
}
const enabledSeats = () => TURN_ORDER.filter((s) => !(screen.getByTestId(`bet-${s}`) as HTMLButtonElement).disabled);

describe("bet controls", () => {
  it("in betting, enables every seat but the thrower's", () => {
    betControls();
    expect(enabledSeats()).toEqual(["teeya", "panja", "chakka"]);
    expect(screen.getByTestId("bet-chauka")).toBeDisabled();
  });

  it("disables every seat outside betting", () => {
    for (const phase of ["waiting", "throwing", "revealing"] as const) {
      const { unmount } = render(<BetControls {...{ ...betControlsDefaults(), phase }} />);
      expect(enabledSeats()).toEqual([]);
      expect(screen.getByText("बाजी राख्ने समय होइन")).toBeInTheDocument();
      unmount();
    }
  });

  it("disables an empty seat, and everything when outside bets are off", () => {
    betControls({ occupied: { ...allOccupied, teeya: false } });
    expect(enabledSeats()).toEqual(["panja", "chakka"]);
    expect(betEnabled({ phase: "betting", thrower: "chauka", occupied: allOccupied, chyakheEnabled: false }, "teeya", 10, 100)).toBe(false);
  });

  it("disables every seat for an amount I do not have, or no amount", async () => {
    betControls({ myChips: 15 });
    const input = screen.getByLabelText("बाजीको रकम");
    await userEvent.clear(input);
    await userEvent.type(input, "20");
    expect(enabledSeats()).toEqual([]);
    await userEvent.clear(input);
    expect(enabledSeats()).toEqual([]);
    await userEvent.type(input, "15");
    expect(enabledSeats()).toEqual(["teeya", "panja", "chakka"]);
  });

  it("bets the amount on the seat, starting at one thini", async () => {
    const props = betControls();
    expect(screen.getByLabelText("बाजीको रकम")).toHaveValue("10");
    await userEvent.click(screen.getByTestId("bet-panja"));
    expect(props.onBet).toHaveBeenCalledWith("panja", 10);
  });

  it("shows my bet with a Clear button, usable only in betting", async () => {
    const props = betControls({ myBet: { seat: "teeya", chips: 30 } });
    expect(screen.getByTestId("my-bet")).toHaveTextContent("तपाईंको बाजी: 30 चिप, तीया मा");
    await userEvent.click(screen.getByRole("button", { name: "बाजी हटाउनुहोस्" }));
    expect(props.onClear).toHaveBeenCalledOnce();
  });
});

function betControlsDefaults(): BetControlsProps {
  return {
    phase: "betting",
    thrower: "chauka",
    occupied: allOccupied,
    thini: 10,
    myChips: 100,
    myBet: null,
    chyakheEnabled: true,
    onBet: vi.fn(),
    onClear: vi.fn(),
  };
}

// ----------------------------------------------------------------- fairness

// Bytes 0x00..0x1f: shell i is up when byte i is odd, so 8 shells up, which is chauka (8 mod 4 = 0).
const SEED = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const HASH = "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd";
const FACES = Array.from({ length: 16 }, (_, i) => i % 2 === 1);
const round = (over: Partial<RoundRecord> = {}): RoundRecord => ({
  roundId: "r1",
  seed: SEED,
  commitHash: HASH,
  faces: FACES,
  faceUp: 8,
  winningSeat: "chauka",
  hit: true,
  stake: 10,
  multiplier: 1,
  deltas: { p1: 30, p2: -10, p3: -10, p4: -10 },
  at: 1,
  thrower: "chauka",
  streak: 0,
  occupants: { teeya: "p2", chauka: "p1", panja: "p3", chakka: "p4" },
  chyakhe: [],
  ...over,
});

describe("fairness check", () => {
  it("passes a round whose seed hashes to its commitment and gives its faces and winner", async () => {
    const result = await checkRound(round(), HASH);
    expect(result).toEqual({ computed: HASH, hashMatches: true, matchesPublished: true, facesMatch: true, seatMatches: true, ok: true });
  });

  it("fails a seed that does not hash to the commitment", async () => {
    const result = await checkRound(round({ seed: SEED.replace(/^00/, "02") }), HASH);
    expect(result.hashMatches).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("fails when the commitment differs from the one published before betting", async () => {
    const result = await checkRound(round(), "f".repeat(64));
    expect(result.hashMatches).toBe(true);
    expect(result.matchesPublished).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("fails faces or a winner the seed does not give", async () => {
    expect((await checkRound(round({ faces: FACES.map((f, i) => (i === 0 ? !f : f)) }), HASH)).facesMatch).toBe(false);
    expect((await checkRound(round({ winningSeat: "panja" }), HASH)).seatMatches).toBe(false);
  });

  it("shows the commitment during betting", () => {
    render(<Fairness commitHash={HASH} round={null} result={undefined} />);
    expect(screen.getByTestId("commit-hash")).toHaveTextContent(HASH);
    expect(screen.getByText("अहिलेसम्म कुनै बीउ खुलेको छैन।")).toBeInTheDocument();
  });

  it("renders a passing check as green ticks", async () => {
    const result = await checkRound(round(), HASH);
    const { container } = render(<Fairness commitHash={null} round={round()} result={result} />);
    expect(screen.getByTestId("seed")).toHaveTextContent(SEED);
    expect(container.querySelectorAll('[data-check="ok"]')).toHaveLength(4); // summary + three checks
    expect(container.querySelectorAll('[data-check="bad"]')).toHaveLength(0);
    expect(screen.getAllByRole("img", { name: "मिल्यो" })[0]).toHaveClass("text-green-700");
  });

  it("renders a failing check as red crosses", async () => {
    const tampered = round({ seed: SEED.replace(/^00/, "02") });
    const result = await checkRound(tampered, HASH);
    const { container } = render(<Fairness commitHash={null} round={tampered} result={result} />);
    expect(container.querySelectorAll('[data-check="bad"]').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("img", { name: "मिलेन" })[0]).toHaveClass("text-red-700");
  });

  it("runs on every round the store receives, against the hash it saw published", async () => {
    const view = {
      tableId: "t1",
      phase: "betting",
      roundId: "r1",
      thrower: "chauka",
      streak: 0,
      stake: 10,
      commitHash: HASH,
      seats: { teeya: null, chauka: null, panja: null, chakka: null },
      chyakhe: [],
      bets: [],
      phaseEndsAt: null,
      reservations: [],
      lastRound: null,
      rules: { thini: 10, doubling: true, maxStakeMultiplier: 8, ghantiChips: 10, chyakheEnabled: true, maxChyakhe: 8 },
    };
    ingest("view", view);
    ingest("round", round());
    await waitFor(() => expect(useTable.getState().fairness.r1?.ok).toBe(true));
    expect(useTable.getState().published.r1).toBe(HASH);
    expect(useTable.getState().rounds.map((r) => r.roundId)).toEqual(["r1"]);
    ingest("round", { ...round({ roundId: "r2" }), faces: "nope" }); // malformed: dropped
    expect(useTable.getState().rounds).toHaveLength(1);
  });
});

// ----------------------------------------------------------- stage and seats

describe("stage", () => {
  it("draws sixteen shells, filled when up, with the count and the winner in Nepali", () => {
    render(<Stage result={{ faces: FACES, faceUp: 8, winningSeat: "chauka", hit: false }} pending={false} />);
    const shells = screen.getByTestId("stage").querySelectorAll("circle");
    expect(shells).toHaveLength(16);
    expect(screen.getByTestId("stage").querySelectorAll('[data-shell="up"]')).toHaveLength(8);
    const result = screen.getByTestId("stage-result");
    expect(result).toHaveTextContent("८ उत्तानो");
    expect(within(result).getByRole("button", { name: "चौका" })).toHaveAttribute("title", "Chauka: seat 4");
    expect(result).toHaveTextContent("जित्यो!");
    expect(within(result).getByRole("button", { name: "ति-र्यो" })).toBeInTheDocument();
  });

  it("shows empty shells while a round waits for its throw", () => {
    render(<Stage result={{ faces: FACES, faceUp: 8, winningSeat: "chauka", hit: true }} pending />);
    expect(screen.getByTestId("stage").querySelectorAll('[data-shell="pending"]')).toHaveLength(16);
    expect(screen.queryByTestId("stage-result")).toBeNull();
  });
});

describe("seat layout", () => {
  it("places the seats anticlockwise in turn order, with mine at the bottom", () => {
    expect(seatSlots("teeya")).toEqual({ teeya: "bottom", chauka: "right", panja: "top", chakka: "left" });
    expect(seatSlots("panja")).toEqual({ panja: "bottom", chakka: "right", teeya: "top", chauka: "left" });
  });
});
