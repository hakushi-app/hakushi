// Track C — dual-editor pane (INTERFACES.md §4).
//
// Command center for loading, saving and view switching. The five M1
// fidelity rules implemented here:
//   1. Save path is always: editor content → md string → normalizeMarkdown
//      → writeFile. Editor-native serialization never hits the disk.
//   2. WYSIWYG never sees frontmatter: splitFrontmatter before, and the raw
//      original frontmatter is re-joined with joinFrontmatter on save.
//   3. The source editor edits the full file text (frontmatter included).
//   4. View switches convert the live editor content through normalize
//      before handing it to the other editor.
//   5. Embed directives are handled by the HakushiEmbed TipTap node
//      (see hakushi-embed-node.ts).

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Root } from "mdast";

// M5 templates (Track T1, INTERFACES.md §9): save-as-template + rich views.
import { saveAsTemplate } from "../app/page-ops";
// M2 resolver contract (INTERFACES.md §5.6, built by Track U in src/app).
import { listChildPages, readPageBody, resolvePage } from "../app/resolver";
import { isMobilePlatform, readFile, writeFile } from "../app/workspace";
// M3 export (Track X, INTERFACES.md §6.1): toolbar「エクスポート ▾」→
// exportPage (reads the saved file from disk) → saveExport / PdfBackend.
import { exportPage, saveExport, type ExportFormat } from "../export";
import {
  isFolderPage,
  joinFrontmatter,
  normalizeMarkdown,
  parseMarkdown,
  readFrontmatter,
  splitFrontmatter,
  stringifyMarkdown,
} from "../markdown";
import { CalendarView } from "../templates-ui/CalendarView";
import { KanbanBoard } from "../templates-ui/KanbanBoard";
import { TodoView } from "../templates-ui/TodoView";
import { BlockEditor, type BlockEditorHandle } from "./BlockEditor";
import type { HakushiEmbedContext } from "./embed-view";
import { SourceEditor, type SourceEditorHandle } from "./SourceEditor";
import "./editor.css";

export type EditorMode = "wysiwyg" | "source" | "view";

/** frontmatter `template` values that get the third "ビュー" mode (§9.2). */
const VIEW_TEMPLATES = new Set(["kanban", "calendar", "todo", "todo-advanced"]);

/** The page's `template` frontmatter value, or null. */
function templateOf(md: string): string | null {
  const meta = readFrontmatter(md);
  return meta !== null && typeof meta.template === "string" && meta.template !== ""
    ? meta.template
    : null;
}

export interface EditorPaneProps {
  workspaceRoot: string;
  filePath: string;
  /** Called after every successful save with the full saved file content. */
  onSaved?: (relPath: string, markdown: string) => void;
  /** Called when the user navigates to another page (embed card / link). */
  onNavigate?: (relPath: string) => void;
  /** Called after「テンプレートとして保存」 with the new template's rel path. */
  onTemplateSaved?: (relPath: string) => void;
}

