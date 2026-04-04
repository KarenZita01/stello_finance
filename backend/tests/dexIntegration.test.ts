import { describe, expect, it } from "vitest";
import {
  computeTwapPrice,
  parseLiquidityMiningProgramProposal,
  quoteExactIn,
} from "../src/dex-integration/index.js";

describe("DEX integration math", () => {
  it("computes a direct quote for XLM to sXLM", () => {
    const quote = quoteExactIn(
      {
        reserveXlmRaw: 1_000_0000000n,
        reserveSxlmRaw: 1_000_0000000n,
        totalLpSupplyRaw: 1_000_0000000n,
        feeBps: 30,
        observedAt: new Date("2026-03-29T00:00:00.000Z"),
      },
      "XLM",
      100_0000000n,
      100
    );

    expect(quote.amountOutRaw).toBeGreaterThan(0n);
    expect(quote.tokenOut).toBe("sXLM");
    expect(quote.minimumAmountOutRaw).toBeLessThan(quote.amountOutRaw);
    expect(quote.priceImpactBps).toBeGreaterThan(0);
  });

  it("reports price impact for sXLM to XLM quotes", () => {
    const quote = quoteExactIn(
      {
        reserveXlmRaw: 1_000_0000000n,
        reserveSxlmRaw: 1_000_0000000n,
        totalLpSupplyRaw: 1_000_0000000n,
        feeBps: 30,
        observedAt: new Date("2026-03-29T00:00:00.000Z"),
      },
      "sXLM",
      100_0000000n,
      100
    );

    expect(quote.tokenOut).toBe("XLM");
    expect(quote.priceImpactBps).toBeGreaterThan(0);
  });

  it("computes a TWAP across staggered observations", () => {
    const now = new Date("2026-03-29T01:00:00.000Z");
    const oracle = computeTwapPrice(
      [
        { observedAt: new Date("2026-03-29T00:45:00.000Z"), spotPrice: 0.99 },
        { observedAt: new Date("2026-03-29T00:52:30.000Z"), spotPrice: 1.01 },
        { observedAt: new Date("2026-03-29T00:57:30.000Z"), spotPrice: 1.02 },
      ],
      900,
      now
    );

    expect(oracle.twapPrice).toBeGreaterThan(1);
    expect(oracle.sampleCount).toBe(3);
    expect(oracle.confidence).toBe("medium");
  });

  it("parses liquidity mining governance proposals", () => {
    const program = parseLiquidityMiningProgramProposal(
      "liquidity_mining_program:ecosystem-bootstrap",
      JSON.stringify({
        title: "Bootstrap Rewards",
        status: "active",
        rewardAsset: "sXLM",
        rewardPerDayRaw: "250000000",
        startAt: "2026-04-01T00:00:00.000Z",
        endAt: "2026-06-30T00:00:00.000Z",
        dexes: ["StellarX", "Lumenswap"],
      }),
      3
    );

    expect(program).not.toBeNull();
    expect(program?.programId).toBe("ecosystem-bootstrap");
    expect(program?.rewardPerDayRaw).toBe(250000000n);
  });

  it("returns null for malformed liquidity mining proposal payloads", () => {
    const program = parseLiquidityMiningProgramProposal(
      "liquidity_mining_program:broken",
      "{not-valid-json",
      7
    );

    expect(program).toBeNull();
  });

  it("normalizes native reward assets in liquidity mining proposals", () => {
    const program = parseLiquidityMiningProgramProposal(
      "liquidity_mining_program:native-rewards",
      JSON.stringify({
        rewardAsset: "xlm",
      }),
      9
    );

    expect(program).not.toBeNull();
    expect(program?.rewardAsset).toBe("XLM");
  });
});
