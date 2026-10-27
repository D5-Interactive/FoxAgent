/*
 * Static pack registry. Every id in packs/index.json must appear here.
 * Static imports keep the extension free of dynamic code loading, which both
 * the security model and web-ext lint require.
 */

import * as canvas from "./canvas/tools.js";
import * as gmail from "./gmail/tools.js";
import * as outlook from "./outlook/tools.js";
import * as gdrive from "./gdrive/tools.js";

export const PACK_MODULES = { canvas, gmail, outlook, gdrive };
