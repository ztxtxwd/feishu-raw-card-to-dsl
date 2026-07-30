// Assemble the CommonJS artifact after the two tsc passes.
//
// tsc (ESM pass)  -> dist/index.js   + dist/index.d.ts   (the package's ESM entry)
// tsc (CJS pass)  -> dist/cjs/index.js                   (CommonJS, temp location)
//
// Node picks a module format by file extension OR by the nearest package.json
// "type". Since this package is "type":"module", a bare dist/cjs/index.js would
// still be treated as ESM. So we:
//   1. move dist/cjs/index.js -> dist/index.cjs (the .cjs ext forces CommonJS),
//   2. copy dist/index.d.ts   -> dist/index.d.cts (types for the require path),
//   3. remove the now-empty dist/cjs/.
//
// Result: dist/index.js (ESM), dist/index.cjs (CJS), dist/index.d.ts +
// dist/index.d.cts — exactly the dual-format layout package.json "exports"
// declares.

import { copyFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

const cjsBuilt = join(dist, "cjs", "index.js");
if (!existsSync(cjsBuilt)) {
  console.error("[finalize-cjs] missing", cjsBuilt, "— did the CJS tsc pass run?");
  process.exit(1);
}

renameSync(cjsBuilt, join(dist, "index.cjs"));
copyFileSync(join(dist, "index.d.ts"), join(dist, "index.d.cts"));
rmSync(join(dist, "cjs"), { recursive: true, force: true });

console.log("[finalize-cjs] wrote dist/index.cjs + dist/index.d.cts");
