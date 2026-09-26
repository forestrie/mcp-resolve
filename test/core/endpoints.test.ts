import { describe, expect, it } from "vitest";
import {
  EndpointError,
  LOG_STATE_SELECTOR,
  genesisUrl,
  logStateCalldata,
  normalizeAddress,
  receiptUrl,
  registrationStatusUrl,
  scittConfigurationUrl,
  toContractLogId,
  toScrapiLogId,
} from "../../src/core/index.js";

describe("scittConfigurationUrl", () => {
  it("builds the well-known route", () => {
    expect(scittConfigurationUrl("https://api-a.forest-2.forestrie.dev")).toBe(
      "https://api-a.forest-2.forestrie.dev/.well-known/scitt-configuration",
    );
  });

  it("trims exactly one trailing slash", () => {
    expect(scittConfigurationUrl("https://example.com/")).toBe(
      "https://example.com/.well-known/scitt-configuration",
    );
    // Only one trailing slash is trimmed, never two.
    expect(scittConfigurationUrl("https://example.com//")).toBe(
      "https://example.com//.well-known/scitt-configuration",
    );
  });

  it("rejects an empty baseUrl", () => {
    expect(() => scittConfigurationUrl("")).toThrow(EndpointError);
  });

  it("rejects a non-http(s) baseUrl", () => {
    expect(() => scittConfigurationUrl("ftp://example.com")).toThrow(
      EndpointError,
    );
    expect(() => scittConfigurationUrl("example.com")).toThrow(EndpointError);
  });

  it("accepts http as well as https", () => {
    expect(scittConfigurationUrl("http://localhost:8787")).toBe(
      "http://localhost:8787/.well-known/scitt-configuration",
    );
  });
});

const BOOT = "67876864-3b46-67ae-dcb3-13cc81624aa5";
const LOG = "e8345800-a747-4e62-9409-61622b836f1f";
/** The same publications log in the 64-hex contract form a caller holds
 *  after decoding a genesis document — the form the operator rejects in a
 *  path with HTTP 400 "Invalid log-id in path". */
const LOG_CONTRACT_HEX = `0x${"0".repeat(32)}e8345800a7474e62940961622b836f1f`;

describe("toScrapiLogId", () => {
  it("passes a lowercase dashed UUID through", () => {
    expect(toScrapiLogId(LOG)).toBe(LOG);
  });

  it("normalises 32-hex, 64-hex (with or without 0x) and mixed case to the UUID", () => {
    expect(toScrapiLogId("e8345800a7474e62940961622b836f1f")).toBe(LOG);
    expect(toScrapiLogId(LOG_CONTRACT_HEX)).toBe(LOG);
    expect(toScrapiLogId(LOG_CONTRACT_HEX.slice(2))).toBe(LOG);
    expect(toScrapiLogId("E8345800-A747-4E62-9409-61622B836F1F")).toBe(LOG);
  });

  it("rejects anything else, naming the accepted forms", () => {
    expect(() => toScrapiLogId("boot-log")).toThrow(EndpointError);
    expect(() => toScrapiLogId("boot-log")).toThrow(
      /must be a UUID or 16\/32-byte hex id/,
    );
  });
});

describe("registrationStatusUrl", () => {
  it("builds the registration-status route", () => {
    expect(
      registrationStatusUrl("https://example.com", BOOT, LOG, "abcdef"),
    ).toBe(`https://example.com/logs/${BOOT}/${LOG}/entries/abcdef`);
  });

  it("sends a contract-form log id in UUID form, and rejects a non-id", () => {
    expect(
      registrationStatusUrl(
        "https://example.com",
        BOOT,
        LOG_CONTRACT_HEX,
        "abcdef",
      ),
    ).toBe(`https://example.com/logs/${BOOT}/${LOG}/entries/abcdef`);
    expect(() =>
      registrationStatusUrl("https://example.com", "boot/log", LOG, "a b"),
    ).toThrow(EndpointError);
  });

  it("encodeURIComponents the content-hash segment", () => {
    expect(
      registrationStatusUrl("https://example.com", BOOT, LOG, "a b"),
    ).toBe(`https://example.com/logs/${BOOT}/${LOG}/entries/a%20b`);
  });
});

