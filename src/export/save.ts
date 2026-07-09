// Track X — persist an ExportResult (INTERFACES.md §6.1 保存フロー).
//
//   - Tauri: @tauri-apps/plugin-dialog save() → write_export_file command
//     (§6.2; absolute path from the dialog, bytes as Vec<u8>).
//   - Browser (dev mock): Blob + <a download> fallback.
//
// Returns true when the file was written / download started, false when the
// user cancelled the save dialog.

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

import { isTauri } from "../app/workspace";
import type { ExportResult } from "./index";

function extensionOf(fileName: string): string | null {
  const i = fileName.lastIndexOf(".");
  return i === -1 ? null : fileName.slice(i + 1);
}

export async function saveExport(result: ExportResult): Promise<boolean> {
  if (isTauri()) {
    const ext = extensionOf(result.fileName);
    const path = await save({
      defaultPath: result.fileName,
      filters: ext !== null ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined,
    });
    if (path === null) return false;
    await invoke("write_export_file", { path, bytes: Array.from(result.bytes) });
    return true;
  }

  // Browser fallback: Blob download. Copy into a fresh ArrayBuffer so the
  // BlobPart type is exact (Uint8Array<ArrayBufferLike> is not accepted).
  const copy = new Uint8Array(result.bytes);
  const blob = new Blob([copy.buffer as ArrayBuffer], { type: result.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return true;
}
