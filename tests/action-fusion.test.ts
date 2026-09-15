/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, mock, vi } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import {
	type BashOperations,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import {
	type ActionFusionOptions,
	assertUnchangedBeforeCommand,
	createActionFusionExtension,
} from "../src/sol-pi/extensions/action-fusion/index.ts";
import { withFusedFileQueue } from "../src/sol-pi/extensions/action-fusion/file-queue.ts";
import { componentText, plainTheme } from "./helpers.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

type ObjectSchema = { properties: Record<string, unknown>; required?: string[] };
type FusedTools = { edit: ToolDefinition; write: ToolDefinition };

/**
 * The tool's declared parameters as JSON Schema. The builder is the host's own
 * callable omptype schema, so the wire document it emits is exactly what the
 * provider sees.
 */
function objectSchema(tool: ToolDefinition): ObjectSchema {
	const builder = tool.parameters as unknown as { toJsonSchema: () => ObjectSchema };
	return builder.toJsonSchema();
}

function loadFusedTools(options?: ActionFusionOptions): FusedTools {
	const registered = new Map<string, ToolDefinition>();
	const pi = {
		registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool),
	} as unknown as ExtensionAPI;
	createActionFusionExtension(options)(pi);
	const edit = registered.get("edit");
	const write = registered.get("write");
	if (!edit || !write) throw new Error("action fusion did not register edit and write");
	return { edit, write };
}

/**
 * A `[PATH#TAG]` header carrying the host's own current snapshot tag. The
 * built-in `edit` is hashline-shaped on this host and rejects any tag it did
 * not mint, so the tag must come from a real `read` of the file.
 */
