#!/usr/bin/env node
// sync-version.mjs — propagate ONE version number to every place that holds it.
//
// Single source of truth is the semver passed on argv (semantic-release feeds
// `${nextRelease.version}`); this script writes it into all platform configs so
// Web / macOS / Windows / iOS / Android ship the same marketing version.
//
//   node scripts/sync-version.mjs 1.4.0
//   BUILD_NUMBER=57 node scripts/sync-version.mjs 1.4.0   # also stamp build no.
//
// Files touched:
//   - package.json                          "version"
//   - src-tauri/Cargo.toml                   [package] version
//   - src-tauri/Cargo.lock                   hakushi crate version (keeps it clean)
//   - src-tauri/tauri.conf.json              "version"  (Tauri derives Android
//                                            versionName/versionCode from this)
//   - src-tauri/gen/apple/project.yml        CFBundleShortVersionString + CFBundleVersion
//   - src-tauri/gen/android/app/tauri.properties  (only when BUILD_NUMBER is set;
//                                            file is gitignored / CI-only)
//
// BUILD_NUMBER (optional): the monotonic build number stores require to strictly
// increase across uploads (iOS CFBundleVersion, Android versionCode). Pass the
// CI run number. Marketing version alone can repeat on re-runs; the build number
// must not.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(
    `sync-version: expected a semver argument, got: ${JSON.stringify(version)}`,
  );
  process.exit(1);
}
const buildNumber = process.env.BUILD_NUMBER; // optional

/** Read a UTF-8 file relative to the repo root. */
const read = (rel) => readFileSync(join(root, rel), "utf8");
/** Write a UTF-8 file relative to the repo root and log it. */
const write = (rel, next) => {
  writeFileSync(join(root, rel), next);
  console.log(`  updated ${rel}`);
};

// --- package.json ----------------------------------------------------------
{
  const rel = "package.json";
  const json = JSON.parse(read(rel));
  json.version = version;
  write(rel, JSON.stringify(json, null, 2) + "\n");
}

// --- src-tauri/tauri.conf.json ---------------------------------------------
{
  const rel = "src-tauri/tauri.conf.json";
  const json = JSON.parse(read(rel));
  json.version = version;
  write(rel, JSON.stringify(json, null, 2) + "\n");
}

// --- src-tauri/Cargo.toml ([package] version only) -------------------------
{
  const rel = "src-tauri/Cargo.toml";
  const src = read(rel);
  // Replace the first `version = "..."` that belongs to the [package] table:
  // scope the replace to the text between `[package]` and the next `[section]`.
  const pkgStart = src.indexOf("[package]");
  if (pkgStart === -1) throw new Error("Cargo.toml: no [package] table");
  const rest = src.slice(pkgStart);
  const nextSection = rest.slice(1).search(/\n\[/); // next "\n[" after [package]
  const end = nextSection === -1 ? src.length : pkgStart + 1 + nextSection;
  const head = src.slice(0, pkgStart);
  const pkg = src.slice(pkgStart, end).replace(
    /^version\s*=\s*"[^"]*"/m,
    `version = "${version}"`,
  );
  write(rel, head + pkg + src.slice(end));
}

// --- src-tauri/Cargo.lock (hakushi crate entry) ----------------------------
{
  const rel = "src-tauri/Cargo.lock";
  const src = read(rel);
  const next = src.replace(
    /(name = "hakushi"\nversion = )"[^"]*"/,
    `$1"${version}"`,
  );
  if (next !== src) write(rel, next);
  else console.log(`  (skipped ${rel}: hakushi entry unchanged)`);
}

// --- src-tauri/gen/apple/project.yml (iOS marketing + build versions) ------
{
  const rel = "src-tauri/gen/apple/project.yml";
  if (existsSync(join(root, rel))) {
    let src = read(rel);
    src = src.replace(
      /CFBundleShortVersionString:\s*.*/g,
      `CFBundleShortVersionString: ${version}`,
    );
    src = src.replace(
      /CFBundleVersion:\s*.*/g,
      `CFBundleVersion: "${buildNumber ?? version}"`,
    );
    write(rel, src);
  }
}

// --- src-tauri/gen/android/app/tauri.properties (CI-only; gitignored) ------
// Tauri normally generates this from tauri.conf.json at build time. We write it
// explicitly ONLY when BUILD_NUMBER is provided, to force a strictly-increasing
// versionCode (Google Play rejects reused codes).
if (buildNumber) {
  const rel = "src-tauri/gen/android/app/tauri.properties";
  const body =
    `tauri.android.versionName=${version}\n` +
    `tauri.android.versionCode=${buildNumber}\n`;
  write(rel, body);
}

console.log(`sync-version: set version ${version}` +
  (buildNumber ? ` (build ${buildNumber})` : ""));
