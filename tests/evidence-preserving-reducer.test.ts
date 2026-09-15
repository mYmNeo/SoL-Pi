/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { Context, Model, StopReason } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, mock, vi } from "bun:test";
import {
	createEvidencePreservingReducerExtension,
	DIAGNOSTIC_COMMAND,
	loadReducerConfig,
	REDUCER_RECEIPT_SCHEMA,
} from "../src/sol-pi/extensions/evidence-preserving-reducer/index.ts";
import { archiveBody } from "../src/sol-pi/extensions/evidence-preserving-reducer/archive.ts";
import { callReducer } from "../src/sol-pi/extensions/evidence-preserving-reducer/provider.ts";
import { runtimeRoot } from "../src/sol-pi/runtime-paths.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

const cleanupPaths: string[] = [];

// The reducer's completion seam is omp's real `complete`, which dispatches on
// the model's `api`. Registering the mock provider here is what lets the tests
// drive that module-level import instead of injecting a completion function the
// extension factory path never accepts.
registerMockApi();

const ACTIVE_MODEL = createMockModel({
	id: ["gpt-5.6", "sol"].join("-"),
	provider: "openai-codex",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_384,
});

const REDUCER_MODEL = createMockModel({
	id: ["gpt-5.6", "luna"].join("-"),
	provider: "openai-codex",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 4_096,
});

interface ModelReceipt {
	schema: string;
	source_sha256: string;
	status: "success" | "failure";
	uncertain: boolean;
	evidence: { kind: string; quote: string }[];
}

interface CapturedCall {
	readonly context: Context;
	readonly model: Model<string>;
	readonly options: Record<string, unknown>;
}

type ReducerAuth =
	| {
			readonly ok: true;
			readonly apiKey?: string;
			readonly headers?: Record<string, string>;
			readonly env?: Record<string, string>;
		}
	| { readonly ok: false; readonly error: string };

afterEach(async () => {
	vi.useRealTimers();
	// `reset()` clears recorded calls but deliberately leaves the fallback in
	// place, so clear it too: a scripted response must never leak into the next test.
	REDUCER_MODEL.reset();
	REDUCER_MODEL.fallback = undefined;
	await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * The reducer resolves its model and its credentials through the host registry,
 * so the registry is the only place a test can steer routing and auth. `find`
 * defaults to serving `REDUCER_MODEL`; `getApiKeyAndHeaders` defaults to a bare
 * success, which is what an unauthenticated route looks like on omp.
 */
function reducerRegistry(
	options: {
		auth?: ReducerAuth;
		find?: (provider: string, modelId: string) => Model<string> | undefined;
		onAuth?: (model: Model<string>) => void;
	} = {},
): ExtensionContext["modelRegistry"] {
	return {
		find:
			options.find ??
			((provider: string, modelId: string) =>
				provider === REDUCER_MODEL.provider && modelId === REDUCER_MODEL.id ? REDUCER_MODEL : undefined),
		getApiKeyAndHeaders: async (model: Model<string>) => {
			options.onAuth?.(model);
			return options.auth ?? { ok: true };
		},
	} as unknown as ExtensionContext["modelRegistry"];
}

/**
 * The call the reducer actually placed, read off the model the host's `complete`
 * dispatched to. `streamMock` records the context and the exact option bag.
 */
function capturedModelCall(model: MockModel): CapturedCall | undefined {
	const call = model.calls[0];
	if (!call) return undefined;
	// The mock stores the host's own `SimpleStreamOptions`; read it as a plain record
	// so an assertion can probe the individual fields the reducer forwarded.
	const options = (call.options ?? {}) as unknown as Record<string, unknown>;
	return { context: call.context, model, options };
}

/** The request's abort signal, narrowed rather than asserted. */
function signalOf(call: CapturedCall | undefined): AbortSignal | undefined {
	const signal = call?.options.signal;
	return signal instanceof AbortSignal ? signal : undefined;
}

async function storeRoot(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "evidence-preserving-reducer-test-"));
	cleanupPaths.push(value);
	return value;
}

