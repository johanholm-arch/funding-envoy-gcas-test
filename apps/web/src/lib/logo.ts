// Prepares a logo before upload, in the browser: crops empty borders (transparent space, or plain background the
// colour of the corners) so the mark fills the space it is shown in, and scales very large images down. SVG files
// are left as they are.

const MAX_W = 1200;
const MAX_H = 400;

export async function prepareLogo(file: File): Promise<{ file: File; trimmed: boolean; resized: boolean }> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || typeof createImageBitmap !== "function") return { file, trimmed: false, resized: false };
  const bmp = await createImageBitmap(file);
  const w = bmp.width, h = bmp.height;
  const src = document.createElement("canvas");
  src.width = w; src.height = h;
  const ctx = src.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { file, trimmed: false, resized: false };
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;

  // What counts as empty: transparency if the corners are transparent, otherwise the corners' colour.
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4];
  const transparentCorners = corners.filter((i) => d[i + 3]! < 16).length >= 3;
  const bg = [0, 1, 2].map((c) => Math.round(corners.reduce((s, i) => s + d[i + c]!, 0) / 4));
  const empty = (i: number) => d[i + 3]! < 16 || (!transparentCorners && Math.abs(d[i]! - bg[0]!) < 18 && Math.abs(d[i + 1]! - bg[1]!) < 18 && Math.abs(d[i + 2]! - bg[2]!) < 18);

  let top = h, left = w, right = -1, bottom = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!empty((y * w + x) * 4)) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return { file, trimmed: false, resized: false }; // nothing but background: leave it alone

  // Keep a small margin so the mark isn't cut tight against its edges.
  const pad = Math.round(Math.max(right - left, bottom - top) * 0.03);
  const cx = Math.max(0, left - pad), cy = Math.max(0, top - pad);
  const cw = Math.min(w, right + pad + 1) - cx, ch = Math.min(h, bottom + pad + 1) - cy;
  const trimmed = cw < w * 0.97 || ch < h * 0.97;
  const scale = Math.min(1, MAX_W / cw, MAX_H / ch);
  const resized = scale < 1;
  const plainWhite = !transparentCorners && bg.every((v) => v > 230);
  if (!trimmed && !resized && !plainWhite) return { file, trimmed: false, resized: false };

  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(cw * scale));
  out.height = Math.max(1, Math.round(ch * scale));
  const octx = out.getContext("2d");
  if (!octx) return { file, trimmed: false, resized: false };
  octx.imageSmoothingQuality = "high";
  octx.drawImage(src, cx, cy, cw, ch, 0, 0, out.width, out.height);
  // A plain white background becomes transparent, with soft edges, so the logo sits on the page's own colour.
  if (plainWhite) {
    const img = octx.getImageData(0, 0, out.width, out.height);
    const px = img.data;
    for (let i = 0; i < px.length; i += 4) {
      const dist = Math.max(Math.abs(px[i]! - bg[0]!), Math.abs(px[i + 1]! - bg[1]!), Math.abs(px[i + 2]! - bg[2]!));
      if (dist < 12) px[i + 3] = 0;
      else if (dist < 48) px[i + 3] = Math.round(px[i + 3]! * (dist - 12) / 36);
    }
    octx.putImageData(img, 0, 0);
  }
  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
  if (!blob) return { file, trimmed: false, resized: false };
  return { file: new File([blob], file.name.replace(/\.[a-z]+$/i, "") + ".png", { type: "image/png" }), trimmed, resized };
}
