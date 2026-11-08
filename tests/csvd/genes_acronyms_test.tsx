import { assertEquals } from "@std/assert";
import { renderToString } from "preact-render-to-string";

import { AcronymText } from "../../components/AcronymText.tsx";
import { OmicsEntryView } from "../../components/OmicsEntryView.tsx";
import { acronymTooltip } from "../../lib/acronyms.ts";
import { genes } from "../../lib/data/genes.ts";
import { parseOmicsEntry } from "../../lib/omics.ts";
import { studyTypeTooltip } from "../../lib/tooltips.ts";

const triggers = (html: string) =>
  [...html.matchAll(
    /<button[^>]*class="tooltip-box[^"]*"[^>]*>(.*?)<\/button>/g,
  )].map((match) => match[1]);

const omics = (symbol: string) =>
  genes.find((gene) => gene.gene === symbol)!.evidenceFromOtherOmicsStudies;

Deno.test("NMT1's TWAS entry boxes each acronym, in reading order", () => {
  const html = renderToString(<OmicsEntryView value={omics("NMT1")[0]} />);
  assertEquals(triggers(html), [
    "TWAS",
    "WMH",
    "C1",
    "BA24",
    "YFS",
    "CMC",
    "RNA-Seq",
  ]);
  assertEquals(
    html.replace(/<[^>]+>/g, ""),
    "TWAS (WMH: nerve tibial, brain spinal cord cervical C1, brain hippocampus, brain caudate basal ganglia, brain anterior cingulate cortex BA24, heart left ventricle, artery tibial, artery coronary, artery aorta, YFS: blood, CMC: brain (RNA-Seq))",
  );
});

Deno.test("NMT1's TWAS tooltip lists every tissue that colocalized", () => {
  assertEquals(studyTypeTooltip(parseOmicsEntry(omics("NMT1")[0]))?.rows[1], {
    label: "Significant colocalization",
    value:
      "brain caudate basal ganglia, brain anterior cingulate cortex BA24, heart left ventricle, artery coronary, artery aorta, YFS: blood",
  });
});

Deno.test("YFS names the Young Finns Study and says its tissue colocalized", () => {
  assertEquals(acronymTooltip("YFS", "YFS: blood"), {
    rows: [
      {
        label: "YFS",
        value: "Young Finns Study · reference dataset (whole blood)",
      },
      { label: "Significant colocalization", value: "YFS: blood" },
    ],
  });
  assertEquals(
    acronymTooltip("WMH")?.rows[0].value,
    "White matter hyperintensities (of presumed vascular origin) · cSVD MRI biomarker",
  );
});

Deno.test("the MTAG trait is seven tooltips", () => {
  const html = renderToString(
    <AcronymText text="MTAG (all ICH, SVS, WMH, FA, MD, AD)" />,
  );
  assertEquals(triggers(html), ["MTAG", "ICH", "SVS", "WMH", "FA", "MD", "AD"]);
});

Deno.test("SMG6's missing biomarker prints as a ? awaiting clarification", () => {
  const html = renderToString(<OmicsEntryView value={omics("SMG6")[0]} />);
  assertEquals(triggers(html), ["TWAS", "?", "BA9"]);
});
