// Track U — sidebar file tree (M2: context menu, folder-note icon).
// Folder-note aware: a directory containing index.md is itself clickable
// and selects that index.md (DESIGN.md §data-model). Directories whose
// index.md body is embeds-only (isFolderPage) get a hybrid folder-page icon
// — a cheap lazy heuristic that never blocks tree rendering.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { isFolderPage, parseMarkdown } from "../markdown";
import { createNewPage } from "./page-ops";
import { listTree, readFile, type TreeEntry } from "./workspace";
import "./app.css";

export interface FileTreeProps {
  root: string;
  selected: string | null;
  onSelect(relPath: string): void;
  /** Bump to reload the tree (expansion state is kept). */
  reloadToken?: number;
  /** App-level create handler (index update + selection); has an internal fallback. */
  onCreatePage?(dirRelPath: string): void | Promise<void>;
  onRenameEntry?(relPath: string, isDir: boolean): void;
  onMoveEntry?(relPath: string, isDir: boolean): void;
  onDeleteEntry?(relPath: string, isDir: boolean): void;
}

interface MenuState {
  x: number;
  y: number;
  relPath: string;
  isDir: boolean;
}

/** rel path of the folder-note (index.md) if the directory has one. */
function folderNotePath(entry: TreeEntry): string | null {
  const hasIndex = (entry.children ?? []).some(
    (c) => !c.isDir && c.name === "index.md",
  );
  return hasIndex ? `${entry.relPath}/index.md` : null;
}

function stripMd(name: string): string {
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
}

