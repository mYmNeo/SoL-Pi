/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

function rootFile(name: string): string {
	return readFileSync(join(process.cwd(), name), "utf8");
}

/** The host package and the version this repository actually pins. */
const HOST_PACKAGE = "@oh-my-pi/pi-coding-agent";
const HOST_VERSION = (
	JSON.parse(rootFile("package.json")) as { devDependencies: Record<string, string> }
).devDependencies[HOST_PACKAGE];

describe("agent installation instructions", () => {
	it("makes the canonical guide mandatory for Codex install and configuration work", () => {
		const instructions = rootFile("AGENTS.md");
		expect(instructions).toContain("agents-install.md");
		expect(instructions).toMatch(/read.+completely/is);
		expect(instructions).toMatch(/install|build|configur/i);
	});

	it("imports the same canonical guide for Claude Code", () => {
		const instructions = rootFile("CLAUDE.md");
		expect(instructions.split(/\r?\n/u)).toContain("@agents-install.md");
	});

	it("keeps the README pointed at the managed installation and configuration profile", () => {
		const readme = rootFile("README.md");
		expect(readme).toContain("[agent installation and configuration protocol](agents-install.md)");
		expect(readme).toContain("check-sol-pi-config.mjs --require-all-enabled");
	});

	it("pins the tested host version this repository develops against", () => {
		expect(typeof HOST_VERSION).toBe("string");
		expect(HOST_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
	});

	it("defines a reproducible and all-enabled installation on the tested host", () => {
		const guide = rootFile("agents-install.md");
		const requiredText = [
			// The host actually under test, at the pinned version.
			`${HOST_PACKAGE}@${HOST_VERSION}`,
			// Reproducible install and the real source checks for this repository.
			"bun install --frozen-lockfile",
			"bun run check",
			"bun test tests/all-mechanisms.test.ts",
			"scripts/check-omp-compat.mjs",
			// Host install and plugin registration.
			"bun install --global",
			"omp --version",
			"omp plugin link",
			"omp plugin list",
			// The all-enabled configuration profile.
			'"actionFusion": true',
			'"observationPack": true',
			'"evidencePreservingReducer": true',
			'"evidencePreservingReducerProvider": "provider-id"',
			'"evidencePreservingReducerModel": "model-id"',
			'"onlineContextCompact": true',
			'"cacheWriteReadRatio": 12.5',
			"scripts/check-sol-pi-config.mjs",
			"tests/all-mechanisms.test.ts",
		];

		for (const text of requiredText) expect(guide, text).toContain(text);
	});

	it("keeps the protocol's guarantees instead of its old host wording", () => {
		const guide = rootFile("agents-install.md");

		// The host must remain unmodified, and secrets must never be printed.
		expect(guide).toMatch(/do not\s+(modify|patch|fork|vendor).+upstream/is);
		expect(guide).toMatch(/do not\s+(print|log|commit|upload).+secret/is);
		// The guide must still name the version check it requires.
		expect(guide).toMatch(/require.+(version|report)/is);
	});

	it("has dropped the retired test runner and host package from the protocol", () => {
		// Needles are assembled so this file itself never carries the retired names.
		const RETIRED_RUNNER = ["vit", "est"].join("");
		const RETIRED_HOST = ["@earendil", "-works"].join("");

		for (const name of ["agents-install.md", "README.md"]) {
			const text = rootFile(name);
			expect(text, name).not.toContain(RETIRED_RUNNER);
			expect(text, name).not.toContain(RETIRED_HOST);
		}
	});

	it("documents one configured ratio and no active-model cost inference", () => {
		for (const name of [
			"README.md",
			"agents-install.md",
			"docs/configuration.md",
			"docs/compatibility.md",
		]) {
			const text = rootFile(name);
			expect(text, name).toContain("cacheWriteReadRatio");
			expect(text, name).not.toContain("Model.cost");
			expect(text, name).not.toContain("cache_read_price_per_million");
			expect(text, name).not.toContain("cache_write_price_per_million");
		}
	});
});
