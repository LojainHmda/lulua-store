// Uploaded files (product images, media library). Production: a Google
// Cloud Storage bucket (STORAGE_BUCKET), objects publicly readable and
// served straight from storage.googleapis.com. Local dev: a folder on disk
// (STORAGE_DIR, default .data/uploads), served by this API.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { Storage } from "@google-cloud/storage";

const PATH_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)+$/;

export function checkPath(path: string) {
  if (!PATH_RE.test(path) || path.split("/").some((s) => s === "." || s === "..")) throw new Error(`Bad storage path: ${path}`);
  return path;
}

export interface FileStore {
  put(path: string, body: Buffer, contentType: string): Promise<string>;
  remove(path: string): Promise<void>;
  // Local store only: read a file back for GET /v1/storage/file/*.
  read?(path: string): Promise<{ body: Buffer; contentType: string } | null>;
}

function gcsStore(bucketName: string): FileStore {
  const bucket = new Storage().bucket(bucketName);
  return {
    async put(path, body, contentType) {
      await bucket.file(path).save(body, { contentType, resumable: false, metadata: { cacheControl: "public, max-age=31536000" } });
      return `https://storage.googleapis.com/${bucketName}/${path.split("/").map(encodeURIComponent).join("/")}`;
    },
    async remove(path) {
      await bucket.file(path).delete({ ignoreNotFound: true });
    },
  };
}

function diskStore(root: string, publicBase: string): FileStore {
  const full = (p: string) => normalize(join(root, p));
  return {
    async put(path, body, contentType) {
      await mkdir(dirname(full(path)), { recursive: true });
      await writeFile(full(path), body);
      await writeFile(`${full(path)}.type`, contentType);
      return `${publicBase}/v1/storage/file/${path}`;
    },
    async remove(path) {
      await rm(full(path), { force: true });
      await rm(`${full(path)}.type`, { force: true });
    },
    async read(path) {
      try {
        return { body: await readFile(full(path)), contentType: await readFile(`${full(path)}.type`, "utf8") };
      } catch {
        return null;
      }
    },
  };
}

export function openFileStore(): FileStore {
  const bucket = process.env.STORAGE_BUCKET;
  if (bucket) return gcsStore(bucket);
  return diskStore(process.env.STORAGE_DIR || ".data/uploads", process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 8787}`);
}
