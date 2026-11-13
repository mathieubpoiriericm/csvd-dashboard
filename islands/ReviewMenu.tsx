/**
 * The navbar's Review control: the way into the scientific review area.
 *
 * A button and its menu. Signed out, the menu offers a log-in dialog whose one
 * action is to enter as an observer (member sign-in opens once the committee
 * is formed) and an account-request form that is a demonstration: it checks
 * what is typed with the browser's own validation, then says nothing was
 * sent, and nothing was. Entered, the button says so and the menu links the
 * review queue and the committee's progress, and leaves.
 *
 * **This island holds no data and imports none.** It is in the navbar of every
 * page while a review exists, so a static import of the round or of a dataset
 * would put it on every visit; `DATA_FREE_ISLANDS` in
 * `server/protected_data_build.ts` fails the build if it ever reaches a
 * protected chunk. The route decides whether it renders at all and hands it
 * one boolean. Entering is the cookie `lib/review/access.ts` writes, which the
 * shell reads on the next request (`lib/review/access_request.ts`).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import { Icon } from "../components/Icon.tsx";
import { useEscapeKey } from "../components/useEscapeKey.ts";
import { useModal } from "../components/useModal.ts";
import { hasObserverCookie, observerCookie } from "../lib/review/access.ts";
import {
  CONTROL,
  CONTROL_ENTERED,
  ENTER_OBSERVER,
  LOGIN_BODY,
  LOGIN_TITLE,
  MENU_LEAVE,
  MENU_LOG_IN,
  MENU_PROGRESS,
  MENU_QUEUE,
  MENU_REQUEST,
  REQUEST_DEMO,
  REQUEST_NOTICE,
  REQUEST_SUBMIT,
  REQUEST_TITLE,
} from "../lib/review/copy.ts";

interface ReviewMenuProps {
  /** In the review area: the observer cookie is set, or this is a review page. */
  entered: boolean;
}

type Dialog = "login" | "request";

const MENU_ID = "review-menu";
const REQUEST_FORM_ID = "review-request-form";

/** The menu's items, in order, for the arrow keys. */
function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return menu
    ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    : [];
}

