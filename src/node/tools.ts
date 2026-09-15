/**
 * The seven tools' zod input/output shapes and handlers. Every handler
 * returns `{ content, structuredContent, isError: false }` — an HTTP
 * problem, a 429, a `NetError`, a chain problem, and a malformed input are
 * ALL a `structuredContent.problem`, never a throw. Only a
 * genuine programming error escapes `guardHandler` below and becomes an
 * MCP-level tool error.
 *
 * Every `structuredContent` carries `supports` (`SUPPORTS[toolName]`,
 * verbatim from `src/core/provenance.ts`) and, for every artefact actually
 * obtained, `provenance`. `verify_fetched_receipt` never uses a
 * genesis fetched in the same call as its root: the input schema's `trust`
 * union admits caller-supplied bytes or `{root:"known-accumulator",
 * chain:…}` only — there is no fetched-genesis variant.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DecodeReceiptError,
  decodeReceipt,
  type TrustRoot,
} from "@forestrie/mcp-verify";
import { decodeTrustRootDetailsFromGenesis } from "@forestrie/receipt-verify";
import {
  EndpointError,
  GenesisBindingError,
  GrantLeafInputError,
  SUPPORTS,
  classify,
  decodeChainBindingFromGenesis,
  decodeReceiptLogId,
  grantLeafInputs,
  isPeakNotInKnownAccumulator,
  peakHeldIn,
  recomputePeakForReceipt,
  selectCheckpoint,
  summarizeFetched,
  toContractLogId,
  toKnownAccumulator,
  verifyFetched,
  type ChainBinding,
  type CourierDiagnostic,
  type FetchedVerifyResult,
  type LogIdProvenance,
  type Provenance,
  type PublishedCheckpoint,
  type ToolName,
} from "../core/index.js";
import {
  NetError,
  fetchAccumulatorSnapshot,
  fetchCheckpointHistory,
  fetchGenesis,
  fetchReceipt,
  fetchScittConfiguration,
  queryRegistration,
  readChainHead,
  scanCheckpointHistory,
  toClassifyView,
  type FetchReceiptInput,
} from "../net/index.js";
import {
  FOR_RECEIPT_INPUT_DESCRIPTION,
  HISTORY_INPUT_DESCRIPTION,
} from "./text.js";
import { InputError, resolveBytes, type BytesInput } from "./resolve-input.js";

/** The resolved form of `server.ts`'s `Deps`: every field defaulted. */
export type ResolvedDeps = {
  fetchImpl: typeof fetch;
  env: Record<string, string | undefined>;
  now: () => Date;
};

/* ------------------------------ wire shapes ------------------------------ */

const BytesInputSchema = z
  .union([
    z.object({ base64: z.string().min(1) }).describe("standard base64"),
    z
      .object({ path: z.string().min(1) })
      .describe("filesystem path, read by the stdio adapter"),
  ])
  .describe("Bytes as base64, or a path the local server reads");

const LogIdSchema = z
  .string()
  .min(1)
  .describe("UUID (with dashes), or a 16/32-byte hex log id");

const EntryIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .describe("32 lowercase hex: idtimestamp_be8 || mmrIndex_be8");

const BaseUrlSchema = z
  .string()
  .min(1)
  .describe(
    "any SCRAPI base URL; falls back to FORESTRIE_BASE_URL when omitted — never defaulted by the package itself",
  );

const RpcUrlSchema = z
  .string()
  .min(1)
  .describe(
    "your own chain RPC access; falls back to FORESTRIE_RPC_URL when omitted — the package ships no provider",
  );

const AddressSchema = z
  .string()
  .min(1)
  .describe("0x-prefixed or bare 40-hex address");

/** Bounds for the backward `CheckpointPublished` scan. Lives
 *  ONLY on the chain union — `chain.history` for both `fetch_accumulator`
 *  and `verify_fetched_receipt`'s `trust.chain` — never a top-level
 *  `history` on either tool. */
const HistoryInputSchema = z
  .object({
    fromBlock: z.number().int().nonnegative().optional(),
    maxBlocks: z.number().int().positive().optional(),
    chunkBlocks: z.number().int().positive().optional(),
  })
  .describe(HISTORY_INPUT_DESCRIPTION);

/** `fetch_accumulator.forReceipt` (1.5.10, added 2026-09-14): the leaf
 *  inputs the verifier needs to recompute a receipt's peak — the same
 *  meaning as `verify_fetched_receipt`'s `payload`/`entryId`/`grant`, just
 *  nested under one object since `fetch_accumulator` has no other use for
 *  them. `grant: true` derives the leaf inputs via `../core/grant-leaf.js`'s
 *  `grantLeafInputs` — see `handleFetchAccumulator` for the
 *  `GrantLeafInputError` mapping. */
const ForReceiptInputSchema = z
  .object({
    receipt: BytesInputSchema.describe("the receipt bytes"),
    payload: BytesInputSchema.optional().describe(
      "the exact registered payload (payload verification), or the committed grant bytes when grant:true",
    ),
    entryId: EntryIdSchema.optional().describe(
      "required for payload verification; optional for a COSE grant, required for a raw grant payload",
    ),
    grant: z
      .boolean()
      .optional()
      .describe(
        "true if payload is the committed grant bytes rather than the registered payload",
      ),
  })
  .describe(FOR_RECEIPT_INPUT_DESCRIPTION);

/** The chain binding comes from a genesis you hold, or is
 *  given explicitly. There is no third form, and `rpcUrl` is the only
 *  field this package will ever read from the environment. `history`
 *  lives on this union alone, so both `fetch_accumulator`
 *  (`chain.history`) and `verify_fetched_receipt` (`trust.chain.history`)
 *  read it from the same place.
 *
 *  `logId` is required here, and in the fixed `ChainInputSchema` below —
 *  `fetch_accumulator` (including `forReceipt`) and `fetch_checkpoint_history`
 *  keep it required. `verify_fetched_receipt`
 *  alone takes `logId` optional, via `VerifyChainInputSchema` below: its
 *  caller may rely on the receipt's own
 *  delegation-certificate log id instead of naming one. */
function chainInputSchema<
  L extends typeof LogIdSchema | z.ZodOptional<typeof LogIdSchema>,
>(logIdSchema: L) {
  return z
    .union([
      z.object({
        genesis: BytesInputSchema.describe(
          "a genesis document you hold; univocity and chainId are decoded from it",
        ),
        rpcUrl: RpcUrlSchema.optional(),
        logId: logIdSchema,
        history: HistoryInputSchema.optional(),
      }),
      z.object({
        rpcUrl: RpcUrlSchema.optional(),
        univocity: AddressSchema,
        logId: logIdSchema,
        chainId: z
          .number()
          .int()
          .optional()
          .describe(
            "checked against eth_chainId before any eth_call, if given",
          ),
        history: HistoryInputSchema.optional(),
      }),
    ])
    .describe(
      "The forest's chain binding: from a genesis you hold, or given explicitly. Never defaulted, never taken from a fetched genesis, never read from the environment except rpcUrl.",
    );
}

const ChainInputSchema = chainInputSchema(LogIdSchema);

/** `verify_fetched_receipt`'s `trust.chain` alone: same shape as `ChainInputSchema`, but `logId` is optional —
 *  omitted, the caller falls back to the id the receipt's own
 *  delegation certificate names; naming neither is
 *  `missing_input`, before any chain request. */
const VerifyChainInputSchema = chainInputSchema(LogIdSchema.optional());

/** The receipt locator's fields, flattened onto the tool's own top-level
 *  arguments (both `fetch_receipt` and `verify_fetched_receipt`) rather
 *  than nested under a key — either `receiptUrl` alone, or all four of
 *  `bootstrapLogId`/`logId`/`massifHeight`/`entryId` plus `baseUrl`
 *  (falling back to `FORESTRIE_BASE_URL`). On `verify_fetched_receipt`,
 *  `entryId` does double duty: it also names the entry being verified. */
