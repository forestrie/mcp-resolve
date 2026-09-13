/**
 * `FetchedVerifyResult`: the verifier's own `VerifyResult`, with `courier`
 * identity attached and `diagnostics` widened to admit the two courier
 * codes `compose.ts` appends. Every other field is the verifier's,
 * untouched (plan-2609-05 N3).
 */
import type {
  AnchorReport,
  Diagnostic,
  DiagnosticCode,
  QuestionAnswer,
  QuestionName,
  QuestionStatus,
  ReceiptVerifyStage,
  RootName,
  StageRow,
  StageStatus,
  TrustQuestions,
  VerifierIdentity,
  VerifyResult,
} from "@forestrie/mcp-verify";
import type { COURIER } from "./version.js";
import type { COURIER_DIAGNOSTIC_CODES } from "./provenance.js";

// Re-exports of the verifier's result types this package exposes.
export type {
  AnchorReport,
  Diagnostic,
  DiagnosticCode,
  QuestionAnswer,
  QuestionName,
  QuestionStatus,
  ReceiptVerifyStage,
  RootName,
  StageRow,
  StageStatus,
  TrustQuestions,
  VerifierIdentity,
  VerifyResult,
};

/**
 * A courier diagnostic code: not a member of the verifier's closed
 * `DiagnosticCode` union, but shaped exactly like its `Diagnostic` type
 * (`{ code, message }`). See `provenance.ts`'s `COURIER_DIAGNOSTIC_CODES`.
 */
export type CourierDiagnosticCode = (typeof COURIER_DIAGNOSTIC_CODES)[number];

export type CourierDiagnostic = {
  code: CourierDiagnosticCode;
  message: string;
};

/**
 * The tool result this package returns: the verifier's `VerifyResult`
 * fields (`ok`, `root`, `stage`, `reason`, `stages`, `anchor`, `questions`)
 * untouched, `diagnostics` widened to admit the courier's appended codes,
 * and `courier` naming this package + the verifier it ran, alongside.
 */
export type FetchedVerifyResult = Omit<VerifyResult, "diagnostics"> & {
  diagnostics: Array<Diagnostic | CourierDiagnostic>;
  courier: typeof COURIER;
};
