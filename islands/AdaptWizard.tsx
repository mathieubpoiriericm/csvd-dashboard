import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import { saveDownload } from "../components/download.ts";
import { Stepper, type StepperStep } from "../components/adapt/Stepper.tsx";
import { GoldStep } from "../components/adapt/steps/GoldStep.tsx";
import { IdentityStep } from "../components/adapt/steps/IdentityStep.tsx";
import { MonogenicStep } from "../components/adapt/steps/MonogenicStep.tsx";
import { PromptStep } from "../components/adapt/steps/PromptStep.tsx";
import { ReviewStep } from "../components/adapt/steps/ReviewStep.tsx";
import { SearchStep } from "../components/adapt/steps/SearchStep.tsx";
import { TrialsStep } from "../components/adapt/steps/TrialsStep.tsx";
import { VocabularyStep } from "../components/adapt/steps/VocabularyStep.tsx";
import { WizardContext } from "../components/adapt/wizard_context.ts";
import {
  type Answers,
  DRAFT_STORAGE_KEY,
  EMPTY_ANSWERS,
  serialiseDraft,
} from "../lib/adapt/answers.ts";
import {
  ANSWERS_NAME,
  bundle,
  BUNDLE_NAME,
  exportText,
  holdsAnswers,
  IMPORT_BYTE_LIMIT,
  importText,
  zipBytes,
} from "../lib/adapt/bundle.ts";
import { cardStates, entryCard, firstOpenCard } from "../lib/adapt/cards.ts";
import {
  adoptDraft,
  discardKept,
  keepUnreadable,
  keptDrafts,
  LOGO_KEYS,
  type LogoSlot,
  readLogo,
  readStoredDraft,
  REPLACED_KEY,
  saveDraft,
  unreadableDownload,
  withoutLogos,
} from "../lib/adapt/draft_storage.ts";
import { spaced } from "../lib/adapt/edits.ts";
import {
  firstInPage,
  forgetRemoved,
  type Progress,
  progressOf,
  reveal,
  seenKey,
  stepRequired,
  stepState,
  targetField,
} from "../lib/adapt/feedback.ts";
import { redraftPrompt } from "../lib/adapt/prompt_redraft.ts";
import {
  issuesFor,
  STEP_LABELS,
  STEP_ORDER,
  type StepId,
  validate,
} from "../lib/adapt/validate.ts";

type ScreenId = StepId | "review";

/**
 * A refused write is the one failure the researcher has to hear about:
 * the wizard goes on working and every answer is still on screen, but
 * nothing of it survives the tab.
 */
const STORAGE_REFUSED =
  "This browser refused to save the draft, so closing the tab will lose it. Export your answers from the Review step before you close it.";

const UNREADABLE =
  "The draft saved in this browser was written by another version of the wizard, or is damaged, so it could not be read. It is kept aside rather than overwritten; download it to keep a copy.";

const UNREADABLE_UNKEPT =
  "The draft saved in this browser was written by another version of the wizard, or is damaged, so it could not be read, and the browser refused the room to keep a copy aside. Nothing is saved over it until you download it.";

/**
 * Once that download is taken: the saves it held back have resumed, over
 * the stored draft, and the copy this tab holds is the last one here.
 */
const UNREADABLE_RELEASED =
  "The draft saved in this browser was written by another version of the wizard, or is damaged, so it could not be read, and the browser refused the room to keep a copy aside. Now that you have taken its download, your answers are saved in its place; it can be downloaded again until this tab is closed.";

/** A later visit: the draft key reads again, and the copy is still there. */
const UNREADABLE_EARLIER =
  "A draft saved in this browser earlier could not be read by this version of the wizard, and is still kept aside. Download it to keep a copy; it takes room in this browser until you discard it.";

/**
 * Said with each of the four: the file is the one a researcher sends on,
 * so it leaves out what "Export answers" leaves out, and says so.
 */
const UNREADABLE_FILE = " The download leaves out the NCBI e-mail and API key.";

/** The nth kept draft's download; the first keeps the name it always had. */
const keptName = (n: number) =>
  n === 1 ? "adapt-draft-unreadable.json" : `adapt-draft-unreadable-${n}.json`;

