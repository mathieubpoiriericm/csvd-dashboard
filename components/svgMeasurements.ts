/** Browser-only helpers shared by the two measured SVG figures. */

export interface SvgTextBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function measureSvgTextBoxes(
  svg: SVGSVGElement,
  selector: string,
  keyOf: (text: SVGTextElement) => string,
): Map<string, SvgTextBox> {
  const boxes = new Map<string, SvgTextBox>();
  for (const text of svg.querySelectorAll<SVGTextElement>(selector)) {
    try {
      const { x, y, width, height } = text.getBBox();
      if (width > 0) boxes.set(keyOf(text), { x, y, width, height });
    } catch {
      // Detached or not-yet-rendered SVG text has no measurable box.
    }
  }
  return boxes;
}

export function measureSvgTextWidths(
  svg: SVGSVGElement,
  selector: string,
  keyOf: (text: SVGTextElement) => string,
): Map<string, number> {
  return new Map(
    [...measureSvgTextBoxes(svg, selector, keyOf)].map(([key, box]) => [
      key,
      box.width,
    ]),
  );
}

/** Runs once web fonts are ready and returns a cancellation callback. */
export function whenFontsReady(callback: () => void): () => void {
  let cancelled = false;
  document.fonts.ready.then(() => {
    if (!cancelled) callback();
  });
  return () => {
    cancelled = true;
  };
}
