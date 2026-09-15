/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactOptions, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it } from "bun:test";
import {
	BOUNDARY_COMPACTION_INSTRUCTIONS,
	createOnlineContextCompactExtension,
	DEFAULT_KEEP_RECENT_TOKENS,
	PENDING_COMPACTION_PLAN_REMINDER,
	registerOnlineContextCompact,
	resolveKeepRecentTokens,
} from "../src/sol-pi/extensions/online-context-compact/index.ts";
import { restoreOnlineState } from "../src/sol-pi/extensions/online-context-compact/state.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

const OPEN = [{ id: "build", goal: "build it", status: "in_progress" }] as const;
const DONE = [{ id: "build", goal: "build it", status: "completed" }] as const;
const PROGRESS = {
	files_changed: ["src/a.ts"],
	verification: ["tests passed"],
	decisions: ["kept the implementation small"],
};

function assistant(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * oh-my-pi fires `session_stop` when a turn is about to settle; a handler asks
 * for one continuation turn by returning a continuation object. There is no
 * `agent_settled` event on this host.
 */
function sessionStopEvent(messages: AgentMessage[] = []) {
	return {
		type: "session_stop",
		messages,
		turn_id: 1,
		session_id: "session-a",
		stop_hook_active: false,
		signal: new AbortController().signal,
	};
}

async function runPlan(pi: FakePi, context: ExtensionContext, id: string, params: unknown) {
	const execute = pi.tool("update_plan").execute as (
		toolCallId: string,
		params: unknown,
		signal: undefined,
		onUpdate: undefined,
		context: ExtensionContext,
	) => Promise<{ content: unknown[]; details: Readonly<Record<string, unknown>> }>;
	return await execute(id, params, undefined, undefined, context);
}

describe("Online Context Compact extension", () => {
	it("registers one tool and only public lifecycle hooks", () => {
		const pi = new FakePi();
		registerOnlineContextCompact(pi.asExtensionApi());
		expect(pi.registeredTools.map((tool) => tool.name)).toEqual(["update_plan"]);
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
			"turn_end",
		]);
	});

	it("uses Pi's retained-tail default and validates overrides", () => {
		expect(resolveKeepRecentTokens(undefined)).toBe(DEFAULT_KEEP_RECENT_TOKENS);
		expect(() => resolveKeepRecentTokens(0)).toThrow(/positive safe integer/u);
		expect(resolveKeepRecentTokens(50)).toBe(50);
	});

	it("observes context without changing it", async () => {
		const pi = new FakePi();
		registerOnlineContextCompact(pi.asExtensionApi());
		const context = fakeContext(pi.sessionManager);
		await pi.emit("session_start", { type: "session_start" }, context);
		const messages = [assistant("unchanged")];
		expect(await pi.emitContext(messages, context)).toEqual(messages);
	});

	it("records a completed-step boundary and resumes through the settle hook", async () => {
		const manager = new FakeSessionManager();
		manager.appendMessage({ role: "user", content: `old ${"x".repeat(2_000)}`, timestamp: Date.now() });
		manager.appendMessage(assistant(`work ${"y".repeat(2_000)}`));
		const pi = new FakePi(manager);
		createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5, keepRecentTokens: 1 })(pi.asExtensionApi());
		let abortCalls = 0;
		const compactCalls: CompactOptions[] = [];
		// The host's managed timer is what defers the compaction by one macrotask.
		// The double records the callback so the test flushes it deterministically
		// instead of racing a wall-clock delay — the deferral itself is load-bearing
		// (an inline compact() aborts the session before the handler returns and
		// discards the continuation), so it is asserted below rather than papered over.
		const deferredCallbacks: Array<() => void> = [];
		const compact = (options: CompactOptions = {}): Promise<void> => {
			compactCalls.push(options);
			// A successful host compaction reports the committed result on
			// `onComplete` before its promise resolves.
			options.onComplete?.({
				summary: "boundary summary",
				firstKeptEntryId: manager.entries.at(-1)?.id ?? "message-1",
				tokensBefore: 195_000,
			} as never);
			return Promise.resolve();
		};
		const context = fakeContext(manager, {
			abort: () => {
				abortCalls += 1;
			},
			compact,
			setTimeout: ((callback: () => void) => {
				deferredCallbacks.push(callback);
				return 0 as never;
			}) as never,
			getSystemPrompt: () => ["test prompt"],
			getContextUsage: () => ({ tokens: 195_000, contextWindow: 200_000, percent: 97.5 }),
		});

		await pi.emit("session_start", { type: "session_start" }, context);
		await pi.emitContext(buildSessionMessages(), context);
		await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, context);
		await runPlan(pi, context, "plan-open", { steps: OPEN });
		const planResult = await runPlan(pi, context, "plan-done", { steps: DONE, progress: PROGRESS });

		await pi.emit(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 1,
				message: assistant("boundary"),
				toolResults: [
					{
						role: "toolResult",
						toolCallId: "plan-done",
						toolName: "update_plan",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			context,
		);

		expect(planResult.details).toMatchObject({ boundary: true, progress_recorded: true });
		// The boundary records a selection and lets the turn end naturally. It must
		// NOT abort: on omp an aborted assistant stop takes the host's aborted fast
		// path, which returns before the `session_stop` dispatch, so an
		// extension-initiated abort would swallow the only hook that can compact.
		expect(abortCalls).toBe(0);
		expect(compactCalls).toEqual([]);

		// The natural stop reaches the settle hook, which asks for one continuation
		// turn. The continuation IS the resume mechanism on this host — the
		// extension no longer injects a message of its own.
		expect(await pi.emit("session_stop", sessionStopEvent(), context)).toEqual({
			continue: true,
			additionalContext: PENDING_COMPACTION_PLAN_REMINDER,
		});
		// Deferred, not inline: the handler must return its continuation before the
		// compaction aborts the session and moves the prompt generation.
		expect(compactCalls).toEqual([]);
		for (const callback of deferredCallbacks.splice(0)) callback();
		expect(pi.sentMessages).toEqual([]);
		expect(compactCalls).toHaveLength(1);
		// omp renamed the internal summarizer guidance; there is no customInstructions.
		expect(compactCalls[0]?.internalGuidance).toBe(BOUNDARY_COMPACTION_INSTRUCTIONS);

		// The native compaction completes and records its own state.
		await pi.emit(
			"session_compact",
			{
				type: "session_compact",
				fromExtension: false,
				reason: "manual",
				willRetry: false,
				compactionEntry: {
					type: "compaction",
					id: "compact-1",
					parentId: manager.getLeafId(),
					timestamp: new Date().toISOString(),
					summary: "summary",
					firstKeptEntryId: manager.entries.at(-1)?.id ?? "message-1",
					tokensBefore: 195_000,
				},
			},
			context,
		);
		expect(restoreOnlineState(manager.entries)).toMatchObject({ nativeCompactionCount: 1, pendingProgress: [] });

		// With the boundary already consumed, a later settle requests no continuation.
		const noBoundary = (await pi.emit("session_stop", sessionStopEvent(), context)) as
			| { continue?: boolean }
			| undefined;
		expect(noBoundary?.continue).not.toBe(true);
		// The guard is released once the compaction settled, so tree navigation is
		// no longer cancelled.
		expect(await pi.emit("session_before_tree", { type: "session_before_tree" }, context)).toBeUndefined();
	});
});

function buildSessionMessages(): AgentMessage[] {
	return [
		{ role: "user", content: `old ${"x".repeat(2_000)}`, timestamp: Date.now() },
		assistant(`work ${"y".repeat(2_000)}`),
	];
}
