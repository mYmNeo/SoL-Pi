/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactOptions, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it } from "bun:test";
import { estimateMessages } from "../src/sol-pi/host-compat.ts";
import {
	BOUNDARY_COMPACTION_INSTRUCTIONS,
	createOnlineContextCompactExtension,
	DEFAULT_KEEP_RECENT_TOKENS,
	DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE,
	estimateNativeCompactionTokens,
	PENDING_COMPACTION_PLAN_REMINDER,
	registerOnlineContextCompact,
	resolveKeepRecentTokens,
} from "../src/sol-pi/extensions/online-context-compact/index.ts";
import {
	appendOnlineState,
	initialOnlineState,
	restoreOnlineState,
} from "../src/sol-pi/extensions/online-context-compact/state.ts";
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

/** oh-my-pi fires `session_stop` when a turn is about to settle. There is no `agent_settled` event. */
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

function messageTokens(message: AgentMessage): number {
	return estimateMessages([message]);
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

	it("uses the retained-tail default and validates overrides", () => {
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

	it.each([0, 3])("records real progress on the first plan update after compaction, following %s work requests", async (workRequests) => {
		const manager = new FakeSessionManager();
		const pi = new FakePi(manager);
		appendOnlineState(pi.asExtensionApi(), {
			...initialOnlineState(), plan: OPEN, requestCount: 5,
			lastBoundaryRequestCount: 2, completedBoundaryRequestCounts: [2],
		});
		registerOnlineContextCompact(pi.asExtensionApi());
		const context = fakeContext(manager);
		await pi.emit("session_start", {}, context);
		await pi.emit("session_compact", { fromExtension: false }, context);
		for (let index = 0; index < workRequests; index++) {
			await pi.emit("before_provider_request", {}, context);
			await pi.emit("turn_end", { message: assistant("work"), toolResults: [{ toolName: "bash", isError: false }] }, context);
		}
		await pi.emit("before_provider_request", {}, context);
		const result = await runPlan(pi, context, "completed-after-compact", { steps: DONE, progress: PROGRESS });
		expect(result.details).toMatchObject({ boundary: true, progress_recorded: true, completed_step_ids: ["build"] });
		expect(restoreOnlineState(manager.entries)).toMatchObject({
			plan: DONE, completedBoundaryRequestCounts: [2, 4 + workRequests],
			pendingProgress: [expect.objectContaining({ stepId: "build", verification: PROGRESS.verification })],
		});
	});

	it("prices the removable prefix across an initial and a repeated compaction", () => {
		const manager = new FakeSessionManager();
		manager.appendMessage({ role: "user", content: "x".repeat(100), timestamp: Date.now() });
		manager.appendMessage(assistant("y".repeat(100_000)));
		const initialEntries = manager.getBranch();
		const initialMessage = initialEntries[0];
		if (initialMessage?.type !== "message") throw new Error("expected message entry");
		const initialExpected = messageTokens(initialMessage.message);
		expect(estimateNativeCompactionTokens(initialEntries, 20_000)).toBe(initialExpected);
		expect(initialExpected).toBeLessThan(DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE);

		const firstKeptEntryId = manager.entries.at(-1)?.id ?? "message-2";
		manager.entries.push({
			type: "compaction",
			id: "compact-1",
			parentId: firstKeptEntryId,
			timestamp: new Date().toISOString(),
			summary: "s".repeat(8_000),
			firstKeptEntryId,
			tokensBefore: 25_025,
		});
		manager.leafId = "compact-1";
		manager.appendMessage({ role: "user", content: "new work", timestamp: Date.now() });
		manager.appendMessage(assistant("z".repeat(8_000)));
		const repeatedEntries = manager.getBranch();
		const previousSummary = repeatedEntries.findLast((entry) => entry.type === "compaction");
		if (!previousSummary || previousSummary.type !== "compaction") throw new Error("expected compaction entry");
		const summaryMessage = {
			role: "compactionSummary" as const,
			summary: previousSummary.summary,
			tokensBefore: previousSummary.tokensBefore,
			timestamp: new Date(previousSummary.timestamp).getTime(),
		};
		const firstKept = repeatedEntries.find((entry) => entry.id === previousSummary.firstKeptEntryId);
		const newUser = repeatedEntries.at(-2);
		if (firstKept?.type !== "message" || newUser?.type !== "message") {
			throw new Error("expected removable message entries");
		}
		const repeatedExpected =
			messageTokens(summaryMessage) + messageTokens(firstKept.message) + messageTokens(newUser.message);
		expect(estimateNativeCompactionTokens(repeatedEntries, 1)).toBe(repeatedExpected);

		// The previous tail is still inside the host's cut once the retained budget
		// is smaller than that tail, so it is priced again. The short message
		// after the compaction stays.
		const noNewPrefix = repeatedEntries.slice(0, repeatedEntries.indexOf(previousSummary) + 2);
		expect(estimateNativeCompactionTokens(noNewPrefix, 20_000)).toBe(
			messageTokens(summaryMessage) + messageTokens(firstKept.message),
		);
	});

	it("defers when the cut leaves too little history to offset the summary", async () => {
		const manager = new FakeSessionManager();
		manager.appendMessage({ role: "user", content: "x".repeat(100), timestamp: Date.now() });
		manager.appendMessage(assistant("y".repeat(100_000)));
		const pi = new FakePi(manager);
		createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5 })(pi.asExtensionApi());
		let compactions = 0;
		const context = fakeContext(manager, {
			compact: () => {
				compactions += 1;
				return Promise.resolve();
			},
			getContextUsage: () => ({ tokens: 25_025, contextWindow: 30_000, percent: 83.4 }),
		});

		await pi.emit("session_start", { type: "session_start" }, context);
		await pi.emitContext(
			[
				{ role: "user", content: "x".repeat(100), timestamp: Date.now() },
				assistant("y".repeat(100_000)),
			],
			context,
		);
		await pi.emit("before_provider_request", { type: "before_provider_request", payload: {} }, context);
		await runPlan(pi, context, "plan-open", { steps: OPEN });
		await runPlan(pi, context, "plan-done", { steps: DONE, progress: PROGRESS });
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

		expect(await pi.emit("session_stop", sessionStopEvent(), context)).toBeUndefined();
		expect(compactions).toBe(0);
	});

	it("records a completed-step boundary and resumes through the settle hook", async () => {
		const manager = new FakeSessionManager();
		manager.appendMessage({ role: "user", content: `old ${"x".repeat(8_000)}`, timestamp: Date.now() });
		manager.appendMessage(assistant(`work ${"y".repeat(2_000)}`));
		const pi = new FakePi(manager);
		createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5, keepRecentTokens: 1 })(pi.asExtensionApi());
		let abortCalls = 0;
		const compactCalls: CompactOptions[] = [];
		const deferredCallbacks: Array<() => void> = [];
		const compact = (options: CompactOptions = {}): Promise<void> => {
			compactCalls.push(options);
			const entry = {
				type: "compaction" as const,
				id: "compact-1",
				parentId: manager.getLeafId(),
				timestamp: new Date().toISOString(),
				summary: "summary",
				firstKeptEntryId: manager.entries.at(-1)?.id ?? "message-1",
				tokensBefore: 195_000,
			};
			// The host emits session_compact before resolving onComplete.
			return pi.emit("session_compact", { type: "session_compact", compactionEntry: entry, fromExtension: false }, context).then(() => {
				options.onComplete?.(entry);
			});
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
		expect(abortCalls).toBe(0);
		expect(compactCalls).toEqual([]);

		expect(await pi.emit("session_stop", sessionStopEvent(), context)).toEqual({
			continue: true,
			additionalContext: PENDING_COMPACTION_PLAN_REMINDER,
		});
		expect(compactCalls).toEqual([]);
		expect(pi.sentMessages).toEqual([]);
		for (const callback of deferredCallbacks.splice(0)) callback();
		await Promise.resolve();
		expect(compactCalls).toHaveLength(1);
		expect(compactCalls[0]?.internalGuidance).toBe(BOUNDARY_COMPACTION_INSTRUCTIONS);
		expect(restoreOnlineState(manager.entries)).toMatchObject({ nativeCompactionCount: 1, pendingProgress: [] });
		expect(restoreOnlineState(manager.entries).cacheDebtTokens).toBeGreaterThan(0);
		expect(restoreOnlineState(manager.entries).cacheDebtRepaymentTokens).toBeGreaterThan(0);

		const noBoundary = (await pi.emit("session_stop", sessionStopEvent(), context)) as
			| { continue?: boolean }
			| undefined;
		expect(noBoundary?.continue).not.toBe(true);
		expect(await pi.emit("session_before_tree", { type: "session_before_tree" }, context)).toBeUndefined();
	});
});

function buildSessionMessages(): AgentMessage[] {
	return [
		{ role: "user", content: `old ${"x".repeat(8_000)}`, timestamp: Date.now() },
		assistant(`work ${"y".repeat(2_000)}`),
	];
}
