/**
 * The `supports` rows and notes are fixed wording, kept in
 * src/core/provenance.ts. This test asserts every row and note against a
 * SECOND, independent literal copy, so a drift in either file is red —
 * never a shared constant that could drift in step.
 */
import { QUESTION_NAMES, ROOT_NAMES } from "@forestrie/mcp-verify";
import { describe, expect, it } from "vitest";
import { COURIER_DIAGNOSTIC_CODES, SUPPORTS } from "../../src/core/index.js";

const EXPECTED_SUPPORTS = {
  fetch_receipt: {
    rows: [],
    note: "a receipt is the operator's claim; verify it under a root you hold",
  },
  fetch_genesis: {
    rows: [{ question: "sealing", root: "known-log-key" }],
    note: "keep this copy; a copy obtained at check time is not the genesis root as intended. The chain binding in this copy (contract address, chain id) is likewise the operator's claim today: a chain read under an address obtained at check time answers split-view against the contract the operator named, so keep the copy from registration, or cross-check the address against a source you trust independently",
  },
  fetch_accumulator: {
    rows: [
      { question: "split-view", root: "known-accumulator" },
      { question: "sealing", root: "known-accumulator" },
      { question: "append-authority", root: "known-accumulator" },
    ],
    note: "split-view against the chain rather than the operator; sealing and append-authority by inheritance from the contract's publish-time checks, stated as inheritance, never as a local signature check",
  },
  fetch_checkpoint_history: {
    rows: [
      { question: "split-view", root: "known-accumulator" },
      { question: "sealing", root: "known-accumulator" },
      { question: "append-authority", root: "known-accumulator" },
    ],
    note: "split-view against the chain rather than the operator; sealing and append-authority by inheritance from the contract's publish-time checks, stated as inheritance, never as a local signature check; a kept checkpoint answers split-view later, without another chain read, for any receipt whose peak it contains",
  },
  fetch_scitt_configuration: {
    rows: [],
    note: "operator self-description; evidence for none of the four questions",
  },
  query_registration: {
    rows: [],
    note: "registration status; evidence for none of the four questions",
  },
  verify_fetched_receipt: {
    rows: [],
    note: "the verifier's own questions object, passed through unaltered; diagnostics say where the bytes came from",
  },
} as const;

describe("SUPPORTS", () => {
  it("has exactly the seven tool names", () => {
    expect(Object.keys(SUPPORTS).sort()).toEqual(
      Object.keys(EXPECTED_SUPPORTS).sort(),
    );
  });

  for (const tool of Object.keys(EXPECTED_SUPPORTS) as Array<
    keyof typeof EXPECTED_SUPPORTS
  >) {
    it(`${tool}: rows and note match verbatim`, () => {
      expect(SUPPORTS[tool].note).toBe(EXPECTED_SUPPORTS[tool].note);
      expect(SUPPORTS[tool].rows).toEqual(EXPECTED_SUPPORTS[tool].rows);
    });
  }

  it("every question is one of the verifier's QUESTION_NAMES", () => {
    for (const supports of Object.values(SUPPORTS)) {
      for (const row of supports.rows) {
        expect(QUESTION_NAMES).toContain(row.question);
      }
    }
  });

  it("every root is one of the verifier's ROOT_NAMES", () => {
    for (const supports of Object.values(SUPPORTS)) {
      for (const row of supports.rows) {
        expect(ROOT_NAMES).toContain(row.root);
      }
    }
  });
});

describe("COURIER_DIAGNOSTIC_CODES", () => {
  it("is exactly the five courier diagnostic codes, in order", () => {
    expect(COURIER_DIAGNOSTIC_CODES).toEqual([
      "receipt_fetched_from_operator",
      "root_read_from_chain",
      "root_read_from_chain_history",
      "receipt_log_id_mismatch",
      "genesis_root_reaches_direct_delegates_only",
    ]);
  });
});
