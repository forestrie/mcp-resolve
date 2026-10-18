import { describe, expect, it } from "vitest";
import { erc1271MagicFromReturn } from "../../src/core/index.js";

const MAGIC = "1626ba7e";
const WORD = `0x${MAGIC}${"00".repeat(28)}`;

describe("erc1271MagicFromReturn", () => {
  it("accepts exactly one 32-byte word, magic then 28 zero bytes", () => {
    expect(Buffer.from(erc1271MagicFromReturn(WORD)!).toString("hex")).toBe(
      MAGIC,
    );
    expect(
      erc1271MagicFromReturn(WORD.toUpperCase().replace("0X", "0x")),
    ).toBeDefined();
  });

  it.each([
    ["empty", "0x"],
    ["the bare selector", `0x${MAGIC}`],
    ["a short word", `0x${MAGIC}${"00".repeat(27)}`],
    ["dirty padding", `0x${MAGIC}${"00".repeat(27)}01`],
    ["magic word plus an extra word", `${WORD}${"00".repeat(32)}`],
    ["odd length", `${WORD}0`],
    ["not hex", `0x${MAGIC}${"zz".repeat(28)}`],
    ["right-aligned", `0x${"00".repeat(28)}${MAGIC}`],
    ["wrong value", `0x${"ff".repeat(32)}`],
  ])("refuses %s", (_name, value) => {
    expect(erc1271MagicFromReturn(value)).toBeUndefined();
  });
});