export default function ReviewMenu({ entered }: ReviewMenuProps) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [sent, setSent] = useState(false);
  // The server's HTML cannot act on a press, so the button is disabled until
  // this island is live, as the About page's preview switch is.
  const [live, setLive] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const notice = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    setLive(true);
    // A deep link enters by its path alone; remembering it here keeps the
    // control saying "Observer" on the pages outside the area too.
    if (entered && !hasObserverCookie(document.cookie)) {
      document.cookie = observerCookie(true);
    }
  }, []);

  const closeMenu = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useEscapeKey(open, () => closeMenu(true));

  // A press anywhere outside the control closes the menu. Subscribed as the
  // menu commits, not a frame later, so a press that quick is not missed.
  useLayoutEffect(() => {
    if (!open) return;
    const pressed = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) closeMenu(false);
    };
    document.addEventListener("pointerdown", pressed);
    return () => document.removeEventListener("pointerdown", pressed);
  }, [open]);

  // Opening the menu moves focus to its first item, as a menu button does.
  useLayoutEffect(() => {
    if (open) menuItems(menu.current)[0]?.focus();
  }, [open]);

  // The form is replaced by the notice, and focus goes onto the notice, so
  // what a screen reader says next is that nothing was sent. On the Close
  // button it said "Close", which is what a request that went sounds like.
  useLayoutEffect(() => {
    if (sent) notice.current?.focus();
  }, [sent]);

  const onMenuKey = (event: KeyboardEvent) => {
    const items = menuItems(menu.current);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step: Record<string, number> = {
      ArrowDown: (at + 1) % items.length,
      ArrowUp: (at - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    };
    if (event.key in step) {
      event.preventDefault();
      items[step[event.key]]?.focus();
    } else if (event.key === "Tab") {
      closeMenu(false);
    }
  };

  const show = (which: Dialog) => {
    // Focus goes back to the button first: the dialog returns focus to what
    // had it when it opened, and the menu item is about to be hidden.
    closeMenu(true);
    setDialog(which);
  };

  const closeLogin = () => setDialog(null);
  // Closing the request dialog, by its button or by Escape, starts it over.
  const closeRequest = () => {
    form.current?.reset();
    setSent(false);
    setDialog(null);
  };
  const label = entered ? CONTROL_ENTERED : CONTROL;
  const login = useModal(dialog === "login", closeLogin);
  const request = useModal(dialog === "request", closeRequest);

  const enter = () => {
    document.cookie = observerCookie(true);
    location.assign("/review");
  };

  const leave = () => {
    document.cookie = observerCookie(false);
    location.assign("/");
  };

  // Nothing leaves the page: the browser checks the fields, then the form
  // gives way to the notice that says nothing was sent.
  const submit = (event: Event) => {
    event.preventDefault();
    if (!(event.currentTarget as HTMLFormElement).reportValidity()) return;
    setSent(true);
  };

  return (
    <div class="review-control" ref={root}>
      {
        /* `aria-expanded` as a string: the server renderer drops an aria
          attribute whose value is boolean `false` (islands/CLAUDE.md). */
      }
      <button
        type="button"
        class="review-button"
        ref={button}
        aria-haspopup="menu"
        aria-expanded={open ? "true" : "false"}
        aria-controls={MENU_ID}
        aria-label={label}
        disabled={!live}
        // From the state, not `open`: a press straight after an outside
        // press arrives before the render that closed the menu.
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="checkBadge" />
        {
          /* Entered, a dot on the glyph says so where the label is gone:
            below 600px the bar has room for the glyph alone. */
        }
        {entered && <span class="review-button-marker" aria-hidden="true" />}
        <span class="review-button-label">{label}</span>
        <span class="review-button-caret">
          <Icon name="chevronDown" />
        </span>
      </button>
      <ul
        id={MENU_ID}
        class="review-menu"
        role="menu"
        aria-label={CONTROL}
        ref={menu}
        hidden={!open}
        onKeyDown={onMenuKey}
      >
        {entered
          ? (
            <>
              <li role="none">
                <a role="menuitem" class="review-menu-item" href="/review">
                  {MENU_QUEUE}
                </a>
              </li>
              <li role="none">
                <a
                  role="menuitem"
                  class="review-menu-item"
                  href="/review/progress"
                >
                  {MENU_PROGRESS}
                </a>
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  class="review-menu-item"
                  onClick={leave}
                >
                  {MENU_LEAVE}
                </button>
              </li>
            </>
          )
          : (
            <>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  class="review-menu-item"
                  onClick={() => show("login")}
                >
                  {MENU_LOG_IN}
                </button>
              </li>
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  class="review-menu-item"
                  onClick={() => show("request")}
                >
                  {MENU_REQUEST}
                </button>
              </li>
            </>
          )}
      </ul>
      {!entered && (
        <>
          <dialog
            ref={login}
            class="review-dialog"
            aria-labelledby="review-login-title"
          >
            <h2 id="review-login-title" class="review-dialog-title">
              {LOGIN_TITLE}
            </h2>
            <p>{LOGIN_BODY}</p>
            <div class="review-dialog-actions">
              <button type="button" class="review-action" onClick={closeLogin}>
                Close
              </button>
              <button
                type="button"
                class="review-action review-action-primary"
                onClick={enter}
              >
                {ENTER_OBSERVER}
              </button>
            </div>
          </dialog>
          <dialog
            ref={request}
            class="review-dialog"
            aria-labelledby="review-request-title"
            aria-describedby="review-request-demo"
          >
            <h2 id="review-request-title" class="review-dialog-title">
              {REQUEST_TITLE}
            </h2>
            {/* The dialog's description: showModal() focuses the first field. */}
            <p id="review-request-demo" class="review-demo">{REQUEST_DEMO}</p>
            {
              /* No action and no method: the form is never submitted
                anywhere. `submit` stops it and shows the notice. */
            }
            <form
              id={REQUEST_FORM_ID}
              class="review-form"
              ref={form}
              hidden={sent}
              onSubmit={submit}
            >
              <label for="review-request-name">Full name</label>
              <input
                id="review-request-name"
                name="name"
                autocomplete="name"
                required
              />
              <label for="review-request-email">Email address</label>
              <input
                id="review-request-email"
                name="email"
                type="email"
                autocomplete="email"
                required
              />
              <label for="review-request-affiliation">Affiliation</label>
              <input
                id="review-request-affiliation"
                name="affiliation"
                autocomplete="organization"
                required
              />
              <label for="review-request-expertise">Area of expertise</label>
              <input
                id="review-request-expertise"
                name="expertise"
                required
              />
              <label for="review-request-type">Account type</label>
              <select id="review-request-type" name="type" required>
                <option value="member">Voting member</option>
                <option value="observer">Observer</option>
              </select>
              <label for="review-request-note">
                Anything the administrator should know (optional)
              </label>
              <textarea id="review-request-note" name="note" rows={3} />
            </form>
            {
              /* Drawn empty from the start: a live region that arrives with
                its text is often not announced. */
            }
            <p
              id="review-request-sent"
              class="review-sent"
              role="status"
              tabIndex={-1}
              ref={notice}
            >
              {sent ? REQUEST_NOTICE : ""}
            </p>
            <div class="review-dialog-actions">
              <button
                type="button"
                class="review-action"
                onClick={closeRequest}
              >
                Close
              </button>
              {!sent && (
                <button
                  type="submit"
                  form={REQUEST_FORM_ID}
                  class="review-action review-action-primary"
                >
                  {REQUEST_SUBMIT}
                </button>
              )}
            </div>
          </dialog>
        </>
      )}
    </div>
  );
}
