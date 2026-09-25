import { describe, it, expect } from "vitest";
import {
  InvalidImageError,
  MAX_IMAGE_BYTES,
  PhotoNotFoundError,
  addPhoto,
  decodeImage,
  removePhoto,
  setHeaderPhoto,
  type Photo,
  type PhotoDeps,
} from "../src/rm/photos";
import { UpstreamError } from "../src/rm/client";

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

describe("decodeImage", () => {
  it("accepts JPEG and PNG", () => {
    expect(decodeImage(JPEG).type).toBe("jpeg");
    expect(decodeImage(PNG).type).toBe("png");
  });

  it("accepts a data URL and strips its prefix", () => {
    const decoded = decodeImage(`data:image/jpeg;base64,${JPEG}`);
    expect(decoded.base64).toBe(JPEG);
  });

  it("tolerates line-wrapped base64", () => {
    const wrapped = JPEG.slice(0, 8) + "\n" + JPEG.slice(8);
    expect(decodeImage(wrapped).base64).toBe(JPEG);
  });

  it("rejects bytes that are not a JPEG or PNG", () => {
    // Receptenmaker answers "failed" for these but still stores a broken photo entry.
    expect(() => decodeImage(btoa("not an image at all"))).toThrow(InvalidImageError);
  });

  it("rejects text that is not base64", () => {
    expect(() => decodeImage("this is ! not base64")).toThrow(InvalidImageError);
  });

  it("rejects an image over the size cap", () => {
    const padding = Math.ceil((MAX_IMAGE_BYTES * 4) / 3 / 4) * 4 + 4;
    const tooBig = JPEG + "A".repeat(padding);
    expect(() => decodeImage(tooBig)).toThrow(/too large/i);
  });
});

/** In-memory stand-in for the two clients, recording every mutation. */
function fakeDeps(initial: string[], behaviour: Partial<{ uploadFails: boolean; strayOnFailure: boolean }> = {}) {
  let photos: Photo[] = initial.map((id) => ({ storage_id: id, url: `https://s3/${id}/400x300/image.jpg` }));
  const log: string[] = [];
  let counter = 0;
  const store = (id: string) => {
    photos.push({ storage_id: id, url: `https://s3/${id}/400x300/image.jpg` });
  };
  const deps: PhotoDeps = {
    listPhotos: async () => photos.map((p) => ({ ...p })),
    saveFromUrl: async (_r, url) => {
      log.push(`saveFromUrl ${url}`);
      if (behaviour.uploadFails) {
        if (behaviour.strayOnFailure) store("stray0000000001");
        throw new UpstreamError("could not download an image");
      }
      const id = `new${++counter}`;
      store(id);
      return id;
    },
    upload: async () => {
      log.push("upload");
      if (behaviour.uploadFails) {
        if (behaviour.strayOnFailure) store("stray0000000001");
        throw new UpstreamError("upload failed");
      }
      const id = `new${++counter}`;
      store(id);
      return id;
    },
    setHeader: async (_r, id) => {
      log.push(`setHeader ${id}`);
      const i = photos.findIndex((p) => p.storage_id === id);
      photos = [photos[i], ...photos.filter((_, j) => j !== i)];
    },
    remove: async (_r, id) => {
      log.push(`remove ${id}`);
      photos = photos.filter((p) => p.storage_id !== id);
    },
  };
  return { deps, log, photos: () => photos.map((p) => p.storage_id) };
}

describe("addPhoto", () => {
  it("adds from a url and makes it the header by default", async () => {
    const f = fakeDeps(["old1"]);
    const id = await addPhoto(f.deps, "42", { url: "https://x/p.jpg" }, true);
    expect(f.photos()).toEqual([id, "old1"]);
  });

  it("leaves the header alone when asked to", async () => {
    const f = fakeDeps(["old1"]);
    await addPhoto(f.deps, "42", { url: "https://x/p.jpg" }, false);
    expect(f.photos()).toEqual(["old1", "new1"]);
    expect(f.log.some((l) => l.startsWith("setHeader"))).toBe(false);
  });

  it("uploads validated bytes", async () => {
    const f = fakeDeps([]);
    await addPhoto(f.deps, "42", { imageBase64: JPEG }, true);
    expect(f.log[0]).toBe("upload");
  });

  it("never uploads bytes that fail validation", async () => {
    const f = fakeDeps([]);
    await expect(addPhoto(f.deps, "42", { imageBase64: btoa("garbage") }, true)).rejects.toThrow(
      InvalidImageError,
    );
    expect(f.log).toEqual([]);
  });

  it("removes a photo that appeared despite a failed upload, then reports the failure", async () => {
    const f = fakeDeps(["old1"], { uploadFails: true, strayOnFailure: true });
    await expect(addPhoto(f.deps, "42", { imageBase64: JPEG }, true)).rejects.toThrow(UpstreamError);
    expect(f.photos()).toEqual(["old1"]);
    expect(f.log).toContain("remove stray0000000001");
  });

  it("does not touch existing photos when a failure leaves nothing behind", async () => {
    const f = fakeDeps(["old1"], { uploadFails: true });
    await expect(addPhoto(f.deps, "42", { url: "https://x/" }, true)).rejects.toThrow(UpstreamError);
    expect(f.log.filter((l) => l.startsWith("remove"))).toEqual([]);
  });
});

describe("setHeaderPhoto", () => {
  it("promotes a photo the recipe has", async () => {
    const f = fakeDeps(["a", "b"]);
    await setHeaderPhoto(f.deps, "42", "b");
    expect(f.photos()).toEqual(["b", "a"]);
  });

  it("refuses a storage id that is not on the recipe", async () => {
    const f = fakeDeps(["a"]);
    await expect(setHeaderPhoto(f.deps, "42", "zzz")).rejects.toThrow(PhotoNotFoundError);
    expect(f.log).toEqual([]);
  });
});

describe("removePhoto", () => {
  it("deletes a photo the recipe has", async () => {
    const f = fakeDeps(["a", "b"]);
    await removePhoto(f.deps, "42", "a");
    expect(f.photos()).toEqual(["b"]);
  });

  it("refuses a storage id that is not on the recipe, since upstream would claim success", async () => {
    const f = fakeDeps(["a"]);
    await expect(removePhoto(f.deps, "42", "zzz")).rejects.toThrow(PhotoNotFoundError);
    expect(f.log).toEqual([]);
  });

  it("reports a deletion that did not take", async () => {
    const f = fakeDeps(["a"]);
    f.deps.remove = async () => {};
    await expect(removePhoto(f.deps, "42", "a")).rejects.toThrow(UpstreamError);
  });
});
