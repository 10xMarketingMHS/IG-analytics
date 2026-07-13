// Resize a user-picked image to a square and return a JPEG data URL.
// 640px @ q0.92 stays sharp even on the large (~322px) featured-champion card on
// retina screens, while the payload (~60–130KB) is still small enough to store
// inline in the DB and send as JSON — no object storage needed.
// We never upscale: if the source is smaller than `size`, we keep its own
// resolution so we don't invent blur that wasn't there.
export async function fileToSquareDataUrl(file: File, size = 640): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Could not read image"));
      i.src = url;
    });

    // Cap the square to the source's shortest side so we never upscale.
    const target = Math.min(size, img.width, img.height) || size;

    const canvas = document.createElement("canvas");
    canvas.width = target;
    canvas.height = target;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not supported");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // Cover-crop to a centered square.
    const scale = Math.max(target / img.width, target / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.drawImage(img, (target - w) / 2, (target - h) / 2, w, h);

    return canvas.toDataURL("image/jpeg", 0.92);
  } finally {
    URL.revokeObjectURL(url);
  }
}
