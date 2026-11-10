import { handleCreate } from "../../../server/adapt_session_api.ts";
import { sessionStore } from "../../../server/adapt_sessions.ts";
import { define } from "../../../utils.ts";

/** POST only: the code, when there is one, travels in the body. */
export const handler = define.handlers({
  POST: (ctx) => handleCreate(ctx.req, sessionStore()),
});