const receiptLocatorFieldsShape = {
  receiptUrl: z
    .string()
    .min(1)
    .optional()
    .describe("as returned by query_registration"),
  baseUrl: BaseUrlSchema.optional(),
  bootstrapLogId: LogIdSchema.optional(),
  logId: LogIdSchema.optional(),
  massifHeight: z.number().int().nonnegative().optional(),
  entryId: EntryIdSchema.optional(),
};

const TrustRootWireSchema = z.discriminatedUnion("root", [
  z.object({ root: z.literal("genesis"), genesis: BytesInputSchema }),
  z.object({
    root: z.literal("known-log-key"),
    keyXy: BytesInputSchema.describe("raw 64-byte P-256 x||y"),
  }),
  z.object({
    root: z.literal("known-accumulator"),
    accumulator: BytesInputSchema.describe(
      "encodeKnownAccumulator snapshot bytes you hold",
    ),
    massif: BytesInputSchema.optional(),
    consistencyProof: BytesInputSchema.optional(),
  }),
  z.object({
    root: z.literal("checkpoint-chain"),
    checkpoints: z.array(BytesInputSchema).min(1),
    genesis: BytesInputSchema.optional(),
    keyXy: BytesInputSchema.optional(),
  }),
]);

/** Bytes you supply, or (known-accumulator only) a chain read in this call.
 *  Deliberately NOT admitting `{root:"genesis", fetch:…}` or any other
 *  fetched-genesis form. */
const TrustInputSchema = z
  .union([
    TrustRootWireSchema,
    z.object({
      root: z.literal("known-accumulator"),
      chain: VerifyChainInputSchema,
    }),
  ])
  .describe(
    "Which trust root to verify under: bytes you supply (genesis, keyXy, accumulator, checkpoints), or {root:'known-accumulator', chain:…} to read the accumulator from the chain in this call. Never a genesis fetched in this same call.",
  );

/* ------------------------------ output shapes ------------------------------ */

/** Present only when the accumulator came from a checkpoint
 *  selected out of published history rather than the latest `logState`.
 *  `blockNumber`/`blockHash`/`size` name that one selected checkpoint
 *  (`fetch_accumulator`, `verify_fetched_receipt`);
 *  `fetch_checkpoint_history` returns every checkpoint in range rather
 *  than selecting one, so its own `provenance.history` carries only the
 *  scan's bounds and cost. */
const HistoryProvenanceSchema = z.object({
  blockNumber: z.number().optional(),
  blockHash: z.string().optional(),
  size: z.number().optional(),
  scannedFrom: z.number(),
  scannedTo: z.number(),
  requests: z.number(),
});

const ProvenanceSchema = z.looseObject({
  source: z.enum(["fetched", "chain-read", "supplied"]),
  from: z.union([
    z.string(),
    z.object({
      rpcUrl: z.string(),
      univocity: z.string(),
      chainId: z.number(),
    }),
  ]),
  at: z.string(),
  binding: z.enum(["held-genesis", "explicit"]).optional(),
  history: HistoryProvenanceSchema.optional(),
});

const SupportsSchema = z.looseObject({
  rows: z.array(z.looseObject({ question: z.string(), root: z.string() })),
  note: z.string(),
});

const ProblemSchema = z.looseObject({ code: z.string() });

const BytesSummarySchema = z.object({
  base64: z.string(),
  byteLength: z.number(),
  sha256: z.string(),
});

const ChainBindingSchema = z.object({
  univocity: z.string(),
  chainId: z.number(),
  forestLogId: z.string(),
});

/* ------------------------------------------------------------------ *
 * Per-tool input/output raw shapes (`{ key: ZodType }`), as the SDK
 * 1.30.0 wants — see @forestrie/mcp-verify's src/node/tools.ts.
 * ------------------------------------------------------------------ */

export const fetchScittConfigurationInputShape = {
  baseUrl: BaseUrlSchema.optional(),
};
export const fetchScittConfigurationOutputShape = {
  configuration: z.unknown().optional(),
  provenance: ProvenanceSchema.optional(),
  supports: SupportsSchema,
  problem: ProblemSchema.optional(),
};

export const queryRegistrationInputShape = {
  baseUrl: BaseUrlSchema.optional(),
  bootstrapLogId: LogIdSchema,
  logId: LogIdSchema,
  contentHash: z
    .string()
    .min(1)
    .describe("hex sha256 of the signed statement bytes"),
};
export const queryRegistrationOutputShape = {
  status: z.enum(["pending", "receipt-available"]).optional(),
  location: z.string().optional(),
  retryAfterMs: z.number().optional(),
  receiptUrl: z.string().optional(),
  entryId: z.string().optional(),
  provenance: ProvenanceSchema.optional(),
  supports: SupportsSchema,
  problem: ProblemSchema.optional(),
};

export const fetchReceiptInputShape = { ...receiptLocatorFieldsShape };
export const fetchReceiptOutputShape = {
  receipt: BytesSummarySchema.optional(),
  decoded: z.unknown().optional(),
  /** The log id the receipt's own delegation
   *  certificate names, decoded from these same bytes — no default logic
   *  here (that's `verify_fetched_receipt` alone); present only when the
   *  receipt carries a certificate at all. */
  receiptLogId: z.string().optional(),
  provenance: ProvenanceSchema.optional(),
  supports: SupportsSchema,
  problem: ProblemSchema.optional(),
};

export const fetchGenesisInputShape = {
  baseUrl: BaseUrlSchema.optional(),
  logId: LogIdSchema,
};
export const fetchGenesisOutputShape = {
  genesis: BytesSummarySchema.optional(),
  chainBinding: ChainBindingSchema.optional(),
  /** The bootstrap public key as `x‖y` hex (64 bytes -> 128 hex chars),
   *  decoded via `@forestrie/receipt-verify`'s
   *  `decodeTrustRootDetailsFromGenesis`. Omitted, not an
   *  error, for a KS256 v2 bootstrap key — an on-chain address, not a
   *  P-256 public key — which `bootstrapKeyXy` has nothing to carry for. */
  bootstrapKeyXy: z.string().optional(),
  provenance: ProvenanceSchema.optional(),
  supports: SupportsSchema,
  problem: ProblemSchema.optional(),
};

export const fetchAccumulatorInputShape = {
  chain: ChainInputSchema,
  forReceipt: ForReceiptInputSchema.optional(),
};
export const fetchAccumulatorOutputShape = {
  snapshot: BytesSummarySchema.optional(),
  accumulator: z
    .object({
      size: z.number(),
      peaks: z.array(z.string()),
      blockNumber: z.number(),
      blockHash: z.string(),
      chainId: z.number(),
      univocity: z.string(),
      logId: z.string(),
    })
    .optional(),
  provenance: ProvenanceSchema.optional(),
  /** Present only on `problem.code === "history_scan_exhausted"`: the
   *  latest state's own size/block, so the caller sees what forReceipt
   *  was compared against. */
  latest: z.object({ size: z.number(), blockNumber: z.number() }).optional(),
  supports: SupportsSchema,
  problem: ProblemSchema.optional(),
};

/** The chain union alone, no `forReceipt` — this tool never selects
 *  one checkpoint, it returns every checkpoint the scan covers. */
export const fetchCheckpointHistoryInputShape = {
  chain: ChainInputSchema,
};
export const fetchCheckpointHistoryOutputShape = {
  checkpoints: z
    .array(
      z.object({
        size: z.number(),
        accumulator: z.array(z.string()),
        blockNumber: z.number(),
        blockHash: z.string(),
        txHash: z.string(),
        /** base64 `toKnownAccumulator(cp, binding)` — keep it, and pass it
         *  back to `verify_fetched_receipt` as supplied `trust.accumulator`
         *  bytes. */
        snapshot: z.string(),
      }),
    )
    .optional(),
  scannedFrom: z.number().optional(),
  scannedTo: z.number().optional(),
  requests: z.number().optional(),
  /** The chain identity every checkpoint above was read against — the
   *  same fields `fetch_accumulator`'s `accumulator` object carries,
   *  factored out once here since this tool returns many checkpoints
   *  rather than one. */
  chainBinding: z
    .object({
      univocity: z.string(),
      chainId: z.number(),
      logId: z.string(),
    })
    .optional(),
  provenance: ProvenanceSchema.optional(),
  supports: SupportsSchema,
  problem: ProblemSchema.optional(),
};

