import { define } from "../utils.ts";
import { logoutResponse } from "../lib/auth.ts";

/**
 * POST only, so a cross-site link cannot sign someone out and csrf() in
 * main.ts guards the form. There is no page here: the response is a
 * redirect to /login with the cookie cleared.
 */
export const handler = define.handlers({
  POST() {
    return logoutResponse();
  },
});
