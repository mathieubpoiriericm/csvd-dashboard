import { createDefine } from "fresh";

/**
 * Per-request state shared between the gate in routes/_middleware.ts and
 * the pages. `authenticated` is set only after a valid session cookie was
 * verified; the shell reads it to decide whether to offer "Sign out".
 */
export interface State {
  authenticated?: boolean;
}

export const define = createDefine<State>();
