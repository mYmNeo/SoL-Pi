/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import {
	AuthStorage,
	createAgentSession,
	ModelRegistry,
	SessionManager,
	Settings,
	SqliteAuthCredentialStore,
	type AgentSession,
} from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
import { expect, it } from "bun:test";
import { DEFAULT_CONFIG } from "../src/sol-pi/config.ts";

/**
 * In-process boot of the real package entrypoint.
 *
 * omp specifics this test cannot express through Pi's `DefaultResourceLoader`:
 *
 *  - `session_start` is emitted by `initializeExtensions` (a mode-level step),
 *    NOT by `createAgentSession`. The entrypoint registers every mechanism from
 *    its `session_start` handler, so skipping that call yields a session whose
 *    extension loaded but registered nothing.
 *  - The mock provider only resolves through the custom-API registry, so
 *    `registerMockApi()` must run before the session is built, and the model
 *    still needs a resolved credential (`AuthStorage` + `setRuntimeApiKey`).
 *  - Settings come from an isolated in-memory instance pinned to the temp
 *    `cwd`/`agentDir`; nothing is read from or written to the real agent dir.
 */
it("loads the package entrypoint and executes fused tools in an all-enabled session", async () => {
	registerMockApi();
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-package-"));
	const agentDir = join(cwd, "agent");
	let session: AgentSession | undefined;
	try {
		await mkdir(agentDir);
		await mkdir(join(cwd, CONFIG_DIR_NAME));
		await writeFile(join(cwd, CONFIG_DIR_NAME, "sol-pi.json"), JSON.stringify({
			...DEFAULT_CONFIG,
			actionFusion: true,
			observationPack: true,
			evidencePreservingReducer: true,
			onlineContextCompact: true,
		}));

		// Deterministic run: no background compaction pass and no provider retry.
		// `tools.xdev` must be off: omp mounts `discoverable` tools (every extension
		// tool, by default) under `xd://` while it is on, and this scenario's model
		// calls `update_plan` directly as a top-level tool.
		const settings = await Settings.loadIsolated({
			cwd,
			agentDir,
			inMemory: true,
			overrides: { "compaction.enabled": false, "retry.enabled": false, "tools.xdev": false },
		});
		const model = createMockModel({
			id: "sol-pi-package-model",
			provider: "mock",
			contextWindow: 200_000,
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "write",
							arguments: {
				path: "result.txt",
				content: "package integration passed\n",
				then_run: { command: "cat result.txt" },
							},
						},
					],
				},
				{
					content: [
						{
							type: "toolCall",
							name: "update_plan",
							arguments: { steps: [{ id: "verify", goal: "verify the package", status: "in_progress" }] },
						},
					],
				},
				{ content: ["package smoke complete"] },
			],
		});
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		authStorage.setRuntimeApiKey(model.provider, "package-integration-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));

		const created = await createAgentSession({
			cwd,
			agentDir,
			settingsManager: settings,
			authStorage,
			modelRegistry,
			sessionManager,
			additionalExtensionPaths: [join(process.cwd(), "src/sol-pi/index.ts")],
			disableExtensionDiscovery: true,
			model,
			thinkingLevel: "off",
		});
		session = created.session;
		expect(created.extensionsResult.errors).toEqual([]);

		const errors: unknown[] = [];
		await initializeExtensions(session, {
			reportSendError: (action, error) => errors.push([action, error.message]),
			reportRuntimeError: (error) => errors.push(error),
		});

		const entry = created.extensionsResult.extensions.find((extension) =>
			extension.path.endsWith("src/sol-pi/index.ts"),
		);
		expect(entry).toBeDefined();
		// The extension's own tools, not the built-ins it also re-registers: with
		// `tools.xdev` off, every registered tool is presented top-level, so an
		// all-enabled config must surface all four mechanisms' tools by name.
		expect([...(entry?.tools.keys() ?? [])]).toEqual(
			expect.arrayContaining(["edit", "write", "obs_recall", "update_plan"]),
		);
		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["edit", "write", "obs_recall", "update_plan"]),
		);
		expect(entry?.handlers.has("tool_result")).toBe(true);
		expect(entry?.handlers.has("context")).toBe(true);

		await session.prompt("run the package smoke test", { expandPromptTemplates: false });
		await session.waitForIdle();

		const toolResults = sessionManager.getBranch().flatMap((branchEntry) =>
			branchEntry.type === "message" && branchEntry.message.role === "toolResult" ? [branchEntry.message] : [],
		);
		expect(toolResults).toHaveLength(2);
		expect(toolResults.every((result) => !result.isError)).toBe(true);

		const writeResult = toolResults.find((result) => result.toolName === "write");
		const observation = writeResult?.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n");
		expect(observation).toContain("[then_run:succeeded]");
		expect(observation).toContain("package integration passed");

		const planResult = toolResults.find((result) => result.toolName === "update_plan");
		const planText = planResult?.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n");
		expect(planText).toContain("verify");

		expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("package integration passed\n");
		expect(session.getLastAssistantText()).toBe("package smoke complete");
		expect(session.isStreaming).toBe(false);
		expect(model.calls).toHaveLength(3);
		expect(errors).toEqual([]);
	} finally {
		await session?.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
}, 30_000);
