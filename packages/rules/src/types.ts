/** The four inside seats (dau / khal). */
export type SeatId = "teeya" | "chauka" | "panja" | "chakka";

/** Traditional number of each seat. */
export const SEAT_NUMBER: Readonly<Record<SeatId, number>> = {
  teeya: 3,
  chauka: 4,
  panja: 5,
  chakka: 6,
};

/**
 * Seating and turn order. The article has the players sitting anticlockwise
 * starting at teeya, with odd and even seats opposite one another, which this
 * order satisfies (teeya faces panja, chauka faces chakka).
 */
export const TURN_ORDER: readonly SeatId[] = ["teeya", "chauka", "panja", "chakka"] as const;

/** Number of cowrie shells thrown. */
export const SHELL_COUNT = 16;

/** A single shell: true = face up (teeth visible), false = ghopto (face down). */
export type ShellFace = boolean;

export interface ThrowResult {
  readonly faces: readonly ShellFace[];
  readonly faceUp: number;
  readonly winningSeat: SeatId;
}

/** One outside bet, placed by a chyakhe on a seat that is not the thrower's. */
export interface ChyakheBet {
  readonly playerId: string;
  readonly seat: SeatId;
  readonly chips: number;
}

export interface HouseRules {
  /** Base stake unit, in chips. Must be a positive integer. */
  readonly thini: number;
  /** Stake doubles after every hit while the thrower keeps the throw. */
  readonly doubling: boolean;
  /** Ceiling on the stake multiplier. 1 disables escalation entirely. */
  readonly maxStakeMultiplier: number;
  /**
   * Fee the thrower pays on the first hit of a streak, in chips. It is split
   * among the other seated players, so it is a transfer and not a rake.
   */
  readonly ghantiChips: number;
  readonly chyakheEnabled: boolean;
  readonly maxChyakhe: number;
}

export interface RoundInput {
  readonly thrower: SeatId;
  /** Seat -> playerId. A missing seat is empty. Bots normally fill all four. */
  readonly occupants: Readonly<Partial<Record<SeatId, string>>>;
  readonly chyakhe: readonly ChyakheBet[];
  /** Consecutive hits the thrower has already made before this throw. */
  readonly streak: number;
  readonly rules: HouseRules;
  readonly faces: readonly ShellFace[];
}

export interface RoundOutcome {
  readonly faceUp: number;
  readonly winningSeat: SeatId;
  readonly hit: boolean;
  readonly stakeMultiplier: number;
  /** Chips at risk per seat on this throw. */
  readonly stake: number;
  /** playerId -> chip change. Always sums to exactly zero. */
  readonly deltas: Readonly<Record<string, number>>;
  readonly nextThrower: SeatId;
  readonly nextStreak: number;
  /** True when the winning seat was empty, so no chips moved. */
  readonly push: boolean;
}
