/** Type declaration for `generate.mjs` (a plain, dependency-free Node
 *  script — not part of the package's own TS build) so
 *  `test/core/synthetic-history-fixture.test.ts` can import it typed. */
export declare function generate(outDir: string): {
  outDir: string;
  files: string[];
};
