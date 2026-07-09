// Track C4 (M8) — PdfBackend (INTERFACES.md §6.1 / §12.6, DESIGN.md M3 + M8).
//
// Strategy (updated in M8, docs/dev/M7-M8-PLAN.md §2.6):
//   - Desktop (Tauri): write the exported self-contained HTML (auto-print
//     script embedded, see html.ts AUTO_PRINT_SCRIPT) to a temp file via the
//     `write_temp_file` command, then open its `file://` URL in a new
//     WebviewWindow. The OS print dialog then offers "Save as PDF". We listen
//     for `tauri://error` (WebviewWindow creation is async — its failure is
//     NOT catchable with try/catch, docs/dev §0.4-1) and fall back to
//     window.open on error. The old `data:` URL was rejected by some platform
//     webviews; a real file:// URL is the reliable path.
//   - Mobile (Tauri iOS/Android): no unified print API and no multi-window
//     support → best-effort `window.print()` (WKWebView shows a print
//     controller on iOS 16+; Android WebView may no-op). A visible
//     「HTMLを書き出して共有」 fallback (saveExport) is offered by the caller
//     so the user can always get the document out.
//   - Browser (dev mock): window.open + document.write; the embedded script
//     triggers print() on load.
//
// No bytes are produced here — `exportPage(..., "pdf")` returns null after
// delegating to this backend (contract §6.1).

import { invoke } from "@tauri-apps/api/core";

import { isMobilePlatform, isTauri } from "../app/workspace";

export interface PdfBackend {
  /**
   * Open `html` (a complete standalone document, auto-print script included)
   * so the user can print / save it as PDF. `title` labels the new window.
   * Never throws for a background/async window-creation failure (that is
   * caught via `tauri://error` and routed to the window.open fallback); only
   * a hard, synchronous inability to open any surface rejects.
   */
  openForPrint(html: string, title: string): Promise<void>;
}

/** Open the HTML in a popup window and write it in (browser + last resort). */
function openInPopup(html: string): void {
  const win = window.open("", "_blank");
  if (win === null) {
    throw new Error(
      "印刷用ウィンドウを開けませんでした（ポップアップがブロックされています）",
    );
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
}

/** Desktop/browser/mobile implementation: new webview or popup + print(). */
export class WebviewPrintBackend implements PdfBackend {
  async openForPrint(html: string, title: string): Promise<void> {
    if (!isTauri()) {
      // Plain browser (dev mock): popup + embedded auto-print.
      openInPopup(html);
      return;
    }

    // Mobile Tauri: no WebviewWindow / no OS print dialog. Best-effort
    // window.print() (the embedded script won't have fired since we render
    // in-place here, so trigger it directly). The caller also surfaces a
    // 「書き出して共有」 fallback button (saveExport) for reliability.
    if (isMobilePlatform()) {
      try {
        window.print();
      } catch {
        // Some mobile webviews reject print(); the share fallback covers it.
      }
      return;
    }

    // Desktop Tauri: temp file + file:// in a new WebviewWindow, with a
    // tauri://error listener → window.open fallback.
    try {
      const fileName = `hakushi-${Date.now().toString(36)}.html`;
      const path = await invoke<string>("write_temp_file", {
        name: fileName,
        content: html,
      });
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const label = `hakushi-export-pdf-${Date.now().toString(36)}`;
      // Open the temp file by its file:// URL (percent-encoded, Windows-drive
      // aware) as a top-level navigation in the new window.
      const win = new WebviewWindow(label, {
        url: pathToFileUrl(path),
        title,
        width: 900,
        height: 1100,
      });
      // Window creation is async on the Rust side: a failure surfaces as a
      // `tauri://error` event, NOT a thrown error here. Fall back to a popup.
      await win.once("tauri://error", () => {
        try {
          openInPopup(html);
        } catch {
          // Nothing more we can do silently; the export UI already returned.
        }
      });
    } catch {
      // Synchronous failure (temp write rejected, api import failed, …):
      // fall back to the popup path immediately.
      openInPopup(html);
    }
  }
}

/**
 * Convert an absolute filesystem path to a `file://` URL. Handles the Windows
 * drive form (`C:\a\b` → `file:///C:/a/b`) and percent-encodes each segment so
 * spaces / CJK in the path survive.
 */
function pathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const encoded = withLeadingSlash
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `file://${encoded}`;
}

let defaultBackend: PdfBackend | null = null;

/** The process-wide default PdfBackend. */
export function getPdfBackend(): PdfBackend {
  if (defaultBackend === null) defaultBackend = new WebviewPrintBackend();
  return defaultBackend;
}
