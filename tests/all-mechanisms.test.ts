/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, mock } from "bun:test";
import { DEFAULT_CONFIG } from "../src/sol-pi/config.ts";
import { REDUCER_RECEIPT_SCHEMA } from "../src/sol-pi/extensions/evidence-preserving-reducer/index.ts";
import { createSolPiExtension, registerConfiguredFeatures } from "../src/sol-pi/index.ts";
import { FakePi, fakeContext } from "./helpers.ts";

// The reducer's completion seam is omp's real `complete`, which dispatches on the
// model's `api`; registering the mock provider is what lets a configured
// mock-provider reducer model actually receive the request.
registerMockApi();

const CUSTOM_REDUCER = createMockModel({
	id: "configured-reducer-model",
	provider: "configured-provider",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 4_096,
});

function contextInput(context: Context): string {
	const message = context.messages[0];
	if (message?.role !== "user") throw new Error("reducer request omitted its user message");
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}

function sourceHash(input: string): string {
	const match = input.match(/source_sha256=([a-f0-9]{64})/u);
	if (!match?.[1]) throw new Error("request omitted source hash");
	return match[1];
}

function bashEvent(body: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId: "call-configured-reducer",
		input: { command: "pytest -q" },
		content: [{ type: "text", text: body }],
		details: undefined,
		isError: true,
	} as ToolResultEvent;
}

describe("SoL-Pi entrypoint", () => {
	it("registers no tools or events when every feature is disabled", () => {
		const pi = new FakePi();
		registerConfiguredFeatures(pi.asExtensionApi(), DEFAULT_CONFIG);
		expect(pi.registeredTools).toEqual([]);
		expect(pi.handlers.size).toBe(0);
	});

	it("registers all four standalone mechanisms from one config", () => {
		const pi = new FakePi();
		registerConfiguredFeatures(pi.asExtensionApi(), {
			...DEFAULT_CONFIG,
			actionFusion: true,
			observationPack: true,
			evidencePreservingReducer: true,
			onlineContextCompact: true,
		});

		expect(pi.registeredTools.map((tool) => tool.name)).toEqual(["edit", "write", "obs_recall", "update_plan"]);
		expect([...pi.handlers.keys()].sort()).toEqual([
			"before_provider_request",
			"context",
			"input",
			"session_before_tree",
			"session_compact",
			"session_shutdown",
			"session_start",
			"session_stop",
			"session_tree",
			"tool_result",
			"turn_end",
		]);
	});

	it("waits for a trusted session context and initializes once", async () => {
		const pi = new FakePi();
		const loader = mock(() => ({ ...DEFAULT_CONFIG, observationPack: true }));
		createSolPiExtension(loader)(pi.asExtensionApi());
		expect([...pi.handlers.keys()]).toEqual(["session_start"]);

		const ctx = fakeContext(pi.sessionManager);
		await pi.emit("session_start", { type: "session_start" }, ctx);
		await pi.emit("session_start", { type: "session_start" }, ctx);

		expect(loader).toHaveBeenCalledTimes(1);
		expect(pi.registeredTools.map((tool) => tool.name)).toEqual(["obs_recall"]);
		expect([...pi.handlers.keys()].sort()).toEqual(["context", "session_start"]);
	});

	it("passes the configured reducer provider/model route into EPR", async () => {
		const root = mkdtempSync(join(tmpdir(), "sol-pi-configured-epr-"));
		try {
			const pi = new FakePi();
			registerConfiguredFeatures(pi.asExtensionApi(), {
				...DEFAULT_CONFIG,
				evidencePreservingReducer: true,
				evidencePreservingReducerProvider: CUSTOM_REDUCER.provider,
				evidencePreservingReducerModel: CUSTOM_REDUCER.id,
			});
			const body = `ERROR configured reducer failure\n${"diagnostic line\n".repeat(360)}`;
			// The reducer reaches the model through omp's real `complete`, which dispatches
			// on the model's `api`. The configured reducer model is a mock-provider model,
			// so scripting it is what proves the configured route was the one taken.
			CUSTOM_REDUCER.reset();
			CUSTOM_REDUCER.fallback = (request) => ({
							content: [
								{
									type: "text",
									text: JSON.stringify({
										schema: REDUCER_RECEIPT_SCHEMA,
							source_sha256: sourceHash(contextInput(request)),
										status: "failure",
										uncertain: false,
										evidence: [{ kind: "failure", quote: "ERROR configured reducer failure" }],
									}),
								},
							],
							usage: {
								input: 10,
								output: 10,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 20,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
			});
			const context = fakeContext(root, {
				modelRegistry: {
					find: (provider: string, modelId: string) =>
						provider === CUSTOM_REDUCER.provider && modelId === CUSTOM_REDUCER.id ? CUSTOM_REDUCER : undefined,
					// omp's auth contract: a bare success carries no credentials.
					getApiKeyAndHeaders: async () => ({ ok: true }),
				} as unknown as ExtensionContext["modelRegistry"],
			});

			const result = (await pi.emit("tool_result", bashEvent(body), context)) as {
				content: { type: string; text: string }[];
			};

			try {
				expect(CUSTOM_REDUCER.calls).toHaveLength(1);
			expect(result.content[0]?.text ?? "").toContain(`reducer_model=${CUSTOM_REDUCER.id}`);
			expect(result.content[0]?.text ?? "").toContain(`reducer_provider=${CUSTOM_REDUCER.provider}`);
			} finally {
				CUSTOM_REDUCER.reset();
				CUSTOM_REDUCER.fallback = undefined;
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
