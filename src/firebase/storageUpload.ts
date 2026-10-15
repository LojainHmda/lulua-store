import { deleteObject, getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { storage } from "./storageClient";
import { mediaApi } from "./collections";
import type { MediaAsset } from "../admin/types";

export async function uploadMediaFile(file: File): Promise<MediaAsset> {
  const id = crypto.randomUUID();
  const ext = file.name.includes(".") ? file.name.split(".").pop() : undefined;
  const path = `media/${id}${ext ? `.${ext}` : ""}`;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file);
  const url = await getDownloadURL(storageRef);
  const type: MediaAsset["type"] = file.type.startsWith("video") ? "video" : "image";

  const docId = await mediaApi.create({
    name: file.name,
    url,
    path,
    type,
    size: file.size,
  } as Omit<MediaAsset, "id">);

  return { id: docId, name: file.name, url, path, type, size: file.size };
}

export async function deleteMediaFile(asset: MediaAsset): Promise<void> {
  try {
    await deleteObject(ref(storage, asset.path));
  } catch {
    // File may already be gone from Storage; still clear the metadata doc.
  }
  await mediaApi.remove(asset.id);
}
