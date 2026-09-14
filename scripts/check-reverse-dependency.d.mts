/**
 * Hand-written type declaration for check-reverse-dependency.mjs, so
 * test/node/check-reverse-dependency.test.ts can import the pure function
 * under `tsc --noEmit` (moduleResolution: "bundler" resolves a relative
 * `.mjs` import against a sibling `.d.mts`, same as @forestrie/mcp-verify's
 * own scripts do).
 */
export declare function findMcpResolveCopies(
  rootDir: string,
  maxDepth?: number,
): string[];
