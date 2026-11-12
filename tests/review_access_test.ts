import { assert, assertEquals } from "@std/assert";

import {
  hasObserverCookie,
  isReviewPath,
  observerCookie,
  REVIEW_COOKIE,
} from "../lib/review/access.ts";
import { observerEntered } from "../lib/review/access_request.ts";

Deno.test("the cookie remembers an observer for a year and forgets on leaving", () => {
  assertEquals(REVIEW_COOKIE, "review_observer");
  assertEquals(
    observerCookie(true),
    "review_observer=1; Path=/; Max-Age=31536000; SameSite=Lax",
  );
  assertEquals(
    observerCookie(false),
    "review_observer=; Path=/; Max-Age=0; SameSite=Lax",
  );
});

Deno.test("a review page counts as entered without the cookie", () => {
  assert(observerEntered(new Headers(), "/review/progress"));
  assert(observerEntered(new Headers(), "/review"));
  assert(!observerEntered(new Headers(), "/genes"));
  assert(
    observerEntered(new Headers({ cookie: "review_observer=1" }), "/genes"),
  );
  assert(
    observerEntered(
      new Headers({ cookie: "other=1; review_observer=1" }),
      "/",
    ),
  );
  assert(
    !observerEntered(new Headers({ cookie: "review_observer=0" }), "/genes"),
  );
  assert(!observerEntered(new Headers({ cookie: "review_observer=" }), "/"));
});

Deno.test("only /review and the pages under it are review paths", () => {
  assert(isReviewPath("/review"));
  assert(isReviewPath("/review/"));
  assert(isReviewPath("/review/gene"));
  assert(!isReviewPath("/reviewers"));
  assert(!isReviewPath("/"));
  assert(!isReviewPath("/genes/review"));
});

Deno.test("the browser's cookie string says whether the observer is remembered", () => {
  // The island reads `document.cookie` on a deep link: entered by the path,
  // it writes the cookie only when it is not already there.
  assert(hasObserverCookie("review_observer=1"));
  assert(hasObserverCookie("a=b; review_observer=1; c=d"));
  assert(!hasObserverCookie(""));
  assert(!hasObserverCookie("review_observer="));
  assert(!hasObserverCookie("review_observer=10"));
  assert(!hasObserverCookie("x_review_observer=1"));
});
