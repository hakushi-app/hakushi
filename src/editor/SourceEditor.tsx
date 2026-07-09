// Track C — CodeMirror 6 markdown source editor (INTERFACES.md §4).
//
// Edits the FULL file text (frontmatter visible, rule 3). The component never
// writes to disk itself — EditorPane pulls the text via `getContent()` and
// pushes it through the canonical pipeline (`normalizeMarkdown` → writeFile).

import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export interface SourceEditorHandle {
  /** Current full-file text as typed in the editor. */
  getContent(): string;
}

export interface SourceEditorProps {
  /** Initial full-file content (frontmatter included). */
  content: string;
  /** Called whenever the document changes. */
  onDirty(): void;
}

export const SourceEditor = forwardRef<SourceEditorHandle, SourceEditorProps>(
  function SourceEditor({ content, onDirty }, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    // Keep the latest callback without recreating the editor view.
    const onDirtyRef = useRef(onDirty);
    onDirtyRef.current = onDirty;

    // (Re)create the view when the initial content changes — EditorPane only
    // changes `content` on file load and view switch, both of which are
    // logically "open a fresh document".
    useEffect(() => {
      const host = hostRef.current;
      if (host === null) return undefined;
      const state = EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          markdown({ codeLanguages: languages }),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onDirtyRef.current();
          }),
        ],
      });
      const view = new EditorView({ state, parent: host });
      viewRef.current = view;
      return () => {
        view.destroy();
        viewRef.current = null;
      };
    }, [content]);

    useImperativeHandle(
      ref,
      () => ({
        getContent: () => viewRef.current?.state.doc.toString() ?? content,
      }),
      [content],
    );

    return <div className="source-editor" ref={hostRef} />;
  },
);
