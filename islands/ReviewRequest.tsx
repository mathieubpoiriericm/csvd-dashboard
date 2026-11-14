/**
 * The demonstration account request: a button and the dialog it opens.
 *
 * The form is a demonstration: it checks what is typed with the browser's own
 * validation, then says nothing was sent, and nothing was. It stands on the
 * previews hub, where the committee's way in is explained.
 *
 * **This island holds no data and imports none**, and `DATA_FREE_ISLANDS` in
 * `server/protected_data_build.ts` fails the build if it ever reaches a
 * protected chunk.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import { useModal } from "../components/useModal.ts";
import {
  REQUEST_DEMO,
  REQUEST_NOTICE,
  REQUEST_OPEN,
  REQUEST_SUBMIT,
  REQUEST_TITLE,
} from "../lib/review/copy.ts";

const REQUEST_FORM_ID = "review-request-form";

export default function ReviewRequest() {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  // The server's HTML cannot act on a press, so the button is disabled until
  // this island is live, as the About page's preview switch is.
  const [live, setLive] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const notice = useRef<HTMLParagraphElement>(null);

  useEffect(() => setLive(true), []);

  // The form is replaced by the notice, and focus goes onto the notice, so
  // what a screen reader says next is that nothing was sent. On the Close
  // button it said "Close", which is what a request that went sounds like.
  useLayoutEffect(() => {
    if (sent) notice.current?.focus();
  }, [sent]);

  // Closing the request dialog, by its button or by Escape, starts it over.
  const close = () => {
    form.current?.reset();
    setSent(false);
    setOpen(false);
  };
  const request = useModal(open, close);

  // Nothing leaves the page: the browser checks the fields, then the form
  // gives way to the notice that says nothing was sent.
  const submit = (event: Event) => {
    event.preventDefault();
    if (!(event.currentTarget as HTMLFormElement).reportValidity()) return;
    setSent(true);
  };

  return (
    <>
      <button
        type="button"
        class="review-action"
        aria-haspopup="dialog"
        disabled={!live}
        onClick={() => setOpen(true)}
      >
        {REQUEST_OPEN}
      </button>
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
            onClick={close}
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
  );
}