describe("receiptUrl", () => {
  it("builds the resolve-receipt route with the massif height segment", () => {
    const entryIdHex = "0123456789abcdef0123456789abcdef";
    expect(receiptUrl("https://example.com", BOOT, LOG, 3, entryIdHex)).toBe(
      `https://example.com/logs/${BOOT}/${LOG}/3/entries/${entryIdHex}/receipt`,
    );
  });

  it("sends a contract-form log id in UUID form", () => {
    const entryIdHex = "0123456789abcdef0123456789abcdef";
    expect(
      receiptUrl(
        "https://example.com",
        BOOT,
        LOG_CONTRACT_HEX,
        14,
        entryIdHex,
      ),
    ).toBe(
      `https://example.com/logs/${BOOT}/${LOG}/14/entries/${entryIdHex}/receipt`,
    );
  });

  it("encodes the entryId segment", () => {
    const url = receiptUrl("https://example.com", BOOT, LOG, 0, "x y");
    expect(url).toBe(
      `https://example.com/logs/${BOOT}/${LOG}/0/entries/x%20y/receipt`,
    );
  });
});

describe("genesisUrl", () => {
  it("builds the forest genesis route", () => {
    expect(genesisUrl("https://example.com", BOOT)).toBe(
      `https://example.com/api/forest/${BOOT}/genesis`,
    );
  });

  it("sends a contract-form log id in UUID form, and rejects a non-id", () => {
    expect(genesisUrl("https://example.com", LOG_CONTRACT_HEX)).toBe(
      `https://example.com/api/forest/${LOG}/genesis`,
    );
    expect(() => genesisUrl("https://example.com", "a/b")).toThrow(
      EndpointError,
    );
  });
});

describe("toContractLogId", () => {
  it("accepts a dashed UUID", () => {
    expect(toContractLogId("660e8400-e29b-41d4-a716-446655440001")).toBe(
      `0x${"660e8400e29b41d4a716446655440001".padStart(64, "0")}`,
    );
  });

  it("accepts 32-hex (no dashes)", () => {
    expect(toContractLogId("660e8400e29b41d4a716446655440001")).toBe(
      `0x${"660e8400e29b41d4a716446655440001".padStart(64, "0")}`,
    );
  });

  it("accepts 64-hex, already contract-shaped", () => {
    const full = "660e8400e29b41d4a716446655440001".padStart(64, "0");
    expect(toContractLogId(full)).toBe(`0x${full}`);
    expect(toContractLogId(`0x${full}`)).toBe(`0x${full}`);
  });

  it("lowercases mixed-case input", () => {
    expect(toContractLogId("660E8400-E29B-41D4-A716-446655440001")).toBe(
      `0x${"660e8400e29b41d4a716446655440001".padStart(64, "0")}`,
    );
  });

  it("rejects anything else", () => {
    expect(() => toContractLogId("not-a-log-id")).toThrow(EndpointError);
    expect(() => toContractLogId("abc")).toThrow(EndpointError);
  });
});

describe("logStateCalldata", () => {
  it("equals the selector plus 64 hex chars", () => {
    const logId = "660e8400-e29b-41d4-a716-446655440001";
    const calldata = logStateCalldata(logId);
    expect(calldata.startsWith(LOG_STATE_SELECTOR)).toBe(true);
    expect(calldata).toBe(
      LOG_STATE_SELECTOR +
        "660e8400e29b41d4a716446655440001".padStart(64, "0"),
    );
    expect(calldata.length).toBe(LOG_STATE_SELECTOR.length + 64);
    expect(/^0xeecac1b7[0-9a-f]{64}$/.test(calldata)).toBe(true);
  });
});

describe("normalizeAddress", () => {
  it("accepts a 0x-prefixed address and lowercases it", () => {
    expect(
      normalizeAddress("0x678768643B4667aEDcB313cC81624aA560b7f0Ca"),
    ).toBe("0x678768643b4667aedcb313cc81624aa560b7f0ca");
  });

  it("accepts a bare 40-hex address", () => {
    expect(normalizeAddress("678768643B4667aEDcB313cC81624aA560b7f0Ca")).toBe(
      "0x678768643b4667aedcb313cc81624aa560b7f0ca",
    );
  });

  it("throws on anything else", () => {
    expect(() => normalizeAddress("0x1234")).toThrow(EndpointError);
    expect(() => normalizeAddress("not-an-address")).toThrow(EndpointError);
  });
});
