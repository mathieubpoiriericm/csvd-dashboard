import { ANSWER_LABELS, percent } from "../../lib/review/display.ts";
import type { Role } from "../../lib/review/events.ts";
import type { ReviewSummary } from "../../lib/review/summary.ts";
import { simulatedTime } from "../../lib/review/time.ts";

const ROLE_LABELS: Record<Role, string> = {
  chair: "Chair",
  member: "Voting member",
  observer: "Observer",
};

/**
 * Each account's progress, one row each in the accounts' order: how many of
 * the answers it owes are in, how they split, and when it last acted, on the
 * committee's simulated clock. An observer owes nothing, so its row says
 * "Read only", once across the answered cell and the four counts, rather
 * than "0 of 0" and four zeros that would read as a
 * member who has not started.
 */
export function MembersTable(
  { summary, runTimestamp }: { summary: ReviewSummary; runTimestamp: string },
) {
  return (
    <section class="card">
      <div class="card-body">
        <h2 class="card-title">Members</h2>
        <div class="table-scroll">
          <table class="data-table review-members">
            <caption class="visually-hidden">Members' progress</caption>
            <thead>
              <tr>
                <th scope="col" class="col-identity">Member</th>
                <th scope="col">Role</th>
                <th scope="col">Answered</th>
                <th scope="col">{ANSWER_LABELS.accept}</th>
                <th scope="col">{ANSWER_LABELS.accept_with_edits}</th>
                <th scope="col">{ANSWER_LABELS.reject}</th>
                <th scope="col">{ANSWER_LABELS.abstain}</th>
                <th scope="col">Last active</th>
              </tr>
            </thead>
            <tbody>
              {summary.members.map((m) => {
                const readOnly = m.account.role === "observer";
                return (
                  <tr key={m.account.id}>
                    <td class="col-identity">{m.account.name}</td>
                    <td class="review-role-cell">
                      {ROLE_LABELS[m.account.role]}
                    </td>
                    {readOnly
                      ? (
                        <td class="review-read-only" colSpan={5}>
                          Read only
                        </td>
                      )
                      : (
                        <>
                          <td class="review-committee">
                            <span class="review-answered">
                              {m.answered} of {m.owed}
                            </span>
                            <span
                              class="review-member-bar"
                              role="img"
                              aria-label={`${m.answered} of ${m.owed} answered`}
                            >
                              <span
                                style={`width: ${percent(m.answered, m.owed)}`}
                              />
                            </span>
                          </td>
                          <td class="review-number">{m.accept}</td>
                          <td class="review-number">{m.withEdits}</td>
                          <td class="review-number">{m.reject}</td>
                          <td class="review-number">{m.abstain}</td>
                        </>
                      )}
                    <td class="review-last-active">
                      {m.lastActive === null
                        ? "No activity"
                        : simulatedTime(m.lastActive, runTimestamp)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
