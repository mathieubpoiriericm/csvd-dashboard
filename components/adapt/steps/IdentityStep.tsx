import { TextField } from "../Field.tsx";
import { Card } from "../Card.tsx";
import { FieldNote, LogoInput } from "../FieldNote.tsx";
import { StepSummary } from "../StepSummary.tsx";
import { ListEditor } from "../ListEditor.tsx";
import {
  CELL_TYPE_NAMES,
  CELL_TYPES_LABEL,
} from "../../../lib/disease/cell_types.ts";
import { LOGO_BYTE_LIMIT, type LogoFile } from "../../../lib/adapt/answers.ts";
import { redraftSite } from "../../../lib/adapt/site_drafts.ts";
import { logoProblem } from "../../../lib/adapt/validate.ts";
import type { StepProps } from "./types.ts";

// The examples name a disease no fork is about, so a fork's own literal
// scan never finds them.
const DISEASE_FIELDS = [
  [
    "name",
    "Disease name",
    "Lower case, as it reads mid-sentence, e.g. examplosis.",
  ],
  ["short", "Short form", "e.g. EXS"],
  ["abbreviation", "Abbreviation", "e.g. EXS"],
  ["adjective", "Adjective form", "For headings, e.g. Examplotic."],
  [
    "key",
    "Key",
    "One lower-case word; names the database and the deploy project, e.g. examplosis.",
  ],
] as const;

const SITE_FIELDS = [
  ["title", "Site title"],
  ["heading", "Navbar heading"],
  ["metaDescription", "Meta description"],
  ["aboutTitle", "About page title"],
  ["aboutLede", "About page lead"],
  ["loginLede", "Login page lead"],
] as const;

const PAGE_FIELDS = [["genes", "Genes"], ["trials", "Trials"], [
  "timeline",
  "Trials radar",
], ["map", "Trials map"]] as const;

// Named by the surface each is drawn on. The navigation bar is dark in
// both themes, so it draws the dark-background logo -- the light one when
// there is none -- and a navy logo uploaded as "for the light theme" was
// all but invisible there.
const LOGOS = [
  [
    "logoLight",
    "Logo on a light background (SVG or PNG)",
    "Drawn on the login card in the light theme.",
    "Remove light-background logo",
  ],
  [
    "logoDark",
    "Logo on a dark background (optional)",
    "Drawn on the navigation bar of every page, and on the login card in the dark theme.",
    "Remove dark-background logo",
  ],
] as const;

function readLogo(file: File): Promise<LogoFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      // "data:<type>;base64,<bytes>". Anything else holds no bytes the
      // archive could decode, and bundle() decodes on every Review render.
      const url = String(reader.result);
      const comma = url.indexOf(",");
      if (comma === -1) reject(new Error("not a data URL"));
      else resolve({ name: file.name, base64: url.slice(comma + 1) });
    };
    reader.readAsDataURL(file);
  });
}

