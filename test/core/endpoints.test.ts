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

describe("registrationStatusUrl", () => {
  it("builds the registration-status route", () => {
    expect(
      registrationStatusUrl(
        "https://example.com",
        "boot-log",
        "log-1",
        "abcdef",
      ),
    ).toBe("https://example.com/logs/boot-log/log-1/entries/abcdef");
  });

  it("encodeURIComponents every dynamic segment", () => {
    expect(
      registrationStatusUrl("https://example.com", "boot/log", "log 1", "a b"),
    ).toBe("https://example.com/logs/boot%2Flog/log%201/entries/a%20b");
  });
});

describe("receiptUrl", () => {
  it("builds the resolve-receipt route with the massif height segment", () => {
    const entryIdHex = "02020202020202020000000000000001";
    expect(
      receiptUrl("https://example.com", "boot-log", "log-1", 3, entryIdHex),
    ).toBe(
      `https://example.com/logs/boot-log/log-1/3/entries/${entryIdHex}/receipt`,
    );
  });

  it("encodes the entryId segment", () => {
    const url = receiptUrl(
      "https://example.com/",
      "boot log",
      "log/1",
      42,
      "deadbeef",
    );
    expect(url).toBe(
      "https://example.com/logs/boot%20log/log%2F1/42/entries/deadbeef/receipt",
    );
  });
});

describe("genesisUrl", () => {
  it("builds the forest genesis route", () => {
    expect(genesisUrl("https://example.com", "log-1")).toBe(
      "https://example.com/api/forest/log-1/genesis",
    );
  });

  it("encodes the logId segment", () => {
    expect(genesisUrl("https://example.com", "a/b")).toBe(
      "https://example.com/api/forest/a%2Fb/genesis",
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
