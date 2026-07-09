import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri dev server settings: fixed port, no clear-screen so cargo logs stay visible.
export default defineConfig({
  plugins: [react()],
  // Public base path. Defaults to "/" (Tauri bundles, custom domain). The web
  // release workflow sets BASE_PATH="/hakushi/" so assets resolve under the
  // GitHub Pages project sub-path (https://<user>.github.io/hakushi/).
  base: process.env.BASE_PATH || "/",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // M8 (§2.7-2): split the heavy editor/markdown vendors out of the app
    // entry chunk. Before this the single index-*.js was ~1.4 MB and tripped
    // the 500 kB chunk-size warning; grouping the big third-party trees into
    // named vendor chunks keeps the app chunk small and the warning silent.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          // ProseMirror engine (the heaviest half of the WYSIWYG editor).
          if (/[\\/]node_modules[\\/]prosemirror-/.test(id)) {
            return "vendor-prosemirror";
          }
          // TipTap wrappers + extensions on top of ProseMirror.
          if (/[\\/]node_modules[\\/]@tiptap[\\/]/.test(id)) {
            return "vendor-tiptap";
          }
          // CodeMirror source-editor CORE only. The ~150 on-demand language
          // modes (@codemirror/lang-*, @codemirror/legacy-modes, and the
          // @codemirror/language-data loader) are already dynamically imported
          // by CodeMirror, so leave them as their own lazy chunks — folding
          // them in here would rebuild the very megabyte chunk we're splitting.
          if (
            /[\\/]node_modules[\\/](@codemirror[\\/](state|view|language|commands|search|autocomplete|lint)|@lezer[\\/](common|highlight|lr)|codemirror)[\\/]/.test(
              id,
            )
          ) {
            return "vendor-codemirror";
          }
          // Markdown pipeline: unified / remark / rehype / mdast / micromark /
          // hast. NOT the docx exporter (mdast2docx / @m2d / docx) — that is
          // already dynamically imported in docx.ts and must stay its own lazy
          // chunk (folding it in here would re-bloat the eager markdown chunk).
          if (
            /[\\/]node_modules[\\/](unified|remark-?[a-z-]*|rehype-[a-z-]*|mdast-?[a-z-]*|micromark[a-z-]*|hast-?[a-z-]*|unist-[a-z-]*|vfile[a-z-]*|property-information|space-separated-tokens|comma-separated-tokens|zwitch|longest-streak|ccount|markdown-table|decode-named-character-reference|character-entities[a-z-]*|parse-entities|stringify-entities)[\\/]/.test(
              id,
            )
          ) {
            return "vendor-markdown";
          }
          // Browser git stack (web backend): isomorphic-git + lightning-fs +
          // the Buffer polyfill. Only pulled into the web build's runtime.
          if (
            /[\\/]node_modules[\\/](isomorphic-git|@isomorphic-git[\\/]lightning-fs|buffer)[\\/]/.test(
              id,
            )
          ) {
            return "vendor-git";
          }
          // React runtime in its own stable chunk.
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return "vendor-react";
          }
          return undefined;
        },
      },
    },
  },
});
