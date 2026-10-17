import { mediaApi } from "./collections";
import { apiUrl, auth } from "./config";
import type { MediaAsset } from "../admin/types";

// Files go to the API's file store (a Cloud Storage bucket in production),
// under media/ — only active admins may upload or delete there.
async function storageCall(path: string, init: RequestInit): Promise<Response> {
  const token = await auth._getToken();
  const res = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error?.message ?? `Upload failed (HTTP ${res.status})`), { code: body.error?.code });
  }
  return res;
}

export async function uploadMediaFile(file: File): Promise<MediaAsset> {
  const id = crypto.randomUUID();
  const ext = file.name.includes(".") ? file.name.split(".").pop() : undefined;
  const path = `media/${id}${ext ? `.${ext.replace(/[^A-Za-z0-9]/g, "")}` : ""}`;
  const res = await storageCall(`/v1/storage/upload?path=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  const { url } = (await res.json()) as { url: string };
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
    await storageCall("/v1/storage/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: asset.path }),
    });
  } catch {
    // File may already be gone from storage; still clear the metadata doc.
  }
  await mediaApi.remove(asset.id);
}
