/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createReadToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { normalizeWindowsShellPath, resolveToolPath } from "../src/sol-pi/extensions/action-fusion/file-queue.ts";
import { createActionFusionExtension, type ActionFusionOptions } from "../src/sol-pi/extensions/action-fusion/index.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "action-fusion-paths-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function loadTools(options: ActionFusionOptions = {}): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	createActionFusionExtension(options)({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
	return tools;
}

/** Exercise the platform-dependent branches without a Windows runner. */
function withPlatform(platform: NodeJS.Platform, run: () => void): void {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	if (!original) throw new Error("process.platform is not configurable");
	Object.defineProperty(process, "platform", { ...original, value: platform });
	try {
		run();
	} finally {
		Object.defineProperty(process, "platform", original);
	}
}

function context(cwd: string): ExtensionContext {
	return {
		cwd,
		mode: "json",
		hasUI: false,
		model: undefined,
		sessionManager: { getSessionId: () => "action-fusion-paths", getSessionFile: () => undefined },
		ui: {},
	} as ExtensionContext;
}

/** The properties the tool actually declares, as JSON Schema. */
function declaredProperties(tool: ToolDefinition): Record<string, unknown> {
	const builder = tool.parameters as unknown as {
		toJsonSchema: () => { properties?: Record<string, unknown> };
	};
	return builder.toJsonSchema().properties ?? {};
}

/**
 * The current snapshot tag the host's built-in edit requires. The tag is minted
 * per session by the host's own store, so it must come from a real read rather
 * than being invented.
 */
async function snapshotTag(cwd: string, target: string): Promise<string> {
	const read = createReadToolDefinition(cwd);
	const result = await read.execute("tag-read", { path: target } as never, undefined, undefined, context(cwd));
	const text = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const tag = /^\[[^\]\r\n]+#([0-9A-Fa-f]{4})\]/mu.exec(text)?.[1];
	if (!tag) throw new Error(`read produced no hashline tag for ${target}`);
	return tag;
}

/**
 * Build mutation arguments from the fused tool's own declared schema: omp's
 * built-in `edit` is hashline-shaped (`input`), while `write` takes
 * `path`/`content`. `escapedPath` is the spelling the model used, so an
 * escaped form reaches the tool exactly as a model would send it.
 */
async function mutationArgs(
	tool: ToolDefinition,
	cwd: string,
	target: string,
	escapedPath: string,
	content: string,
): Promise<Record<string, unknown>> {
	if ("input" in declaredProperties(tool)) {
		return { input: `[${escapedPath}#${await snapshotTag(cwd, target)}]\nPUT 1.=1:\n+${content}` };
	}
	return { path: escapedPath, content };
}

describe("Action Fusion file URL paths", () => {
	it.each(["target.txt", "space and #hash %.txt"])("resolves a file URL and @file URL for %s", (name) => {
		const cwd = join(tmpdir(), "action-fusion-cwd");
		const target = resolve(tmpdir(), name);
		const url = pathToFileURL(target).href;
		expect(resolveToolPath(cwd, url)).toBe(target);
		expect(resolveToolPath(cwd, `@${url}`)).toBe(target);
	});

	it("converts Git Bash, MSYS, Cygwin, and WSL drive paths on Windows", () => {
		withPlatform("win32", () => {
			expect(normalizeWindowsShellPath("/c/src/app.ts")).toBe("C:\\src\\app.ts");
			expect(normalizeWindowsShellPath("/mnt/d/work/notes.md")).toBe("D:\\work\\notes.md");
			expect(normalizeWindowsShellPath("/cygdrive/e/x/y")).toBe("E:\\x\\y");
			expect(normalizeWindowsShellPath("/c")).toBe("C:\\");
			// Not a drive path: leave it alone.
			expect(normalizeWindowsShellPath("/usr/local/bin/pi")).toBe("/usr/local/bin/pi");
			expect(normalizeWindowsShellPath("//server/share/file.txt")).toBe("//server/share/file.txt");
			expect(normalizeWindowsShellPath("C:\\already\\native.ts")).toBe("C:\\already\\native.ts");
		});
	});

	it("leaves a POSIX path alone off Windows", () => {
		withPlatform("linux", () => {
			expect(normalizeWindowsShellPath("/c/src/app.ts")).toBe("/c/src/app.ts");
		});
	});

	it.each([
		["/c/work/a\u00a0b.txt", "C:\\work\\a b.txt"],
		["/mnt/d/work/a\u202fb.txt", "D:\\work\\a b.txt"],
		["/cygdrive/e/work/a\u3000b.txt", "E:\\work\\a b.txt"],
	])("composes Unicode, optional @, and Windows drive normalization for %s", (input, nativePath) => {
		const cwd = join(tmpdir(), "action-fusion-cwd");
		withPlatform("win32", () => {
			for (const prefix of ["", "@"]) {
				expect(resolveToolPath(cwd, `${prefix}${input}`)).toBe(resolve(cwd, nativePath));
			}
		});
	});

	it("composes Unicode, optional @, and Windows home expansion", () => {
		withPlatform("win32", () => {
			expect(resolveToolPath("/work", "@~\\a\u00a0b.txt")).toBe(resolve(homedir(), "a b.txt"));
		});
	});

	it.skipIf(process.platform === "win32")("resolves a POSIX path on a POSIX host", () => {
		expect(resolveToolPath("/work", "/c/src/app.ts")).toBe("/c/src/app.ts");
	});

	it("expands a Windows home-relative path", () => {
		withPlatform("win32", () => {
			expect(resolveToolPath("/work", "~\\notes.txt")).toBe(resolve(homedir(), "notes.txt"));
		});
		withPlatform("linux", () => {
			// A backslash is an ordinary filename character here.
			expect(resolveToolPath("/work", "~\\notes.txt")).toBe(resolve("/work", "~\\notes.txt"));
		});
	});

	it("preserves ordinary relative and absolute path semantics", () => {
		const cwd = join(tmpdir(), "action-fusion-cwd");
		const target = join(cwd, "target.txt");
		expect(resolveToolPath(cwd, "target.txt")).toBe(target);
		expect(resolveToolPath(cwd, "@target.txt")).toBe(target);
		expect(resolveToolPath(cwd, target)).toBe(target);
	});

	it.each(["\u00A0", "\u2000", "\u200A", "\u202F", "\u205F", "\u3000"])(
		"normalizes Unicode space %s like Pi's built-in file tools",
		(space) => {
			const cwd = join(tmpdir(), "action-fusion-cwd");
			expect(resolveToolPath(cwd, `target${space}file.txt`)).toBe(join(cwd, "target file.txt"));
		},
	);

	it.each([
		{ name: "write", prefix: "" }, { name: "edit", prefix: "" },
		{ name: "write", prefix: "@" }, { name: "edit", prefix: "@" },
	])("runs then_run after a real $name through an escaped $prefix file URL", async ({ name, prefix }) => {
		const cwd = await createTempDir();
		const target = join(cwd, "space and #hash %.txt");
		if (name === "edit") await writeFile(target, "before\n");
		const commands: string[] = [];
		const tools = loadTools({
			bashOptions: { operations: { exec: async (command, commandCwd) => {
				commands.push(command);
				expect(commandCwd).toBe(cwd);
				expect(await readFile(target, "utf8")).toBe("after\n");
				return { exitCode: 0 };
			} } },
		});
		const tool = tools.get(name)!;
		const escaped = `${prefix}${pathToFileURL(target).href}`;
		const input = {
			...(await mutationArgs(tool, cwd, target, escaped, "after\n")),
			then_run: { command: "check target" },
		};
		const result = await tool.execute("file-url", input, undefined, undefined, context(cwd));
		expect(commands).toEqual(["check target"]);
		expect(result.content).toContainEqual({
			type: "text",
			text: expect.stringMatching(/^\[then_run:succeeded\](?:\n|$)/),
		});
		expect(await readFile(target, "utf8")).toBe("after\n");
	});

	it.each(["write", "edit"])("runs then_run after a real %s through a Unicode-space path", async (name) => {
		const cwd = await createTempDir();
		const target = join(cwd, `${name} space.txt`);
		if (name === "edit") await writeFile(target, "before\n");
		const commands: string[] = [];
		const tools = loadTools({
			bashOptions: { operations: { exec: async (command, commandCwd) => {
				commands.push(command);
				expect(commandCwd).toBe(cwd);
				expect(await readFile(target, "utf8")).toBe("after\n");
				return { exitCode: 0 };
			} } },
		});
		const tool = tools.get(name)!;
		const escaped = `${name}\u00A0space.txt`;
		const input = {
			...(await mutationArgs(tool, cwd, target, escaped, "after\n")),
			then_run: { command: "check target" },
		};
		const result = await tool.execute("unicode-space", input, undefined, undefined, context(cwd));
		expect(commands).toEqual(["check target"]);
		expect(result.content).toContainEqual({
			type: "text",
			text: expect.stringMatching(/^\[then_run:succeeded\](?:\n|$)/),
		});
		expect(await readFile(target, "utf8")).toBe("after\n");
	});

	it("executes a real bash follow-up after writing through a file URL", async () => {
		const cwd = await createTempDir();
		const target = join(cwd, "real-command.txt");
		const result = await loadTools().get("write")!.execute("real-command", {
			path: pathToFileURL(target).href,
			content: "written\n",
			then_run: { command: "printf FILE_URL_THEN_RUN_OK" },
		}, undefined, undefined, context(cwd));
		const output = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		expect(output).toContain("[then_run:succeeded]");
		expect(output).toContain("FILE_URL_THEN_RUN_OK");
		expect(await readFile(target, "utf8")).toBe("written\n");
	});

	it("serializes a file URL and ordinary path to the same file through then_run", async () => {
		const cwd = await createTempDir();
		const target = join(cwd, "shared file.txt");
		const events: string[] = [];
		const commandStarted = Promise.withResolvers<void>();
		const releaseCommand = Promise.withResolvers<void>();
		const tools = loadTools({
			bashOptions: { operations: { exec: async () => {
				events.push("command:start");
				commandStarted.resolve();
				await releaseCommand.promise;
				events.push("command:end");
				return { exitCode: 0 };
			} } },
		});
		const write = tools.get("write")!;
		const first = write.execute("url", { path: pathToFileURL(target).href, content: "first", then_run: { command: "block" } }, undefined, undefined, context(cwd));
		// Propagate an early failure instead of waiting forever for the command.
		await Promise.race([commandStarted.promise, first]);
		const second = write.execute("ordinary", { path: target, content: "second" }, undefined, undefined, context(cwd));
		try {
			// Only the fused call may have started its command so far.
			expect(events).toEqual(["command:start"]);
		} finally {
			releaseCommand.resolve();
			await Promise.all([first, second]);
		}
		expect(events).toEqual(["command:start", "command:end"]);
		// The second write ran after the first call released the file queue, and the
		// two calls targeted the same file, so its content is the one left behind.
		expect(await readFile(target, "utf8")).toBe("second");
	});

	it("does not run a command or create a file for an invalid encoded file URL", async () => {
		const cwd = await createTempDir();
		let commands = 0;
		const tools = loadTools({
			bashOptions: { operations: { exec: async () => { commands++; return { exitCode: 0 }; } } },
		});
		const invalidUrl = `${pathToFileURL(cwd).href}/bad%2Fname.txt`;
		await expect(tools.get("write")!.execute("invalid", { path: invalidUrl, content: "unused", then_run: { command: "must not run" } }, undefined, undefined, context(cwd))).rejects.toThrow();
		expect(commands).toBe(0);
	});
});
