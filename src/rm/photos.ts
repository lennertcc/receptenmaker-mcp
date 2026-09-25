import { UpstreamError } from "./client";
import type { Photo } from "./fields";

export type { Photo };

/** Receptenmaker scales photos down to 400×300, so there is no point sending more. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export class InvalidImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidImageError";
  }
}

export class PhotoNotFoundError extends Error {
  constructor(recipeId: string, storageId: string) {
    super(`recipe ${recipeId} has no photo with storage id ${storageId}`);
    this.name = "PhotoNotFoundError";
  }
}

/** What the photo operations need from the two clients. */
export interface PhotoDeps {
  listPhotos(recipeId: string): Promise<Photo[]>;
  saveFromUrl(recipeId: string, url: string): Promise<string>;
  upload(recipeId: string, imageBase64: string): Promise<string>;
  setHeader(recipeId: string, storageId: string): Promise<void>;
  remove(recipeId: string, storageId: string): Promise<void>;
}

export type PhotoSource = { url: string } | { imageBase64: string };

/**
 * Normalises and checks base64 image input. Only JPEG and PNG are accepted, both verified
 * to upload correctly; validation has to happen here because upstream stores a broken
 * photo entry for bytes that are not an image, while reporting failure.
 */
export function decodeImage(input: string): { base64: string; type: "jpeg" | "png"; bytes: number } {
  const base64 = input.replace(/^data:[^;,]*;base64,/, "").replace(/\s+/g, "");
  if (base64 === "" || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new InvalidImageError("image_base64 is not valid base64");
  }

  const bytes = (base64.length * 3) / 4 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (bytes > MAX_IMAGE_BYTES) {
    throw new InvalidImageError(
      `image is too large (${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`,
    );
  }

  const head = atob(base64.slice(0, 12));
  const code = (i: number) => head.charCodeAt(i);
  if (code(0) === 0xff && code(1) === 0xd8 && code(2) === 0xff) return { base64, type: "jpeg", bytes };
  if (head.startsWith("\x89PNG\r\n\x1a\n")) return { base64, type: "png", bytes };
  throw new InvalidImageError("image must be a JPEG or PNG");
}

/**
 * Adds a photo and returns its storage id. If the upload fails, any photo entry it left
 * behind is removed before the error is reported.
 */
export async function addPhoto(
  deps: PhotoDeps,
  recipeId: string,
  source: PhotoSource,
  makeHeader: boolean,
): Promise<string> {
  const image = "imageBase64" in source ? decodeImage(source.imageBase64) : null;
  const before = new Set((await deps.listPhotos(recipeId)).map((p) => p.storage_id));

  let storageId: string;
  try {
    storageId = image
      ? await deps.upload(recipeId, image.base64)
      : await deps.saveFromUrl(recipeId, (source as { url: string }).url);
  } catch (error) {
    const strays = (await deps.listPhotos(recipeId)).filter((p) => !before.has(p.storage_id));
    for (const stray of strays) await deps.remove(recipeId, stray.storage_id);
    throw error;
  }

  if (makeHeader) await deps.setHeader(recipeId, storageId);
  return storageId;
}

async function requirePhoto(deps: PhotoDeps, recipeId: string, storageId: string): Promise<void> {
  const photos = await deps.listPhotos(recipeId);
  if (!photos.some((p) => p.storage_id === storageId)) {
    throw new PhotoNotFoundError(recipeId, storageId);
  }
}

export async function setHeaderPhoto(deps: PhotoDeps, recipeId: string, storageId: string): Promise<void> {
  await requirePhoto(deps, recipeId, storageId);
  await deps.setHeader(recipeId, storageId);
}

/** Irreversible. Confirms the photo is gone, since upstream answers "ok" regardless. */
export async function removePhoto(deps: PhotoDeps, recipeId: string, storageId: string): Promise<void> {
  await requirePhoto(deps, recipeId, storageId);
  await deps.remove(recipeId, storageId);
  const after = await deps.listPhotos(recipeId);
  if (after.some((p) => p.storage_id === storageId)) {
    throw new UpstreamError(`Receptenmaker reported deleting photo ${storageId} but it is still there`);
  }
}
