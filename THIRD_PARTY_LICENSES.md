# Third-Party Licenses

Hakushi is distributed under the [MIT License](LICENSE). It builds on open-source
components whose own licenses continue to apply. This file inventories them and
records the license decisions that matter for redistribution.

> This inventory is **generated** from `src-tauri/Cargo.lock` and
> `package-lock.json` at the `v0.1.0` dependency set. Regenerate it whenever
> dependencies change — see [Regenerating](#regenerating). The generated crate
> metadata reports the license of each *crate*; where a crate vendors a C
> library with a **different** license (libgit2, OpenSSL, SQLite), that is
> called out explicitly under [Components requiring attention](#components-requiring-specific-attention).

## Summary

- **No strong copyleft (GPL / AGPL / LGPL) is a *required* license anywhere in
  the shipped dependency graph.** Hakushi can be redistributed under MIT.
- Rust: **463** crates, overwhelmingly `MIT` / `Apache-2.0` / `BSD` /
  `Zlib` / `Unicode-3.0` (all permissive).
- npm (production/bundled): **360** packages, overwhelmingly `MIT` / `ISC`.
- A handful of `MPL-2.0` components (weak, file-level copyleft) are present and
  are fine to redistribute; they are listed below for attribution.

## License distribution — Rust (compiled into the binary)

| License | Count |
|---|---|
| `MIT OR Apache-2.0` | 223 |
| `MIT` | 106 |
| `Apache-2.0 OR MIT` | 35 |
| `MIT/Apache-2.0` | 24 |
| `Unicode-3.0` | 18 |
| `Zlib OR Apache-2.0 OR MIT` | 17 |
| `MPL-2.0` | 5 |
| `Unlicense OR MIT` | 4 |
| `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT` | 3 |
| `Apache-2.0/MIT` | 3 |
| `Apache-2.0` | 2 |
| `BSD-2-Clause OR Apache-2.0 OR MIT` | 2 |
| `BSD-3-Clause` | 2 |
| `BSD-3-Clause OR MIT OR Apache-2.0` | 2 |
| `MIT OR Apache-2.0 OR LGPL-2.1-or-later` | 2 |
| `MIT OR Apache-2.0 OR Zlib` | 2 |
| `Unlicense/MIT` | 2 |
| `(MIT OR Apache-2.0) AND Unicode-3.0` | 1 |
| `0BSD OR MIT OR Apache-2.0` | 1 |
| `Apache-2.0 / MIT` | 1 |
| `Apache-2.0 AND MIT` | 1 |
| `Apache-2.0 WITH LLVM-exception` | 1 |
| `BSD-3-Clause AND MIT` | 1 |
| `BSD-3-Clause/MIT` | 1 |
| `CC0-1.0 OR MIT-0 OR Apache-2.0` | 1 |
| `ISC` | 1 |
| `MIT OR Zlib OR Apache-2.0` | 1 |
| `Zlib` | 1 |

## License distribution — npm (bundled into the web assets)

| License | Count |
|---|---|
| `MIT` | 297 |
| `ISC` | 36 |
| `MPL-2.0` | 13 |
| `BSD-3-Clause` | 3 |
| `UNKNOWN` | 3 |
| `(MIT AND Zlib)` | 1 |
| `(MIT OR GPL-3.0-or-later)` | 1 |
| `(MPL-2.0 OR Apache-2.0)` | 1 |
| `Apache-2.0` | 1 |
| `Apache-2.0 OR MIT` | 1 |
| `BlueOak-1.0.0` | 1 |
| `MIT OR Apache-2.0` | 1 |
| `Unlicense` | 1 |

## Components requiring specific attention

These are the items where the crate/package metadata above does **not** tell the
whole story, or where a redistribution obligation exists.

### libgit2 — GPL-2.0 **with a linking exception** (desktop builds only)

`libgit2-sys` (the Rust binding) is MIT/Apache-2.0, but it **vendors the libgit2
C library** (`libgit2-sys@0.18.5+1.9.4` → libgit2 1.9.4), which is licensed
**GPL-2.0 with a linking exception**. The linking exception explicitly permits
linking libgit2 into a work under a different license (including MIT) and
distributing the combined binary, provided libgit2's own license notice is
preserved. Hakushi honors this by shipping the notice.

- Applies to: **desktop** builds only (`--features git-libgit2`, the default).
- **Mobile builds do not include libgit2** — they use `gix` (pure Rust).
- License text: <https://github.com/libgit2/libgit2/blob/main/COPYING>

### OpenSSL — Apache-2.0 (desktop builds only)

`openssl-src@300.6.1+3.6.3` vendors **OpenSSL 3.6.3**, licensed **Apache-2.0**.
Pulled in by `git2/vendored-openssl` for HTTPS on desktop.

- Applies to: **desktop** builds only. **Mobile uses rustls (pure Rust)** via
  `gix` and does **not** link OpenSSL.

### SQLite — Public Domain

`libsqlite3-sys` (`bundled`) compiles the **SQLite** amalgamation from source
for the link index (`.hakushi/index.db`). SQLite is in the **public domain**; no
attribution is required, but we note it for completeness.

### MPL-2.0 components (weak, file-level copyleft)

MPL-2.0 requires that if you *modify* an MPL-covered source file and distribute
it, you make that file's source available. Merely *using / linking* the
unmodified package (as Hakushi does) imposes no obligation on Hakushi's own MIT
code. Source for all of these is published on npm / crates.io.

- **Rust:** `cssparser`, `cssparser-macros`, `dtoa-short`, `option-ext`, `selectors` (Servo CSS parsing, pulled in transitively).
- **npm:** `@m2d/core`, `@m2d/emoji`, `@m2d/html`, `@m2d/image`, `@m2d/list`, `@m2d/math`, `@m2d/mdast`, `@m2d/mermaid`, `@m2d/table`, `@svg-fns/io`, `@svg-fns/svg2img`, `dompurify`, `latex-math`, `mdast2docx` (the `mdast2docx` Docx-export toolchain).

### Dual-licensed packages (permissive option elected)

Where a dependency is offered under multiple licenses, Hakushi elects the
permissive option:

- `jszip` — `(MIT OR GPL-3.0-or-later)` → **MIT** elected.
- `dompurify` — `(MPL-2.0 OR Apache-2.0)` → **Apache-2.0** elected.

### Unverified — resolve before a signed release

The quick scan could not resolve a license for these npm packages (nested /
optional installs). Their upstreams are permissive (xmldom = MIT, khroma = MIT,
sharp = Apache-2.0), but the canonical inventory must confirm this via tooling:

- `@xmldom/xmldom`
- `khroma`
- `sharp`

## Regenerating

This file is a point-in-time snapshot. Regenerate the machine-readable inventory
before each release:

```bash
# Rust — full per-crate license report (install once)
cargo install cargo-about
cd src-tauri && cargo about generate about.hbs > ../reports/rust-licenses.html
#   or a quick table:
cargo install cargo-license && cargo license

# npm — production dependency licenses
npx license-checker --production --json > reports/npm-licenses.json
```

An `about.toml` + `about.hbs` (cargo-about config + template) are committed in
`src-tauri/` so `cargo about` runs without additional setup.

---

## Appendix A — Rust crates (463)

- `adler2@2.0.1` — 0BSD OR MIT OR Apache-2.0
- `aho-corasick@1.1.4` — Unlicense OR MIT
- `alloc-no-stdlib@2.0.4` — BSD-3-Clause
- `alloc-stdlib@0.2.4` — BSD-3-Clause
- `android_system_properties@0.1.5` — MIT/Apache-2.0
- `anyhow@1.0.103` — MIT OR Apache-2.0
- `atk@0.18.2` — MIT
- `atk-sys@0.18.2` — MIT
- `atomic-waker@1.1.2` — Apache-2.0 OR MIT
- `autocfg@1.5.1` — Apache-2.0 OR MIT
- `base64@0.21.7` — MIT OR Apache-2.0
- `base64@0.22.1` — MIT OR Apache-2.0
- `bit-set@0.8.0` — Apache-2.0 OR MIT
- `bit-vec@0.8.0` — Apache-2.0 OR MIT
- `bitflags@1.3.2` — MIT/Apache-2.0
- `bitflags@2.13.0` — MIT OR Apache-2.0
- `block-buffer@0.10.4` — MIT OR Apache-2.0
- `block2@0.6.2` — MIT
- `brotli@8.0.4` — BSD-3-Clause AND MIT
- `brotli-decompressor@5.0.3` — BSD-3-Clause/MIT
- `bs58@0.5.1` — MIT/Apache-2.0
- `bumpalo@3.20.3` — MIT OR Apache-2.0
- `bytemuck@1.25.0` — Zlib OR Apache-2.0 OR MIT
- `byteorder@1.5.0` — Unlicense OR MIT
- `bytes@1.12.0` — MIT
- `cairo-rs@0.18.5` — MIT
- `cairo-sys-rs@0.18.2` — MIT
- `camino@1.2.4` — MIT OR Apache-2.0
- `cargo_metadata@0.19.2` — MIT
- `cargo_toml@0.22.3` — Apache-2.0 OR MIT
- `cargo-platform@0.1.9` — MIT OR Apache-2.0
- `cc@1.2.65` — MIT OR Apache-2.0
- `cesu8@1.1.0` — Apache-2.0/MIT
- `cfb@0.7.3` — MIT
- `cfg-expr@0.15.8` — MIT OR Apache-2.0
- `cfg-if@1.0.4` — MIT OR Apache-2.0
- `chrono@0.4.45` — MIT OR Apache-2.0
- `combine@4.6.7` — MIT
- `cookie@0.18.1` — MIT OR Apache-2.0
- `core-foundation@0.10.1` — MIT OR Apache-2.0
- `core-foundation@0.9.4` — MIT OR Apache-2.0
- `core-foundation-sys@0.8.7` — MIT OR Apache-2.0
- `core-graphics@0.25.0` — MIT OR Apache-2.0
- `core-graphics-types@0.2.0` — MIT OR Apache-2.0
- `cpufeatures@0.2.17` — MIT OR Apache-2.0
- `crc32fast@1.5.0` — MIT OR Apache-2.0
- `crossbeam-channel@0.5.15` — MIT OR Apache-2.0
- `crossbeam-utils@0.8.21` — MIT OR Apache-2.0
- `crypto-common@0.1.7` — MIT OR Apache-2.0
- `cssparser@0.36.0` — MPL-2.0
- `cssparser-macros@0.6.1` — MPL-2.0
- `ctor@0.8.0` — Apache-2.0 OR MIT
- `ctor-proc-macro@0.0.7` — Apache-2.0 OR MIT
- `darling@0.23.0` — MIT
- `darling_core@0.23.0` — MIT
- `darling_macro@0.23.0` — MIT
- `dbus@0.9.12` — Apache-2.0/MIT
- `deranged@0.5.8` — MIT OR Apache-2.0
- `derive_more@2.1.1` — MIT
- `derive_more-impl@2.1.1` — MIT
- `digest@0.10.7` — MIT OR Apache-2.0
- `dirs@6.0.0` — MIT OR Apache-2.0
- `dirs-sys@0.5.0` — MIT OR Apache-2.0
- `dispatch2@0.3.1` — Zlib OR Apache-2.0 OR MIT
- `displaydoc@0.2.6` — MIT OR Apache-2.0
- `dlopen2@0.8.2` — MIT
- `dlopen2_derive@0.4.3` — MIT
- `dom_query@0.27.0` — MIT
- `dpi@0.1.2` — Apache-2.0 AND MIT
- `dtoa@1.0.11` — MIT OR Apache-2.0
- `dtoa-short@0.3.5` — MPL-2.0
- `dtor@0.3.0` — Apache-2.0 OR MIT
- `dtor-proc-macro@0.0.6` — Apache-2.0 OR MIT
- `dunce@1.0.5` — CC0-1.0 OR MIT-0 OR Apache-2.0
- `dyn-clone@1.0.20` — MIT OR Apache-2.0
- `embed_plist@1.2.2` — MIT OR Apache-2.0
- `embed-resource@3.0.11` — MIT
- `equivalent@1.0.2` — Apache-2.0 OR MIT
- `erased-serde@0.4.10` — MIT OR Apache-2.0
- `fallible-iterator@0.3.0` — MIT/Apache-2.0
- `fallible-streaming-iterator@0.1.9` — MIT/Apache-2.0
- `fastrand@2.4.1` — Apache-2.0 OR MIT
- `fdeflate@0.3.7` — MIT OR Apache-2.0
- `field-offset@0.3.6` — MIT OR Apache-2.0
- `find-msvc-tools@0.1.9` — MIT OR Apache-2.0
- `flate2@1.1.9` — MIT OR Apache-2.0
- `fnv@1.0.7` — Apache-2.0 / MIT
- `foldhash@0.2.0` — Zlib
- `foreign-types@0.5.0` — MIT/Apache-2.0
- `foreign-types-macros@0.2.3` — MIT/Apache-2.0
- `foreign-types-shared@0.3.1` — MIT/Apache-2.0
- `form_urlencoded@1.2.2` — MIT OR Apache-2.0
- `futures-channel@0.3.32` — MIT OR Apache-2.0
- `futures-core@0.3.32` — MIT OR Apache-2.0
- `futures-executor@0.3.32` — MIT OR Apache-2.0
- `futures-io@0.3.32` — MIT OR Apache-2.0
- `futures-macro@0.3.32` — MIT OR Apache-2.0
- `futures-sink@0.3.32` — MIT OR Apache-2.0
- `futures-task@0.3.32` — MIT OR Apache-2.0
- `futures-util@0.3.32` — MIT OR Apache-2.0
- `gdk@0.18.2` — MIT
- `gdk-pixbuf@0.18.5` — MIT
- `gdk-pixbuf-sys@0.18.0` — MIT
- `gdk-sys@0.18.2` — MIT
- `gdkwayland-sys@0.18.2` — MIT
- `gdkx11@0.18.2` — MIT
- `gdkx11-sys@0.18.2` — MIT
- `generic-array@0.14.7` — MIT
- `getrandom@0.2.17` — MIT OR Apache-2.0
- `getrandom@0.3.4` — MIT OR Apache-2.0
- `getrandom@0.4.3` — MIT OR Apache-2.0
- `gio@0.18.4` — MIT
- `gio-sys@0.18.1` — MIT
- `git2@0.20.4` — MIT OR Apache-2.0
- `glib@0.18.5` — MIT
- `glib-macros@0.18.5` — MIT
- `glib-sys@0.18.1` — MIT
- `glob@0.3.3` — MIT OR Apache-2.0
- `gobject-sys@0.18.0` — MIT
- `gtk@0.18.2` — MIT
- `gtk-sys@0.18.2` — MIT
- `gtk3-macros@0.18.2` — MIT
- `hashbrown@0.12.3` — MIT OR Apache-2.0
- `hashbrown@0.16.1` — MIT OR Apache-2.0
- `hashbrown@0.17.1` — MIT OR Apache-2.0
- `hashlink@0.12.0` — MIT OR Apache-2.0
- `heck@0.4.1` — MIT OR Apache-2.0
- `heck@0.5.0` — MIT OR Apache-2.0
- `hex@0.4.3` — MIT OR Apache-2.0
- `html5ever@0.38.0` — MIT OR Apache-2.0
- `http@1.4.2` — MIT OR Apache-2.0
- `http-body@1.0.1` — MIT
- `http-body-util@0.1.3` — MIT
- `httparse@1.10.1` — MIT OR Apache-2.0
- `hyper@1.10.1` — MIT
- `hyper-util@0.1.20` — MIT
- `iana-time-zone@0.1.65` — MIT OR Apache-2.0
- `iana-time-zone-haiku@0.1.2` — MIT OR Apache-2.0
- `ico@0.5.0` — MIT
- `icu_collections@2.2.0` — Unicode-3.0
- `icu_locale_core@2.2.0` — Unicode-3.0
- `icu_normalizer@2.2.0` — Unicode-3.0
- `icu_normalizer_data@2.2.0` — Unicode-3.0
- `icu_properties@2.2.0` — Unicode-3.0
- `icu_properties_data@2.2.0` — Unicode-3.0
- `icu_provider@2.2.0` — Unicode-3.0
- `ident_case@1.0.1` — MIT/Apache-2.0
- `idna@1.1.0` — MIT OR Apache-2.0
- `idna_adapter@1.2.2` — Apache-2.0 OR MIT
- `indexmap@1.9.3` — Apache-2.0 OR MIT
- `indexmap@2.14.0` — Apache-2.0 OR MIT
- `infer@0.19.0` — MIT
- `ipnet@2.12.0` — MIT OR Apache-2.0
- `itoa@1.0.18` — MIT OR Apache-2.0
- `javascriptcore-rs@1.1.2` — MIT
- `javascriptcore-rs-sys@1.1.1` — MIT
- `jni@0.21.1` — MIT/Apache-2.0
- `jni-sys@0.3.1` — MIT OR Apache-2.0
- `jni-sys@0.4.1` — MIT OR Apache-2.0
- `jni-sys-macros@0.4.1` — MIT OR Apache-2.0
- `jobserver@0.1.34` — MIT OR Apache-2.0
- `js-sys@0.3.103` — MIT OR Apache-2.0
- `json-patch@3.0.1` — MIT/Apache-2.0
- `jsonptr@0.6.3` — MIT OR Apache-2.0
- `keyboard-types@0.7.0` — MIT OR Apache-2.0
- `keyring@3.6.3` — MIT OR Apache-2.0
- `libappindicator@0.9.0` — Apache-2.0 OR MIT
- `libappindicator-sys@0.9.0` — Apache-2.0 OR MIT
- `libc@0.2.186` — MIT OR Apache-2.0
- `libdbus-sys@0.2.7` — Apache-2.0/MIT
- `libgit2-sys@0.18.5+1.9.4` — MIT OR Apache-2.0
- `libloading@0.7.4` — ISC
- `libredox@0.1.18` — MIT
- `libsqlite3-sys@0.38.1` — MIT
- `libz-sys@1.1.29` — MIT OR Apache-2.0
- `linux-keyutils@0.2.5` — Apache-2.0 OR MIT
- `litemap@0.8.2` — Unicode-3.0
- `lock_api@0.4.14` — MIT OR Apache-2.0
- `log@0.4.33` — MIT OR Apache-2.0
- `markup5ever@0.38.0` — MIT OR Apache-2.0
- `memchr@2.8.2` — Unlicense OR MIT
- `memoffset@0.9.1` — MIT
- `mime@0.3.17` — MIT OR Apache-2.0
- `miniz_oxide@0.8.9` — MIT OR Zlib OR Apache-2.0
- `mio@1.2.1` — MIT
- `muda@0.19.3` — Apache-2.0 OR MIT
- `ndk@0.9.0` — MIT OR Apache-2.0
- `ndk-sys@0.6.0+11769913` — MIT OR Apache-2.0
- `new_debug_unreachable@1.0.6` — MIT
- `num_enum@0.7.6` — BSD-3-Clause OR MIT OR Apache-2.0
- `num_enum_derive@0.7.6` — BSD-3-Clause OR MIT OR Apache-2.0
- `num-conv@0.2.2` — MIT OR Apache-2.0
- `num-traits@0.2.19` — MIT OR Apache-2.0
- `objc2@0.6.4` — MIT
- `objc2-app-kit@0.3.2` — Zlib OR Apache-2.0 OR MIT
- `objc2-cloud-kit@0.3.2` — Zlib OR Apache-2.0 OR MIT
- `objc2-core-data@0.3.2` — Zlib OR Apache-2.0 OR MIT
- `objc2-core-foundation@0.3.2` — Zlib OR Apache-2.0 OR MIT
- `objc2-core-graphics@0.3.2` — Zlib OR Apache-2.0 OR MIT
- `objc2-core-image@0.3.2` — Zlib OR Apache-2.0 OR MIT
- `objc2-core-location@0.3.2` — Zlib OR Apache-2.0 OR MIT
- `objc2-core-text@0.3.2` — Zlib OR Apache-2.0 OR MIT
- `objc2-encode@4.1.0` — MIT
- `objc2-exception-helper@0.1.1` — Zlib OR Apache-2.0 OR MIT
- `objc2-foundation@0.3.2` — MIT
- `objc2-io-surface@0.3.2` — Zlib OR Apache-2.0 OR MIT
- `objc2-quartz-core@0.3.2` — Zlib OR Apache-2.0 OR MIT
- `objc2-ui-kit@0.3.2` — Zlib OR Apache-2.0 OR MIT
- `objc2-user-notifications@0.3.2` — Zlib OR Apache-2.0 OR MIT
- `objc2-web-kit@0.3.2` — Zlib OR Apache-2.0 OR MIT
- `once_cell@1.21.4` — MIT OR Apache-2.0
- `openssl-probe@0.1.6` — MIT/Apache-2.0
- `openssl-src@300.6.1+3.6.3` — MIT/Apache-2.0
- `openssl-sys@0.9.117` — MIT
- `option-ext@0.2.0` — MPL-2.0
- `pango@0.18.3` — MIT
- `pango-sys@0.18.0` — MIT
- `parking_lot@0.12.5` — MIT OR Apache-2.0
- `parking_lot_core@0.9.12` — MIT OR Apache-2.0
- `percent-encoding@2.3.2` — MIT OR Apache-2.0
- `phf@0.13.1` — MIT
- `phf_codegen@0.13.1` — MIT
- `phf_generator@0.13.1` — MIT
- `phf_macros@0.13.1` — MIT
- `phf_shared@0.13.1` — MIT
- `pin-project-lite@0.2.17` — Apache-2.0 OR MIT
- `pkg-config@0.3.33` — MIT OR Apache-2.0
- `plist@1.9.0` — MIT
- `png@0.17.16` — MIT OR Apache-2.0
- `png@0.18.1` — MIT OR Apache-2.0
- `potential_utf@0.1.5` — Unicode-3.0
- `powerfmt@0.2.0` — MIT OR Apache-2.0
- `ppv-lite86@0.2.21` — MIT OR Apache-2.0
- `precomputed-hash@0.1.1` — MIT
- `proc-macro-crate@1.3.1` — MIT OR Apache-2.0
- `proc-macro-crate@2.0.2` — MIT OR Apache-2.0
- `proc-macro-crate@3.5.0` — MIT OR Apache-2.0
- `proc-macro-error@1.0.4` — MIT OR Apache-2.0
- `proc-macro-error-attr@1.0.4` — MIT OR Apache-2.0
- `proc-macro2@1.0.106` — MIT OR Apache-2.0
- `quick-xml@0.39.4` — MIT
- `quote@1.0.46` — MIT OR Apache-2.0
- `r-efi@5.3.0` — MIT OR Apache-2.0 OR LGPL-2.1-or-later
- `r-efi@6.0.0` — MIT OR Apache-2.0 OR LGPL-2.1-or-later
- `rand@0.9.4` — MIT OR Apache-2.0
- `rand_chacha@0.9.0` — MIT OR Apache-2.0
- `rand_core@0.9.5` — MIT OR Apache-2.0
- `raw-window-handle@0.6.2` — MIT OR Apache-2.0 OR Zlib
- `redox_syscall@0.5.18` — MIT
- `redox_users@0.5.2` — MIT
- `ref-cast@1.0.25` — MIT OR Apache-2.0
- `ref-cast-impl@1.0.25` — MIT OR Apache-2.0
- `regex@1.12.4` — MIT OR Apache-2.0
- `regex-automata@0.4.14` — MIT OR Apache-2.0
- `regex-syntax@0.8.11` — MIT OR Apache-2.0
- `reqwest@0.13.4` — MIT OR Apache-2.0
- `rfd@0.16.0` — MIT
- `rsqlite-vfs@0.1.1` — MIT
- `rusqlite@0.40.1` — MIT
- `rustc_version@0.4.1` — MIT OR Apache-2.0
- `rustc-hash@2.1.3` — Apache-2.0 OR MIT
- `rustversion@1.0.22` — MIT OR Apache-2.0
- `same-file@1.0.6` — Unlicense/MIT
- `schemars@0.8.22` — MIT
- `schemars@0.9.0` — MIT
- `schemars@1.2.1` — MIT
- `schemars_derive@0.8.22` — MIT
- `scopeguard@1.2.0` — MIT OR Apache-2.0
- `security-framework@2.11.1` — MIT OR Apache-2.0
- `security-framework@3.7.0` — MIT OR Apache-2.0
- `security-framework-sys@2.17.0` — MIT OR Apache-2.0
- `selectors@0.36.1` — MPL-2.0
- `semver@1.0.28` — MIT OR Apache-2.0
- `serde@1.0.228` — MIT OR Apache-2.0
- `serde_core@1.0.228` — MIT OR Apache-2.0
- `serde_derive@1.0.228` — MIT OR Apache-2.0
- `serde_derive_internals@0.29.1` — MIT OR Apache-2.0
- `serde_json@1.0.150` — MIT OR Apache-2.0
- `serde_repr@0.1.20` — MIT OR Apache-2.0
- `serde_spanned@0.6.9` — MIT OR Apache-2.0
- `serde_spanned@1.1.1` — MIT OR Apache-2.0
- `serde_with@3.21.0` — MIT OR Apache-2.0
- `serde_with_macros@3.21.0` — MIT OR Apache-2.0
- `serde-untagged@0.1.9` — MIT OR Apache-2.0
- `serialize-to-javascript@0.1.2` — MIT OR Apache-2.0
- `serialize-to-javascript-impl@0.1.2` — MIT OR Apache-2.0
- `servo_arc@0.4.3` — MIT OR Apache-2.0
- `sha2@0.10.9` — MIT OR Apache-2.0
- `shlex@2.0.1` — MIT OR Apache-2.0
- `simd-adler32@0.3.9` — MIT
- `siphasher@1.0.3` — MIT/Apache-2.0
- `slab@0.4.12` — MIT
- `smallvec@1.15.2` — MIT OR Apache-2.0
- `socket2@0.6.4` — MIT OR Apache-2.0
- `softbuffer@0.4.8` — MIT OR Apache-2.0
- `soup3@0.5.0` — MIT
- `soup3-sys@0.5.0` — MIT
- `sqlite-wasm-rs@0.5.5` — MIT
- `stable_deref_trait@1.2.1` — MIT OR Apache-2.0
- `string_cache@0.9.0` — MIT OR Apache-2.0
- `string_cache_codegen@0.6.1` — MIT OR Apache-2.0
- `strsim@0.11.1` — MIT
- `swift-rs@1.0.7` — MIT OR Apache-2.0
- `syn@1.0.109` — MIT OR Apache-2.0
- `syn@2.0.118` — MIT OR Apache-2.0
- `sync_wrapper@1.0.2` — Apache-2.0
- `synstructure@0.13.2` — MIT
- `system-deps@6.2.2` — MIT OR Apache-2.0
- `tao@0.35.3` — Apache-2.0
- `tao-macros@0.1.3` — MIT OR Apache-2.0
- `target-lexicon@0.12.16` — Apache-2.0 WITH LLVM-exception
- `tauri@2.11.5` — Apache-2.0 OR MIT
- `tauri-build@2.6.3` — Apache-2.0 OR MIT
- `tauri-codegen@2.6.3` — Apache-2.0 OR MIT
- `tauri-macros@2.6.3` — Apache-2.0 OR MIT
- `tauri-plugin@2.6.3` — Apache-2.0 OR MIT
- `tauri-plugin-dialog@2.7.1` — Apache-2.0 OR MIT
- `tauri-plugin-fs@2.5.1` — Apache-2.0 OR MIT
- `tauri-runtime@2.11.3` — Apache-2.0 OR MIT
- `tauri-runtime-wry@2.11.4` — Apache-2.0 OR MIT
- `tauri-utils@2.9.3` — Apache-2.0 OR MIT
- `tauri-winres@0.3.6` — MIT
- `tendril@0.5.0` — MIT OR Apache-2.0
- `thiserror@1.0.69` — MIT OR Apache-2.0
- `thiserror@2.0.18` — MIT OR Apache-2.0
- `thiserror-impl@1.0.69` — MIT OR Apache-2.0
- `thiserror-impl@2.0.18` — MIT OR Apache-2.0
- `time@0.3.53` — MIT OR Apache-2.0
- `time-core@0.1.9` — MIT OR Apache-2.0
- `time-macros@0.2.31` — MIT OR Apache-2.0
- `tinystr@0.8.3` — Unicode-3.0
- `tinyvec@1.11.0` — Zlib OR Apache-2.0 OR MIT
- `tinyvec_macros@0.1.1` — MIT OR Apache-2.0 OR Zlib
- `tokio@1.52.3` — MIT
- `tokio-util@0.7.18` — MIT
- `toml@0.8.2` — MIT OR Apache-2.0
- `toml@0.9.12+spec-1.1.0` — MIT OR Apache-2.0
- `toml@1.1.2+spec-1.1.0` — MIT OR Apache-2.0
- `toml_datetime@0.6.3` — MIT OR Apache-2.0
- `toml_datetime@0.7.5+spec-1.1.0` — MIT OR Apache-2.0
- `toml_datetime@1.1.1+spec-1.1.0` — MIT OR Apache-2.0
- `toml_edit@0.19.15` — MIT OR Apache-2.0
- `toml_edit@0.20.2` — MIT OR Apache-2.0
- `toml_edit@0.25.12+spec-1.1.0` — MIT OR Apache-2.0
- `toml_parser@1.1.2+spec-1.1.0` — MIT OR Apache-2.0
- `toml_writer@1.1.1+spec-1.1.0` — MIT OR Apache-2.0
- `tower@0.5.3` — MIT
- `tower-http@0.6.11` — MIT
- `tower-layer@0.3.3` — MIT
- `tower-service@0.3.3` — MIT
- `tracing@0.1.44` — MIT
- `tracing-core@0.1.36` — MIT
- `tray-icon@0.24.1` — MIT OR Apache-2.0
- `try-lock@0.2.5` — MIT
- `typeid@1.0.3` — MIT OR Apache-2.0
- `typenum@1.20.1` — MIT OR Apache-2.0
- `ulid@1.2.1` — MIT
- `unic-char-property@0.9.0` — MIT/Apache-2.0
- `unic-char-range@0.9.0` — MIT/Apache-2.0
- `unic-common@0.9.0` — MIT/Apache-2.0
- `unic-ucd-ident@0.9.0` — MIT/Apache-2.0
- `unic-ucd-version@0.9.0` — MIT/Apache-2.0
- `unicode-ident@1.0.24` — (MIT OR Apache-2.0) AND Unicode-3.0
- `unicode-segmentation@1.13.3` — MIT OR Apache-2.0
- `url@2.5.8` — MIT OR Apache-2.0
- `urlpattern@0.3.0` — MIT
- `utf-8@0.7.6` — MIT OR Apache-2.0
- `utf8_iter@1.0.4` — Apache-2.0 OR MIT
- `uuid@1.23.4` — Apache-2.0 OR MIT
- `vcpkg@0.2.15` — MIT/Apache-2.0
- `version_check@0.9.5` — MIT/Apache-2.0
- `version-compare@0.2.1` — MIT
- `vswhom@0.1.0` — MIT
- `vswhom-sys@0.1.3` — MIT
- `walkdir@2.5.0` — Unlicense/MIT
- `want@0.3.1` — MIT
- `wasi@0.11.1+wasi-snapshot-preview1` — Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT
- `wasip2@1.0.4+wasi-0.2.12` — Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT
- `wasm-bindgen@0.2.126` — MIT OR Apache-2.0
- `wasm-bindgen-futures@0.4.76` — MIT OR Apache-2.0
- `wasm-bindgen-macro@0.2.126` — MIT OR Apache-2.0
- `wasm-bindgen-macro-support@0.2.126` — MIT OR Apache-2.0
- `wasm-bindgen-shared@0.2.126` — MIT OR Apache-2.0
- `wasm-streams@0.5.0` — MIT OR Apache-2.0
- `web_atoms@0.2.5` — MIT OR Apache-2.0
- `web-sys@0.3.103` — MIT OR Apache-2.0
- `web-time@1.1.0` — MIT OR Apache-2.0
- `webkit2gtk@2.0.2` — MIT
- `webkit2gtk-sys@2.0.2` — MIT
- `webview2-com@0.38.2` — MIT
- `webview2-com-macros@0.8.1` — MIT
- `webview2-com-sys@0.38.2` — MIT
- `winapi@0.3.9` — MIT/Apache-2.0
- `winapi-i686-pc-windows-gnu@0.4.0` — MIT/Apache-2.0
- `winapi-util@0.1.11` — Unlicense OR MIT
- `winapi-x86_64-pc-windows-gnu@0.4.0` — MIT/Apache-2.0
- `window-vibrancy@0.6.0` — Apache-2.0 OR MIT
- `windows@0.61.3` — MIT OR Apache-2.0
- `windows_aarch64_gnullvm@0.42.2` — MIT OR Apache-2.0
- `windows_aarch64_gnullvm@0.52.6` — MIT OR Apache-2.0
- `windows_aarch64_gnullvm@0.53.1` — MIT OR Apache-2.0
- `windows_aarch64_msvc@0.42.2` — MIT OR Apache-2.0
- `windows_aarch64_msvc@0.52.6` — MIT OR Apache-2.0
- `windows_aarch64_msvc@0.53.1` — MIT OR Apache-2.0
- `windows_i686_gnu@0.42.2` — MIT OR Apache-2.0
- `windows_i686_gnu@0.52.6` — MIT OR Apache-2.0
- `windows_i686_gnu@0.53.1` — MIT OR Apache-2.0
- `windows_i686_gnullvm@0.52.6` — MIT OR Apache-2.0
- `windows_i686_gnullvm@0.53.1` — MIT OR Apache-2.0
- `windows_i686_msvc@0.42.2` — MIT OR Apache-2.0
- `windows_i686_msvc@0.52.6` — MIT OR Apache-2.0
- `windows_i686_msvc@0.53.1` — MIT OR Apache-2.0
- `windows_x86_64_gnu@0.42.2` — MIT OR Apache-2.0
- `windows_x86_64_gnu@0.52.6` — MIT OR Apache-2.0
- `windows_x86_64_gnu@0.53.1` — MIT OR Apache-2.0
- `windows_x86_64_gnullvm@0.42.2` — MIT OR Apache-2.0
- `windows_x86_64_gnullvm@0.52.6` — MIT OR Apache-2.0
- `windows_x86_64_gnullvm@0.53.1` — MIT OR Apache-2.0
- `windows_x86_64_msvc@0.42.2` — MIT OR Apache-2.0
- `windows_x86_64_msvc@0.52.6` — MIT OR Apache-2.0
- `windows_x86_64_msvc@0.53.1` — MIT OR Apache-2.0
- `windows-collections@0.2.0` — MIT OR Apache-2.0
- `windows-core@0.61.2` — MIT OR Apache-2.0
- `windows-core@0.62.2` — MIT OR Apache-2.0
- `windows-future@0.2.1` — MIT OR Apache-2.0
- `windows-implement@0.60.2` — MIT OR Apache-2.0
- `windows-interface@0.59.3` — MIT OR Apache-2.0
- `windows-link@0.1.3` — MIT OR Apache-2.0
- `windows-link@0.2.1` — MIT OR Apache-2.0
- `windows-numerics@0.2.0` — MIT OR Apache-2.0
- `windows-result@0.3.4` — MIT OR Apache-2.0
- `windows-result@0.4.1` — MIT OR Apache-2.0
- `windows-strings@0.4.2` — MIT OR Apache-2.0
- `windows-strings@0.5.1` — MIT OR Apache-2.0
- `windows-sys@0.45.0` — MIT OR Apache-2.0
- `windows-sys@0.59.0` — MIT OR Apache-2.0
- `windows-sys@0.60.2` — MIT OR Apache-2.0
- `windows-sys@0.61.2` — MIT OR Apache-2.0
- `windows-targets@0.42.2` — MIT OR Apache-2.0
- `windows-targets@0.52.6` — MIT OR Apache-2.0
- `windows-targets@0.53.5` — MIT OR Apache-2.0
- `windows-threading@0.1.0` — MIT OR Apache-2.0
- `windows-version@0.1.7` — MIT OR Apache-2.0
- `winnow@0.5.40` — MIT
- `winnow@0.7.15` — MIT
- `winnow@1.0.3` — MIT
- `winreg@0.55.0` — MIT
- `wit-bindgen@0.57.1` — Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT
- `writeable@0.6.3` — Unicode-3.0
- `wry@0.55.1` — Apache-2.0 OR MIT
- `x11@2.21.0` — MIT
- `x11-dl@2.21.0` — MIT
- `yoke@0.8.3` — Unicode-3.0
- `yoke-derive@0.8.2` — Unicode-3.0
- `zerocopy@0.8.52` — BSD-2-Clause OR Apache-2.0 OR MIT
- `zerocopy-derive@0.8.52` — BSD-2-Clause OR Apache-2.0 OR MIT
- `zerofrom@0.1.8` — Unicode-3.0
- `zerofrom-derive@0.1.7` — Unicode-3.0
- `zeroize@1.9.0` — Apache-2.0 OR MIT
- `zerotrie@0.2.4` — Unicode-3.0
- `zerovec@0.11.6` — Unicode-3.0
- `zerovec-derive@0.11.3` — Unicode-3.0
- `zmij@1.0.21` — MIT

## Appendix B — npm production packages (360)

- `@antfu/install-pkg@1.1.0` — MIT
- `@braintree/sanitize-url@7.1.2` — MIT
- `@chevrotain/types@11.1.2` — Apache-2.0
- `@codemirror/autocomplete@6.20.3` — MIT
- `@codemirror/commands@6.10.4` — MIT
- `@codemirror/lang-angular@0.1.4` — MIT
- `@codemirror/lang-cpp@6.0.3` — MIT
- `@codemirror/lang-css@6.3.1` — MIT
- `@codemirror/lang-go@6.0.1` — MIT
- `@codemirror/lang-html@6.4.11` — MIT
- `@codemirror/lang-java@6.0.2` — MIT
- `@codemirror/lang-javascript@6.2.5` — MIT
- `@codemirror/lang-jinja@6.0.1` — MIT
- `@codemirror/lang-json@6.0.2` — MIT
- `@codemirror/lang-less@6.0.2` — MIT
- `@codemirror/lang-liquid@6.3.2` — MIT
- `@codemirror/lang-markdown@6.5.0` — MIT
- `@codemirror/lang-php@6.0.2` — MIT
- `@codemirror/lang-python@6.2.1` — MIT
- `@codemirror/lang-rust@6.0.2` — MIT
- `@codemirror/lang-sass@6.0.2` — MIT
- `@codemirror/lang-sql@6.10.0` — MIT
- `@codemirror/lang-vue@0.1.3` — MIT
- `@codemirror/lang-wast@6.0.2` — MIT
- `@codemirror/lang-xml@6.1.0` — MIT
- `@codemirror/lang-yaml@6.1.3` — MIT
- `@codemirror/language@6.12.4` — MIT
- `@codemirror/language-data@6.5.2` — MIT
- `@codemirror/legacy-modes@6.5.3` — MIT
- `@codemirror/lint@6.9.7` — MIT
- `@codemirror/search@6.7.1` — MIT
- `@codemirror/state@6.7.0` — MIT
- `@codemirror/view@6.43.4` — MIT
- `@floating-ui/core@1.7.5` — MIT
- `@floating-ui/dom@1.7.6` — MIT
- `@floating-ui/utils@0.2.11` — MIT
- `@iconify/types@2.0.0` — MIT
- `@iconify/utils@3.1.3` — MIT
- `@lezer/common@1.5.2` — MIT
- `@lezer/cpp@1.1.6` — MIT
- `@lezer/css@1.3.4` — MIT
- `@lezer/go@1.0.1` — MIT
- `@lezer/highlight@1.2.3` — MIT
- `@lezer/html@1.3.13` — MIT
- `@lezer/java@1.1.3` — MIT
- `@lezer/javascript@1.5.4` — MIT
- `@lezer/json@1.0.3` — MIT
- `@lezer/lr@1.4.10` — MIT
- `@lezer/markdown@1.6.4` — MIT
- `@lezer/php@1.0.5` — MIT
- `@lezer/python@1.1.19` — MIT
- `@lezer/rust@1.0.2` — MIT
- `@lezer/sass@1.1.0` — MIT
- `@lezer/xml@1.0.6` — MIT
- `@lezer/yaml@1.0.4` — MIT
- `@m2d/core@1.7.1` — MPL-2.0
- `@m2d/emoji@0.1.3` — MPL-2.0
- `@m2d/html@1.1.11` — MPL-2.0
- `@m2d/image@1.4.1` — MPL-2.0
- `@m2d/list@0.0.9` — MPL-2.0
- `@m2d/math@0.0.6` — MPL-2.0
- `@m2d/mdast@0.2.4` — MPL-2.0
- `@m2d/mermaid@1.2.2` — MPL-2.0
- `@m2d/table@0.1.1` — MPL-2.0
- `@marijn/find-cluster-break@1.0.3` — MIT
- `@mermaid-js/parser@1.2.0` — MIT
- `@svg-fns/io@1.0.1` — MPL-2.0
- `@svg-fns/svg2img@0.0.0` — MPL-2.0
- `@tauri-apps/api@2.11.1` — Apache-2.0 OR MIT
- `@tauri-apps/plugin-dialog@2.7.1` — MIT OR Apache-2.0
- `@tiptap/core@3.27.1` — MIT
- `@tiptap/extension-blockquote@3.27.1` — MIT
- `@tiptap/extension-bold@3.27.1` — MIT
- `@tiptap/extension-bubble-menu@3.27.1` — MIT
- `@tiptap/extension-bullet-list@3.27.1` — MIT
- `@tiptap/extension-code@3.27.1` — MIT
- `@tiptap/extension-code-block@3.27.1` — MIT
- `@tiptap/extension-document@3.27.1` — MIT
- `@tiptap/extension-dropcursor@3.27.1` — MIT
- `@tiptap/extension-floating-menu@3.27.1` — MIT
- `@tiptap/extension-gapcursor@3.27.1` — MIT
- `@tiptap/extension-hard-break@3.27.1` — MIT
- `@tiptap/extension-heading@3.27.1` — MIT
- `@tiptap/extension-horizontal-rule@3.27.1` — MIT
- `@tiptap/extension-image@3.27.1` — MIT
- `@tiptap/extension-italic@3.27.1` — MIT
- `@tiptap/extension-link@3.27.1` — MIT
- `@tiptap/extension-list@3.27.1` — MIT
- `@tiptap/extension-list-item@3.27.1` — MIT
- `@tiptap/extension-list-keymap@3.27.1` — MIT
- `@tiptap/extension-ordered-list@3.27.1` — MIT
- `@tiptap/extension-paragraph@3.27.1` — MIT
- `@tiptap/extension-strike@3.27.1` — MIT
- `@tiptap/extension-table@3.27.1` — MIT
- `@tiptap/extension-task-item@3.27.1` — MIT
- `@tiptap/extension-task-list@3.27.1` — MIT
- `@tiptap/extension-text@3.27.1` — MIT
- `@tiptap/extension-underline@3.27.1` — MIT
- `@tiptap/extensions@3.27.1` — MIT
- `@tiptap/markdown@3.27.1` — MIT
- `@tiptap/pm@3.27.1` — MIT
- `@tiptap/react@3.27.1` — MIT
- `@tiptap/starter-kit@3.27.1` — MIT
- `@types/d3@7.4.3` — MIT
- `@types/d3-array@3.2.2` — MIT
- `@types/d3-axis@3.0.6` — MIT
- `@types/d3-brush@3.0.6` — MIT
- `@types/d3-chord@3.0.6` — MIT
- `@types/d3-color@3.1.3` — MIT
- `@types/d3-contour@3.0.6` — MIT
- `@types/d3-delaunay@6.0.4` — MIT
- `@types/d3-dispatch@3.0.7` — MIT
- `@types/d3-drag@3.0.7` — MIT
- `@types/d3-dsv@3.0.7` — MIT
- `@types/d3-ease@3.0.2` — MIT
- `@types/d3-fetch@3.0.7` — MIT
- `@types/d3-force@3.0.10` — MIT
- `@types/d3-format@3.0.4` — MIT
- `@types/d3-geo@3.1.0` — MIT
- `@types/d3-hierarchy@3.1.7` — MIT
- `@types/d3-interpolate@3.0.4` — MIT
- `@types/d3-path@3.1.1` — MIT
- `@types/d3-polygon@3.0.2` — MIT
- `@types/d3-quadtree@3.0.6` — MIT
- `@types/d3-random@3.0.4` — MIT
- `@types/d3-scale@4.0.9` — MIT
- `@types/d3-scale-chromatic@3.1.0` — MIT
- `@types/d3-selection@3.0.11` — MIT
- `@types/d3-shape@3.1.8` — MIT
- `@types/d3-time@3.0.4` — MIT
- `@types/d3-time-format@4.0.3` — MIT
- `@types/d3-timer@3.0.2` — MIT
- `@types/d3-transition@3.0.9` — MIT
- `@types/d3-zoom@3.0.8` — MIT
- `@types/debug@4.1.13` — MIT
- `@types/geojson@7946.0.16` — MIT
- `@types/hast@3.0.4` — MIT
- `@types/katex@0.16.8` — MIT
- `@types/mdast@4.0.4` — MIT
- `@types/ms@2.1.0` — MIT
- `@types/node@25.9.4` — MIT
- `@types/react@19.2.17` — MIT
- `@types/react-dom@19.2.3` — MIT
- `@types/trusted-types@2.0.7` — MIT
- `@types/unist@3.0.3` — MIT
- `@types/use-sync-external-store@0.0.6` — MIT
- `@ungap/structured-clone@1.3.2` — ISC
- `@upsetjs/venn.js@2.0.0` — MIT
- `@xmldom/xmldom@?` — UNKNOWN
- `bail@2.0.2` — MIT
- `ccount@2.0.1` — MIT
- `character-entities@2.0.2` — MIT
- `character-entities-html4@2.1.0` — MIT
- `character-entities-legacy@3.0.0` — MIT
- `character-reference-invalid@2.0.1` — MIT
- `codemirror@6.0.2` — MIT
- `comma-separated-tokens@2.0.3` — MIT
- `commander@7.2.0` — MIT
- `core-util-is@1.0.3` — MIT
- `cose-base@1.0.3` — MIT
- `crelt@1.0.7` — MIT
- `csstype@3.2.3` — MIT
- `cytoscape@3.34.0` — MIT
- `cytoscape-cose-bilkent@4.1.0` — MIT
- `cytoscape-fcose@2.2.0` — MIT
- `d3@7.9.0` — ISC
- `d3-array@3.2.4` — ISC
- `d3-axis@3.0.0` — ISC
- `d3-brush@3.0.0` — ISC
- `d3-chord@3.0.1` — ISC
- `d3-color@3.1.0` — ISC
- `d3-contour@4.0.2` — ISC
- `d3-delaunay@6.0.4` — ISC
- `d3-dispatch@3.0.1` — ISC
- `d3-drag@3.0.0` — ISC
- `d3-dsv@3.0.1` — ISC
- `d3-ease@3.0.1` — BSD-3-Clause
- `d3-fetch@3.0.1` — ISC
- `d3-force@3.0.0` — ISC
- `d3-format@3.1.2` — ISC
- `d3-geo@3.1.1` — ISC
- `d3-hierarchy@3.1.2` — ISC
- `d3-interpolate@3.0.1` — ISC
- `d3-path@3.1.0` — ISC
- `d3-polygon@3.0.1` — ISC
- `d3-quadtree@3.0.1` — ISC
- `d3-random@3.0.1` — ISC
- `d3-sankey@0.12.3` — BSD-3-Clause
- `d3-scale@4.0.2` — ISC
- `d3-scale-chromatic@3.1.0` — ISC
- `d3-selection@3.0.0` — ISC
- `d3-shape@3.2.0` — ISC
- `d3-time@3.1.0` — ISC
- `d3-time-format@4.1.0` — ISC
- `d3-timer@3.0.1` — ISC
- `d3-transition@3.0.1` — ISC
- `d3-zoom@3.0.0` — ISC
- `dagre-d3-es@7.0.14` — MIT
- `dayjs@1.11.21` — MIT
- `debug@4.4.3` — MIT
- `decode-named-character-reference@1.3.0` — MIT
- `delaunator@5.1.0` — ISC
- `dequal@2.0.3` — MIT
- `devlop@1.1.0` — MIT
- `docx@9.7.1` — MIT
- `dompurify@3.4.11` — (MPL-2.0 OR Apache-2.0)
- `es-toolkit@1.49.0` — MIT
- `escape-string-regexp@5.0.0` — MIT
- `extend@3.0.2` — MIT
- `fast-equals@5.4.0` — MIT
- `fault@2.0.1` — MIT
- `format@0.2.2` — MIT
- `hachure-fill@0.5.2` — MIT
- `hash.js@1.1.7` — MIT
- `hast-util-to-html@9.0.5` — MIT
- `hast-util-whitespace@3.0.0` — MIT
- `html-void-elements@3.0.0` — MIT
- `iconv-lite@0.6.3` — MIT
- `immediate@3.0.6` — MIT
- `import-meta-resolve@4.2.0` — MIT
- `inherits@2.0.4` — ISC
- `internmap@2.0.3` — ISC
- `is-alphabetical@2.0.1` — MIT
- `is-alphanumerical@2.0.1` — MIT
- `is-decimal@2.0.1` — MIT
- `is-hexadecimal@2.0.1` — MIT
- `is-plain-obj@4.1.0` — MIT
- `isarray@1.0.0` — MIT
- `jszip@3.10.1` — (MIT OR GPL-3.0-or-later)
- `katex@0.16.47` — MIT
- `khroma@2.1.0` — UNKNOWN
- `latex-math@0.0.2` — MPL-2.0
- `layout-base@1.0.2` — MIT
- `lie@3.3.0` — MIT
- `linkifyjs@4.3.3` — MIT
- `lodash-es@4.18.1` — MIT
- `longest-streak@3.1.0` — MIT
- `markdown-table@3.0.4` — MIT
- `marked@17.0.6` — MIT
- `mdast-util-directive@3.1.0` — MIT
- `mdast-util-find-and-replace@3.0.2` — MIT
- `mdast-util-from-markdown@2.0.3` — MIT
- `mdast-util-frontmatter@2.0.1` — MIT
- `mdast-util-gfm@3.1.0` — MIT
- `mdast-util-gfm-autolink-literal@2.0.1` — MIT
- `mdast-util-gfm-footnote@2.1.0` — MIT
- `mdast-util-gfm-strikethrough@2.0.0` — MIT
- `mdast-util-gfm-table@2.0.0` — MIT
- `mdast-util-gfm-task-list-item@2.0.0` — MIT
- `mdast-util-math@3.0.0` — MIT
- `mdast-util-phrasing@4.1.0` — MIT
- `mdast-util-to-hast@13.2.1` — MIT
- `mdast-util-to-markdown@2.1.2` — MIT
- `mdast-util-to-string@4.0.0` — MIT
- `mdast2docx@1.6.1` — MPL-2.0
- `mermaid@11.16.0` — MIT
- `micromark@4.0.2` — MIT
- `micromark-core-commonmark@2.0.3` — MIT
- `micromark-extension-directive@4.0.0` — MIT
- `micromark-extension-frontmatter@2.0.0` — MIT
- `micromark-extension-gfm@3.0.0` — MIT
- `micromark-extension-gfm-autolink-literal@2.1.0` — MIT
- `micromark-extension-gfm-footnote@2.1.0` — MIT
- `micromark-extension-gfm-strikethrough@2.1.0` — MIT
- `micromark-extension-gfm-table@2.1.1` — MIT
- `micromark-extension-gfm-tagfilter@2.0.0` — MIT
- `micromark-extension-gfm-task-list-item@2.1.0` — MIT
- `micromark-extension-math@3.1.0` — MIT
- `micromark-factory-destination@2.0.1` — MIT
- `micromark-factory-label@2.0.1` — MIT
- `micromark-factory-space@2.0.1` — MIT
- `micromark-factory-title@2.0.1` — MIT
- `micromark-factory-whitespace@2.0.1` — MIT
- `micromark-util-character@2.1.1` — MIT
- `micromark-util-chunked@2.0.1` — MIT
- `micromark-util-classify-character@2.0.1` — MIT
- `micromark-util-combine-extensions@2.0.1` — MIT
- `micromark-util-decode-numeric-character-reference@2.0.2` — MIT
- `micromark-util-decode-string@2.0.1` — MIT
- `micromark-util-encode@2.0.1` — MIT
- `micromark-util-html-tag-name@2.0.1` — MIT
- `micromark-util-normalize-identifier@2.0.1` — MIT
- `micromark-util-resolve-all@2.0.1` — MIT
- `micromark-util-sanitize-uri@2.0.1` — MIT
- `micromark-util-subtokenize@2.1.0` — MIT
- `micromark-util-symbol@2.0.1` — MIT
- `micromark-util-types@2.0.2` — MIT
- `minimalistic-assert@1.0.1` — ISC
- `ms@2.1.3` — MIT
- `nanoid@3.3.15` — MIT
- `orderedmap@2.1.1` — MIT
- `package-manager-detector@1.7.0` — MIT
- `pako@1.0.11` — (MIT AND Zlib)
- `parse-entities@4.0.2` — MIT
- `path-data-parser@0.1.0` — MIT
- `points-on-curve@0.2.0` — MIT
- `points-on-path@0.2.1` — MIT
- `process-nextick-args@2.0.1` — MIT
- `property-information@7.2.0` — MIT
- `prosemirror-changeset@2.4.1` — MIT
- `prosemirror-commands@1.7.1` — MIT
- `prosemirror-dropcursor@1.8.2` — MIT
- `prosemirror-gapcursor@1.4.1` — MIT
- `prosemirror-history@1.5.0` — MIT
- `prosemirror-inputrules@1.5.1` — MIT
- `prosemirror-keymap@1.2.3` — MIT
- `prosemirror-model@1.25.9` — MIT
- `prosemirror-schema-list@1.5.1` — MIT
- `prosemirror-state@1.4.4` — MIT
- `prosemirror-tables@1.8.5` — MIT
- `prosemirror-transform@1.12.0` — MIT
- `prosemirror-view@1.42.0` — MIT
- `react@19.2.7` — MIT
- `react-dom@19.2.7` — MIT
- `readable-stream@2.3.8` — MIT
- `rehype-stringify@10.0.1` — MIT
- `remark-directive@4.0.0` — MIT
- `remark-frontmatter@5.0.0` — MIT
- `remark-gfm@4.0.1` — MIT
- `remark-math@6.0.0` — MIT
- `remark-parse@11.0.0` — MIT
- `remark-stringify@11.0.0` — MIT
- `robust-predicates@3.0.3` — Unlicense
- `rope-sequence@1.3.4` — MIT
- `roughjs@4.6.6` — MIT
- `rw@1.3.3` — BSD-3-Clause
- `safe-buffer@5.1.2` — MIT
- `safer-buffer@2.1.2` — MIT
- `sax@1.6.0` — BlueOak-1.0.0
- `scheduler@0.27.0` — MIT
- `setimmediate@1.0.5` — MIT
- `sharp@?` — UNKNOWN
- `space-separated-tokens@2.0.2` — MIT
- `string_decoder@1.1.1` — MIT
- `stringify-entities@4.0.4` — MIT
- `style-mod@4.1.3` — MIT
- `stylis@4.4.0` — MIT
- `tinyexec@1.2.4` — MIT
- `trim-lines@3.0.1` — MIT
- `trough@2.2.0` — MIT
- `ts-dedent@2.3.0` — MIT
- `ulid@3.0.2` — MIT
- `undici-types@7.24.6` — MIT
- `unified@11.0.5` — MIT
- `unist-util-is@6.0.1` — MIT
- `unist-util-position@5.0.0` — MIT
- `unist-util-remove-position@5.0.0` — MIT
- `unist-util-stringify-position@4.0.0` — MIT
- `unist-util-visit@5.1.0` — MIT
- `unist-util-visit-parents@6.0.2` — MIT
- `use-sync-external-store@1.6.0` — MIT
- `util-deprecate@1.0.2` — MIT
- `uuid@14.0.1` — MIT
- `vfile@6.0.3` — MIT
- `vfile-message@4.0.3` — MIT
- `w3c-keyname@2.2.8` — MIT
- `xml@1.0.1` — MIT
- `xml-js@1.6.11` — MIT
- `yaml@2.9.0` — ISC
- `zwitch@2.0.4` — MIT
