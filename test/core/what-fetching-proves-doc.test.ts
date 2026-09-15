/**
 * docs/what-fetching-proves.md quotes the `supports` notes and the courier
 * diagnostic messages word for word. This keeps the doc and the package in
 * step: every quoted block must be a string the package emits, and every
 * `supports` note must be quoted.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUPPORTS } from "../../src/core/index.js";

const repoRoot = new URL("../../", import.meta.url).pathname;
const read = (file: string): string =>
  readFileSync(`${repoRoot}${file}`, "utf8");
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const notes = Object.values(SUPPORTS).map((entry) => entry.note);
const diagnosticMessages = [
  ...read("src/core/compose.ts").matchAll(/message:\s*"([^"]+)"/g),
].map((match) => match[1]!);
const emitted = new Set([...notes, ...diagnosticMessages]);

const quotes = (
  read("docs/what-fetching-proves.md").match(/(?:^> .*\n)+/gm) ?? []
).map((block) => oneLine(block.replace(/^> /gm, "")));

describe("docs/what-fetching-proves.md", () => {
  it("quotes at least one emitted string", () => {
    expect(quotes.length).toBeGreaterThan(0);
  });

  it.each(quotes)("quotes an emitted string exactly: %s", (quote) => {
    expect(emitted.has(quote)).toBe(true);
  });

  it.each(notes)("quotes the supports note: %s", (note) => {
    expect(quotes).toContain(note);
  });
});
