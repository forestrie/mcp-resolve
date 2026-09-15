/**
 * Decode the chain binding — univocity contract address, chain id, and this
 * package's UUID-formatted forest log id — out of a forest's genesis
 * document. The address is a property of the
 * FOREST, bound at genesis, not of the operator: a caller who holds a
 * genesis document already holds it, which is why `fetch_accumulator` and
 * the chain path of `verify_fetched_receipt` never take the address from a
 * fetched-at-check-time source.
 *
 * Delegates the label table and the byte-level decode to
 * `@forestrie/receipt-verify`'s own `decodeChainBindingFromGenesis`. Only
 * what this module's own callers depend on is kept local: a `GenesisBindingError` with `.code`/`.reason`
 * (`src/node/tools.ts`'s `guardHandler` matches on it by `instanceof`), and
 * `forestLogId` formatted as a UUID string rather than the raw 32-byte wire
 * value receipt-verify's own `ChainBinding.logId` carries.
 *
 * `FOREST_GENESIS_SCHEMA_V2` stays defined here: `@forestrie/receipt-verify`
 * 1.1.0's package root re-exports only the `FOREST_GENESIS_LABEL_*` label
 * constants (`dist/index.d.ts`), not the schema-version constant, which
 * lives in an internal module with no subpath export
 * (`package.json#exports` lists only `"."`) — the same restriction that
 * kept the label table itself local before this.
 */
import {
  decodeChainBindingFromGenesis as decodeChainBindingFromGenesisUpstream,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_LOG_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
} from "@forestrie/receipt-verify";

export {
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_LOG_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
};

/** Not re-exported from `@forestrie/receipt-verify`'s package root (see
 *  this file's docstring) — kept local for that reason only. */
export const FOREST_GENESIS_SCHEMA_V2 = 2;

export type ChainBinding = {
  /** `0x` + 40 lowercase hex. */
  univocity: string;
  chainId: number;
  /** UUID with dashes. */
  forestLogId: string;
};

/** Thrown for any genesis document that does not decode into a usable
 *  chain binding: not CBOR, not a map, wrong version, or a label absent or
 *  mis-sized. `reason` is a short, human-readable cause — receipt-verify's
 *  own upstream error's `message`, wrapped here rather than rephrased, so
 *  the two packages' validation stays recognisably the same check even
 *  though the exact wording differs slightly. */
export class GenesisBindingError extends Error {
  readonly code = "genesis_malformed" as const;
  readonly reason: string;
  constructor(reason: string) {
    super(`genesis document malformed: ${reason}`);
    this.name = "GenesisBindingError";
    this.reason = reason;
  }
}

function bytesToLowerHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function formatUuid(hex32: string): string {
  return [
    hex32.slice(0, 8),
    hex32.slice(8, 12),
    hex32.slice(12, 16),
    hex32.slice(16, 20),
    hex32.slice(20, 32),
  ].join("-");
}

export function decodeChainBindingFromGenesis(
  genesis: Uint8Array,
): ChainBinding {
  let upstream: { univocity: string; chainId: number; logId: Uint8Array };
  try {
    upstream = decodeChainBindingFromGenesisUpstream(genesis);
  } catch (err) {
    throw new GenesisBindingError(
      err instanceof Error ? err.message : String(err),
    );
  }

  return {
    univocity: upstream.univocity,
    chainId: upstream.chainId,
    forestLogId: formatUuid(bytesToLowerHex(upstream.logId.slice(16))),
  };
}
