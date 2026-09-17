import type { ComponentChildren } from "preact";

interface TipBoxProps {
  /**
   * The bold prefix. Ported from the Shiny `tip_box_ui(tip_label = …)`
   * argument — only the timeline's citation box overrides the default.
   */
  label?: string;
  children: ComponentChildren;
}

/** Highlighted hint shown above a page's main content. */
export function TipBox({ label = "Tip:", children }: TipBoxProps) {
  return (
    <div class="tip-box">
      <strong>{label}</strong> {children}
    </div>
  );
}
