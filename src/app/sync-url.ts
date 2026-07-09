// Track S2 — pure URL helper for the sync settings UI (M7, PLAN §1.3).
//
// The keyring credential key is the remote's host name (INTERFACES.md §11.1:
// service "hakushi", account = host, e.g. "github.com"). This helper extracts
// that host from whatever the user typed into the remote-URL field. Only
// http(s) remotes need a PAT; file:// remotes and plain local paths return
// null (no credential required).

/** Host name for credential storage, or null when the URL needs no PAT. */
export function hostFromSyncUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    // hostname (not host): the keychain account is the bare host name
    // without a port, matching the Rust side's keyring key.
    const host = new URL(trimmed).hostname;
    return host === "" ? null : host.toLowerCase();
  } catch {
    return null;
  }
}
