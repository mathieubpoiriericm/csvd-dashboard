/** sRGB hex → OKLab, and the ΔE the palette gates measure. */
export const HEX = /^#[0-9a-f]{6}$/;

const linear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

export function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) =>
    linear(parseInt(hex.slice(i, i + 2), 16) / 255)
  );
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** Euclidean distance in OKLab × 100, the unit the design spec records. */
export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = oklab(a);
  const [l2, a2, b2] = oklab(b);
  return 100 * Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** A stylesheet colour -- `#rgb`, `#rrggbb` or `oklch(L C H)` -- in linear sRGB. */
function linearRgb(colour: string): [number, number, number] {
  const hex = colour.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1].length === 3
      ? [...hex[1]].map((d) => d + d).join("")
      : hex[1];
    return [0, 2, 4].map((i) =>
      linear(parseInt(digits.slice(i, i + 2), 16) / 255)
    ) as [number, number, number];
  }
  const oklch = colour.match(/^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/);
  if (!oklch) throw new Error(`not a colour this helper reads: ${colour}`);
  const [lightness, chroma, hue] = oklch.slice(1).map(Number);
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

/** WCAG's contrast ratio between two stylesheet colours. */
export function contrast(first: string, second: string): number {
  const luminance = (colour: string) => {
    const [r, g, b] = linearRgb(colour);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(first), luminance(second)].sort((x, y) =>
    y - x
  );
  return (light + 0.05) / (dark + 0.05);
}
