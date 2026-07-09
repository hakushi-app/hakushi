// Track C3 — mobile off-canvas drawer wrapper (M8, INTERFACES.md §12.4).
//
// On desktop this is a passthrough (the sidebar sits in normal flow). On
// mobile the sidebar becomes an off-canvas panel translated in from the left
// with a dimmed backdrop; the transform + backdrop live in styles.css so the
// slide is GPU-composited and desktop is completely unaffected.
//
// Presentation only: `open`/`onClose`/`isMobile` are owned by App.tsx.

import { useEffect, type ReactNode } from "react";

export interface DrawerProps {
  /** True below the 768px breakpoint (from useIsMobile). */
  isMobile: boolean;
  /** Whether the drawer is currently slid open (mobile only). */
  open: boolean;
  /** Request close (backdrop tap / Escape). */
  onClose(): void;
  /** ARIA label for the drawer region. */
  ariaLabel?: string;
  children: ReactNode;
}

/**
 * Wraps the sidebar. Desktop → renders children in place. Mobile → renders an
 * off-canvas <aside> plus a backdrop that closes it. The child (the real
 * <aside className="sidebar">) is untouched; we only add positioning classes
 * and a backdrop around it.
 */
export function Drawer({ isMobile, open, onClose, ariaLabel, children }: DrawerProps) {
  // Close on Escape while open on mobile.
  useEffect(() => {
    if (!isMobile || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile, open, onClose]);

  if (!isMobile) {
    // Desktop: no wrapper, no backdrop — identical DOM/behavior to pre-M8.
    return <>{children}</>;
  }

  return (
    <>
      {open && (
        <div
          className="drawer-backdrop"
          aria-hidden="true"
          onClick={onClose}
        />
      )}
      <div
        className={open ? "drawer-shell open" : "drawer-shell"}
        role="dialog"
        aria-modal={open}
        aria-label={ariaLabel}
        aria-hidden={!open}
      >
        {children}
      </div>
    </>
  );
}
