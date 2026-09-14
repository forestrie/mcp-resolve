/** Type declaration for `generate.mjs` (a plain, dependency-free Node
 *  script importing only `@forestrie/encoding` and `node:*` — not part of
 *  the package's own TS build) so `test/core/grant-leaf.test.ts` can
 *  import it typed. */
export declare function generate(outDir: string): Promise<{
  outDir: string;
  files: string[];
  protectedMapBytes: Uint8Array;
  unprotected: Map<number, unknown>;
  payload: Uint8Array;
  coseBytes: Uint8Array;
  jwk: Record<string, unknown>;
}>;