export function IdentityStep(
  { answers, update, setStatus }: StepProps,
) {
  const {
    disease,
    site,
    institute,
    maintainer,
    cellTypes,
  } = answers.identity;

  const setDisease = (key: keyof typeof disease, value: string) =>
    update((d) =>
      redraftSite(d.identity, (identity) => identity.disease[key] = value)
    );
  const setInstitute = (key: keyof typeof institute, value: string) =>
    update((d) =>
      redraftSite(d.identity, (identity) => identity.institute[key] = value)
    );
  const setSite = (
    key: Exclude<keyof typeof site, "pages">,
    value: string,
  ) => update((d) => d.identity.site[key] = value);
  const setPage = (key: keyof typeof site.pages, value: string) =>
    update((d) => d.identity.site.pages[key] = value);
  const removeLogo = (
    which: "logoLight" | "logoDark",
    button: HTMLElement,
  ) => {
    // The button goes with the logo, so focus would fall to the page; the
    // file input it stands beside takes it, ready for another file.
    const input = button.closest(".adapt-card-body")?.querySelector<
      HTMLElement
    >(`input[data-field="${which}"]`);
    update((d) => d.identity[which] = null);
    setTimeout(() => input?.focus());
  };
  const setLogo = (which: "logoLight" | "logoDark", file: File | undefined) => {
    // Cancelling the file dialog empties the input, which is not a request
    // to drop the logo already uploaded; the Remove button is.
    if (file === undefined) return;
    // The logo rides in the draft as base64, which localStorage caps at a
    // few megabytes; a large file would take the whole draft down with it.
    if (file.size > LOGO_BYTE_LIMIT) {
      setStatus(
        `${file.name} is larger than 1 MB. A logo this size belongs in the repository, not in the draft; upload a smaller SVG or PNG.`,
      );
      return;
    }
    if (file.size === 0) {
      setStatus(`${file.name} is empty; choose the logo file itself.`);
      return;
    }
    readLogo(file).then((logo) => {
      // Its bytes are checked as validate() checks them: a PNG named .svg,
      // an SVG a browser would not draw, one carrying a script.
      const problem = logoProblem(logo);
      if (problem !== null) {
        setStatus(`${file.name}: ${problem}`);
        return;
      }
      update((d) => d.identity[which] = logo);
      // A refusal left by an earlier choice no longer applies.
      setStatus("");
    }).catch(() => setStatus(`${file.name} could not be read.`));
  };
  const prefillCellTypes = () => {
    // The button replaces the whole column, so what has been typed into it
    // goes only on a yes.
    const typed = cellTypes.label.trim() !== "" ||
      cellTypes.glossary.length > 0;
    if (
      typed &&
      !globalThis.confirm(
        "Replace the cell types entered here with this dashboard's?",
      )
    ) return;
    update((d) => {
      d.identity.cellTypes = {
        label: CELL_TYPES_LABEL,
        glossary: Object.entries(CELL_TYPE_NAMES).map(([abbrev, name]) => ({
          abbrev,
          name,
        })),
      };
    });
  };

  return (
    <section class="adapt-step">
      <h2 class="adapt-step-title">1. Identity</h2>
      <StepSummary />
      <Card step="identity" id="disease">
        {DISEASE_FIELDS.map(([key, label, hint]) => (
          <TextField
            key={key}
            label={label}
            value={disease[key]}
            onInput={(v) => setDisease(key, v)}
            hint={hint}
            field={`disease.${key}`}
          />
        ))}
      </Card>
      <Card step="identity" id="institute">
        <div class="adapt-row">
          <TextField
            label="Institute name"
            value={institute.name}
            onInput={(v) => setInstitute("name", v)}
            field="institute.name"
          />
          <TextField
            label="Institute short name"
            value={institute.short}
            onInput={(v) => setInstitute("short", v)}
            field="institute.short"
          />
        </div>
        <TextField
          label="Institute URL (optional)"
          value={institute.url}
          onInput={(v) => setInstitute("url", v)}
          inputMode="url"
          autoComplete="url"
          optional
          field="institute.url"
        />
        <TextField
          label="Copyright line"
          value={institute.copyright}
          onInput={(v) => setInstitute("copyright", v)}
          hint="As the footer prints it, e.g. Northbridge Institute (NBI)."
          field="institute.copyright"
        />
        <TextField
          label="Logo alternative text"
          value={institute.logoAlt}
          onInput={(v) => setInstitute("logoAlt", v)}
          field="institute.logoAlt"
        />
      </Card>
      <Card step="identity" id="logos">
        {LOGOS.map(([which, label, drawn, removeLabel]) => (
          <div class="adapt-lookup" key={which}>
            <label class="adapt-field">
              <span class="adapt-field-label">{label}</span>
              <LogoInput
                field={which}
                required={which === "logoLight"}
                onFile={(file) =>
                  setLogo(which, file)}
              />
            </label>
            <span class="adapt-field-hint">{drawn}</span>
            {answers.identity[which] && (
              <div class="adapt-actions">
                <span class="adapt-field-hint">
                  Uploaded: {answers.identity[which]!.name}
                </span>
                <button
                  type="button"
                  class="adapt-button"
                  onClick={(e) => removeLogo(which, e.currentTarget)}
                >
                  {removeLabel}
                </button>
              </div>
            )}
            <FieldNote field={which} />
          </div>
        ))}
        {answers.identity.logoDark === null && (
          <p class="adapt-status">
            With one logo, that one is drawn on the dark navigation bar and on
            the light login card, so it has to read on both.
          </p>
        )}
      </Card>
      <Card step="identity" id="maintainer">
        <div class="adapt-row">
          <TextField
            label="Maintainer name"
            value={maintainer.name}
            onInput={(v) => update((d) => d.identity.maintainer.name = v)}
            autoComplete="name"
            field="maintainer.name"
          />
          <TextField
            label="Maintainer email"
            value={maintainer.email}
            onInput={(v) => update((d) => d.identity.maintainer.email = v)}
            inputMode="email"
            autoComplete="email"
            field="maintainer.email"
          />
        </div>
      </Card>
      <Card step="identity" id="site">
        <p class="adapt-status">
          Drafted from the names above; a line you edit stops following them,
          and the others keep being redrafted.
        </p>
        {SITE_FIELDS.map(([key, label]) => (
          <TextField
            key={key}
            label={label}
            value={site[key]}
            onInput={(v) => setSite(key, v)}
            multiline={key !== "title"}
            field={`site.${key}`}
          />
        ))}
        {PAGE_FIELDS.map(([key, label]) => (
          <TextField
            key={key}
            label={`${label} page description`}
            value={site.pages[key]}
            onInput={(v) => setPage(key, v)}
            multiline
            field={`site.pages.${key}`}
          />
        ))}
      </Card>
      <Card step="identity" id="cells">
        <p class="adapt-status">
          The cell-type column and its abbreviations. A disease of the same
          class usually keeps this dashboard's list.
        </p>
        <div class="adapt-actions">
          <button
            type="button"
            class="adapt-button"
            onClick={prefillCellTypes}
          >
            Use this dashboard's cell types
          </button>
        </div>
        <TextField
          label="Column label"
          value={cellTypes.label}
          onInput={(v) => update((d) => d.identity.cellTypes.label = v)}
          field="cellTypes.label"
        />
        <ListEditor
          items={cellTypes.glossary}
          addLabel="Add cell type"
          field="cellTypes.glossary"
          rowLabel={(row, i) =>
            `Cell type ${i + 1}${
              row.abbrev.trim() === "" ? "" : `: ${row.abbrev}`
            }`}
          add={() =>
            update((d) =>
              d.identity.cellTypes.glossary.push({ abbrev: "", name: "" })
            )}
          remove={(i) =>
            update((d) => d.identity.cellTypes.glossary.splice(i, 1))}
          render={(row, i) => (
            <>
              {
                /* validate() files the abbreviation's faults ("needs an
                   abbreviation", "listed twice") on the row path and the
                   name's on the row's `.name`, so each control says its
                   own; a row's first control does not answer for the
                   control beside it (covers() in lib/adapt/feedback.ts). */
              }
              <TextField
                label="Abbreviation"
                value={row.abbrev}
                onInput={(v) =>
                  update((d) => d.identity.cellTypes.glossary[i].abbrev = v)}
                field={`cellTypes.glossary[${i}]`}
              />
              <TextField
                label="Full name"
                value={row.name}
                onInput={(v) =>
                  update((d) => d.identity.cellTypes.glossary[i].name = v)}
                field={`cellTypes.glossary[${i}].name`}
              />
            </>
          )}
        />
      </Card>
    </section>
  );
}