export const verifyFetchedReceiptInputShape = {
  ...receiptLocatorFieldsShape,
  trust: TrustInputSchema,
  payload: BytesInputSchema.optional().describe(
    "the exact registered payload (payload verification), or the committed grant bytes when grant:true",
  ),
  entryId: EntryIdSchema.optional().describe(
    "required for payload verification; optional for a COSE grant, required for a raw grant payload",
  ),
  grant: z
    .boolean()
    .optional()
    .describe(
      "true to verify a grant receipt (verifyGrantReceipt) instead of a payload receipt",
    ),
};
export const verifyFetchedReceiptOutputShape = {
  ok: z.boolean().optional(),
  root: z.string().optional(),
  stage: z.string().optional(),
  reason: z.string().optional(),
  stages: z.array(z.unknown()).optional(),
  anchor: z.unknown().optional(),
  questions: z.unknown().optional(),
  diagnostics: z.array(z.unknown()).optional(),
  verifier: z.unknown().optional(),
  courier: z.unknown().optional(),
  provenance: z
    .object({
      receipt: ProvenanceSchema,
      root: ProvenanceSchema,
      /** Present whenever a chain read happens —
       *  which log id was used, and whether it came from the caller or
       *  (absent a caller id) the receipt's own delegation certificate. */
      logId: z
        .object({
          source: z.enum(["caller", "receipt-delegation-certificate"]),
          value: z.string(),
        })
        .optional(),
    })
    .optional(),
  /** Present only on `problem.code === "history_scan_exhausted"`: the
   *  verifier's result under the latest chain state, so the caller sees
   *  what the history scan was trying to improve on. */
  latest: z.unknown().optional(),
  supports: SupportsSchema,
  problem: ProblemSchema.optional(),
};

/* ------------------------------- helpers -------------------------------- */

type ToolResult = {
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
  isError: false;
};

function ok(
  text: string,
  structuredContent: Record<string, unknown>,
): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent,
    isError: false,
  };
}

function problemResult(
  toolName: ToolName,
  problem: Record<string, unknown>,
): ToolResult {
  const message =
    typeof problem["message"] === "string"
      ? problem["message"]
      : typeof problem["detail"] === "string"
        ? problem["detail"]
        : JSON.stringify(problem);
  const code =
    typeof problem["code"] === "string" ? problem["code"] : "problem";
  return ok(`problem (${code}): ${message}`, {
    problem,
    supports: SUPPORTS[toolName],
  });
}

function missingInput(
  toolName: ToolName,
  field: string,
  envVar: string,
): ToolResult {
  return problemResult(toolName, {
    code: "missing_input",
    message: `${field} is required: pass it explicitly or set ${envVar}`,
  });
}

function bytesSummary(bytes: Uint8Array): {
  base64: string;
  byteLength: number;
  sha256: string;
} {
  return {
    base64: Buffer.from(bytes).toString("base64"),
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function fetchedProvenance(from: string, at: string): Provenance {
  return { source: "fetched", from, at };
}

function suppliedProvenance(at: string): Provenance {
  return { source: "supplied", from: "supplied by caller", at };
}

function chainReadProvenance(
  rpcUrl: string,
  univocity: string,
  chainId: number,
  at: string,
  binding: "held-genesis" | "explicit",
): Provenance {
  return {
    source: "chain-read",
    from: { rpcUrl, univocity, chainId },
    at,
    binding,
  };
}

/** Field mapping from core's `Classified` "problem" kind onto this
 *  package's `structuredContent.problem` shape — a `code` alongside
 *  whatever `classify.ts` produced, so every problem shape this package
 *  returns carries `code`. */
function classifiedProblemValue(classified: {
  status: number;
  retryAfterMs?: number;
  detail: string;
  problem?: unknown;
}): Record<string, unknown> {
  return {
    code: classified.status === 429 ? "rate_limited" : "http_error",
    status: classified.status,
    detail: classified.detail,
    ...(classified.retryAfterMs !== undefined
      ? { retryAfterMs: classified.retryAfterMs }
      : {}),
    ...(classified.problem !== undefined
      ? { problemDetails: classified.problem }
      : {}),
  };
}

function resolveBaseUrl(
  explicit: string | undefined,
  deps: ResolvedDeps,
): string | undefined {
  return explicit ?? deps.env["FORESTRIE_BASE_URL"];
}

function resolveRpcUrl(
  explicit: string | undefined,
  deps: ResolvedDeps,
): string | undefined {
  return explicit ?? deps.env["FORESTRIE_RPC_URL"];
}

/**
 * Every handler runs through this. An `InputError` (malformed base64/path),
 * an `EndpointError` (a bad baseUrl/logId/address string), a
 * `GenesisBindingError` (an unusable genesis document) or a `NetError` (no
 * response at all) are all "the input, or the network, did not cooperate" —
 * a `structuredContent.problem`, never a throw. Anything else is a
 * programming error and is left to propagate as an MCP tool error.
 */
async function guardHandler(
  toolName: ToolName,
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof InputError) {
      return problemResult(toolName, {
        code: "invalid_input",
        message: err.message,
      });
    }
    if (err instanceof EndpointError) {
      return problemResult(toolName, {
        code: "invalid_input",
        message: err.message,
      });
    }
    if (err instanceof GenesisBindingError) {
      return problemResult(toolName, {
        code: err.code,
        message: err.message,
        reason: err.reason,
      });
    }
    if (err instanceof NetError) {
      return problemResult(toolName, { code: err.code, message: err.message });
    }
    throw err;
  }
}

/* --------------------------- receipt locator ----------------------------- */

type FlatReceiptFields = {
  receiptUrl?: string | undefined;
  baseUrl?: string | undefined;
  bootstrapLogId?: string | undefined;
  logId?: string | undefined;
  massifHeight?: number | undefined;
  entryId?: string | undefined;
};

/** `receiptUrl` alone, or all four of `bootstrapLogId`/`logId`/
 *  `massifHeight`/`entryId` (plus a `baseUrl`, explicit or from
 *  `FORESTRIE_BASE_URL`) — never a throw for a caller who supplied
 *  neither shape completely, a `missing_input` problem naming what's
 *  absent instead. */
function resolveReceiptLocator(
  input: FlatReceiptFields,
  deps: ResolvedDeps,
):
  | { ok: true; value: FetchReceiptInput }
  | { ok: false; problem: Record<string, unknown> } {
  if (input.receiptUrl !== undefined) {
    return { ok: true, value: { receiptUrl: input.receiptUrl } };
  }
  const baseUrl = resolveBaseUrl(input.baseUrl, deps);
  const missing: string[] = [];
  if (baseUrl === undefined) missing.push("baseUrl (or FORESTRIE_BASE_URL)");
  if (input.bootstrapLogId === undefined) missing.push("bootstrapLogId");
  if (input.logId === undefined) missing.push("logId");
  if (input.massifHeight === undefined) missing.push("massifHeight");
  if (input.entryId === undefined) missing.push("entryId");
  if (missing.length > 0) {
    return {
      ok: false,
      problem: {
        code: "missing_input",
        message: `receiptUrl, or all of baseUrl/bootstrapLogId/logId/massifHeight/entryId, are required; missing: ${missing.join(", ")}`,
      },
    };
  }
  return {
    ok: true,
    value: {
      baseUrl: baseUrl as string,
      bootstrapLogId: input.bootstrapLogId as string,
      logId: input.logId as string,
      massifHeight: input.massifHeight as number,
      entryId: input.entryId as string,
    },
  };
}

/** One GET, classified. A 404 ("still writing") becomes a `pending`
 *  problem rather than the bytes; every other non-2xx is `classify`'s own
 *  `problem` kind. */
async function fetchAndClassifyReceipt(
  locator: FetchReceiptInput,
  deps: ResolvedDeps,
): Promise<
  | { kind: "ok"; bytes: Uint8Array; url: string; at: string }
  | { kind: "problem"; problem: Record<string, unknown> }