/** A draft this build could not read, as a file for the researcher. */
function downloadUnreadable(name: string, text: string) {
  saveDownload(
    name,
    new TextEncoder().encode(unreadableDownload(text)),
    "application/json",
  );
}

/**
 * The answers to change, cloned but for the logos: a logo is replaced
 * whole, never written into, so the new answers share it rather than copy
 * a megabyte of base64 on every keystroke.
 */
function draftOf(answers: Answers): Answers {
  const next = structuredClone(withoutLogos(answers));
  next.identity.logoLight = answers.identity.logoLight;
  next.identity.logoDark = answers.identity.logoDark;
  return next;
}

/**
 * The nine-question interview as a form, with the lookups the skill runs
 * and a download of the disease/ folder it would write. Reads no data
 * file: it is the one island with nothing of the dataset in it.
 */
export default function AdaptWizard() {
  const [answers, setAnswers] = useState<Answers>(EMPTY_ANSWERS);
  const [current, setCurrent] = useState<ScreenId>("identity");
  // Each screen's status line: a lookup writes its own step's, so two
  // lookups on different steps cannot clear each other's line, and one
  // that lands while the researcher is on another step is still there on
  // their return. The one live region shows the current screen's.
  const [statuses, setStatuses] = useState<Partial<Record<ScreenId, string>>>(
    {},
  );
  const status = statuses[current] ?? "";
  // Whether the last save was refused. It is kept apart from the status
  // line, which every lookup rewrites when it finishes -- in the same tick
  // as the save its result triggers -- so a warning there would vanish
  // unread. Only a save that succeeds clears it; the ref lets the storage
  // listener, set up once, read it.
  const [unsaved, setUnsaved] = useState(false);
  const unsavedRef = useRef(false);
  // The drafts this build could not read, kept aside in storage until the
  // researcher discards them, and whether this load found one: read on
  // every load, because the first save makes the draft key readable again
  // and a copy offered only on the visit that kept it was stranded there.
  const [kept, setKept] = useState<readonly string[]>([]);
  const [found, setFound] = useState(false);
  // The stored draft that could not be copied aside, offered for as long as
  // the tab lives. While the ref is true it is still the only copy: no save
  // writes over it until it is downloaded. The ref is what `save`, called
  // inside state updaters, reads; `released` is the same fact as state, so
  // the notice stops saying nothing is saved over it once something is.
  const [unkept, setUnkept] = useState<string | null>(null);
  const unkeptRef = useRef(false);
  const [released, setReleased] = useState(false);
  // Whether storage holds the logos these answers carry, under their keys.
  // `saveDraft` skips a logo equal to the previous answers', which is only
  // safe while this holds: after a refused logo write, or for a draft that
  // still carries its logos inline, the next save must write them again,
  // or it succeeds without them and clears the alert over a logo lost on
  // reload.
  const logosStored = useRef(true);
  // False until the stored draft has been read. Before that the form is the
  // server's HTML with no island behind it: whatever is typed there reaches
  // no state and is lost at the first render, so it is disabled until then.
  const [ready, setReady] = useState(false);
  // One lookup at a time, across every step: a double click would send
  // every request twice. The ref closes the gap before the buttons
  // re-render busy.
  const [busy, setBusy] = useState(false);
  // The touched state: "step:path" keys left after an edit (seen), and the
  // edits not yet left (edited). Session state -- never saved or exported --
  // so a reload starts calm again, though an offending character still
  // shows at once because it does not wait on either.
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const edited = useRef(new Set<string>());
  // The open card, null when every card is folded. It is decided when a
  // step is entered -- its first unfinished card, for the answers it is
  // entered with -- and then changes only when the researcher opens, folds
  // or continues a card. Worked out afresh on every render instead, typing
  // the last required key of a card folded it and opened the next, leaving
  // focus in a field that had just been hidden. The server renders the
  // empty answers, so this starts where their Identity step opens.
  const [openCard, setOpenCard] = useState<string | null>(() =>
    entryCard(EMPTY_ANSWERS, "identity")
  );
  // Where focus goes once the render that makes it reachable has landed.
  // A path list rather than one path: several fields can be revealed at
  // once, and the one to focus is whichever sits first on the page, not
  // whichever validate() happened to list first.
  const pending = useRef<
    { paths: string[] } | { card: string } | { next: true } | null
  >(null);
  const running = useRef(false);
  // The draft this tab last wrote or adopted, as the draft key holds it:
  // what both tabs agreed on, for a three-way merge when they diverge.
  const synced = useRef<string | null>(null);
  // NCBI allows three requests a second without an API key and ten with
  // one; every lookup shares this fetch, so the spacing holds across them.
  const apiKey = useRef("");
  apiKey.current = answers.search.ncbi.apiKey;
  const fetch = useMemo(
    () =>
      spaced(
        (input, init) => globalThis.fetch(input, init),
        "eutils.ncbi.nlm.nih.gov",
        () => apiKey.current.trim() === "" ? 350 : 110,
      ),
    [],
  );

  useEffect(() => {
    try {
      const stored = readStoredDraft(localStorage);
      if (stored.unreadable) {
        setFound(true);
        // Kept before anything is saved over it: a draft another version
        // wrote is not destroyed by the first keystroke of this one.
        try {
          keepUnreadable(localStorage);
        } catch {
          // No room for the copy, so the stored draft is still the only
          // one: offer it for download, and save nothing over it until then.
          unkeptRef.current = true;
          setUnkept(localStorage.getItem(DRAFT_STORAGE_KEY));
        }
      } else {
        synced.current = localStorage.getItem(DRAFT_STORAGE_KEY);
      }
      setKept(keptDrafts(localStorage));
      if (stored.answers !== null) {
        const draft = stored.answers;
        // A draft saved before the logos had keys of their own carries them
        // inline; the first save has to move them out.
        logosStored.current = (Object.keys(LOGO_KEYS) as LogoSlot[]).every(
          (slot) =>
            draft.identity[slot] === null ||
            readLogo(localStorage.getItem(LOGO_KEYS[slot])) !== null,
        );
        setAnswers(draft);
        // The page opens on Identity; a stored draft decides its card.
        setOpenCard(entryCard(draft, "identity"));
      }
    } catch {
      // Private browsing can refuse storage; the wizard still works unsaved.
    }
    setReady(true);
  }, []);

  /**
   * Write `next` (`saveDraft()`, which merges another tab's write first)
   * and return the answers that are now this tab's: the ones the draft key
   * holds, or `next` when it took nothing. A refused write, of the draft
   * or of a logo, raises the alert.
   */
  function save(next: Answers, previous: Answers | null): Answers {
    if (unkeptRef.current) {
      unsavedRef.current = true;
      setUnsaved(true);
      return next;
    }
    let result = { answers: next, synced: synced.current, saved: false };
    try {
      result = saveDraft(
        localStorage,
        next,
        previous,
        synced.current,
        logosStored.current,
      );
    } catch {
      // Storage that cannot be reached at all: nothing was written.
    }
    synced.current = result.synced;
    logosStored.current = result.saved;
    unsavedRef.current = !result.saved;
    setUnsaved(!result.saved);
    return result.answers;
  }

  // Every edit saves at once, so a second tab on this page holds an older
  // draft and its next edit would save over this one's work unseen. A save
  // from another tab is merged in here instead, so the two stay one draft:
  // what this tab has not yet saved -- all of it, while its saves are
  // refused -- is kept over theirs. It leaves the open card alone: every
  // step has the same cards whatever the answers, so the card open here
  // still exists, and an edit made in the other tab must not fold the card
  // this one is typing in. A Start over or an import there replaces the
  // draft wholesale, and what was revealed here no longer applies.
  useEffect(() => {
    const adopt = (event: StorageEvent) => {
      if (event.key === REPLACED_KEY) {
        setSeen(new Set());
        edited.current = new Set();
        return;
      }
      const slot = (Object.keys(LOGO_KEYS) as LogoSlot[]).find((s) =>
        LOGO_KEYS[s] === event.key
      );
      if (slot !== undefined) {
        const logo = readLogo(event.newValue);
        setAnswers((previous) => ({
          ...previous,
          identity: { ...previous.identity, [slot]: logo },
        }));
        return;
      }
      if (event.key !== DRAFT_STORAGE_KEY || event.newValue === null) return;
      const incoming = event.newValue;
      setAnswers((previous) => {
        // Null for an event storage has moved past: this tab's own save
        // merged that write already, and adopting it now would take the
        // edit that save carried back off the screen.
        const adopted = adoptDraft(
          localStorage,
          incoming,
          previous,
          synced.current,
        );
        if (adopted === null) return previous;
        const draft = adopted.answers;
        synced.current = adopted.synced;
        // Showing exactly what is stored, this tab has nothing unsaved --
        // unless a logo it holds never reached storage.
        if (
          logosStored.current && !unkeptRef.current &&
          serialiseDraft(withoutLogos(draft)) === incoming
        ) {
          unsavedRef.current = false;
          setUnsaved(false);
        }
        setSeen((keys) => forgetRemoved(keys, previous, draft));
        edited.current = forgetRemoved(edited.current, previous, draft);
        return draft;
      });
    };
    globalThis.addEventListener("storage", adopt);
    return () => globalThis.removeEventListener("storage", adopt);
  }, []);

  // While a save is refused the answers exist only in this tab, as the
  // alert says; closing it asks first.
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener("beforeunload", warn);
    return () => globalThis.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  function lookup(task: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    task().finally(() => {
      running.current = false;
      setBusy(false);
    });
  }

  // Start over and an import: every answer at once, and the touched state
  // with them, here and -- through REPLACED_KEY -- in any other tab.
  function replace(next: Answers) {
    setAnswers(save(next, null));
    setSeen(new Set());
    edited.current = new Set();
    try {
      localStorage.setItem(REPLACED_KEY, String(Date.now()));
    } catch {
      // The draft's own save has said whether storage works.
    }
  }

  function update(change: (draft: Answers) => void) {
    setAnswers((previous) => {
      const next = draftOf(previous);
      change(next);
      // The derived prompt sections still on their draft follow the
      // answers they were drafted from.
      redraftPrompt(previous, next);
      const written = save(next, previous);
      setSeen((keys) => forgetRemoved(keys, previous, written));
      edited.current = forgetRemoved(edited.current, previous, written);
      return written;
    });
  }

  const issues = validate(answers);
  const required = Object.fromEntries(
    STEP_ORDER.map((id) => [id, stepRequired(answers, id)]),
  ) as Record<StepId, string[]>;
  const progress = Object.fromEntries(
    STEP_ORDER.map((id) => [id, progressOf(issues, id, required[id])]),
  ) as Record<StepId, Progress>;
  const steps: StepperStep[] = [
    ...STEP_ORDER.map((id) => {
      const p = progress[id];
      return {
        id,
        label: STEP_LABELS[id],
        ...stepState(p),
        fill: p.asked === 0 ? 100 : Math.round((p.answered / p.asked) * 100),
      };
    }),
    {
      id: "review",
      label: "Review",
      state: issues.length === 0 ? "done" as const : "todo" as const,
      detail: issues.length === 0 ? "Ready" : "Not ready",
      fill: issues.length === 0 ? 100 : 0,
    },
  ];

  // A step's cards and each one's own progress. Broken out so that opening
  // another step (a Go to, a "left") can work out that step's cards ahead
  // of the render that makes it current, rather than waiting for `step`
  // and `cards` below to catch up.
  function cardsFor(id: StepId) {
    const stepCards = cardStates(answers, issues, id, required[id]);
    const stepCardProgress = Object.fromEntries(
      Object.entries(stepCards).map(([cardId, card]) => [
        cardId,
        card.progress,
      ]),
    );
    return { cards: stepCards, cardProgress: stepCardProgress };
  }

  // Review has no cards of its own -- it reads every step's issues instead --
  // so `step` is null there and the card block below has nothing to compute.
  const step = current === "review" ? null : current;
  const { cards, cardProgress: cardProgressMap } = step === null
    ? { cards: {}, cardProgress: {} }
    : cardsFor(step);
  const open = step === null ? null : openCard;

  const screen = useRef<ScreenId>(current);
  screen.current = current;
  const setStatusOf = (id: ScreenId) => (text: string) =>
    setStatuses((lines) => ({ ...lines, [id]: text }));
  const stepProps = (id: StepId) => ({
    answers,
    latest: () => latest.current,
    update,
    issues: issuesFor(issues, id),
    fetch,
    setStatus: setStatusOf(id),
    busy,
    lookup,
  });

  // The answers an import lands on: it reads its file first, and what it
  // weighs and keeps the NCBI credentials of is what is held by then.
  const latest = useRef(answers);
  latest.current = answers;
  const reviewStatus = setStatusOf("review");
  const importAnswers = (file: File) => {
    // Two logos at their cap make an export of about 2.7 MB; a file far
    // larger is no export, and reading it whole would only stall the tab.
    if (file.size > IMPORT_BYTE_LIMIT) {
      reviewStatus(
        `${file.name} is larger than any answers export, so it was not read.`,
      );
      return;
    }
    file.text().then((text) => {
      const imported = importText(text, latest.current);
      if ("error" in imported) {
        reviewStatus(imported.error);
        return;
      }
      // Every answer goes at once, as with Start over, and the export
      // beside the button may never have been made; so an import asks
      // first unless there is nothing here to lose.
      if (
        holdsAnswers(latest.current) &&
        !globalThis.confirm(
          `Replace every answer here with the answers in ${file.name}? Export them first to keep them.`,
        )
      ) {
        reviewStatus(`Kept the answers here; ${file.name} was not imported.`);
        return;
      }
      replace(imported.answers);
      // Import sits on Review, which has no cards, and leaving Review
      // decides the next step's card anew; this covers a screen that
      // changed while the file was read.
      const on = screen.current;
      setOpenCard(on === "review" ? null : entryCard(imported.answers, on));
      // Said, and so also clearing a failure left by an earlier attempt.
      const lost = imported.dropped.length;
      reviewStatus(
        lost === 0
          ? `Imported the answers in ${file.name}.`
          : `Imported the answers in ${file.name}; ${lost} ${
            lost === 1 ? "answer" : "answers"
          } in it could not be read and ${
            lost === 1 ? "was" : "were"
          } left empty.`,
      );
    }).catch(() => reviewStatus(`${file.name} could not be read.`));
  };

  // Next sits below the step, so a new step would otherwise open with the
  // page still scrolled to where the last one ended, and nothing would tell
  // a screen reader the step had changed. Its heading takes focus instead,
  // which scrolls it into view. Only a change the researcher asked for
  // moves focus; the first render and a draft loading from storage do not.
  // A layout effect, so focus moves as the step is drawn: a passive effect
  // runs a frame later and took focus from a field clicked in the meantime,
  // sending what was typed into it to the heading.
  const root = useRef<HTMLFieldSetElement>(null);
  const moved = useRef(false);
  useLayoutEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    const heading = root.current?.querySelector<HTMLElement>(
      ".adapt-step-title",
    );
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }, [current]);

  // Focus goes where a Continue, a "Show what's left" or a Go to sent it,
  // once the render that opened its card and revealed it has landed: the
  // control is then reachable, and already carries its message, so a
  // screen reader reads the error with the field. Runs after every render;
  // it does nothing unless something is pending.
  useLayoutEffect(() => {
    const target = pending.current;
    const element = root.current;
    if (target === null || element === null) return;
    pending.current = null;
    if ("card" in target) {
      element.querySelector<HTMLElement>(
        `[data-card="${target.card}"] .adapt-card-head`,
      )?.focus();
      return;
    }
    if ("next" in target) {
      element.querySelector<HTMLElement>("[data-next]")?.focus();
      return;
    }
    const controls = [
      ...element.querySelectorAll<HTMLElement>(
        "input[data-field], select[data-field], textarea[data-field], button[data-field]",
      ),
    ];
    const notes = [...element.querySelectorAll<HTMLElement>("[data-field]")];
    const pick = (list: HTMLElement[]) =>
      list[firstInPage(list.map((el) => el.dataset.field!), target.paths)];
    const control = pick(controls) ?? pick(notes);
    if (control) {
      control.focus();
      return;
    }
    // None of the paths named a rendered control -- a card not yet drawn,
    // say. The heading is always there, so focus lands somewhere on the
    // step rather than falling through to the document body.
    const heading = element.querySelector<HTMLElement>(".adapt-step-title");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  });

  // Leaving a field reveals its error. With a pointer, focus leaves on the
  // press but the click lands on the release, and a message appearing in
  // between moves everything below it: the release then lands elsewhere,
  // and a Continue, a Remove or a card head swallows the click. So while a
  // pointer is down, a field left is only noted, and revealed once the
  // press is over -- unless focus came back to that field (a click on its
  // own label), which is not leaving it. The rows the press removed are
  // forgotten on the way, as any removal's are. The press is the mouse's as
  // well as the pointer's, because it is `mousedown` that moves focus: a
  // touch tap sends `pointerup` first and its mouse events after, so with
  // the pointer's events alone the wait was over before the field was left,
  // the message showed between that `mousedown` and its `click`, and the
  // tap on a button under the field was lost. `mouseup` and `click` come in
  // one task, and the reveal waits a task past the release.
  const pressing = useRef(false);
  const queued = useRef<{ keys: Set<string>; answers: Answers } | null>(null);
  useEffect(() => {
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(fallback);
      pressing.current = false;
      const waiting = queued.current;
      queued.current = null;
      if (waiting === null) return;
      setTimeout(() => {
        const active = document.activeElement;
        const keys = [...forgetRemoved(
          waiting.keys,
          waiting.answers,
          latest.current,
        )].filter((key) => {
          const field = key.slice(key.indexOf(":") + 1);
          const control = root.current?.querySelector<HTMLElement>(
            `[data-field="${CSS.escape(field)}"]`,
          );
          return !(active !== null &&
            control?.closest(".adapt-field")?.contains(active));
        });
        if (keys.length > 0) {
          setSeen((seenKeys) => new Set([...seenKeys, ...keys]));
        }
      });
    };
    const press = () => {
      pressing.current = true;
      // A release the window never hears -- dragged off it, say -- still
      // ends the wait.
      clearTimeout(fallback);
      fallback = setTimeout(flush, 2000);
    };
    const element = root.current;
    element?.addEventListener("pointerdown", press, true);
    element?.addEventListener("mousedown", press, true);
    globalThis.addEventListener("pointerup", flush);
    globalThis.addEventListener("mouseup", flush);
    globalThis.addEventListener("pointercancel", flush);
    globalThis.addEventListener("blur", flush);
    return () => {
      clearTimeout(fallback);
      element?.removeEventListener("pointerdown", press, true);
      element?.removeEventListener("mousedown", press, true);
      globalThis.removeEventListener("pointerup", flush);
      globalThis.removeEventListener("mouseup", flush);
      globalThis.removeEventListener("pointercancel", flush);
      globalThis.removeEventListener("blur", flush);
    };
  }, []);

  // What the island tells the fields, the notes and the cards about the
  // step on screen. Null on Review, which reads every step's issues
  // instead of one step's cards.
  const wizard = step === null ? null : {
    step,
    answers,
    issues,
    seen,
    progress: progress[step],
    cards,
    openCard: open,
    toggleCard: (id: string) => setOpenCard(open === id ? null : id),
    continueCard: (id: string) => {
      const left = cards[id].progress.open;
      if (left.length > 0) {
        setSeen((keys) => reveal(keys, step, left));
        pending.current = { paths: left };
        return;
      }
      const next = firstOpenCard(cardProgressMap, step, id);
      // A no-op setOpenCard(open) triggers no re-render, so a pending target
      // set here would sit unconsumed until some unrelated render fired the
      // focus effect -- landing on whatever the researcher had moved to by
      // then. Nothing to focus when nothing is changing.
      if (next === open) {
        pending.current = null;
        return;
      }
      setOpenCard(next);
      pending.current = next === null ? { next: true } : { card: next };
    },
    showLeft: () => {
      const left = progress[step].open;
      setSeen((keys) => reveal(keys, step, left));
      if (left.length === 0) return;
      // The card holding the page-first open item, not the card that owns
      // whichever path validate() happened to list first.
      const first = firstOpenCard(cardProgressMap, step);
      if (first === null) return;
      setOpenCard(first);
      pending.current = { paths: cards[first].progress.open };
    },
  };

  // The reveal policy: Next reveals what it leaves behind, so a field left
  // blank or wrong there shows its error at once rather than waiting for a
  // return visit -- this cannot turn the stepper itself amber, since
  // stepState reads what is answered and what is wrongly typed, never seen;
  // "left" (a "Show what's left" or a Review "Go to") reveals the step it
  // opens instead, since that is the one about to be read; Back and the
  // stepper reveal nothing, so a step visited only in passing stays as
  // quiet as it was. Each step keeps its own status line (see statuses).
  // `basis` is the answers the step is entered with: Start over enters
  // Identity with the empty answers in the same handler that sets them, so
  // this render's answers would decide the card from the discarded draft.
  const show = (
    id: ScreenId,
    how: "move" | "next" | "left" = "move",
    basis: Answers = answers,
  ) => {
    if (how === "next" && current !== "review") {
      const leaving = current;
      setSeen((keys) => reveal(keys, leaving, progress[leaving].open));
    }
    setCurrent(id);
    if (how === "left" && id !== "review" && progress[id].open.length > 0) {
      const left = progress[id].open;
      setSeen((keys) => reveal(keys, id, left));
      // The card holding the page-first open item in the step being
      // entered, worked out ahead of the render that makes it current.
      const { cards: idCards, cardProgress: idProgress } = cardsFor(id);
      const first = firstOpenCard(idProgress, id);
      if (first !== null) {
        setOpenCard(first);
        pending.current = { paths: idCards[first].progress.open };
      }
      return;
    }
    setOpenCard(id === "review" ? null : entryCard(basis, id));
    moved.current = true;
  };

  return (
    <fieldset
      class="adapt"
      ref={root}
      disabled={!ready}
      onInput={(e) => {
        const field = (e.target as HTMLElement).dataset?.field;
        if (field !== undefined && step !== null) {
          edited.current.add(seenKey(step, field));
        }
      }}
      onFocusOut={(e) => {
        const target = e.target as HTMLElement;
        const field = targetField(target);
        if (field === undefined || step === null) return;
        // Focus leaving the window -- another tab, another application --
        // is not the researcher leaving the field.
        if (!document.hasFocus()) return;
        // Focus moving to the field's own fix button is not leaving it.
        const to = e.relatedTarget as Node | null;
        if (to !== null && target.closest(".adapt-field")?.contains(to)) {
          return;
        }
        const key = seenKey(step, field);
        if (!edited.current.has(key)) return;
        if (pressing.current) {
          queued.current ??= { keys: new Set(), answers };
          queued.current.keys.add(key);
          return;
        }
        setSeen((keys) => keys.has(key) ? keys : new Set(keys).add(key));
      }}
    >
      {!ready && (
        <p class="adapt-status">
          Loading the wizard… It needs JavaScript. If this note stays, reload
          the page; the guide docs/adapting-to-your-disease.md walks the same
          interview by hand.
        </p>
      )}
      <Stepper
        steps={steps}
        current={current}
        // The current step's own segment moves nothing: pressed again, it
        // would clear the step's line and refold the card that is open.
        onSelect={(id) => {
          if (id !== current) show(id as ScreenId);
        }}
      />
      {(unkept !== null || kept.length > 0) && (
        <div class="notice notice-warning" role="alert">
          <p>
            {unkept !== null
              ? released ? UNREADABLE_RELEASED : UNREADABLE_UNKEPT
              : found
              ? UNREADABLE
              : UNREADABLE_EARLIER}
            {UNREADABLE_FILE}
          </p>
          <div class="adapt-actions">
            {unkept !== null && (
              <button
                type="button"
                class="adapt-button"
                onClick={() => {
                  downloadUnreadable(keptName(kept.length + 1), unkept);
                  if (unkeptRef.current) {
                    // The researcher holds the copy now; save the answers.
                    unkeptRef.current = false;
                    setReleased(true);
                    setAnswers((current) => save(current, null));
                  }
                }}
              >
                Download the stored draft
              </button>
            )}
            {kept.map((text, i) => (
              <button
                type="button"
                class="adapt-button"
                onClick={() => downloadUnreadable(keptName(i + 1), text)}
              >
                {kept.length === 1
                  ? "Download the kept draft"
                  : `Download kept draft ${i + 1} of ${kept.length}`}
              </button>
            ))}
            {kept.length > 0 && (
              <button
                type="button"
                class="adapt-button"
                onClick={() => {
                  // The copy in storage is the only one this page can
                  // vouch for: a download may have been cancelled.
                  if (
                    !globalThis.confirm(
                      "Discard what is kept aside? It cannot be read by this version of the wizard, and the download is the only other copy.",
                    )
                  ) {
                    return;
                  }
                  discardKept(localStorage);
                  // The room it took may be what the stored draft's own
                  // copy needed: kept now, it no longer holds the saves
                  // back, and is offered with the kept ones.
                  if (unkeptRef.current) {
                    try {
                      keepUnreadable(localStorage);
                      unkeptRef.current = false;
                      setUnkept(null);
                    } catch {
                      // Still no room: it stays the only copy.
                    }
                  }
                  setKept(keptDrafts(localStorage));
                  // Or what a refused save needed.
                  if (unsavedRef.current) {
                    setAnswers((current) => save(current, null));
                  }
                }}
              >
                {kept.length === 1
                  ? "Discard the kept draft"
                  : "Discard the kept drafts"}
              </button>
            )}
          </div>
        </div>
      )}
      {
        /* Pinned under the navbar while the step scrolls: what lands here
          answers a button pressed, or a key typed, far down the step. */
      }
      <div class="adapt-messages">
        {unsaved && (
          <p class="notice notice-warning" role="alert">{STORAGE_REFUSED}</p>
        )}
        <p class="adapt-status" role="status">{status}</p>
      </div>
      <WizardContext.Provider value={wizard}>
        {current === "identity" && <IdentityStep {...stepProps("identity")} />}
        {current === "search" && <SearchStep {...stepProps("search")} />}
        {current === "vocabulary" && (
          <VocabularyStep {...stepProps("vocabulary")} />
        )}
        {current === "trials" && <TrialsStep {...stepProps("trials")} />}
        {current === "monogenic" && (
          <MonogenicStep {...stepProps("monogenic")} />
        )}
        {current === "prompt" && <PromptStep {...stepProps("prompt")} />}
        {current === "gold" && <GoldStep {...stepProps("gold")} />}
      </WizardContext.Provider>
      {current === "review" && (
        <ReviewStep
          {...stepProps("gold")}
          setStatus={reviewStatus}
          allIssues={issues}
          onShow={(id) => show(id, "left")}
          onDownload={() =>
            saveDownload(
              BUNDLE_NAME,
              zipBytes(bundle(answers)),
              "application/zip",
            )}
          onExport={() =>
            saveDownload(
              ANSWERS_NAME,
              new TextEncoder().encode(exportText(answers)),
              "application/json",
            )}
          onImport={importAnswers}
          onReset={() => {
            replace(EMPTY_ANSWERS);
            setStatuses({});
            show("identity", "move", EMPTY_ANSWERS);
          }}
        />
      )}
      <div class="adapt-actions">
        {current !== "identity" && (
          <button
            type="button"
            class="adapt-button"
            onClick={() =>
              show(
                steps[steps.findIndex((s) => s.id === current) - 1]
                  .id as ScreenId,
              )}
          >
            Back
          </button>
        )}
        {current !== "review" && (
          <button
            type="button"
            class="adapt-button adapt-button-primary"
            data-next
            onClick={() =>
              show(
                steps[steps.findIndex((s) => s.id === current) + 1]
                  .id as ScreenId,
                "next",
              )}
          >
            Next
          </button>
        )}
      </div>
    </fieldset>
  );
}
