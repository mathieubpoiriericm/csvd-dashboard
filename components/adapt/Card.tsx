import type { ComponentChildren } from "preact";

import { Icon } from "../Icon.tsx";
import { CARDS } from "../../lib/adapt/cards.ts";
import type { StepId } from "../../lib/adapt/validate.ts";
import { useWizard } from "./wizard_context.ts";

interface CardProps {
  step: StepId;
  id: string;
  children: ComponentChildren;
}

/**
 * One group of a step's questions. Folded, it is a line: its number or a
 * check, its title, its summary and its state. The body stays in the page
 * with `hidden` rather than leaving it, so a control in it can be found and
 * focused the moment its card opens, and a ParsedTextField keeps what was
 * typed across a fold. Outside the wizard (the unit tests) every card is
 * open. The props hold no function: the open state and Continue come from
 * the context.
 */
export function Card({ step, id, children }: CardProps) {
  const wizard = useWizard();
  const index = CARDS[step].findIndex((card) => card.id === id);
  const def = CARDS[step][index];
  const state = wizard?.step === step ? wizard.cards[id] : undefined;
  const fixed = def.fixed === true;
  const open = fixed || wizard === null || wizard.openCard === id;
  const done = state !== undefined && state.progress.open.length === 0;
  const body = `adapt-card-${step}-${id}`;
  let pill = null;
  if (state !== undefined) {
    const left = state.progress.asked - state.progress.answered;
    pill = done
      ? (
        <span class="adapt-pill is-done">
          <Icon name="checkCircle" />Complete
        </span>
      )
      : state.progress.toFix > 0
      ? (
        <span class="adapt-pill is-fix">
          <Icon name="exclamationTriangle" />
          {state.progress.toFix} to fix
        </span>
      )
      : <span class="adapt-pill">{left} to go</span>;
  }
  const head = (
    <>
      <span class="adapt-card-number" aria-hidden="true">
        {done ? <Icon name="checkCircle" /> : index + 1}
      </span>
      <span class="adapt-card-text">
        <span class="adapt-card-title">{def.title}</span>
        <span class="adapt-card-summary">
          {done ? state!.summary : def.purpose}
        </span>
      </span>
      {pill}
    </>
  );
  const classes = ["adapt-card"];
  if (open) classes.push("is-open");
  if (done) classes.push("is-done");
  return (
    <section class={classes.join(" ")} data-card={id}>
      <h3 class="adapt-card-heading">
        {fixed || wizard === null
          ? <span class="adapt-card-head">{head}</span>
          : (
            <button
              type="button"
              class="adapt-card-head"
              aria-expanded={open ? "true" : "false"}
              aria-controls={body}
              onClick={() => wizard.toggleCard(id)}
            >
              {head}
              <Icon name="chevronDown" />
            </button>
          )}
      </h3>
      <div class="adapt-card-body" id={body} hidden={!open}>
        {children}
        {!fixed && wizard !== null && (
          <div class="adapt-actions adapt-card-actions">
            <button
              type="button"
              class="adapt-button adapt-button-primary"
              onClick={() => wizard.continueCard(id)}
            >
              Continue
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