export function EditorPane({
  workspaceRoot,
  filePath,
  onSaved,
  onNavigate,
  onTemplateSaved,
}: EditorPaneProps) {
  const [mode, setMode] = useState<EditorMode>("wysiwyg");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // Raw frontmatter block ("---\n…\n---\n" or null), kept verbatim for saves
  // from WYSIWYG mode (rule 2).
  const [frontmatter, setFrontmatter] = useState<string | null>(null);
  // Content handed to the currently mounted editor.
  const [wysiwygBody, setWysiwygBody] = useState("");
  const [sourceText, setSourceText] = useState("");
  // M5 view mode (§9.2): the live body md while the rich view is active.
  const [viewBody, setViewBody] = useState("");
  const [pageTemplate, setPageTemplate] = useState<string | null>(null);

  // M5 save-as-template popover (§9.1).
  const [tplOpen, setTplOpen] = useState(false);
  const [tplName, setTplName] = useState("");
  const [tplBusy, setTplBusy] = useState(false);
  const [tplError, setTplError] = useState<string | null>(null);
  const [tplSavedTo, setTplSavedTo] = useState<string | null>(null);

  // M3 export menu (INTERFACES.md §6.1 UI).
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [isFolderNote, setIsFolderNote] = useState(false);
  const [includeSubtree, setIncludeSubtree] = useState(false);

  // §2.6/§12.6: on mobile the PDF print path is best-effort; offer an explicit
  // 「HTMLを書き出して共有」 fallback (saveExport → OS share sheet). Computed once.
  const mobile = useMemo(() => isMobilePlatform(), []);

  const blockRef = useRef<BlockEditorHandle | null>(null);
  const sourceRef = useRef<SourceEditorHandle | null>(null);

  // Latest-callback refs so save/navigate never capture stale props.
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const onTemplateSavedRef = useRef(onTemplateSaved);
  onTemplateSavedRef.current = onTemplateSaved;

  // Embed/link resolution context for the WYSIWYG editor (M2, §5.6).
  const embedContext = useMemo<HakushiEmbedContext>(
    () => ({
      workspaceRoot,
      currentRelPath: filePath,
      resolver: { resolvePage, listChildPages, readPageBody },
      onNavigate: (relPath: string) => onNavigateRef.current?.(relPath),
    }),
    [workspaceRoot, filePath],
  );

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDirty(false);
    setMode("wysiwyg");
    setExportOpen(false);
    setExportError(null);
    setIncludeSubtree(false);
    setTplOpen(false);
    setTplError(null);
    setTplSavedTo(null);
    readFile(workspaceRoot, filePath)
      .then((raw) => {
        if (cancelled) return;
        const { frontmatter: fm, body } = splitFrontmatter(raw);
        setFrontmatter(fm);
        setWysiwygBody(body);
        setSourceText(raw);
        setViewBody(body);
        // M5 (§9.2): template pages default to their rich view.
        const template = templateOf(raw);
        setPageTemplate(template);
        if (template !== null && VIEW_TEMPLATES.has(template)) setMode("view");
        // Folder-note (§5.4: body is embeds only) → the export menu offers
        // 「配下ページも含める」 (§6.1 UI).
        setIsFolderNote(isFolderPage(parseMarkdown(body)));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot, filePath]);

  // Every editor change bumps this monotonically; the autosave effect debounces
  // on it. (`dirty` alone is idempotent — it can't distinguish keystrokes.)
  const [editSeq, setEditSeq] = useState(0);
  const markDirty = useCallback(() => {
    setDirty(true);
    setEditSeq((n) => n + 1);
  }, []);

  // -------------------------------------------------------------------------
  // Save (rule 1) — button and Cmd/Ctrl+S
  // -------------------------------------------------------------------------
  // Returns true when the file was written, false when the save failed (the
  // error is also reflected in `error` state). Callers that gate a follow-up
  // action on a fresh disk write (export, save-as-template) must check this so
  // they never operate on stale on-disk content (§2.7-1).
  const save = useCallback(async (): Promise<boolean> => {
    if (loading || error !== null) return false;
    try {
      let savedBody: string;
      let onDisk: string;
      if (mode === "wysiwyg") {
        const md = blockRef.current?.getBody() ?? "";
        savedBody = normalizeMarkdown(md);
        onDisk = joinFrontmatter(frontmatter, savedBody);
      } else if (mode === "view") {
        // M5 (§9.2): the rich view's edits are already pipeline output;
        // same save path as the other modes regardless.
        savedBody = normalizeMarkdown(viewBody);
        onDisk = joinFrontmatter(frontmatter, savedBody);
      } else {
        const full = sourceRef.current?.getContent() ?? "";
        const { frontmatter: fm, body } = splitFrontmatter(full);
        // Normalize the body through the canonical pipeline; keep the
        // frontmatter bytes exactly as typed (the pipeline preserves the YAML
        // value verbatim, and byte-keeping it avoids surprise reflows).
        savedBody = normalizeMarkdown(body);
        onDisk = joinFrontmatter(fm, savedBody);
        // Keep pane state consistent for a later switch to WYSIWYG.
        setFrontmatter(fm);
        // The frontmatter (and its template) may have been edited.
        setPageTemplate(templateOf(onDisk));
      }
      await writeFile(workspaceRoot, filePath, onDisk);
      setDirty(false);
      // The edit may have turned the page into (or out of) a folder note.
      setIsFolderNote(isFolderPage(parseMarkdown(savedBody)));
      // M2: notify the app (index refresh etc.) with the exact saved bytes.
      onSavedRef.current?.(filePath, onDisk);
      return true;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [loading, error, mode, frontmatter, viewBody, workspaceRoot, filePath]);

  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // -------------------------------------------------------------------------
  // Autosave (debounced) — edits persist to the git worktree automatically, so
  // the file tree, Git panel status/history and remote sync all reflect them
  // without a manual ⌘S. Without this, typing never reaches disk and the Git
  // panel shows "変更はありません" with a disabled コミット button, which reads
  // as a broken/mock UI. Writes still go through save() (normalizeMarkdown →
  // writeFile — the one sanctioned path to disk); the editor content is never
  // reloaded, so typing (incl. IME composition) is not interrupted.
  const AUTOSAVE_DELAY_MS = 800;
  useEffect(() => {
    if (editSeq === 0 || loading || error !== null) return;
    const id = window.setTimeout(() => void saveRef.current(), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [editSeq, loading, error]);

  // -------------------------------------------------------------------------
  // View switch (rule 4): live content → md → normalize → other editor
  // -------------------------------------------------------------------------
  const switchMode = useCallback(
    (next: EditorMode) => {
      if (next === mode || loading || error !== null) return;
      // Live content of the CURRENT editor → (frontmatter, normalized body).
      let fm = frontmatter;
      let body: string;
      if (mode === "wysiwyg") {
        body = normalizeMarkdown(blockRef.current?.getBody() ?? wysiwygBody);
      } else if (mode === "view") {
        body = normalizeMarkdown(viewBody);
      } else {
        const full = sourceRef.current?.getContent() ?? sourceText;
        const split = splitFrontmatter(full);
        fm = split.frontmatter;
        body = normalizeMarkdown(split.body);
        setFrontmatter(fm);
        setPageTemplate(templateOf(full));
      }
      // Hand it to the target editor.
      if (next === "source") setSourceText(joinFrontmatter(fm, body));
      else if (next === "wysiwyg") setWysiwygBody(body);
      else {
        // The source edit may just have removed/changed `template:` — the
        // view tab only works for view templates (recomputed from fm).
        const template = templateOf(joinFrontmatter(fm, ""));
        if (template === null || !VIEW_TEMPLATES.has(template)) {
          setWysiwygBody(body);
          setMode("wysiwyg");
          return;
        }
        setViewBody(body);
      }
      setMode(next);
    },
    [mode, loading, error, wysiwygBody, sourceText, viewBody, frontmatter],
  );

  // -------------------------------------------------------------------------
  // M5 rich view (§9.2): parse the live body; edits come back as a new Root,
  // serialized through the canonical pipeline only.
  // -------------------------------------------------------------------------
  const hasView = pageTemplate !== null && VIEW_TEMPLATES.has(pageTemplate);
  const viewRoot = useMemo(() => parseMarkdown(viewBody), [viewBody]);

  const handleViewChange = useCallback((nextTree: Root) => {
    setViewBody(stringifyMarkdown(nextTree));
    setDirty(true);
    setEditSeq((n) => n + 1);
  }, []);

  /** Calendar events carry a raw page target (id or path) — resolve first. */
  const handleViewNavigate = useCallback(
    (target: string) => {
      resolvePage(workspaceRoot, target)
        .then((resolved) => {
          if (resolved !== null) onNavigateRef.current?.(resolved.relPath);
        })
        .catch(() => undefined);
    },
    [workspaceRoot],
  );

  // -------------------------------------------------------------------------
  // M5 save-as-template (§9.1): save if dirty, then copy to templates/.
  // -------------------------------------------------------------------------
  const doSaveAsTemplate = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const name = tplName.trim();
      if (name === "" || tplBusy) return;
      setTplBusy(true);
      setTplError(null);
      try {
        if (dirty) {
          const saved = await saveRef.current();
          if (!saved) {
            setTplError("保存に失敗したためテンプレート保存を中止しました。");
            return;
          }
        }
        const destRel = await saveAsTemplate(workspaceRoot, filePath, name);
        setTplOpen(false);
        setTplName("");
        setTplSavedTo(destRel);
        onTemplateSavedRef.current?.(destRel);
      } catch (err: unknown) {
        setTplError(err instanceof Error ? err.message : String(err));
      } finally {
        setTplBusy(false);
      }
    },
    [tplName, tplBusy, dirty, workspaceRoot, filePath],
  );

  // -------------------------------------------------------------------------
  // Export (M3, §6.1): save if dirty → exportPage (reads from disk) →
  // saveExport (html/docx) or PdfBackend print flow (pdf → null).
  // -------------------------------------------------------------------------
  const doExport = useCallback(
    async (format: ExportFormat) => {
      setExportOpen(false);
      setExporting(true);
      setExportError(null);
      try {
        // §2.7-1: if the implicit save-before-export fails, abort — never
        // export stale on-disk content. `save()` returns false and records
        // the underlying error in `error` state; surface it in the export UI.
        if (dirty) {
          const saved = await saveRef.current();
          if (!saved) {
            setExportError(
              "保存に失敗したためエクスポートを中止しました。エディタのエラーを確認してください。",
            );
            return;
          }
        }
        const result = await exportPage(workspaceRoot, filePath, format, {
          includeSubtree: isFolderNote && includeSubtree,
        });
        if (result !== null) {
          await saveExport(result); // false = dialog cancelled; nothing to do
        }
      } catch (err: unknown) {
        setExportError(err instanceof Error ? err.message : String(err));
      } finally {
        setExporting(false);
      }
    },
    [workspaceRoot, filePath, dirty, isFolderNote, includeSubtree],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        <span className="editor-path" title={filePath}>
          {filePath}
          {dirty ? <span className="editor-dirty-dot" aria-label="unsaved changes">●</span> : null}
        </span>
        <div className="editor-toolbar-actions">
          <div className="editor-mode-toggle" role="group" aria-label="Editor mode">
            {hasView && (
              <button
                type="button"
                className={mode === "view" ? "mode-btn active" : "mode-btn"}
                aria-pressed={mode === "view"}
                onClick={() => switchMode("view")}
              >
                ビュー
              </button>
            )}
            <button
              type="button"
              className={mode === "wysiwyg" ? "mode-btn active" : "mode-btn"}
              aria-pressed={mode === "wysiwyg"}
              onClick={() => switchMode("wysiwyg")}
            >
              WYSIWYG
            </button>
            <button
              type="button"
              className={mode === "source" ? "mode-btn active" : "mode-btn"}
              aria-pressed={mode === "source"}
              onClick={() => switchMode("source")}
            >
              Source
            </button>
          </div>
          <button
            type="button"
            className="save-btn"
            disabled={loading || error !== null}
            onClick={() => void save()}
            title="Save (Cmd/Ctrl+S)"
          >
            Save
          </button>
          <div className="export-menu-wrap">
            <button
              type="button"
              className="export-btn"
              disabled={loading || error !== null || exporting}
              aria-haspopup="menu"
              aria-expanded={exportOpen}
              onClick={() => setExportOpen((v) => !v)}
            >
              {exporting ? "エクスポート中…" : "エクスポート ▾"}
            </button>
            {exportOpen && (
              <>
                <div
                  className="export-menu-backdrop"
                  onClick={() => setExportOpen(false)}
                />
                <div className="export-menu" role="menu">
                  <button role="menuitem" onClick={() => void doExport("html")}>
                    HTML
                  </button>
                  <button role="menuitem" onClick={() => void doExport("docx")}>
                    Docx
                  </button>
                  <button role="menuitem" onClick={() => void doExport("pdf")}>
                    {mobile ? "PDF（印刷）" : "PDF"}
                  </button>
                  {mobile && (
                    <button role="menuitem" onClick={() => void doExport("html")}>
                      HTMLを書き出して共有
                    </button>
                  )}
                  {isFolderNote && (
                    <label className="export-subtree-toggle">
                      <input
                        type="checkbox"
                        checked={includeSubtree}
                        onChange={(e) => setIncludeSubtree(e.target.checked)}
                      />
                      配下ページも含める
                    </label>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="export-menu-wrap">
            <button
              type="button"
              className="export-btn"
              disabled={loading || error !== null || tplBusy}
              aria-haspopup="dialog"
              aria-expanded={tplOpen}
              onClick={() => {
                setTplOpen((v) => !v);
                setTplError(null);
                setTplSavedTo(null);
              }}
            >
              テンプレートとして保存…
            </button>
            {tplOpen && (
              <>
                <div
                  className="export-menu-backdrop"
                  onClick={() => setTplOpen(false)}
                />
                <form
                  className="export-menu tpl-save-popover"
                  onSubmit={(e) => void doSaveAsTemplate(e)}
                >
                  <label className="tpl-save-label">
                    テンプレート名
                    <input
                      type="text"
                      value={tplName}
                      placeholder="週次レビュー"
                      autoFocus
                      onChange={(e) => setTplName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setTplOpen(false);
                      }}
                    />
                  </label>
                  {tplError !== null && (
                    <div className="tpl-error" role="alert">
                      {tplError}
                    </div>
                  )}
                  <button type="submit" disabled={tplBusy || tplName.trim() === ""}>
                    {tplBusy ? "保存中…" : "templates/ に保存"}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </div>

      {tplSavedTo !== null && (
        <div className="tpl-saved-note" role="status">
          「{tplSavedTo}」として保存しました
        </div>
      )}

      {exportError !== null && (
        <div className="export-error" role="alert">
          エクスポートに失敗しました: {exportError}
        </div>
      )}

      <div className="editor-body">
        {loading ? (
          <div className="editor-status">Loading…</div>
        ) : error !== null ? (
          <div className="editor-status editor-error">{error}</div>
        ) : mode === "view" && hasView ? (
          pageTemplate === "kanban" ? (
            <KanbanBoard
              root={viewRoot}
              onChange={handleViewChange}
              onNavigate={handleViewNavigate}
            />
          ) : pageTemplate === "calendar" ? (
            <CalendarView
              root={viewRoot}
              onChange={handleViewChange}
              onNavigate={handleViewNavigate}
            />
          ) : (
            <TodoView
              root={viewRoot}
              onChange={handleViewChange}
              onNavigate={handleViewNavigate}
            />
          )
        ) : mode === "wysiwyg" ? (
          <BlockEditor
            ref={blockRef}
            body={wysiwygBody}
            onDirty={markDirty}
            embedContext={embedContext}
          />
        ) : (
          <SourceEditor ref={sourceRef} content={sourceText} onDirty={markDirty} />
        )}
      </div>
    </div>
  );
}
