import { App, csrf, staticFiles } from "fresh";

import { compression } from "./server/compression.ts";
import { frameProtection } from "./server/frame_protection.ts";
import { loginPostLimiter } from "./server/login_post_limiter.ts";
import { protectDataAssets } from "./server/protected_data_assets.ts";
import type { State } from "./utils.ts";

export const app = new App<State>();

// The outer policy reaches static files, route responses, and early denials. The
// protected-data matcher must run before staticFiles(), which otherwise serves
// immutable assets immediately; every other asset stays public for /login.
// Outermost, so it also covers the protected-data chunk that the next
// middleware rewrites and the denials that never reach file routing. Nothing
// compressed before this: staticFiles() serves the built bundles verbatim.
app.use(compression());
app.use(frameProtection());
app.use(protectDataAssets());
app.use(staticFiles());
// Reject cross-site writes before they consume a rate-limit reservation. The
// limiter then reserves atomically before POST /login verifies the passphrase.
app.use(csrf());
app.use(loginPostLimiter());
app.fsRoutes();
