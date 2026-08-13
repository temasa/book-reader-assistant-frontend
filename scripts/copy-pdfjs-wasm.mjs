// pdf.js's JPX (JPEG2000) image decoder and its ICC color-space conversion need
// their wasm modules served as plain static files at a known URL (the `wasmUrl`
// option passed to <Document>) -- Turbopack's `new URL(..., import.meta.url)`
// asset pipeline only handles single-file references, not a whole directory of
// originally-named files fetched at runtime, so those files are copied into
// public/ instead. Regenerated from node_modules on every dev/build (not
// committed) so it can never drift from the installed pdfjs-dist version.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "node_modules", "pdfjs-dist", "wasm");
const dest = join(here, "..", "public", "pdfjs-wasm");

mkdirSync(dest, { recursive: true });
for (const name of [
  "openjpeg.wasm",
  "openjpeg_nowasm_fallback.js",
  "qcms_bg.wasm",
  "LICENSE_OPENJPEG",
  "LICENSE_QCMS",
]) {
  cpSync(join(src, name), join(dest, name));
}
