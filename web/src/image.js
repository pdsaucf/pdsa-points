// Client-side photo compression, to the spec in docs/02-storage.md:
// longest edge 1280px, JPEG quality 0.7, EXIF stripped except orientation,
// createImageBitmap plus OffscreenCanvas with a <canvas> fallback, and a hard
// reject above 8 MB before any of it runs.
//
// This is not an optimisation. A raw phone photo is about 3.5 MB, and 3,000 of
// those a year fill the 1 GB tier in three weeks. At these settings a year of
// photos is about 0.45 GB.
//
// On stripping EXIF "except orientation": there is no way to keep one tag and
// drop the rest through a canvas, because a canvas encode carries no metadata
// at all. So orientation is honoured by baking it into the pixels, with
// `imageOrientation: 'from-image'` on decode. The photo comes out the right way
// up and carries no GPS coordinates, no camera serial and no timestamp, which
// is the outcome the spec is after.

export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_EDGE = 1280;
export const JPEG_QUALITY = 0.7;

export class ImageTooLargeError extends Error {
  constructor(bytes) {
    super('That photo is too large to send.');
    this.name = 'ImageTooLargeError';
    this.bytes = bytes;
  }
}

export class ImageDecodeError extends Error {
  constructor(cause) {
    super('That file could not be read as a photo.');
    this.name = 'ImageDecodeError';
    this.cause = cause;
  }
}

function targetSize(width, height) {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE) return { width, height };
  const scale = MAX_EDGE / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (err) {
      // Safari has historically refused HEIC here while still rendering it in
      // an <img>, so fall through rather than turning the member away.
      void err;
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    // Browsers apply the EXIF orientation to an <img> by default, and drawImage
    // follows what the element renders, so this fallback keeps the photo the
    // right way up too.
    img.decoding = 'sync';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new ImageDecodeError());
      img.src = url;
    });
    return img;
  } catch (err) {
    throw err instanceof ImageDecodeError ? err : new ImageDecodeError(err);
  } finally {
    // Revoking immediately is safe: the bitmap or the decoded image is already
    // in memory by the time we get here.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

async function encode(source, width, height) {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, width, height);
    if (typeof canvas.convertToBlob === 'function') {
      return canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, width, height);

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
  );
  if (!blob) throw new ImageDecodeError();
  return blob;
}

/**
 * sha256 of the compressed bytes, hex encoded. submit_checkin() uses it to
 * notice the same photo submitted against two events.
 *
 * crypto.subtle only exists in a secure context. GitHub Pages is https and
 * localhost counts as secure, so this is present in practice; if it ever is
 * not, the hash is skipped rather than the check-in failing. The RPC takes a
 * null sha256 quite happily.
 */
async function sha256Hex(blob) {
  if (!globalThis.crypto?.subtle) return null;
  try {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

/**
 * @param {File|Blob} file straight off the camera
 * @returns {Promise<{blob: Blob, contentType: string, byteSize: number,
 *   sha256: string|null, width: number, height: number, originalBytes: number}>}
 */
export async function compressPhoto(file) {
  if (file.size > MAX_INPUT_BYTES) throw new ImageTooLargeError(file.size);

  const source = await decode(file);
  const sourceWidth = source.width ?? source.naturalWidth;
  const sourceHeight = source.height ?? source.naturalHeight;
  if (!sourceWidth || !sourceHeight) throw new ImageDecodeError();

  const { width, height } = targetSize(sourceWidth, sourceHeight);
  const blob = await encode(source, width, height);
  source.close?.();

  return {
    blob,
    contentType: 'image/jpeg',
    byteSize: blob.size,
    sha256: await sha256Hex(blob),
    width,
    height,
    originalBytes: file.size,
  };
}