export function FileTree({
  root,
  selected,
  onSelect,
  reloadToken = 0,
  onCreatePage,
  onRenameEntry,
  onMoveEntry,
  onDeleteEntry,
}: FileTreeProps) {
  const [tree, setTree] = useState<TreeEntry[] | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // dirs whose index.md body is embeds-only (visual hint, computed lazily)
  const [folderNotes, setFolderNotes] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );

  const load = useCallback(
    async (resetExpanded: boolean) => {
      setError(null);
      try {
        const entries = await listTree(root);
        setTree(entries);
        if (resetExpanded) {
          // Default: top-level directories expanded (depth 1 visible).
          setExpanded(
            new Set(entries.filter((e) => e.isDir).map((e) => e.relPath)),
          );
        }
      } catch (e) {
        setTree(null);
        setError(String(e));
      }
    },
    [root],
  );

  // Reset expansion only when the workspace root changes.
  const prevRootRef = useRef<string | null>(null);
  useEffect(() => {
    const isNewRoot = prevRootRef.current !== root;
    prevRootRef.current = root;
    void load(isNewRoot);
  }, [load, reloadToken, root]);

  // Lazy folder-note detection (never blocks the tree render).
  useEffect(() => {
    if (tree === null) return;
    let cancelled = false;
    const targets: { dir: string; note: string }[] = [];
    const collect = (entries: TreeEntry[]) => {
      for (const e of entries) {
        if (!e.isDir) continue;
        const note = folderNotePath(e);
        if (note !== null) targets.push({ dir: e.relPath, note });
        collect(e.children ?? []);
      }
    };
    collect(tree);
    void (async () => {
      const results = await Promise.all(
        targets.map(async ({ dir, note }) => {
          try {
            const md = await readFile(root, note);
            return [dir, isFolderPage(parseMarkdown(md))] as const;
          } catch {
            return [dir, false] as const;
          }
        }),
      );
      if (!cancelled) setFolderNotes(new Map(results));
    })();
    return () => {
      cancelled = true;
    };
  }, [tree, root]);

  const toggle = (relPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  const handleCreate = async (dirRelPath: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (onCreatePage !== undefined) {
        await onCreatePage(dirRelPath);
      } else {
        // Standalone fallback (no app-level handler wired).
        const relPath = await createNewPage(root, dirRelPath, "Untitled");
        await load(false);
        onSelect(relPath);
      }
      if (dirRelPath !== "") {
        setExpanded((prev) => new Set(prev).add(dirRelPath));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const hasEntryMenu =
    onRenameEntry !== undefined ||
    onMoveEntry !== undefined ||
    onDeleteEntry !== undefined;

  const openMenuAt = (x: number, y: number, relPath: string, isDir: boolean) => {
    if (!hasEntryMenu) return;
    setMenu({ x, y, relPath, isDir });
  };

  const onRowContextMenu = (
    event: ReactMouseEvent,
    relPath: string,
    isDir: boolean,
  ) => {
    if (!hasEntryMenu) return;
    event.preventDefault();
    openMenuAt(event.clientX, event.clientY, relPath, isDir);
  };

  const onMoreClick = (
    event: ReactMouseEvent<HTMLButtonElement>,
    relPath: string,
    isDir: boolean,
  ) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openMenuAt(rect.left, rect.bottom + 2, relPath, isDir);
  };

  const menuAction = (fn: ((relPath: string, isDir: boolean) => void) | undefined) => {
    if (menu === null) return;
    setMenu(null);
    fn?.(menu.relPath, menu.isDir);
  };

  const moreButton = (relPath: string, isDir: boolean): ReactNode =>
    hasEntryMenu ? (
      <button
        type="button"
        className="tree-btn tree-more"
        title="操作…"
        aria-label={`${relPath} の操作`}
        onClick={(e) => onMoreClick(e, relPath, isDir)}
      >
        ⋯
      </button>
    ) : null;

  const renderEntries = (entries: TreeEntry[], depth: number): ReactNode[] =>
    entries.map((entry) => {
      const indent = { paddingLeft: 4 + depth * 14 };

      if (entry.isDir) {
        const isExpanded = expanded.has(entry.relPath);
        const notePath = folderNotePath(entry);
        const isSelected = notePath !== null && selected === notePath;
        const isFolderNote = folderNotes.get(entry.relPath) === true;
        return (
          <div key={entry.relPath}>
            <div
              className={
                "tree-row tree-dir" + (isSelected ? " selected" : "")
              }
              style={indent}
              onContextMenu={(e) => onRowContextMenu(e, entry.relPath, true)}
            >
              <button
                type="button"
                className="tree-btn tree-chevron"
                aria-label={isExpanded ? "Collapse" : "Expand"}
                onClick={() => toggle(entry.relPath)}
              >
                {isExpanded ? "▾" : "▸"}
              </button>
              {isFolderNote && (
                <span
                  className="tree-foldernote"
                  title="フォルダページ（本文が埋め込みのみ）"
                  aria-hidden="true"
                >
                  🗂
                </span>
              )}
              <span
                className={"tree-label" + (notePath ? " tree-page" : "")}
                title={entry.relPath}
                onClick={() =>
                  notePath ? onSelect(notePath) : toggle(entry.relPath)
                }
              >
                {entry.name}
              </span>
              {moreButton(entry.relPath, true)}
              <button
                type="button"
                className="tree-btn tree-add"
                title="ここに新規ページ"
                disabled={busy}
                onClick={() => void handleCreate(entry.relPath)}
              >
                +
              </button>
            </div>
            {isExpanded && renderEntries(entry.children ?? [], depth + 1)}
          </div>
        );
      }

      const isSelected = selected === entry.relPath;
      return (
        <div
          key={entry.relPath}
          className={"tree-row tree-file" + (isSelected ? " selected" : "")}
          style={indent}
          title={entry.relPath}
          onClick={() => onSelect(entry.relPath)}
          onContextMenu={(e) => onRowContextMenu(e, entry.relPath, false)}
        >
          <span className="tree-chevron-spacer" aria-hidden="true" />
          <span className="tree-label tree-page">{stripMd(entry.name)}</span>
          {moreButton(entry.relPath, false)}
        </div>
      );
    });

  return (
    <nav className="file-tree">
      <div className="file-tree-toolbar">
        <span className="file-tree-title">Pages</span>
        <button
          type="button"
          className="tree-btn"
          title="ルートに新規ページ"
          disabled={busy}
          onClick={() => void handleCreate("")}
        >
          +
        </button>
        <button
          type="button"
          className="tree-btn"
          title="ツリーを再読込"
          onClick={() => void load(false)}
        >
          {"↻"}
        </button>
      </div>
      {error !== null && <div className="file-tree-error">{error}</div>}
      {tree === null && error === null && (
        <div className="file-tree-status">Loading…</div>
      )}
      {tree !== null && tree.length === 0 && (
        <div className="file-tree-status">No pages yet.</div>
      )}
      {tree !== null && (
        <div className="file-tree-list">{renderEntries(tree, 0)}</div>
      )}

      {menu !== null && (
        <>
          <div
            className="context-menu-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="context-menu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
          >
            {onRenameEntry !== undefined && (
              <button role="menuitem" onClick={() => menuAction(onRenameEntry)}>
                改名
              </button>
            )}
            {onMoveEntry !== undefined && (
              <button role="menuitem" onClick={() => menuAction(onMoveEntry)}>
                移動
              </button>
            )}
            {onDeleteEntry !== undefined && (
              <button
                role="menuitem"
                className="danger"
                onClick={() => menuAction(onDeleteEntry)}
              >
                削除
              </button>
            )}
          </div>
        </>
      )}
    </nav>
  );
}
