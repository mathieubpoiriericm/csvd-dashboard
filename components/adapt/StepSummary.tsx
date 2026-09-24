import { Icon } from "../Icon.tsx";
import { useWizard } from "./wizard_context.ts";

/**
 * The step's count, where the red list of every issue used to be: what is
 * answered, what is typed wrongly, what is left, and a way to go to it. A
 * note, not a panel, and not a live region.
 */
export function StepSummary() {
  const wizard = useWizard();
  if (wizard === null) return null;
  const { asked, answered, toFix, open } = wizard.progress;
  const ok = asked === 0 ? 100 : ((answered - toFix) / asked) * 100;
  const fix = asked === 0 ? 0 : (toFix / asked) * 100;
  return (
    <div class="adapt-summary">
      <p class="adapt-summary-count">
        <strong>{answered}</strong> of {asked} answered
      </p>
      <span class="adapt-meter" aria-hidden="true">
        <span class="adapt-meter-ok" style={{ width: `${ok}%` }} />
        <span
          class="adapt-meter-fix"
          style={{ left: `${ok}%`, width: `${fix}%` }}
        />
      </span>
      {toFix > 0 && (
        <span class="adapt-summary-fix">
          <Icon name="exclamationTriangle" />
          {toFix} to fix
        </span>
      )}
      {open.length === 0
        ? (
          <span class="adapt-summary-done">
            <Icon name="checkCircle" />Nothing left in this step
          </span>
        )
        : (
          <>
            <span>{asked - answered} to go</span>
            <button
              type="button"
              class="adapt-link-button"
              onClick={wizard.showLeft}
            >
              Show what's left
            </button>
          </>
        )}
    </div>
  );
}
