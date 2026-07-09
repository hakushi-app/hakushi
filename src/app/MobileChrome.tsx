// Track C3 — mobile top chrome: hamburger button (M8, INTERFACES.md §12.4).
//
// Renders a top bar (hamburger + workspace title) that is visible ONLY on
// mobile (`.mobile-topbar` is display:none until the 768px media query). The
// hamburger toggles the sidebar drawer owned by App.tsx. Kept tiny and
// presentation-only so App's edits stay surgical.

export interface MobileChromeProps {
  /** True below the 768px breakpoint (from useIsMobile). */
  isMobile: boolean;
  /** Whether the sidebar drawer is currently open (for aria-expanded). */
  drawerOpen: boolean;
  /** Toggle the sidebar drawer. */
  onToggleDrawer(): void;
}

/**
 * Mobile-only top bar. Returns null on desktop so it adds zero DOM there.
 * The ≥44px tap target for the hamburger is enforced in styles.css.
 */
export function MobileChrome({ isMobile, drawerOpen, onToggleDrawer }: MobileChromeProps) {
  if (!isMobile) return null;
  return (
    <header className="mobile-topbar">
      <button
        type="button"
        className="hamburger-btn"
        aria-label="メニューを開く"
        aria-expanded={drawerOpen}
        onClick={onToggleDrawer}
      >
        <span className="hamburger-icon" aria-hidden="true">
          ☰
        </span>
      </button>
      <span className="mobile-topbar-title">白紙 Hakushi</span>
    </header>
  );
}
