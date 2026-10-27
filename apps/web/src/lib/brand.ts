// The tenant's brand colour replaces the accent. It is adjusted, never the layout: darkened until it reads at
// 4.5:1 on the light ground, lightened until it reads at 4.5:1 on the dark ground.

type RGB = [number, number, number];

function parseHex(hex: string): RGB | undefined {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return undefined;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("")}`;
}

function luminance([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: RGB, b: RGB): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function fit(color: RGB, ground: RGB, toward: RGB): RGB {
  let c = color;
  for (let t = 0; t <= 1 && contrast(c, ground) < 4.6; t += 0.04) c = mix(color, toward, t);
  return c;
}

const LIGHT_GROUND: RGB = [0xfb, 0xfa, 0xf8];
const DARK_GROUND: RGB = [0x16, 0x16, 0x19];

export function applyBrand(color: string | undefined) {
  const root = document.documentElement;
  const rgb = color ? parseHex(color) : undefined;
  if (!rgb) {
    root.style.removeProperty("--brand-light");
    root.style.removeProperty("--brand-dark");
    return;
  }
  root.style.setProperty("--brand-light", toHex(fit(rgb, LIGHT_GROUND, [0, 0, 0])));
  root.style.setProperty("--brand-dark", toHex(fit(rgb, DARK_GROUND, [255, 255, 255])));
}

/** Contrast of a colour against the light and dark grounds, for the Studio's live check. */
export function contrastWithGround(color: string): { light: number; dark: number } {
  const rgb = parseHex(color);
  if (!rgb) return { light: 0, dark: 0 };
  return { light: contrast(rgb, LIGHT_GROUND), dark: contrast(rgb, DARK_GROUND) };
}