> {
  const raw = await fetchReceipt(locator, { fetchImpl: deps.fetchImpl });
  const view = toClassifyView(raw);
  const classified = classify(
    "receipt",
    { ...view, location: view.location ?? raw.url },
    raw.url,
  );
  if (classified.kind === "problem") {
    return { kind: "problem", problem: classifiedProblemValue(classified) };
  }
  if (classified.kind === "pending") {
    return {
      kind: "problem",
      problem: {
        code: "pending",
        location: classified.location,
        ...(classified.retryAfterMs !== undefined
          ? { retryAfterMs: classified.retryAfterMs }
          : {}),
        message: "the receipt is not written yet; retry later",
      },
    };
  }
  if (classified.kind !== "receipt") {
    throw new Error(
      `unreachable: classify("receipt", …) returned kind ${classified.kind}`,
    );
  }
  return { kind: "ok", bytes: classified.bytes, url: raw.url, at: raw.at };
}

/* ----------------------------- chain input -------------------------------- */

/** `history` bounds for the backward `CheckpointPublished` scan. */
type HistoryInput = {
  fromBlock?: number | undefined;
  maxBlocks?: number | undefined;
  chunkBlocks?: number | undefined;
};

type ChainInput =
  | {
      genesis: BytesInput;
      rpcUrl?: string | undefined;
      logId: string;
      history?: HistoryInput | undefined;
    }
  | {
      rpcUrl?: string | undefined;
      univocity: string;
      logId: string;
      chainId?: number | undefined;
      history?: HistoryInput | undefined;
    };

/** `verify_fetched_receipt`'s `trust.chain` alone: `ChainInput`, but `logId` optional — the handler resolves
 *  the effective id (caller's, or the receipt's own delegation
 *  certificate) before ever building a plain `ChainInput` for
 *  `resolveChainInput`. */
type VerifyChainInput =
  | {
      genesis: BytesInput;
      rpcUrl?: string | undefined;
      logId?: string | undefined;
      history?: HistoryInput | undefined;
    }
  | {
      rpcUrl?: string | undefined;
      univocity: string;
      logId?: string | undefined;
      chainId?: number | undefined;
      history?: HistoryInput | undefined;
    };

/** `fetch_accumulator.forReceipt` (1.5.10): the leaf inputs the verifier
 *  needs to recompute a receipt's peak. */
type ForReceiptInput = {
  receipt: BytesInput;
  payload?: BytesInput | undefined;
  entryId?: string | undefined;
  grant?: boolean | undefined;
};

type ResolvedChain = {
  rpcUrl: string;
  univocity: string;
  logId: string;
  expectedChainId: number | undefined;
  binding: "held-genesis" | "explicit";
};

/** `toContractLogId`'s own normalisation
 *  and validation (strip dashes/`0x`, lowercase, 32 or 64 hex), but never
 *  throwing — `undefined` for anything that doesn't parse, so a caller's
 *  malformed id is left for the ordinary chain-input resolution to
 *  reject, rather than surfacing a different error here. */
function tryContractLogId(logId: string): string | undefined {
  try {
    return toContractLogId(logId);
  } catch {
    return undefined;
  }
}

/** The low 16 bytes of a `toContractLogId` result, dashed: log ids are
 *  reported in lowercase UUID form. */
function formatContractLogIdAsUuid(contractForm: string): string {
  const hex32 = contractForm.slice(-32);
  return [
    hex32.slice(0, 8),
    hex32.slice(8, 12),
    hex32.slice(12, 16),
    hex32.slice(16, 20),
    hex32.slice(20, 32),
  ].join("-");
}

function resolveChainInput(
  input: ChainInput,
  deps: ResolvedDeps,
):
  | { ok: true; value: ResolvedChain }
  | { ok: false; problem: Record<string, unknown> } {
  const rpcUrl = resolveRpcUrl(input.rpcUrl, deps);
  if (rpcUrl === undefined) {
    return {
      ok: false,
      problem: {
        code: "missing_input",
        message:
          "rpcUrl is required: pass it explicitly or set FORESTRIE_RPC_URL",
      },
    };
  }
  if ("genesis" in input) {
    const genesisBytes = resolveBytes(input.genesis, "chain.genesis");
    const binding: ChainBinding = decodeChainBindingFromGenesis(genesisBytes);
    return {
      ok: true,
      value: {
        rpcUrl,
        univocity: binding.univocity,
        logId: input.logId,
        expectedChainId: binding.chainId,
        binding: "held-genesis",
      },
    };
  }
  return {
    ok: true,
    value: {
      rpcUrl,
      univocity: input.univocity,
      logId: input.logId,
      expectedChainId: input.chainId,
      binding: "explicit",
    },
  };
}

/** `HistoryInput`'s wire numbers -> the bigint bounds `scanCheckpointHistory`
 *  takes, respecting `exactOptionalPropertyTypes` (an explicit `undefined`
 *  is not the same as an absent key). */
function historyBounds(input: HistoryInput | undefined): {
  fromBlock?: bigint;
  maxBlocks?: bigint;
  chunkBlocks?: bigint;
} {
  return {
    ...(input?.fromBlock !== undefined
      ? { fromBlock: BigInt(input.fromBlock) }
      : {}),
    ...(input?.maxBlocks !== undefined
      ? { maxBlocks: BigInt(input.maxBlocks) }
      : {}),
    ...(input?.chunkBlocks !== undefined
      ? { chunkBlocks: BigInt(input.chunkBlocks) }
      : {}),
  };
}

/* ------------------------------- handlers --------------------------------- */

