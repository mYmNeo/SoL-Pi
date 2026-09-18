/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

/**
 * oh-my-pi host preflight.
 *
 * Asserts the invariants this extension depends on before it is loaded:
 *
 *  1. Every omp package it builds against is installed at the pinned version.
 *  2. `package.json` declares the extension entry under `omp.extensions`.
 *  3. No leftover legacy Pi-scope specifier remains anywhere under `src/`.
 *  4. The four mechanism entrypoints and the package entry exist on disk.
 *
 * Runs under plain Node. The omp runtime packages are Bun-only, so this script
 * only ever reads JSON and text from disk — it never imports them.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OMP_SCOPE = "@oh-my-pi";
const REQUIRED_VERSION = "18.2.5";
const HOST_PACKAGES = ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui", "pi-utils", "omptype"];
const PACKAGE_ENTRY = "./src/sol-pi/index.ts";
const MECHANISM_ENTRIES = [
 "src/sol-pi/extensions/action-fusion/index.ts",
 "src/sol-pi/extensions/observation-pack/index.ts",
 "src/sol-pi/extensions/evidence-preserving-reducer/index.ts",
 "src/sol-pi/extensions/online-context-compact/index.ts",
];
const LEGACY_SCOPE = `${"@earendil"}-works/`;

function fail(message) {
 throw new Error(message);
}

function readJson(path) {
 try {
  return JSON.parse(readFileSync(path, "utf8"));
 } catch (error) {
  fail(`unable to read JSON at ${relative(REPO_ROOT, path)}: ${error instanceof Error ? error.message : error}`);
 }
}

/** Every `.ts` file under `dir`, recursively. */
function collectTypeScriptFiles(dir) {
 if (!existsSync(dir)) fail(`missing source directory: ${relative(REPO_ROOT, dir)}`);
 const files = [];
 for (const entry of readdirSync(dir, { withFileTypes: true })) {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) files.push(...collectTypeScriptFiles(path));
  else if (entry.name.endsWith(".ts")) files.push(path);
 }
 return files;
}

function checkHostPackageVersions() {
 const problems = [];
 for (const name of HOST_PACKAGES) {
  const manifestPath = join(REPO_ROOT, "node_modules", OMP_SCOPE, name, "package.json");
  if (!existsSync(manifestPath)) {
   problems.push(`${OMP_SCOPE}/${name} is not installed — run the package install first`);
   continue;
  }
  const { version } = readJson(manifestPath);
  if (version !== REQUIRED_VERSION) {
   problems.push(`${OMP_SCOPE}/${name} is ${version}, expected ${REQUIRED_VERSION}`);
  }
 }
 return problems;
}

function checkPackageManifest() {
 const problems = [];
 const manifest = readJson(join(REPO_ROOT, "package.json"));
 const declared = manifest.omp?.extensions;
 if (!Array.isArray(declared)) {
  problems.push("package.json is missing the omp.extensions array");
 } else if (!declared.includes(PACKAGE_ENTRY)) {
  problems.push(`package.json omp.extensions must include ${PACKAGE_ENTRY}`);
 }
 if ("pi" in manifest) problems.push("package.json still declares a legacy pi manifest key");
 for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
  for (const name of Object.keys(manifest[section] ?? {})) {
   if (name.startsWith(LEGACY_SCOPE) || name === "typebox") {
    problems.push(`package.json ${section} still lists ${name}`);
   }
  }
 }
 return problems;
}

function checkNoLegacySpecifiers() {
 const problems = [];
 for (const path of collectTypeScriptFiles(join(REPO_ROOT, "src"))) {
  const source = readFileSync(path, "utf8");
  source.split("\n").forEach((line, index) => {
   if (line.includes(LEGACY_SCOPE)) {
    problems.push(`${relative(REPO_ROOT, path)}:${index + 1} still imports ${LEGACY_SCOPE}`);
   }
  });
 }
 return problems;
}

function checkEntrypoints() {
 return [...MECHANISM_ENTRIES, "src/sol-pi/index.ts", "src/sol-pi/host-compat.ts"]
  .filter((entry) => !existsSync(join(REPO_ROOT, entry)))
  .map((entry) => `missing entrypoint: ${entry}`);
}

try {
 const problems = [
  ...checkHostPackageVersions(),
  ...checkPackageManifest(),
  ...checkNoLegacySpecifiers(),
  ...checkEntrypoints(),
 ];
 if (problems.length > 0) {
  fail(`oh-my-pi host preflight failed:\n  - ${problems.join("\n  - ")}`);
 }
 process.stdout.write(`oh-my-pi host preflight passed (host packages at ${REQUIRED_VERSION}).\n`);
} catch (error) {
 process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
 process.exitCode = 1;
}