async function hashlineInput(dir: string, path: string): Promise<string> {
	const read = createReadToolDefinition(dir);
	const result = await read.execute(
		"read-for-tag",
		{ path } as never,
		undefined,
		undefined,
		createContext(dir),
	);
	const header = /^\[([^\]\r\n]+#[0-9A-Fa-f]{4})\]/mu.exec(text(result));
	if (!header) throw new Error(`read produced no hashline header for ${path}`);
	return `[${header[1]}]\n`;
}

function createContext(cwd: string, overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		mode: "json",
		hasUI: false,
		cwd,
		model: undefined,
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => "action-fusion-test",
		},
		ui: {},
		...overrides,
	} as unknown as ExtensionContext;
}

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-then-run-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("action fusion then_run", () => {
	it("adds an optional command and timeout object to edit and write", () => {
		const { edit, write } = loadFusedTools();

		expect(objectSchema(write).properties.then_run).toMatchObject({
			type: "object",
			description:
				"Command to run next on this file after the write succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the write fails; a non-zero exit is reported but keeps the write.",
			properties: {
				command: { type: "string" },
				timeout: { type: "number" },
			},
			required: ["command"],
		});
		expect(objectSchema(edit).properties.then_run).toMatchObject({
			type: "object",
			description:
				"Command to run next on this file after the edit succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the edit fails; a non-zero exit is reported but keeps the edit.",
			properties: {
				command: { type: "string" },
				timeout: { type: "number" },
			},
			required: ["command"],
		});
		expect(objectSchema(write).required).not.toContain("then_run");
		expect(objectSchema(edit).required).not.toContain("then_run");
	});

	/**
  * The fusion composes from the host's live definitions, so the guard is that
  * every field the host's own built-in declares survives into the fused tool —
  * plus `then_run`. Comparing against the host's schema rather than a literal
  * keeps this honest whichever edit mode the host resolves (hashline's `input`,
  * patch's `path`/`edits`, replace's `old_string`/`new_string`, …).
  */
	it("keeps every built-in parameter of the host's edit and write tools", () => {
		const { edit, write } = loadFusedTools();

		for (const [fused, base] of [
			[write, createWriteToolDefinition(process.cwd())],
			[edit, createEditToolDefinition(process.cwd())],
		] as const) {
			const baseSchema = objectSchema(base);
			const fusedSchema = objectSchema(fused);

			expect(Object.keys(fusedSchema.properties)).toEqual([...Object.keys(baseSchema.properties), "then_run"]);
			expect(fusedSchema.properties).toMatchObject(baseSchema.properties);
			expect(fusedSchema.required).toEqual(baseSchema.required);
			expect(fused.name).toBe(base.name);
		}
	});

	it.each([
		{ label: "default checkout name", cwd: join(tmpdir(), "SoL-Pi"), path: "target.ts" },
		{ label: "unrelated checkout name", cwd: join(tmpdir(), "plain-checkout"), path: "target.ts" },
		{ label: "repository name in the target path", cwd: join(tmpdir(), "plain-checkout"), path: "SoL-Pi/target.ts" },
	])("renders a fused mutation as an English lightning savings call ($label)", ({ cwd, path }) => {
		const { write } = loadFusedTools();
		const fusedArgs = {
			path,
			content: "export {};\n",
			then_run: { command: "npm test" },
		};
		const fused = write.renderCall!(fusedArgs, { cwd } as never, plainTheme);
		const plainArgs = { path, content: "export {};\n" };
		const plain = write.renderCall!(plainArgs, { cwd } as never, plainTheme);

		expect(componentText(fused)).toContain("⚡ SoL-Pi · Action Fusion");
		expect(componentText(fused)).toContain("Money saved · 1 model round-trip avoided");
		// A normal path or its OSC 8 hyperlink may contain the repository name.
		expect(componentText(plain)).not.toContain("⚡ SoL-Pi · Action Fusion");
		expect(componentText(plain)).not.toContain("Money saved · 1 model round-trip avoided");
	});

	it("runs write then_run through bash after the written content is visible", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "written.txt");
		const commands: string[] = [];
		const operations: BashOperations = {
			exec: async (command, cwd, { onData }) => {
				commands.push(command);
				expect(cwd).toBe(dir);
				expect(await readFile(filePath, "utf8")).toBe("new content\n");
				onData(Buffer.from("write check passed\n"));
				return { exitCode: 0 };
			},
		};
		const { write } = loadFusedTools({ bashOptions: { operations } });

		const result = await write.execute(
			"write-1",
			{ path: filePath, content: "new content\n", then_run: { command: "check write" } },
			undefined,
			undefined,
			createContext(dir),
		);

		expect(commands).toEqual(["check write"]);
		expect(text(result)).toContain("[then_run:succeeded]");
		expect(text(result)).toContain("write check passed");
	});

	it("announces savings only after a fused command succeeds in TUI mode", async () => {
		const dir = await createTempDir();
		const notify = mock();
		const setStatus = mock();
		const { write } = loadFusedTools({
			bashOptions: { operations: { exec: async () => ({ exitCode: 0 }) } },
		});

		await write.execute(
			"write-tui",
			{ path: "target.ts", content: "export {};\n", then_run: { command: "npm test" } },
			undefined,
			undefined,
			createContext(dir, { mode: "tui", hasUI: true, ui: { notify, setStatus } as never }),
		);

		expect(notify).toHaveBeenCalledWith(
			"⚡ SoL-Pi · Action Fusion\nMoney saved · 1 model round-trip avoided",
			"info",
		);
	});

	it("runs edit then_run after the edited content is visible", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "edited.txt");
		await writeFile(filePath, "before\n", "utf8");
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				expect(await readFile(filePath, "utf8")).toBe("after\n");
				onData(Buffer.from("edit check passed\n"));
				return { exitCode: 0 };
			},
		};
		const { edit } = loadFusedTools({ bashOptions: { operations } });

		const result = await edit.execute(
			"edit-1",
			{ input: `${await hashlineInput(dir, filePath)}PUT 1.=1:\n+after\n`, then_run: { command: "check edit" } },
			undefined,
			undefined,
			createContext(dir),
		);

		expect(text(result)).toContain("[then_run:succeeded]");
		expect(text(result)).toContain("edit check passed");
	});

	it("leaves a mutation without then_run untouched", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "plain.txt");
		let bashCalls = 0;
		const operations: BashOperations = {
			exec: async () => {
				bashCalls++;
				return { exitCode: 0 };
			},
		};
		const { write } = loadFusedTools({ bashOptions: { operations } });

		const result = await write.execute(
			"write-plain",
			{ path: filePath, content: "plain\n" },
			undefined,
			undefined,
			createContext(dir),
		);

		expect(bashCalls).toBe(0);
		expect(text(result)).not.toContain("[then_run:");
		expect(await readFile(filePath, "utf8")).toBe("plain\n");
	});

	it("preserves a successful mutation when then_run fails", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "preserved.txt");
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("validation failed\n"));
				return { exitCode: 7 };
			},
		};
		const { write } = loadFusedTools({ bashOptions: { operations } });

		await expect(
			write.execute(
				"write-2",
				{ path: filePath, content: "keep me\n", then_run: { command: "exit 7" } },
				undefined,
				undefined,
				createContext(dir),
			),
		).rejects.toThrow("[then_run:failed]");
		expect(await readFile(filePath, "utf8")).toBe("keep me\n");
	});

	it("skips then_run and reports it when the mutation fails", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "rejected.txt");
		await writeFile(filePath, "before\n", "utf8");
		let bashCalls = 0;
		const operations: BashOperations = {
			exec: async () => {
				bashCalls++;
				return { exitCode: 0 };
			},
		};
		const { edit } = loadFusedTools({ bashOptions: { operations } });

		// A stale snapshot tag is how the host's hashline `edit` reports failure: it
		// returns `isError` rather than throwing, so the follow-up must not run and
		// the file must keep its original content.
		await expect(
			edit.execute(
				"edit-2",
				{ input: `[${filePath}#0000]\nPUT 1.=1:\n+after\n`, then_run: { command: "must not run" } },
				undefined,
				undefined,
				createContext(dir),
			),
		).rejects.toThrow("[then_run:skipped]");
		expect(bashCalls).toBe(0);
		expect(await readFile(filePath, "utf8")).toBe("before\n");
	});

	it("keeps the file queue locked through then_run", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "ordered.txt");
		const thenRunStarted = deferred();
		const finishThenRun = deferred();
		const events: string[] = [];
		const operations: BashOperations = {
			exec: async () => {
				events.push("then_run:start");
				thenRunStarted.resolve();
				await finishThenRun.promise;
				events.push("then_run:end");
				return { exitCode: 0 };
			},
		};
		const { write } = loadFusedTools({ bashOptions: { operations } });
		const ctx = createContext(dir);

		const first = write.execute(
			"write-3",
			{ path: filePath, content: "first", then_run: { command: "block" } },
			undefined,
			undefined,
			ctx,
		);
		await thenRunStarted.promise;
		// The fused call still holds this file's queue slot, so the second mutation
		// cannot run its own follow-up until the first one finishes.
		const second = write.execute(
			"write-4",
			{ path: filePath, content: "second", then_run: { command: "after second" } },
			undefined,
			undefined,
			ctx,
		);
		expect(events).toEqual(["then_run:start"]);

		finishThenRun.resolve();
		await Promise.all([first, second]);
		expect(events).toEqual(["then_run:start", "then_run:end", "then_run:start", "then_run:end"]);
		expect(await readFile(filePath, "utf8")).toBe("second");
	});

	it("passes then_run timeout through to the bash operation", async () => {
		const dir = await createTempDir();
		const operations: BashOperations = {
			exec: async (command, _cwd, { timeout }) => {
				expect(command).toBe("check with timeout");
				expect(timeout).toBe(12);
				return { exitCode: 0 };
			},
		};
		const { write } = loadFusedTools({ bashOptions: { operations } });

		const result = await write.execute(
			"write-timeout",
			{ path: "timeout.txt", content: "content\n", then_run: { command: "check with timeout", timeout: 12 } },
			undefined,
			undefined,
			createContext(dir),
		);

		expect(text(result)).toContain("[then_run:succeeded]");
	});

	it("passes the command unchanged to Pi's default bash behavior", async () => {
		const dir = await createTempDir();
		const commands: string[] = [];
		const operations: BashOperations = {
			exec: async (command) => {
				commands.push(command);
				return { exitCode: 0 };
			},
		};
		const { write } = loadFusedTools({ bashOptions: { operations } });

		await write.execute(
			"write-default-shell",
			{ path: "default-shell.txt", content: "content\n", then_run: { command: "check default shell" } },
			undefined,
			undefined,
			createContext(dir),
		);

		expect(commands).toEqual(["check default shell"]);
	});

	it("serializes direct uses of the extension queue", async () => {
		const events: string[] = [];
		const firstStarted = deferred();
		const releaseFirst = deferred();
		let firstFinished = false;
		const queuePath = join(tmpdir(), "action-fusion-queue");
		const first = withFusedFileQueue(queuePath, async () => {
			events.push("first:start");
			firstStarted.resolve();
			await releaseFirst.promise;
			events.push("first:end");
			firstFinished = true;
		});
		await firstStarted.promise;
		// The second task must not enter the critical section until the first one
		// has released it, so it observes the first task's completion.
		const second = withFusedFileQueue(queuePath, async () => {
			events.push(`second:firstFinished=${firstFinished}`);
		});
		releaseFirst.resolve();
		await Promise.all([first, second]);
		expect(events).toEqual(["first:start", "first:end", "second:firstFinished=true"]);
	});

	it("skips the command when the target changes after mutation", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "changed-before-command.txt");
		await writeFile(filePath, "mutation result\n");

		await expect(
			assertUnchangedBeforeCommand(filePath, async () => {
				await writeFile(filePath, "external change\n");
			}),
		).rejects.toThrow("[then_run:skipped] target content changed after the fused mutation");
	});
});
