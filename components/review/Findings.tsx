import { PUBMED_BASE_URL } from "../../lib/constants.ts";
import type { ReviewFinding } from "../../lib/types.ts";

/** How the paper was read; nothing when the run did not record it. */
const READING: Record<string, string> = {
  true: "full text",
  false: "abstract only",
};

/**
 * One paper's extraction about the gene, as the committee weighs it: where
 * it came from and how far to trust it, then what it claims and the words it
 * claims them from. A fact the run did not record is left out rather than
 * printed as a blank.
 */
function Finding({ finding }: { finding: ReviewFinding }) {
  const facts = [
    finding.pmid !== null && (
      <>
        PMID{" "}
        <a
          href={`${PUBMED_BASE_URL}${finding.pmid}/`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {finding.pmid}
        </a>
      </>
    ),
    finding.fulltext !== null && READING[String(finding.fulltext)],
    finding.confidence !== null && (
      <span class="review-number">confidence {finding.confidence}</span>
    ),
    finding.extractionModel !== null &&
    `extracted by ${finding.extractionModel}`,
    finding.citationOnly && "citation only",
  ].filter((fact) => fact !== false);
  return (
    <li class="review-finding">
      {facts.length > 0 && (
        <p class="review-finding-facts">
          {facts.map((fact, i) => (
            <span key={i}>
              {i > 0 && " · "}
              {fact}
            </span>
          ))}
        </p>
      )}
      {finding.causalEvidenceSummary && <p>{finding.causalEvidenceSummary}</p>}
      {finding.sourceQuote && (
        <blockquote class="review-quote">{finding.sourceQuote}</blockquote>
      )}
    </li>
  );
}

/** The papers behind the change, each with its reading, score and quote. */
export function Findings({ findings }: { findings: ReviewFinding[] }) {
  return (
    <section class="card">
      <div class="card-body">
        <h2 class="card-title">Findings</h2>
        {findings.length === 0
          ? <p class="review-absent">No findings</p>
          : (
            <ol class="review-findings">
              {findings.map((finding, i) => (
                <Finding key={i} finding={finding} />
              ))}
            </ol>
          )}
      </div>
    </section>
  );
}
