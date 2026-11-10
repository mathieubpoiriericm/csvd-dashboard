import { handleCreate } from "../../../server/adapt_session_api.ts";
import { sessionHolder } from "../../../server/adapt_session_holder.ts";
import { sessionStore } from "../../../server/adapt_sessions.ts";
import {
  CLIENT_IP_HEADER_VAR,
  clientKeyOf,
} from "../../../server/login_post_limiter.ts";
import { define } from "../../../utils.ts";

/**
 * POST only: the code, when there is one, travels in the body. The client is
 * keyed exactly as the limiters key it, for the per-connection session cap.
 */
export const handler = define.handlers({
  POST: (ctx) =>
    handleCreate(ctx.req, sessionStore(), sessionHolder(), {
      clientKey: clientKeyOf(ctx, Deno.env.get(CLIENT_IP_HEADER_VAR)),
    }),
});
