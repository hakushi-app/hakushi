//! HTTPS PAT storage in the OS keychain (M7, docs/dev/INTERFACES.md §11.2,
//! docs/dev/M7-M8-PLAN.md §1.3).
//!
//! service = "hakushi", account = host (e.g. "github.com"). The token is
//! **never** returned to the TS side — only `set` / `clear` / `has` are
//! exposed. The sync path reads it internally via [`token_for_url`].
//!
//! Backend availability is decided by the `keyring` features in Cargo.toml:
//! apple-native (macOS/iOS Keychain), windows-native (Credential Manager),
//! linux-native (kernel keyutils). Android matches no backend and falls back
//! to keyring's in-memory mock, which is fine — Android sync is
//! unsupported/pull-only in M7 (docs/dev/M7-M8-PLAN.md §1.7).

use keyring::Entry;

const SERVICE: &str = "hakushi";

/// Extract the host from a remote URL for use as the keychain account.
/// `https://github.com/o/r.git` → `github.com`. Returns `None` for URLs
/// without a host (file:// and bare absolute paths need no credentials).
pub fn host_from_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    // Strip any userinfo ("user@host"), then take up to the first '/', ':',
    // or '?'. Empty host (e.g. "https:///path") yields None.
    let after_userinfo = rest.rsplit_once('@').map(|(_, h)| h).unwrap_or(rest);
    let host: String = after_userinfo
        .chars()
        .take_while(|c| !matches!(c, '/' | ':' | '?' | '#'))
        .collect();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// The keychain username sent alongside the PAT for a given host
/// (docs/dev/M7-M8-PLAN.md §1.2). GitLab wants "oauth2"; GitHub and most
/// others accept any username with a valid PAT, so we use the conventional
/// "x-access-token".
pub fn username_for_host(host: &str) -> &'static str {
    let h = host.to_ascii_lowercase();
    if h == "gitlab.com" || h.starts_with("gitlab.") || h.contains(".gitlab.") {
        "oauth2"
    } else {
        "x-access-token"
    }
}

fn entry(host: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, host).map_err(|e| format!("keychain error: {e}"))
}

/// Store `token` for `host`, overwriting any existing entry.
pub fn set(host: &str, token: &str) -> Result<(), String> {
    entry(host)?
        .set_password(token)
        .map_err(|e| format!("could not save credential: {e}"))
}

/// Remove the stored token for `host`. Succeeds even if none was stored.
pub fn clear(host: &str) -> Result<(), String> {
    match entry(host)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not delete credential: {e}")),
    }
}

/// Is a token stored for `host`?
pub fn has(host: &str) -> Result<bool, String> {
    match entry(host)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("keychain error: {e}")),
    }
}

/// The (username, token) pair to use when authenticating to `url`, or `None`
/// when the URL needs no credentials (file:// / absolute path) or no token is
/// stored. Used only inside the sync path — never surfaced to TS.
pub fn token_for_url(url: &str) -> Option<(&'static str, String)> {
    let host = host_from_url(url)?;
    let token = entry(&host).ok()?.get_password().ok()?;
    Some((username_for_host(&host), token))
}

// ---------------------------------------------------------------------------
// Tauri commands (docs/dev/INTERFACES.md §11.2). No `get` command exists by
// design — the token is write-only from TS's perspective.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn credential_set(host: String, token: String) -> Result<(), String> {
    if host.trim().is_empty() {
        return Err("host is required".to_string());
    }
    if token.is_empty() {
        return Err("token is required".to_string());
    }
    set(&host, &token)
}

#[tauri::command]
pub fn credential_clear(host: String) -> Result<(), String> {
    if host.trim().is_empty() {
        return Err("host is required".to_string());
    }
    clear(&host)
}

#[tauri::command]
pub fn credential_has(host: String) -> Result<bool, String> {
    if host.trim().is_empty() {
        return Err("host is required".to_string());
    }
    has(&host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_extraction() {
        assert_eq!(host_from_url("https://github.com/o/r.git").as_deref(), Some("github.com"));
        assert_eq!(host_from_url("https://github.com").as_deref(), Some("github.com"));
        assert_eq!(
            host_from_url("https://user@gitlab.example.com:443/o/r").as_deref(),
            Some("gitlab.example.com")
        );
        assert_eq!(host_from_url("http://localhost:8080/r").as_deref(), Some("localhost"));
        // No host → no credentials needed.
        assert_eq!(host_from_url("file:///tmp/repo"), None);
        assert_eq!(host_from_url("/tmp/repo"), None);
        assert_eq!(host_from_url("https:///nohost"), None);
        assert_eq!(host_from_url("ssh://git@github.com/o/r"), None);
    }

    #[test]
    fn username_mapping() {
        assert_eq!(username_for_host("github.com"), "x-access-token");
        assert_eq!(username_for_host("GitHub.com"), "x-access-token");
        assert_eq!(username_for_host("gitlab.com"), "oauth2");
        assert_eq!(username_for_host("gitlab.example.org"), "oauth2");
        assert_eq!(username_for_host("git.example.gitlab.io"), "oauth2");
        assert_eq!(username_for_host("bitbucket.org"), "x-access-token");
    }
}
