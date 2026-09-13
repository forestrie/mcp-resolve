/**
 * Decode the chain binding — univocity contract address and chain id — out
 * of a forest's genesis document (plan-2609-05 N2 amendment A). The address
 * is a property of the FOREST, bound at genesis, not of the operator: a
 * caller who holds a genesis document already holds it, which is why
 * `fetch_accumulator` and the chain path of `verify_fetched_receipt` never
 * take the address from a fetched-at-check-time source (decisions.md N2
 * amendment A).
 *
 * The label numbers and their values are runner-verified (2026-09-13)
 * against lane A's genesis document, decoded with
 * `@forestrie/encoding`'s `decodeCborDeterministic`.
 *
 * Defined LOCALLY rather than imported from `@forestrie/receipt-verify`:
 * that package's published `package.json#exports` (1.0.0) exposes only its
 * `"."` entry, so `dist/forest-genesis-labels.d.ts` — though it ships
 * inside the tarball's `src`/`dist` — is not import-reachable at runtime
 * (`ERR_PACKAGE_PATH_NOT_EXPORTED`). See this PR's description for the
 * finding filed against the verifier/receipt-verify estate.
 */
import { decodeCborDeterministic } from "@forestrie/encoding";

export const FOREST_GENESIS_LABEL_GENESIS_VERSION = -68009;
/** Not named in `@forestrie/receipt-verify` 1.0.0 nor `forestrie-cli` 0.8.0
 *  (decisions.md N2 amendment A) — defined here for step 1.6. 32 bytes: 16
 *  zero bytes then the 16-byte forest bootstrap log id. */
export const FOREST_GENESIS_LABEL_LOG_ID = -68010;
export const FOREST_GENESIS_LABEL_UNIVOCITY_ADDR = -68011;
export const FOREST_GENESIS_LABEL_CHAIN_ID = -68013;
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
 *  mis-sized. `reason` is a short, human-readable cause. */
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
  let decoded: unknown;
  try {
    decoded = decodeCborDeterministic(genesis);
  } catch (err) {
    throw new GenesisBindingError(
      `not valid CBOR (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!(decoded instanceof Map)) {
    throw new GenesisBindingError("not a CBOR map");
  }

  const versionRaw = decoded.get(FOREST_GENESIS_LABEL_GENESIS_VERSION);
  if (versionRaw === undefined) {
    throw new GenesisBindingError("version label absent");
  }
  const version =
    typeof versionRaw === "bigint" ? Number(versionRaw) : versionRaw;
  if (version !== FOREST_GENESIS_SCHEMA_V2) {
    throw new GenesisBindingError(
      `version ${String(version)} is not ${FOREST_GENESIS_SCHEMA_V2}`,
    );
  }

  const addr = decoded.get(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR);
  if (!(addr instanceof Uint8Array) || addr.length !== 20) {
    throw new GenesisBindingError(
      "univocity address label absent or not 20 bytes",
    );
  }

  const chainIdRaw = decoded.get(FOREST_GENESIS_LABEL_CHAIN_ID);
  if (typeof chainIdRaw !== "string" || !/^[0-9]+$/.test(chainIdRaw)) {
    throw new GenesisBindingError(
      "chain id label absent or not a decimal string",
    );
  }

  const logIdWire = decoded.get(FOREST_GENESIS_LABEL_LOG_ID);
  if (!(logIdWire instanceof Uint8Array) || logIdWire.length !== 32) {
    throw new GenesisBindingError("log id label absent or not 32 bytes");
  }

  return {
    univocity: `0x${bytesToLowerHex(addr)}`,
    chainId: Number(chainIdRaw),
    forestLogId: formatUuid(bytesToLowerHex(logIdWire.slice(16))),
  };
}
