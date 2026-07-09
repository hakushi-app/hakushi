# Security Policy

Hakushi is a local-first application that handles your notes, git credentials,
and network sync. We take security reports seriously and appreciate responsible
disclosure.

## Supported versions

Hakushi is pre-1.0. Only the latest release line receives security fixes.

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub:
[**Report a vulnerability**](https://github.com/0Myu0001/Hakushi/security/advisories/new)
(repository → *Security* → *Advisories* → *Report a vulnerability*). This opens
a private advisory visible only to you and the maintainers.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a minimal repro or PoC is ideal).
- Affected platform(s): macOS / Windows / Linux / iOS / Android, and the build
  (desktop `git-libgit2` vs. mobile `git-gix`).
- The Hakushi version (Help → About, or the `version` in `tauri.conf.json`).

**Never paste tokens, Personal Access Tokens (PATs), passwords, or private
repository contents into a report.** Redact them.

### Response targets

- **Acknowledgement:** within 5 business days.
- **Triage / initial assessment:** within 10 business days.
- **Coordinated disclosure:** we aim to ship a fix within 90 days and will
  credit reporters who wish to be named.

## Scope

Hakushi's security-relevant surfaces:

- **Credential handling** — HTTPS PATs are stored in the OS keychain (service
  `hakushi`, account = host) and are **never returned to the web/TS layer** by
  design. Bugs that leak a PAT to the frontend, to disk, or over the wire are
  in scope.
- **Git sync** — fetch / merge / push, ref manipulation (`refs/hakushi/*`), and
  conflict resolution. Injection or path-traversal via crafted refs, branch
  names, or Markdown paths is in scope.
- **Content rendering** — Markdown → mdast → HTML/embeds. XSS or code execution
  via crafted note content, embeds (`::embed`), or static-site export is in
  scope. Note the app runs under a Content-Security-Policy
  (`app.security.csp` in `tauri.conf.json`); CSP bypasses are in scope.
- **Tauri IPC / commands** — command handlers exposed to the webview.

Out of scope:

- The security of the **remote git host** (GitHub/GitLab/your bare repo) itself.
- The security of the **user's OS keychain** implementation.
- Social-engineering or physical-access attacks.
- Issues requiring a malicious build of Hakushi (supply your own).

## Safe harbor

Good-faith security research that respects users' privacy, avoids data
destruction, and gives us reasonable time to respond will not be pursued as a
violation of our terms. Thank you for helping keep Hakushi users safe.