function bashEvent(body: string, overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId: "call-1",
		input: { command: "pytest -q" },
		content: [{ type: "text", text: body }],
		details: undefined,
		isError: true,
		...overrides,
	} as ToolResultEvent;
}

function fusedEvent(body: string, failed: boolean): ToolResultEvent {
	const marker = failed ? "[then_run:failed]" : "[then_run:succeeded]";
	const confirmation = "Successfully wrote 12 bytes to target.ts";
	return {
		type: "tool_result",
		toolName: "write",
		toolCallId: "write-1",
		input: { path: "target.ts", content: "export {};\n", then_run: { command: "npm test" } },
		content: failed
			? [{ type: "text", text: `${confirmation}\n\n${marker}\n\n${body}` }]
			: [
					{ type: "text", text: confirmation },
					{ type: "text", text: `${marker}\n${body}` },
				],
		details: { patch: "test patch" },
		isError: failed,
	} as ToolResultEvent;
}

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

/**
 * Script the reducer model's next response.
 *
 * The receipt is built from the request the reducer actually sent, so every
 * assertion downstream still proves the reducer's request carried the archive
 * hash, the untrusted log, and the instruction text.
 */
function scriptReducer(
	body: string,
	receiptFactory: (input: string) => ModelReceipt,
	stopReason: StopReason = "stop",
): void {
	REDUCER_MODEL.fallback = (context) => {
		const input = contextInput(context);
		const receipt = receiptFactory(input);
		return {
			content: stopReason === "error" ? [] : [{ type: "text", text: JSON.stringify(receipt) }],
			usage: {
				input: Math.ceil(body.length / 4),
				output: 90,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: Math.ceil(body.length / 4) + 90,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			...(stopReason === "error" ? { errorMessage: "model call failed" } : {}),
		};
	};
}

/** Script the reducer model to reject, as an unreachable provider or bad credential does. */
function scriptReducerFailure(error: unknown): void {
	REDUCER_MODEL.fallback = () => {
		throw error;
	};
}

function load(
	root: string,
	model: Model<string> | null = ACTIVE_MODEL,
	overrides: Partial<ExtensionContext> = {},
): { context: ExtensionContext; manager: FakeSessionManager; pi: FakePi } {
	const manager = new FakeSessionManager([], "reducer", root);
	const pi = new FakePi(manager);
	createEvidencePreservingReducerExtension()(pi.asExtensionApi());
	const context = fakeContext(manager, {
		model: model ?? undefined,
		modelRegistry: reducerRegistry(),
		...overrides,
	});
	return { context, manager, pi };
}

describe("evidence-preserving reducer", () => {
	it("registers without an extension-specific credential", () => {
		const pi = new FakePi();
		expect(() => createEvidencePreservingReducerExtension()(pi.asExtensionApi())).not.toThrow();
		expect(pi.handlers.get("tool_result")).toHaveLength(1);
	});

	it("keeps the SoL-Pi identifiers that are written to disk", async () => {
		const root = await storeRoot();
		const signal = "ERROR test target failed";
		const body = `${signal}\n${"diagnostic output\n".repeat(400)}`;
		scriptReducer(body, (input) => ({
				schema: REDUCER_RECEIPT_SCHEMA,
				source_sha256: sourceHash(input),
				status: "failure",
				uncertain: false,
				evidence: [{ kind: "failure", quote: signal }],
		}));
		const { context, manager, pi } = load(root);

		const result = (await pi.emit("tool_result", bashEvent(body), context)) as {
			content: { type: string; text: string }[];
			details: Record<string, unknown>;
		};

		expect(result.content[0]?.text ?? "").toMatch(/^sol_pi_evidence_receipt_v1\n/u);
		expect(REDUCER_RECEIPT_SCHEMA).toBe("sol-pi-evidence-receipt/1");
		expect(Object.keys(result.details)).toContain("evidencePreservingReducer");
		expect(manager.entries.map((entry) => entry.type === "custom" && entry.customType)).toContain(
			"sol-pi-evidence-preserving-reducer-v1",
		);
		expect(
			manager.customEntryData().every((entry) => entry.schema === "sol-pi-evidence-preserving-reducer/1"),
		).toBe(true);
	});

	it("keeps the diagnostic command trigger generic", () => {
		expect(DIAGNOSTIC_COMMAND.test("pytest -q")).toBe(true);
		expect(DIAGNOSTIC_COMMAND.test("lake build")).toBe(true);
		expect(DIAGNOSTIC_COMMAND.test("cargo test --all")).toBe(true);
		expect(DIAGNOSTIC_COMMAND.test("rg test src")).toBe(false);
	});

	it("loads a configured reducer provider/model route", async () => {
		const root = await storeRoot();
		const config = loadReducerConfig(root, {
			reducerProvider: "test-provider",
			reducerModel: "test-reducer-model",
		});

		expect(config.reducerProvider).toBe("test-provider");
		expect(config.reducerModel).toBe("test-reducer-model");
	});

	it("uses the Luna reducer model and accepts only verified exact quotes", async () => {
		vi.useFakeTimers();
		const root = await storeRoot();
		const fatal = "E   AssertionError: expected 4 but received 5";
		const body = ["pytest session starts", fatal, "FAILED tests/test_math.py::test_addition", ".".repeat(6000)].join(
			"\n",
		);
		const notify = mock();
		const setStatus = mock();
		scriptReducer(body, (input) => ({
					schema: REDUCER_RECEIPT_SCHEMA,
					source_sha256: sourceHash(input),
					status: "failure",
					uncertain: false,
					evidence: [
						{ kind: "failure", quote: fatal },
						{ kind: "target", quote: "FAILED tests/test_math.py::test_addition" },
					],
		}));
		const { context, manager, pi } = load(root, ACTIVE_MODEL, {
			mode: "tui",
			hasUI: true,
			ui: { notify, setStatus } as never,
		});

		const result = (await pi.emit("tool_result", bashEvent(body), context)) as {
			content: { type: string; text: string }[];
		};

		const call = capturedModelCall(REDUCER_MODEL);
		expect(call?.model).toBe(REDUCER_MODEL);
		expect(call?.context.systemPrompt?.join("\n")).toContain("lossless test/build output reducer");
		expect(contextInput(call!.context)).toContain("<untrusted_log>");
		// omp's stream options carry no total request deadline, so the reducer budget
		// is enforced by the abort signal the port arms instead of a `timeoutMs` field.
		expect(call?.options).toMatchObject({ cacheRetention: "none", maxTokens: 2_048 });
		expect(call?.options).not.toHaveProperty("timeoutMs");
		expect(signalOf(call)).toBeInstanceOf(AbortSignal);
		expect(signalOf(call)?.aborted).toBe(false);
		const receipt = result.content[0]?.text ?? "";
		expect(receipt).toMatch(/status=failure/u);
		expect(receipt).toMatch(/line=2/u);
		expect(receipt).toMatch(/reducer_provider=openai-codex/u);
		expect(receipt).toContain(`reducer_model=${REDUCER_MODEL.id}`);
		expect(receipt).toMatch(/authority=Sol retains diagnosis/u);
		expect(Buffer.byteLength(receipt)).toBeLessThan(Buffer.byteLength(body));

		const events = manager.customEntryData();
		const candidate = events.find((entry) => entry.kind === "candidate");
		expect(candidate).toBeTruthy();
		const sourcePath = String(candidate?.sourcePath);
		const localSourcePath = relative(join(runtimeRoot(context), "evidence-preserving-reducer"), sourcePath);
		expect(localSourcePath.length > 0 && !localSourcePath.startsWith("..") && !isAbsolute(localSourcePath)).toBe(true);
		expect(await readFile(sourcePath, "utf8")).toBe(body);
		expect((await stat(sourcePath)).mode & 0o777).toBe(0o600);
		expect(events.filter((entry) => entry.kind === "applied")).toHaveLength(1);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toMatch(
			/^⚡ SoL-Pi · Luna Delegating\nMoney saved · .+ removed from future prompts$/u,
		);
	});

	it("forwards host-resolved authentication onto the reducer request", async () => {
		const root = await storeRoot();
		const config = loadReducerConfig(join(root, "session-runtime"));
		const body = `ERROR auth forwarding\n${"diagnostic\n".repeat(400)}`;
		const archive = await archiveBody(config.storeRoot, body);
		scriptReducer(body, (input) => ({
				schema: REDUCER_RECEIPT_SCHEMA,
				source_sha256: sourceHash(input),
				status: "failure",
				uncertain: false,
			evidence: [{ kind: "failure", quote: "ERROR auth forwarding" }],
		}));
		const authModels: Model<string>[] = [];
		const context = fakeContext(new FakeSessionManager([], "auth-session", root), {
			model: ACTIVE_MODEL,
			modelRegistry: reducerRegistry({
				auth: {
					ok: true,
					apiKey: "host-test-key",
					headers: { "x-test-header": "host" },
					env: { TEST_REGION: "test" },
				},
				onAuth: (model) => authModels.push(model),
			}),
		});

		const result = await callReducer(config, "pytest -q", true, archive, body, context);

		expect(result.ok).toBe(true);
		// Auth is resolved for the reducer model the registry returned, never for the
		// session's active model: the reducer never carries its own credentials.
		expect(authModels).toEqual([REDUCER_MODEL]);
		const call = capturedModelCall(REDUCER_MODEL);
		expect(call?.model).toBe(REDUCER_MODEL);
		expect(call?.options).toMatchObject({
			apiKey: "host-test-key",
			headers: { "x-test-header": "host" },
			env: { TEST_REGION: "test" },
		});
	});

	it("omits unset authentication rather than forwarding nulls", async () => {
		const root = await storeRoot();
		const config = loadReducerConfig(join(root, "session-runtime"));
		const body = `ERROR no credentials\n${"diagnostic\n".repeat(400)}`;
		const archive = await archiveBody(config.storeRoot, body);
		scriptReducer(body, (input) => ({
			schema: REDUCER_RECEIPT_SCHEMA,
			source_sha256: sourceHash(input),
			status: "failure",
			uncertain: false,
			evidence: [{ kind: "failure", quote: "ERROR no credentials" }],
		}));
		const context = fakeContext(new FakeSessionManager([], "auth-empty-session", root), {
			model: ACTIVE_MODEL,
			modelRegistry: reducerRegistry({ auth: { ok: true } }),
		});

		const result = await callReducer(config, "pytest -q", true, archive, body, context);

		expect(result.ok).toBe(true);
		const options = capturedModelCall(REDUCER_MODEL)?.options ?? {};
		expect(options).not.toHaveProperty("apiKey");
		expect(options).not.toHaveProperty("headers");
		expect(options).not.toHaveProperty("env");
	});

	it("propagates a host authentication failure instead of calling the model", async () => {
		const root = await storeRoot();
		const config = loadReducerConfig(join(root, "session-runtime"));
		const body = `ERROR auth failure\n${"diagnostic\n".repeat(400)}`;
		const archive = await archiveBody(config.storeRoot, body);
		REDUCER_MODEL.fallback = () => {
			throw new Error("unexpected model call");
		};
		const context = fakeContext(new FakeSessionManager([], "auth-fail-session", root), {
			model: ACTIVE_MODEL,
			modelRegistry: reducerRegistry({ auth: { ok: false, error: "no credential for openai-codex" } }),
		});

		await expect(callReducer(config, "pytest -q", true, archive, body, context)).rejects.toThrow(
			"no credential for openai-codex",
		);
		expect(REDUCER_MODEL.calls).toHaveLength(0);
	});

	it.each([false, true])(
		"reduces fused command output while preserving the mutation confirmation (failed=%s)",
		async (failed) => {
			const root = await storeRoot();
			const signal = failed ? "ERROR test target failed" : "PASS test target completed";
			const body = `${signal}\n${"diagnostic output\n".repeat(400)}`;
			scriptReducer(body, (input) => ({
					schema: REDUCER_RECEIPT_SCHEMA,
					source_sha256: sourceHash(input),
					status: failed ? "failure" : "success",
					uncertain: false,
					evidence: [{ kind: failed ? "failure" : "summary", quote: signal }],
			}));
			const { context, manager, pi } = load(root);

			const result = (await pi.emit("tool_result", fusedEvent(body, failed), context)) as {
				content: Array<{ type: string; text?: string }>;
				details: Record<string, unknown>;
				isError: boolean;
			};

			const projected = result.content.map((content) => content.text ?? "").join("\n");
			expect(projected).toMatch(/Successfully wrote 12 bytes to target\.ts/u);
			expect(projected).toMatch(failed ? /\[then_run:failed\]/u : /\[then_run:succeeded\]/u);
			expect(projected).toMatch(/sol_pi_evidence_receipt_v1/u);
			expect(projected).not.toContain("diagnostic output");
			expect(result.isError).toBe(failed);
			expect(result.details.patch).toBe("test patch");
			const candidate = manager.customEntryData().find((entry) => entry.kind === "candidate");
			expect(await readFile(String(candidate?.sourcePath), "utf8")).toBe(body);
		},
	);

	it.each(["invented", "model-error"] as const)("fails open on %s", async (mode) => {
		const root = await storeRoot();
		const body = `ERROR real failure\n${"x".repeat(5000)}`;
		scriptReducer(
				body,
				(input) => ({
					schema: REDUCER_RECEIPT_SCHEMA,
					source_sha256: sourceHash(input),
					status: "failure",
					uncertain: false,
					evidence: [{ kind: "failure", quote: "ERROR invented failure" }],
				}),
				mode === "model-error" ? "error" : "stop",
		);
		const { context, manager, pi } = load(root);

		const result = await pi.emit("tool_result", bashEvent(body), context);

		expect(result).toBeUndefined();
		const fallbacks = manager.customEntryData().filter((entry) => entry.kind === "fallback");
		expect(
			fallbacks.some((entry) =>
				mode === "model-error"
					? entry.reason === "model-response-error" && entry.stopReason === "error"
					: entry.reason === "unverifiable-quote",
			),
		).toBe(true);
	});

	it("fails open when the nested model call throws", async () => {
		const root = await storeRoot();
		const body = `ERROR real failure\n${"x".repeat(5000)}`;
		scriptReducerFailure(new Error("authentication is not configured"));
		const { context, manager, pi } = load(root);

		expect(await pi.emit("tool_result", bashEvent(body), context)).toBeUndefined();
		expect(manager.customEntryData()).toContainEqual(
			expect.objectContaining({ kind: "fallback", reason: "model-call-exception" }),
		);
	});

	it("fails open when the configured reducer model is unavailable", async () => {
		const root = await storeRoot();
		const body = `ERROR real failure\n${"x".repeat(5000)}`;
		let calls = 0;
		REDUCER_MODEL.fallback = () => {
				calls++;
				throw new Error("unexpected model call");
		};
		const { context, manager, pi } = load(root, ACTIVE_MODEL, {
			modelRegistry: reducerRegistry({ find: () => undefined }),
		});

		expect(await pi.emit("tool_result", bashEvent(body), context)).toBeUndefined();
		expect(calls).toBe(0);
		expect(manager.customEntryData()).toContainEqual(
			expect.objectContaining({ kind: "fallback", reason: "reducer-model-unavailable" }),
		);
	});

	it("fails open when the session has no persistent directory", async () => {
		const manager = new FakeSessionManager([], "ephemeral-session", "");
		const pi = new FakePi(manager);
		createEvidencePreservingReducerExtension()(pi.asExtensionApi());
		let calls = 0;
		REDUCER_MODEL.fallback = () => {
					calls++;
					throw new Error("unexpected model call");
		};
		const context = fakeContext(manager, { model: ACTIVE_MODEL, modelRegistry: reducerRegistry() });
		const body = `ERROR no session storage\n${"x".repeat(5000)}`;

		expect(await pi.emit("tool_result", bashEvent(body), context)).toBeUndefined();
		expect(calls).toBe(0);
		expect(manager.customEntryData()).toEqual([]);
	});

	it("reads only Pi output files in the system temporary directory", async () => {
		const root = await storeRoot();
		const fullBody = `ERROR full output\n${"full diagnostic\n".repeat(400)}`;
		const outputPath = join(tmpdir(), `pi-bash-${randomUUID()}.log`);
		await writeFile(outputPath, fullBody, { mode: 0o600 });
		cleanupPaths.push(outputPath);
		// Capturing inside the receipt factory records the exact request the reducer sent.
		const inputs: string[] = [];
		scriptReducer(fullBody, (value) => {
			inputs.push(value);
				return {
					schema: REDUCER_RECEIPT_SCHEMA,
					source_sha256: sourceHash(value),
					status: "failure",
					uncertain: false,
					evidence: [{ kind: "failure", quote: "ERROR full output" }],
				};
		});
		const { context, manager, pi } = load(root);

		await pi.emit(
			"tool_result",
			bashEvent("ERROR truncated", { details: { fullOutputPath: outputPath } }),
			context,
		);
		expect(inputs[0]).toContain(fullBody);
		const candidate = manager.customEntryData().find((entry) => entry.kind === "candidate");
		expect(await readFile(String(candidate?.sourcePath), "utf8")).toBe(fullBody);

		const outsidePath = join(root, `pi-bash-${randomUUID()}.log`);
		await writeFile(outsidePath, `ERROR outside file\n${"outside\n".repeat(600)}`);
		const inlineBody = `ERROR inline output\n${"inline diagnostic\n".repeat(400)}`;
		inputs.length = 0;
		await pi.emit(
			"tool_result",
			bashEvent(inlineBody, { toolCallId: "call-2", details: { fullOutputPath: outsidePath } }),
			context,
		);
		expect(inputs[0]).toContain(inlineBody);
		expect(inputs[0]).not.toContain("ERROR outside file");
	});

	it("enforces the reducer budget through the request abort signal", async () => {
		const root = await storeRoot();
		const config = { ...loadReducerConfig(join(root, "session-runtime")), timeoutMs: 60 };
		const body = `ERROR stalled reducer\n${"diagnostic\n".repeat(400)}`;
		const archive = await archiveBody(config.storeRoot, body);
		REDUCER_MODEL.fallback = (_context, options) => {
			const { promise, reject } = Promise.withResolvers<never>();
			const signal = options?.signal;
			if (signal?.aborted) {
				reject(signal.reason);
				return promise;
			}
			signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
			return promise;
		};
		const context = fakeContext(new FakeSessionManager([], "timeout-session", root), {
			model: ACTIVE_MODEL,
			modelRegistry: reducerRegistry(),
		});

		await expect(callReducer(config, "pytest -q", true, archive, body, context)).rejects.toMatchObject({
			name: "AbortError",
		});
		// The signal the reducer handed the provider is what enforced the deadline.
		expect(signalOf(capturedModelCall(REDUCER_MODEL))?.aborted).toBe(true);
	});

	it("does not delegate small or non-diagnostic output", async () => {
		const root = await storeRoot();
		let calls = 0;
		REDUCER_MODEL.fallback = () => {
			calls++;
			throw new Error("unexpected model call");
		};
		const { context, pi } = load(root);

		expect(await pi.emit("tool_result", bashEvent("ERROR short"), context)).toBeUndefined();
		expect(
			await pi.emit(
				"tool_result",
				bashEvent("x".repeat(5000), { input: { command: "rg symbol src" } }),
				context,
			),
		).toBeUndefined();
		expect(calls).toBe(0);
	});
});
