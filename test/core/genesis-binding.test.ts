import { encodeCborDeterministic } from "@forestrie/encoding";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_LOG_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_SCHEMA_V2,
  GenesisBindingError,
  decodeChainBindingFromGenesis,
} from "../../src/core/index.js";

const repoRoot = new URL("../../", import.meta.url).pathname;
const GOLDEN_GRANT_GENESIS = new Uint8Array(
  readFileSync(
    `${repoRoot}node_modules/@forestrie/mcp-verify/fixtures/golden/grant-genesis.cbor`,
  ),
);

/** Build a genesis-shaped CBOR map with the labels this module reads, plus
 *  an arbitrary extra label, exactly as a real genesis document carries
 *  more than the chain binding alone. */
function buildGenesis(fields: {
  version?: number;
  univocity?: Uint8Array;
  chainId?: string;
  logIdWire?: Uint8Array;
}): Uint8Array {
  const map = new Map<number, unknown>();
  if (fields.version !== undefined) {
    map.set(FOREST_GENESIS_LABEL_GENESIS_VERSION, fields.version);
  }
  if (fields.univocity !== undefined) {
    map.set(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, fields.univocity);
  }
  if (fields.chainId !== undefined) {
    map.set(FOREST_GENESIS_LABEL_CHAIN_ID, fields.chainId);
  }
  if (fields.logIdWire !== undefined) {
    map.set(FOREST_GENESIS_LABEL_LOG_ID, fields.logIdWire);
  }
  map.set(-68014, -7); // an unrelated label, present in every real genesis
  return encodeCborDeterministic(map);
}

/** 32-byte wire log id: 16 zero bytes then a 16-byte UUID's bytes — here,
 *  deliberately the address's own first 16 bytes, matching the CLI's
 *  `onboard-genesis` / `genesisLogIdFromImutableAddress` relationship
 *  for a well-formed genesis document. */
function logIdWireFromAddress(address: Uint8Array): Uint8Array {
  const wire = new Uint8Array(32);
  wire.set(address.slice(0, 16), 16);
  return wire;
}

describe("decodeChainBindingFromGenesis", () => {
  it("round-trips a hand-built genesis map", () => {
    const univocity = new Uint8Array(20);
    for (let i = 0; i < 20; i++) univocity[i] = i;
    const logIdWire = logIdWireFromAddress(univocity);

    const genesis = buildGenesis({
      version: FOREST_GENESIS_SCHEMA_V2,
      univocity,
      chainId: "84532",
      logIdWire,
    });

    const binding = decodeChainBindingFromGenesis(genesis);

    expect(binding.univocity).toBe(
      "0x000102030405060708090a0b0c0d0e0f10111213",
    );
    expect(binding.chainId).toBe(84532);
    expect(binding.forestLogId).toBe("00010203-0405-0607-0809-0a0b0c0d0e0f");
    // The general property well-formed genesis documents have (not
    // asserted for the verifier's own synthetic golden fixture below,
    // which uses placeholder, unrelated bytes for each label).
    expect(binding.forestLogId.replace(/-/g, "")).toBe(
      Buffer.from(univocity.slice(0, 16)).toString("hex"),
    );
  });

  it("decodes the verifier's shipped golden grant-genesis.cbor", () => {
    const binding = decodeChainBindingFromGenesis(GOLDEN_GRANT_GENESIS);

    expect(binding.univocity.startsWith("0x")).toBe(true);
    expect(binding.univocity.length).toBe(42); // 0x + 40 hex
    expect(Number.isInteger(binding.chainId)).toBe(true);
    expect(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        binding.forestLogId,
      ),
    ).toBe(true);
    // manifest.json's logId, decoded from label -68010's last 16 bytes.
    expect(binding.forestLogId).toBe("660e8400-e29b-41d4-a716-446655440001");
  });

  it("throws genesis_malformed on a truncated document", () => {
    const genesis = buildGenesis({
      version: FOREST_GENESIS_SCHEMA_V2,
      univocity: new Uint8Array(20).fill(1),
      chainId: "84532",
      logIdWire: new Uint8Array(32).fill(2),
    });
    const truncated = genesis.slice(0, genesis.length - 5);

    expect(() => decodeChainBindingFromGenesis(truncated)).toThrow(
      GenesisBindingError,
    );
    try {
      decodeChainBindingFromGenesis(truncated);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GenesisBindingError);
      expect((err as InstanceType<typeof GenesisBindingError>).code).toBe(
        "genesis_malformed",
      );
    }
  });

  it("throws genesis_malformed on a version-1 map", () => {
    const genesis = buildGenesis({
      version: 1,
      univocity: new Uint8Array(20).fill(1),
      chainId: "84532",
      logIdWire: new Uint8Array(32).fill(2),
    });

    expect(() => decodeChainBindingFromGenesis(genesis)).toThrow(
      GenesisBindingError,
    );
  });

  it("throws genesis_malformed when not a CBOR map", () => {
    expect(() =>
      decodeChainBindingFromGenesis(encodeCborDeterministic([1, 2, 3])),
    ).toThrow(GenesisBindingError);
  });

  it("throws genesis_malformed when the address is the wrong size", () => {
    const genesis = buildGenesis({
      version: FOREST_GENESIS_SCHEMA_V2,
      univocity: new Uint8Array(19).fill(1),
      chainId: "84532",
      logIdWire: new Uint8Array(32).fill(2),
    });
    expect(() => decodeChainBindingFromGenesis(genesis)).toThrow(
      GenesisBindingError,
    );
  });

  it("throws genesis_malformed when chain id is not a decimal string", () => {
    const map = new Map<number, unknown>([
      [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
      [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, new Uint8Array(20).fill(1)],
      [FOREST_GENESIS_LABEL_CHAIN_ID, 84532], // integer, not text
      [FOREST_GENESIS_LABEL_LOG_ID, new Uint8Array(32).fill(2)],
    ]);
    expect(() =>
      decodeChainBindingFromGenesis(encodeCborDeterministic(map)),
    ).toThrow(GenesisBindingError);
  });

  it("throws genesis_malformed when the log id label is absent", () => {
    const genesis = buildGenesis({
      version: FOREST_GENESIS_SCHEMA_V2,
      univocity: new Uint8Array(20).fill(1),
      chainId: "84532",
    });
    expect(() => decodeChainBindingFromGenesis(genesis)).toThrow(
      GenesisBindingError,
    );
  });
});