function extractServiceId(json: unknown): string | undefined {
  if (json !== null && typeof json === "object" && "serviceId" in json) {
    const value = (json as { serviceId: unknown }).serviceId;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

async function handleFetchScittConfiguration(
  args: { baseUrl?: string | undefined },
  deps: ResolvedDeps,
): Promise<ToolResult> {
  const baseUrl = resolveBaseUrl(args.baseUrl, deps);
  if (baseUrl === undefined) {
    return missingInput(
      "fetch_scitt_configuration",
      "baseUrl",
      "FORESTRIE_BASE_URL",
    );
  }

  const raw = await fetchScittConfiguration(
    { baseUrl },
    { fetchImpl: deps.fetchImpl },
  );
  const classified = classify("configuration", toClassifyView(raw), baseUrl);
  if (classified.kind === "problem") {
    return problemResult(
      "fetch_scitt_configuration",
      classifiedProblemValue(classified),
    );
  }
  if (classified.kind !== "configuration") {
    throw new Error(
      `unreachable: classify("configuration", …) returned kind ${classified.kind}`,
    );
  }

  const provenance = fetchedProvenance(raw.url, raw.at);
  const serviceId = extractServiceId(classified.json);
  const text =
    serviceId !== undefined
      ? `fetched SCITT configuration (serviceId ${serviceId}) from ${raw.url}`
      : `fetched SCITT configuration from ${raw.url}`;

  return ok(text, {
    configuration: classified.json,
    provenance,
    supports: SUPPORTS.fetch_scitt_configuration,
  });
}

async function handleQueryRegistration(
  args: {
    baseUrl?: string | undefined;
    bootstrapLogId: string;
    logId: string;
    contentHash: string;
  },
  deps: ResolvedDeps,
): Promise<ToolResult> {
  const baseUrl = resolveBaseUrl(args.baseUrl, deps);
  if (baseUrl === undefined) {
    return missingInput("query_registration", "baseUrl", "FORESTRIE_BASE_URL");
  }

  const raw = await queryRegistration(
    {
      baseUrl,
      bootstrapLogId: args.bootstrapLogId,
      logId: args.logId,
      contentHash: args.contentHash,
    },
    { fetchImpl: deps.fetchImpl },
  );
  const classified = classify("registration", toClassifyView(raw), baseUrl);
  if (classified.kind === "problem") {
    return problemResult(
      "query_registration",
      classifiedProblemValue(classified),
    );
  }

  const provenance = fetchedProvenance(raw.url, raw.at);
  if (classified.kind === "pending") {
    return ok(`registration pending; retry ${classified.location}`, {
      status: "pending",
      location: classified.location,
      ...(classified.retryAfterMs !== undefined
        ? { retryAfterMs: classified.retryAfterMs }
        : {}),
      provenance,
      supports: SUPPORTS.query_registration,
    });
  }

  if (classified.kind !== "receipt-location") {
    throw new Error(
      `unreachable: classify("registration", …) returned kind ${classified.kind}`,
    );
  }
  return ok(`registration complete; receipt at ${classified.receiptUrl}`, {
    status: "receipt-available",
    receiptUrl: classified.receiptUrl,
    entryId: classified.entryIdHex,
    provenance,
    supports: SUPPORTS.query_registration,
  });
}

async function handleFetchReceipt(
  args: FlatReceiptFields,
  deps: ResolvedDeps,
): Promise<ToolResult> {
  const locator = resolveReceiptLocator(args, deps);
  if (!locator.ok) return problemResult("fetch_receipt", locator.problem);

  const fetched = await fetchAndClassifyReceipt(locator.value, deps);
  if (fetched.kind === "problem")
    return problemResult("fetch_receipt", fetched.problem);

  let decoded: unknown;
  try {
    decoded = decodeReceipt(fetched.bytes);
  } catch (err) {
    if (err instanceof DecodeReceiptError) {
      return problemResult("fetch_receipt", {
        code: "receipt_malformed",
        stage: err.stage,
        message: err.message,
      });
    }
    throw err;
  }

  const provenance = fetchedProvenance(fetched.url, fetched.at);
  // Report only — no default logic here, unlike verify_fetched_receipt.
  const receiptLogId = decodeReceiptLogId(fetched.bytes)?.logId;
  return ok(
    `fetched receipt (${fetched.bytes.length} B) from ${fetched.url}`,
    {
      receipt: bytesSummary(fetched.bytes),
      decoded,
      ...(receiptLogId !== undefined ? { receiptLogId } : {}),
      provenance,
      supports: SUPPORTS.fetch_receipt,
    },
  );
}

async function handleFetchGenesis(
  args: { baseUrl?: string | undefined; logId: string },
  deps: ResolvedDeps,
): Promise<ToolResult> {
  const baseUrl = resolveBaseUrl(args.baseUrl, deps);
  if (baseUrl === undefined) {
    return missingInput("fetch_genesis", "baseUrl", "FORESTRIE_BASE_URL");
  }

  const raw = await fetchGenesis(
    { baseUrl, logId: args.logId },
    { fetchImpl: deps.fetchImpl },
  );
  const classified = classify("genesis", toClassifyView(raw), baseUrl);
  if (classified.kind === "problem") {
    return problemResult("fetch_genesis", classifiedProblemValue(classified));
  }
  if (classified.kind !== "genesis") {
    throw new Error(
      `unreachable: classify("genesis", …) returned kind ${classified.kind}`,
    );
  }

  // GenesisBindingError, if the fetched document does not decode, is caught
  // by guardHandler — this handler does not need its own try/catch for it.
  const chainBinding = decodeChainBindingFromGenesis(classified.bytes);

  // The bootstrap public key as x‖y hex, straight from the
  // genesis bytes (never exported from the non-extractable CryptoKey a
  // trust-root decode would otherwise produce). `bootstrapKeyXy` is
  // `undefined` for a KS256 v2 bootstrap key (an on-chain address), and
  // omitted here rather than failing — decodeTrustRootDetailsFromGenesis
  // itself throws the same shape of error as decodeChainBindingFromGenesis
  // for a malformed document, so a document that failed the chain-binding
  // decode above never reaches this call, and one that failed only here
  // (an unusable trust root with an otherwise-valid chain binding) is
  // likewise caught by guardHandler's GenesisBindingError handling — this
  // package's own class, not receipt-verify's plain Error, so it is
  // wrapped the same way decodeChainBindingFromGenesis wraps it.
  let bootstrapKeyXy: string | undefined;
  try {
    const trustRoot = await decodeTrustRootDetailsFromGenesis(
      classified.bytes,
    );
    bootstrapKeyXy = trustRoot.bootstrapKeyXy
      ? Buffer.from(trustRoot.bootstrapKeyXy).toString("hex")
      : undefined;
  } catch (err) {
    throw new GenesisBindingError(
      err instanceof Error ? err.message : String(err),
    );
  }

  const provenance = fetchedProvenance(raw.url, raw.at);
  return ok(
    `fetched genesis (${classified.bytes.length} B) from ${raw.url}: univocity ${chainBinding.univocity} on chain ${chainBinding.chainId}`,
    {
      genesis: bytesSummary(classified.bytes),
      chainBinding,
      ...(bootstrapKeyXy !== undefined ? { bootstrapKeyXy } : {}),
      provenance,
      supports: SUPPORTS.fetch_genesis,
    },
  );
}

function accumulatorStructured(
  result: {
    size: bigint;
    accumulator: Uint8Array[];
    blockNumber: bigint;
    blockHash: string;
    chainId: number;
    univocity: string;
  },
  logId: string,
  snapshot: Uint8Array,
  provenance: Provenance,
): Record<string, unknown> {
  return {
    snapshot: bytesSummary(snapshot),
    accumulator: {
      size: Number(result.size),
      peaks: result.accumulator.map(
        (p) => `0x${Buffer.from(p).toString("hex")}`,
      ),
      blockNumber: Number(result.blockNumber),
      blockHash: result.blockHash,
      chainId: result.chainId,
      univocity: result.univocity,
      logId,
    },
    provenance,
    supports: SUPPORTS.fetch_accumulator,
  };
}

async function handleFetchAccumulator(
  args: {
    chain: ChainInput;
    forReceipt?: ForReceiptInput | undefined;
  },
  deps: ResolvedDeps,
): Promise<ToolResult> {
  const resolved = resolveChainInput(args.chain, deps);
  if (!resolved.ok)
    return problemResult("fetch_accumulator", resolved.problem);
  const { rpcUrl, univocity, logId, expectedChainId, binding } =
    resolved.value;

  // forReceipt's leaf inputs are validated before any JSON-RPC call: a
  // payload receipt needs
  // both payload and entryId to recompute its peak; a grant receipt's
  // leaf inputs are derived by `grantLeafInputs`
  // (`../core/grant-leaf.js`), whose `GrantLeafInputError` is mapped to a
  // problem here — both BEFORE the accumulator read, so either failure is
  // zero-request, same as the payload case.
  let leafInput:
    | {
        kind: "payload";
        receiptBytes: Uint8Array;
        payloadBytes: Uint8Array;
        entryId: string;
      }
    | {
        kind: "grant";
        receiptBytes: Uint8Array;
        idtimestampBe8: Uint8Array;
        inner: Uint8Array;
      }
    | undefined;
  if (args.forReceipt !== undefined) {
    if (args.forReceipt.grant === true) {
      if (args.forReceipt.payload === undefined) {
        return problemResult("fetch_accumulator", {
          code: "missing_input",
          message:
            "forReceipt needs payload and entryId (or grant true with the committed grant bytes) to recompute the receipt's peak",
        });
      }
      const receiptBytes = resolveBytes(
        args.forReceipt.receipt,
        "forReceipt.receipt",
      );
      const committedGrantBytes = resolveBytes(
        args.forReceipt.payload,
        "forReceipt.payload",
      );
      try {
        const { idtimestampBe8, inner } = await grantLeafInputs(
          committedGrantBytes,
          args.forReceipt.entryId,
        );
        leafInput = { kind: "grant", receiptBytes, idtimestampBe8, inner };
      } catch (err) {
        if (err instanceof GrantLeafInputError) {
          if (err.kind === "missing_entry_id") {
            return problemResult("fetch_accumulator", {
              code: "missing_input",
              message:
                "forReceipt.payload is a raw grant payload, which carries no idtimestamp; supply entryId (a Forestrie-Grant COSE Sign1 carries its own)",
            });
          }
          return problemResult("fetch_accumulator", {
            code: "invalid_input",
            message: `forReceipt.payload with grant true is neither a Forestrie-Grant COSE Sign1 nor a raw grant payload: ${err.detail}`,
          });
        }
        throw err;
      }
    } else if (
      args.forReceipt.payload === undefined ||
      args.forReceipt.entryId === undefined
    ) {
      return problemResult("fetch_accumulator", {
        code: "missing_input",
        message:
          "forReceipt needs payload and entryId (or grant true with the committed grant bytes) to recompute the receipt's peak",
      });
    } else {
      leafInput = {
        kind: "payload",
        receiptBytes: resolveBytes(
          args.forReceipt.receipt,
          "forReceipt.receipt",
        ),
        payloadBytes: resolveBytes(
          args.forReceipt.payload,
          "forReceipt.payload",
        ),
        entryId: args.forReceipt.entryId,
      };
    }
  }

  const result = await fetchAccumulatorSnapshot(
    {
      rpcUrl,
      univocity,
      logId,
      ...(expectedChainId !== undefined ? { expectedChainId } : {}),
    },
    { fetchImpl: deps.fetchImpl },
  );
  if (result.kind === "problem") {
    return problemResult("fetch_accumulator", { ...result.problem });
  }

  const provenance = chainReadProvenance(
    rpcUrl,
    result.univocity,
    result.chainId,
    result.at,
    binding,
  );

  // Without forReceipt: the latest state, no history scan.
  if (leafInput === undefined) {
    return ok(
      `read accumulator (size ${result.size}) from ${result.univocity} on chain ${result.chainId} at block ${result.blockNumber}`,
      accumulatorStructured(result, logId, result.snapshot, provenance),
    );
  }

  let peak: Uint8Array;
  try {
    peak = await recomputePeakForReceipt(
      leafInput.kind === "payload"
        ? {
            kind: "payload",
            receipt: leafInput.receiptBytes,
            payload: leafInput.payloadBytes,
            entryId: leafInput.entryId,
          }
        : {
            kind: "grant",
            receipt: leafInput.receiptBytes,
            idtimestampBe8: leafInput.idtimestampBe8,
            inner: leafInput.inner,
          },
    );
  } catch (err) {
    return problemResult("fetch_accumulator", {
      code: "receipt_malformed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (peakHeldIn(peak, result.accumulator)) {
    return ok(
      `read accumulator (size ${result.size}) from ${result.univocity} on chain ${result.chainId} at block ${result.blockNumber}: holds the receipt's peak`,
      accumulatorStructured(result, logId, result.snapshot, provenance),
    );
  }

  // The latest state does not hold the peak — walk published
  // history backwards from this read's own block.
  const scan = await scanCheckpointHistory(
    {
      rpcUrl,
      univocity: result.univocity,
      logId,
      latestBlock: result.blockNumber,
      ...historyBounds(args.chain.history),
    },
    (checkpoints) =>
      selectCheckpoint(checkpoints, async (cp) =>
        peakHeldIn(peak, cp.accumulator),
      ),
    { fetchImpl: deps.fetchImpl },
  );

  if (scan.kind === "problem") {
    return problemResult("fetch_accumulator", {
      ...scan.problem,
      scannedFrom: Number(scan.scannedFrom),
      scannedTo: Number(scan.scannedTo),
      requests: scan.requests,
    });
  }

  if (scan.kind === "exhausted") {
    return ok(
      `no published checkpoint between blocks ${scan.scannedFrom} and ${scan.scannedTo} holds this receipt's peak (${scan.requests} requests)`,
      {
        problem: {
          code: "history_scan_exhausted",
          scannedFrom: Number(scan.scannedFrom),
          scannedTo: Number(scan.scannedTo),
          checkpointsSeen: scan.checkpointsSeen,
          requests: scan.requests,
        },
        latest: {
          size: Number(result.size),
          blockNumber: Number(result.blockNumber),
        },
        supports: SUPPORTS.fetch_accumulator,
      },
    );
  }

  const cp: PublishedCheckpoint = scan.checkpoint;
  const historySnapshot = toKnownAccumulator(cp, {
    chainId: result.chainId,
    univocity: result.univocity,
    logId,
  });
  const historyProvenance: Provenance = {
    ...provenance,
    history: {
      blockNumber: Number(cp.blockNumber),
      blockHash: cp.blockHash,
      size: Number(cp.size),
      scannedFrom: Number(scan.scannedFrom),
      scannedTo: Number(scan.scannedTo),
      requests: scan.requests,
    },
  };
  return ok(
    `read accumulator (size ${cp.size}) from published checkpoint history at block ${cp.blockNumber}: holds the receipt's peak`,
    accumulatorStructured(
      {
        size: cp.size,
        accumulator: cp.accumulator,
        blockNumber: cp.blockNumber,
        blockHash: cp.blockHash,
        chainId: result.chainId,
        univocity: result.univocity,
      },
      logId,
      historySnapshot,
      historyProvenance,
    ),
  );
}

/* --------------------------- fetch_checkpoint_history ----------------------- */

/** One `PublishedCheckpoint`, structured for the wire: hex peaks (as
 *  `fetch_accumulator`'s `accumulator.peaks` are), and the same checkpoint
 *  as a `known-accumulator` snapshot (base64) the caller can keep and
 *  later pass back as `trust.accumulator` supplied bytes. */
function publishedCheckpointStructured(
  cp: PublishedCheckpoint,
  binding: { chainId: number; univocity: string; logId: string },
): Record<string, unknown> {
  const snapshot = toKnownAccumulator(cp, binding);
  return {
    size: Number(cp.size),
    accumulator: cp.accumulator.map(
      (p) => `0x${Buffer.from(p).toString("hex")}`,
    ),
    blockNumber: Number(cp.blockNumber),
    blockHash: cp.blockHash,
    txHash: cp.txHash,
    snapshot: Buffer.from(snapshot).toString("base64"),
  };
}

async function handleFetchCheckpointHistory(
  args: { chain: ChainInput },
  deps: ResolvedDeps,
): Promise<ToolResult> {
  const resolved = resolveChainInput(args.chain, deps);
  if (!resolved.ok)
    return problemResult("fetch_checkpoint_history", resolved.problem);
  const { rpcUrl, univocity, logId, expectedChainId, binding } =
    resolved.value;

  // The latest block only — no eth_call, this tool has no use for
  // logState itself.
  const head = await readChainHead(
    {
      rpcUrl,
      ...(expectedChainId !== undefined ? { expectedChainId } : {}),
    },
    { fetchImpl: deps.fetchImpl },
  );
  if (head.kind === "problem") {
    return problemResult("fetch_checkpoint_history", { ...head.problem });
  }

  const scan = await fetchCheckpointHistory(
    {
      rpcUrl,
      univocity,
      logId,
      latestBlock: head.blockNumber,
      ...historyBounds(args.chain.history),
    },
    { fetchImpl: deps.fetchImpl },
  );

  if (scan.kind === "problem") {
    return problemResult("fetch_checkpoint_history", {
      ...scan.problem,
      scannedFrom: Number(scan.scannedFrom),
      scannedTo: Number(scan.scannedTo),
      requests: scan.requests,
    });
  }

  const chainBinding = { univocity, chainId: head.chainId, logId };
  const checkpoints = scan.checkpoints.map((cp) =>
    publishedCheckpointStructured(cp, chainBinding),
  );

  const provenance: Provenance = {
    source: "chain-read",
    from: { rpcUrl, univocity, chainId: head.chainId },
    at: head.at,
    binding,
    history: {
      scannedFrom: Number(scan.scannedFrom),
      scannedTo: Number(scan.scannedTo),
      requests: scan.requests,
    },
  };

  const text = `read ${checkpoints.length} published checkpoint${checkpoints.length === 1 ? "" : "s"} between blocks ${scan.scannedFrom} and ${scan.scannedTo} (${scan.requests} requests)\n${SUPPORTS.fetch_checkpoint_history.note}`;

  return ok(text, {
    checkpoints,
    scannedFrom: Number(scan.scannedFrom),
    scannedTo: Number(scan.scannedTo),
    requests: scan.requests,
    chainBinding,
    provenance,
    supports: SUPPORTS.fetch_checkpoint_history,
  });
}

/* --------------------------- verify_fetched_receipt ------------------------ */

type TrustRootWireInput =
  | { root: "genesis"; genesis: BytesInput }
  | { root: "known-log-key"; keyXy: BytesInput }
  | {
      root: "known-accumulator";
      accumulator: BytesInput;
      massif?: BytesInput | undefined;
      consistencyProof?: BytesInput | undefined;
    }
  | {
      root: "checkpoint-chain";
      checkpoints: BytesInput[];
      genesis?: BytesInput | undefined;
      keyXy?: BytesInput | undefined;
    };

type TrustInput =
  TrustRootWireInput | { root: "known-accumulator"; chain: VerifyChainInput };

/** Mirrors `@forestrie/mcp-verify`'s `resolveRoot`, over `base64`-named bytes. */
function resolveSuppliedRoot(input: TrustRootWireInput): TrustRoot {
  switch (input.root) {
    case "genesis":
      return {
        root: "genesis",
        genesis: resolveBytes(input.genesis, "trust.genesis"),
      };
    case "known-log-key":
      return {
        root: "known-log-key",
        keyXy: resolveBytes(input.keyXy, "trust.keyXy"),
      };
    case "known-accumulator": {
      const out: TrustRoot = {
        root: "known-accumulator",
        accumulator: resolveBytes(input.accumulator, "trust.accumulator"),
      };
      if (input.massif !== undefined) {
        out.massif = resolveBytes(input.massif, "trust.massif");
      }
      if (input.consistencyProof !== undefined) {
        out.consistencyProof = resolveBytes(
          input.consistencyProof,
          "trust.consistencyProof",
        );
      }
      return out;
    }
    case "checkpoint-chain": {
      if (input.checkpoints.length === 0) {
        throw new InputError("trust.checkpoints must not be empty");
      }
      const out: TrustRoot = {
        root: "checkpoint-chain",
        checkpoints: input.checkpoints.map((c, i) =>
          resolveBytes(c, `trust.checkpoints[${i}]`),
        ),
      };
      if (input.genesis !== undefined) {
        out.genesis = resolveBytes(input.genesis, "trust.genesis");
      }
      if (input.keyXy !== undefined) {
        out.keyXy = resolveBytes(input.keyXy, "trust.keyXy");
      }
      if (out.genesis === undefined && out.keyXy === undefined) {
        throw new InputError(
          "the checkpoint-chain root needs a trust root: supply trust.genesis or trust.keyXy",
        );
      }
      return out;
    }
  }
}

type VerifyFetchedArgs = FlatReceiptFields & {
  trust: TrustInput;
  payload?: BytesInput | undefined;
  grant?: boolean | undefined;
};

function rpcUrlFromProvenance(p: Provenance): string | undefined {
  return typeof p.from === "object" ? p.from.rpcUrl : undefined;
}

/** The chain path's own state, kept around only so a `peak_not_in_known_accumulator`
 *  result can trigger the history scan from the same block/binding the
 *  initial `logState` read already established. `undefined` for a
 *  supplied root, which never scans. */
type ChainScanContext = {
  rpcUrl: string;
  univocity: string;
  logId: string;
  chainId: number;
  latestBlock: bigint;
  history: HistoryInput | undefined;
};

async function handleVerifyFetchedReceipt(
  args: VerifyFetchedArgs,
  deps: ResolvedDeps,
): Promise<ToolResult> {
  const locator = resolveReceiptLocator(args, deps);
  if (!locator.ok)
    return problemResult("verify_fetched_receipt", locator.problem);

  const fetchedReceipt = await fetchAndClassifyReceipt(locator.value, deps);
  if (fetchedReceipt.kind === "problem") {
    return problemResult("verify_fetched_receipt", fetchedReceipt.problem);
  }
  const receiptProvenance = fetchedProvenance(
    fetchedReceipt.url,
    fetchedReceipt.at,
  );

  let trust: TrustRoot;
  let rootProvenance: "supplied" | "chain-read" | "chain-read-history";
  let rootProvenanceValue: Provenance;
  let chainScan: ChainScanContext | undefined;
  let logIdProvenanceValue: LogIdProvenance | undefined;
  let logIdMismatchDiagnostic: CourierDiagnostic | undefined;

  if (args.trust.root === "known-accumulator" && "chain" in args.trust) {
    // The effective log id is the caller's whenever one was supplied —
    // trust.chain.logId, else the receipt coordinates' logId (a receiptUrl
    // call has no coordinates to fall back to) — else the id the receipt's
    // own delegation certificate names, decoded from the bytes just fetched.
    // Absent both, missing_input, before any chain request. The decode and
    // the cross-check below cost no request, so the request order and counts
    // are unchanged.
    const callerLogId: string | undefined =
      args.trust.chain.logId ??
      ("logId" in locator.value ? locator.value.logId : undefined);
    const certificateLogId = decodeReceiptLogId(fetchedReceipt.bytes)?.logId;

    let effectiveLogId: string;
    if (callerLogId !== undefined) {
      effectiveLogId = callerLogId;
      // Same normalisation rule as `toContractLogId`: compare
      // the zero-padded contract forms, so a dash/case/0x difference
      // alone never reads as a mismatch. A caller id that doesn't parse
      // as a log id at all is left for `resolveChainInput`/the calldata
      // build below to reject, as today.
      const callerContractForm = tryContractLogId(callerLogId);
      // Provenance reports the id in lowercase UUID form, whatever surface
      // form the caller used. An unparseable id is echoed as
      // given; the chain step below rejects it.
      logIdProvenanceValue = {
        source: "caller",
        value:
          callerContractForm !== undefined
            ? formatContractLogIdAsUuid(callerContractForm)
            : callerLogId,
      };
      const certificateContractForm =
        certificateLogId !== undefined
          ? tryContractLogId(certificateLogId)
          : undefined;
      if (
        callerContractForm !== undefined &&
        certificateContractForm !== undefined &&
        callerContractForm !== certificateContractForm
      ) {
        logIdMismatchDiagnostic = {
          code: "receipt_log_id_mismatch",
          message: `the receipt's delegation certificate names log ${formatContractLogIdAsUuid(certificateContractForm)}, the call named ${formatContractLogIdAsUuid(callerContractForm)}`,
        };
      }
    } else if (certificateLogId !== undefined) {
      effectiveLogId = certificateLogId;
      logIdProvenanceValue = {
        source: "receipt-delegation-certificate",
        value: certificateLogId,
      };
    } else {
      return problemResult("verify_fetched_receipt", {
        code: "missing_input",
        message:
          "logId is required: supply trust.chain.logId, the receipt coordinates' logId, or a receipt whose delegation certificate names one",
      });
    }

    const resolvedChain = resolveChainInput(
      { ...args.trust.chain, logId: effectiveLogId },
      deps,
    );
    if (!resolvedChain.ok) {
      return problemResult("verify_fetched_receipt", resolvedChain.problem);
    }
    const { rpcUrl, univocity, logId, expectedChainId, binding } =
      resolvedChain.value;
    const snapshot = await fetchAccumulatorSnapshot(
      {
        rpcUrl,
        univocity,
        logId,
        ...(expectedChainId !== undefined ? { expectedChainId } : {}),
      },
      { fetchImpl: deps.fetchImpl },
    );
    if (snapshot.kind === "problem") {
      return problemResult("verify_fetched_receipt", { ...snapshot.problem });
    }
    trust = { root: "known-accumulator", accumulator: snapshot.snapshot };
    rootProvenance = "chain-read";
    rootProvenanceValue = chainReadProvenance(
      rpcUrl,
      snapshot.univocity,
      snapshot.chainId,
      snapshot.at,
      binding,
    );
    chainScan = {
      rpcUrl,
      univocity: snapshot.univocity,
      logId,
      chainId: snapshot.chainId,
      latestBlock: snapshot.blockNumber,
      history: args.trust.chain.history,
    };
  } else {
    trust = resolveSuppliedRoot(args.trust);
    rootProvenance = "supplied";
    rootProvenanceValue = suppliedProvenance(deps.now().toISOString());
  }

  const kind: "payload" | "grant" = args.grant === true ? "grant" : "payload";

  let runVerify: (
    verifyTrust: TrustRoot,
    verifyRootProvenance: "supplied" | "chain-read" | "chain-read-history",
  ) => Promise<FetchedVerifyResult>;

  if (kind === "payload") {
    if (args.payload === undefined || args.entryId === undefined) {
      return problemResult("verify_fetched_receipt", {
        code: "missing_input",
        message:
          "payload and entryId are required to verify a payload receipt (set grant:true to verify a grant receipt instead)",
      });
    }
    const payloadBytes = resolveBytes(args.payload, "payload");
    const entryId = args.entryId;
    runVerify = (verifyTrust, verifyRootProvenance) =>
      verifyFetched({
        kind: "payload",
        receipt: fetchedReceipt.bytes,
        payload: payloadBytes,
        entryId,
        trust: verifyTrust,
        rootProvenance: verifyRootProvenance,
      });
  } else {
    if (args.payload === undefined) {
      return problemResult("verify_fetched_receipt", {
        code: "missing_input",
        message:
          "payload is required (the committed grant bytes) to verify a grant receipt",
      });
    }
    const committedGrant = resolveBytes(args.payload, "committedGrant");
    const entryId = args.entryId;
    runVerify = (verifyTrust, verifyRootProvenance) =>
      verifyFetched({
        kind: "grant",
        receipt: fetchedReceipt.bytes,
        committedGrant,
        ...(entryId !== undefined ? { entryId } : {}),
        trust: verifyTrust,
        rootProvenance: verifyRootProvenance,
      });
  }

  let result = await runVerify(trust, rootProvenance);

  // The latest chain state didn't hold the peak — walk published
  // history backwards from this read's own block, re-verifying under
  // each candidate checkpoint (newest first) until one is ok.
  if (
    chainScan !== undefined &&
    rootProvenance === "chain-read" &&
    isPeakNotInKnownAccumulator(result)
  ) {
    const scan = await scanCheckpointHistory(
      {
        rpcUrl: chainScan.rpcUrl,
        univocity: chainScan.univocity,
        logId: chainScan.logId,
        latestBlock: chainScan.latestBlock,
        ...historyBounds(chainScan.history),
      },
      (checkpoints) =>
        selectCheckpoint(checkpoints, async (cp) => {
          const candidateSnapshot = toKnownAccumulator(cp, {
            chainId: chainScan!.chainId,
            univocity: chainScan!.univocity,
            logId: chainScan!.logId,
          });
          const candidate = await runVerify(
            { root: "known-accumulator", accumulator: candidateSnapshot },
            "chain-read-history",
          );
          return candidate.ok;
        }),
      { fetchImpl: deps.fetchImpl },
    );

    if (scan.kind === "problem") {
      return problemResult("verify_fetched_receipt", {
        ...scan.problem,
        scannedFrom: Number(scan.scannedFrom),
        scannedTo: Number(scan.scannedTo),
        requests: scan.requests,
      });
    }

    if (scan.kind === "exhausted") {
      return ok(
        `no published checkpoint between blocks ${scan.scannedFrom} and ${scan.scannedTo} holds this receipt's peak (${scan.requests} requests)`,
        {
          problem: {
            code: "history_scan_exhausted",
            scannedFrom: Number(scan.scannedFrom),
            scannedTo: Number(scan.scannedTo),
            checkpointsSeen: scan.checkpointsSeen,
            requests: scan.requests,
          },
          latest: result,
          supports: SUPPORTS.verify_fetched_receipt,
        },
      );
    }

    // match: verify once more under the selected checkpoint — the
    // final result and provenance are this checkpoint's, not the
    // intermediate `accepts` check's.
    const cp: PublishedCheckpoint = scan.checkpoint;
    const candidateSnapshot = toKnownAccumulator(cp, {
      chainId: chainScan.chainId,
      univocity: chainScan.univocity,
      logId: chainScan.logId,
    });
    result = await runVerify(
      { root: "known-accumulator", accumulator: candidateSnapshot },
      "chain-read-history",
    );
    rootProvenanceValue = {
      ...rootProvenanceValue,
      history: {
        blockNumber: Number(cp.blockNumber),
        blockHash: cp.blockHash,
        size: Number(cp.size),
        scannedFrom: Number(scan.scannedFrom),
        scannedTo: Number(scan.scannedTo),
        requests: scan.requests,
      },
    };
  }

  const provenance = {
    receipt: receiptProvenance,
    root: rootProvenanceValue,
    // Present whenever a chain read happened above.
    ...(logIdProvenanceValue !== undefined
      ? { logId: logIdProvenanceValue }
      : {}),
  };
  const rpcUrl = rpcUrlFromProvenance(rootProvenanceValue);
  const provenanceLine =
    `receipt: fetched from ${fetchedReceipt.url} at ${fetchedReceipt.at}` +
    (rpcUrl !== undefined
      ? `; root: read from the chain at ${rpcUrl}`
      : "; root: supplied by caller");

  const verb = kind === "grant" ? "verify-grant" : "verify";
  const text = summarizeFetched(verb, result, provenanceLine);

  // The mismatch diagnostic is tools.ts's own, appended alongside
  // (never instead of) compose.ts's courier diagnostics on `result`.
  const diagnostics =
    logIdMismatchDiagnostic !== undefined
      ? [...result.diagnostics, logIdMismatchDiagnostic]
      : result.diagnostics;

  return ok(text, {
    ...result,
    diagnostics,
    provenance,
    supports: SUPPORTS.verify_fetched_receipt,
  });
}

/* -------------------------------- exports --------------------------------- */

/**
 * One factory per tool: closes over `deps` and returns the
 * `registerTool` callback, wrapped in `guardHandler` so every escape is a
 * `structuredContent.problem` rather than a thrown MCP tool error (except
 * a genuine programming error, which `guardHandler` re-throws). `server.ts`
 * pairs each of these with its input/output raw shape above and the
 * shared annotations object.
 */
export function makeFetchScittConfigurationTool(deps: ResolvedDeps) {
  return (args: { baseUrl?: string | undefined }) =>
    guardHandler("fetch_scitt_configuration", () =>
      handleFetchScittConfiguration(args, deps),
    );
}

export function makeQueryRegistrationTool(deps: ResolvedDeps) {
  return (args: {
    baseUrl?: string | undefined;
    bootstrapLogId: string;
    logId: string;
    contentHash: string;
  }) =>
    guardHandler("query_registration", () =>
      handleQueryRegistration(args, deps),
    );
}

export function makeFetchReceiptTool(deps: ResolvedDeps) {
  return (args: FlatReceiptFields) =>
    guardHandler("fetch_receipt", () => handleFetchReceipt(args, deps));
}

export function makeFetchGenesisTool(deps: ResolvedDeps) {
  return (args: { baseUrl?: string | undefined; logId: string }) =>
    guardHandler("fetch_genesis", () => handleFetchGenesis(args, deps));
}

export function makeFetchAccumulatorTool(deps: ResolvedDeps) {
  return (args: {
    chain: ChainInput;
    forReceipt?: ForReceiptInput | undefined;
  }) =>
    guardHandler("fetch_accumulator", () =>
      handleFetchAccumulator(args, deps),
    );
}

export function makeFetchCheckpointHistoryTool(deps: ResolvedDeps) {
  return (args: { chain: ChainInput }) =>
    guardHandler("fetch_checkpoint_history", () =>
      handleFetchCheckpointHistory(args, deps),
    );
}

export function makeVerifyFetchedReceiptTool(deps: ResolvedDeps) {
  return (args: VerifyFetchedArgs) =>
    guardHandler("verify_fetched_receipt", () =>
      handleVerifyFetchedReceipt(args, deps),
    );
}
