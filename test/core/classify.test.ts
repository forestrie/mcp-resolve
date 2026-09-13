import {
  encodeProblemDetailsCbor,
  type ProblemDetail,
} from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
import { classify } from "../../src/core/index.js";

const BASE_URL = "https://api-a.forest-2.forestrie.dev";

function textBody(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function problemBody(fields: ProblemDetail): Uint8Array {
  return encodeProblemDetailsCbor(fields);
}

describe("classify", () => {
  it("configuration: 2xx JSON body", () => {
    const json = { serviceId: "canopy-dev-1", baseUrl: BASE_URL };
    const result = classify(
      "configuration",
      { status: 200, body: textBody(JSON.stringify(json)) },
      BASE_URL,
    );
    expect(result).toEqual({ kind: "configuration", json });
  });

  it("configuration: a non-JSON 2xx body is a problem", () => {
    const result = classify(
      "configuration",
      { status: 200, body: textBody("not json") },
      BASE_URL,
    );
    expect(result.kind).toBe("problem");
  });

  it("registration: 303 pending, no Retry-After", () => {
    const location = "/logs/boot/log-1/entries/abcdef?poll=1";
    const result = classify(
      "registration",
      { status: 303, location, body: new Uint8Array() },
      BASE_URL,
    );
    expect(result).toEqual({
      kind: "pending",
      location: `${BASE_URL}${location}`,
    });
  });

  it("registration: 303 pending, with Retry-After", () => {
    const location = "/logs/boot/log-1/entries/abcdef?poll=1";
    const result = classify(
      "registration",
      {
        status: 303,
        location,
        retryAfter: "5",
        body: new Uint8Array(),
      },
      BASE_URL,
    );
    expect(result).toEqual({
      kind: "pending",
      location: `${BASE_URL}${location}`,
      retryAfterMs: 5000,
    });
  });

  it("registration: 303 to a receipt Location", () => {
    const location =
      "/logs/boot/log-1/3/entries/02020202020202020000000000000001/receipt";
    const result = classify(
      "registration",
      { status: 303, location, body: new Uint8Array() },
      BASE_URL,
    );
    expect(result).toEqual({
      kind: "receipt-location",
      receiptUrl: `${BASE_URL}${location}`,
      entryIdHex: "02020202020202020000000000000001",
    });
  });

  it("registration: 303 without Location is a problem", () => {
    const result = classify(
      "registration",
      { status: 303, body: new Uint8Array() },
      BASE_URL,
    );
    expect(result).toEqual({
      kind: "problem",
      status: 303,
      detail: "303 without Location",
    });
  });

  it("receipt: 200 returns the bytes", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = classify("receipt", { status: 200, body: bytes }, BASE_URL);
    expect(result).toEqual({ kind: "receipt", bytes });
  });

  it("receipt: 404 is pending (still writing)", () => {
    const receiptUrl = `${BASE_URL}/logs/boot/log-1/3/entries/abc/receipt`;
    const result = classify(
      "receipt",
      { status: 404, location: receiptUrl, body: new Uint8Array() },
      BASE_URL,
    );
    expect(result).toEqual({ kind: "pending", location: receiptUrl });
  });

  it("genesis: 200 returns the bytes", () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const result = classify("genesis", { status: 200, body: bytes }, BASE_URL);
    expect(result).toEqual({ kind: "genesis", bytes });
  });

  it("genesis: 404 is a problem", () => {
    const result = classify(
      "genesis",
      { status: 404, body: new Uint8Array() },
      BASE_URL,
    );
    expect(result.kind).toBe("problem");
  });

  it("429 without Retry-After is a problem, on any route", () => {
    const result = classify(
      "receipt",
      { status: 429, body: new Uint8Array() },
      BASE_URL,
    );
    expect(result).toEqual({
      kind: "problem",
      status: 429,
      detail: "(empty body)",
    });
  });

  it("429 with Retry-After carries retryAfterMs", () => {
    const result = classify(
      "genesis",
      { status: 429, retryAfter: "30", body: new Uint8Array() },
      BASE_URL,
    );
    expect(result).toEqual({
      kind: "problem",
      status: 429,
      retryAfterMs: 30_000,
      detail: "(empty body)",
    });
  });

  it("decodes an application/problem+cbor body", () => {
    const body = problemBody({
      title: "Too Many Requests",
      status: 429,
      detail: "quota exceeded",
    });
    const result = classify(
      "receipt",
      {
        status: 429,
        contentType: "application/problem+cbor",
        body,
      },
      BASE_URL,
    );
    expect(result.kind).toBe("problem");
    if (result.kind !== "problem") throw new Error("unreachable");
    expect(result.detail).toBe("quota exceeded");
    expect(result.problem).toMatchObject({
      title: "Too Many Requests",
      status: 429,
      detail: "quota exceeded",
    });
  });

  it("falls back to a 200-char body preview when there is no problem body", () => {
    const text = "server exploded";
    const result = classify(
      "genesis",
      { status: 500, body: textBody(text) },
      BASE_URL,
    );
    expect(result).toEqual({ kind: "problem", status: 500, detail: text });
  });

  it("falls back to '(empty body)' for an empty non-problem body", () => {
    const result = classify(
      "genesis",
      { status: 500, body: new Uint8Array() },
      BASE_URL,
    );
    expect(result).toEqual({
      kind: "problem",
      status: 500,
      detail: "(empty body)",
    });
  });
});
