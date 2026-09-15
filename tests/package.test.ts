/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "bun:test";

interface PackReport {
	files: Array<{ path: string }>;
}

function packedFiles(): string[] {
	const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: process.cwd(),
		encoding: "utf8",
		timeout: 25_000,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	const report = JSON.parse(result.stdout) as PackReport[];
	return report[0]?.files.map((file) => file.path) ?? [];
}

describe("published package", () => {
	let files: string[];
	beforeAll(() => {
		files = packedFiles();
	}, 30_000);

	it("ships the default cache write/read ratio in the example config", () => {
		const config = JSON.parse(readFileSync("sol-pi.example.json", "utf8")) as Record<string, unknown>;
		expect(config.cacheWriteReadRatio).toBe(12.5);
		expect(config.evidencePreservingReducerProvider).toBe("provider-id");
		expect(config.evidencePreservingReducerModel).toBe("model-id");
	});

	it("contains the standalone entrypoint and no upstream monorepo source", () => {
		expect(files).toContain("src/sol-pi/index.ts");
		expect(files).toContain("sol-pi.example.json");
		expect(files.some((file) => file.startsWith("packages/"))).toBe(false);
		expect(files.some((file) => file.startsWith("docs/superpowers/"))).toBe(false);
	});

	it("ships Online Context Compact and both compatibility checks from the standalone source tree", () => {
		expect(files).toContain("src/sol-pi/extensions/online-context-compact/index.ts");
		expect(files).toContain("scripts/check-sol-pi-config.mjs");
		expect(files).toContain("scripts/check-omp-compat.mjs");
		expect(files).toContain("agents-install.md");
		expect(files).not.toContain("AGENTS.md");
		expect(files).not.toContain("CLAUDE.md");
	});

	it("declares the tested host at the pinned version", () => {
		const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
			devDependencies: Record<string, string>;
			scripts: Record<string, string>;
		};

		// Needles are assembled so this file itself never carries the retired names.
		const RETIRED_RUNNER = ["vit", "est"].join("");
		const RETIRED_HOST_PREFIX = ["@earendil", "-works/"].join("");

		expect(manifest.devDependencies["@oh-my-pi/pi-coding-agent"]).toMatch(/^\d+\.\d+\.\d+$/u);
		// The retired runner and host are gone from the manifest.
		expect(Object.keys(manifest.devDependencies)).not.toContain(RETIRED_RUNNER);
		expect(Object.keys(manifest.devDependencies).some((name) => name.startsWith(RETIRED_HOST_PREFIX))).toBe(false);
		// The supported entry points run on bun.
		expect(manifest.scripts.test).toBe("bun test");
		expect(manifest.scripts.check).toContain("bun test");
		expect(manifest.scripts.check).not.toContain(RETIRED_RUNNER);
		expect(manifest.scripts["check:omp"]).toBe("node scripts/check-omp-compat.mjs");
	});
});
