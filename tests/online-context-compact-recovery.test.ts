/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactOptions } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, mock } from "bun:test";
import {
	createOnlineContextCompactExtension,
	PENDING_COMPACTION_PLAN_REMINDER,
} from "../src/sol-pi/extensions/online-context-compact/extension.ts";
import { restoreOnlineState } from "../src/sol-pi/extensions/online-context-compact/state.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

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

async function scenario(error?: Error, unrelatedCompactionAfterError = false) {
	const manager = new FakeSessionManager();
	const messages = [
		{ role: "user" as const, content: "old ".repeat(4_000), timestamp: 1 },
		assistant("tail ".repeat(400)),
	];
	for (const message of messages) manager.appendMessage(message);
	const pi = new FakePi(manager);
	createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5, keepRecentTokens: 1 })(pi.asExtensionApi());
	const deferred: Array<() => void> = [];
	const notify = mock();
	const compact = mock((options: CompactOptions = {}) => {
		if (error) {
			options.onError?.(error);
			if (unrelatedCompactionAfterError) void pi.emit("session_compact", { fromExtension: false }, ctx);
			return Promise.reject(error);
		}
		const entry = {
			type: "compaction" as const,
			id: "compact-test",
			parentId: manager.getLeafId(),
			timestamp: new Date().toISOString(),
			summary: "memo",
			firstKeptEntryId: manager.entries[1]!.id,
			tokensBefore: 195_000,
		};
		return pi
			.emit("session_compact", { compactionEntry: entry, fromExtension: false }, ctx)
			.then(() => options.onComplete?.(entry));
	});
	const ctx = fakeContext(manager, {
		compact,
		ui: { notify } as never,
		setTimeout: ((callback: () => void) => {
			deferred.push(callback);
			return 0 as never;
		}) as never,
		mode: "tui",
		getContextUsage: () => ({ tokens: 195_000, contextWindow: 200_000, percent: 97.5 }),
	});
	await pi.emit("session_start", {}, ctx);
	await pi.emitContext(messages, ctx);
	async function boundary(id: string) {
		await pi.emit("before_provider_request", {}, ctx);
		const steps = [
			{ id, goal: "do work", status: "completed" },
			{ id: "remaining", goal: "remaining work", status: "pending" },
		];
		await pi.tool("update_plan").execute(
			`${id}-open`,
			{ steps: steps.map((step) => (step.id === id ? { ...step, status: "in_progress" } : step)) },
			undefined,
			undefined,
			ctx,
		);
		await pi.emit("before_provider_request", {}, ctx);
		const result = await pi.tool("update_plan").execute(id, { steps }, undefined, undefined, ctx);
		await pi.emit(
			"turn_end",
			{ message: assistant("boundary"), toolResults: [{ toolCallId: id, toolName: "update_plan", isError: false }] },
			ctx,
		);
		return result;
	}
	async function settle() {
		const result = await pi.emit("session_stop", {
			type: "session_stop",
			messages: [],
			turn_id: 1,
			session_id: manager.sessionId,
			stop_hook_active: false,
			signal: new AbortController().signal,
		}, ctx);
		// The host delivers the reminder on the next turn. Compaction waits until
		// that projection exists, then starts on the macrotask after `turn_end`.
		if (result && typeof result === "object" && "continue" in result && result.continue === true) {
			await pi.emitContext(
				[
					...messages,
					{
						role: "custom",
						customType: "session-stop-continuation",
						content: PENDING_COMPACTION_PLAN_REMINDER,
						display: false,
						timestamp: Date.now(),
					},
				],
				ctx,
			);
			await pi.emit(
				"turn_end",
				{ message: assistant("continued"), toolResults: [] },
				ctx,
			);
		}
		for (const callback of deferred.splice(0)) callback();
		await Promise.resolve();
		return result;
	}
	return { pi, manager, ctx, compact, notify, boundary, settle };
}

describe("Online Context Compact recovery", () => {
	it("asks for one continuation and compacts on the next macrotask", async () => {
		const { pi, manager, boundary, compact, settle } = await scenario();
		await boundary("first");
		await expect(settle()).resolves.toEqual({
			continue: true,
			additionalContext: PENDING_COMPACTION_PLAN_REMINDER,
		});
		expect(compact).toHaveBeenCalledTimes(1);
		expect(pi.sentMessages).toHaveLength(0);
		expect(restoreOnlineState(manager.entries).nativeCompactionCount).toBe(1);
	});

	it.each([
		"Nothing to compact (session too small)",
		"Already compacted",
		"Summarization failed: generation hit the token cap and the summary is incomplete",
	])("records a skip after %s and blocks repeated plan-only attempts", async (message) => {
		const { pi, manager, ctx, boundary, compact, notify, settle } = await scenario(new Error(message));
		await boundary("first");
		await expect(settle()).resolves.toEqual({
			continue: true,
			additionalContext: PENDING_COMPACTION_PLAN_REMINDER,
		});
		expect(manager.entries).toEqual(expect.arrayContaining([
			expect.objectContaining({
				type: "custom",
				customType: "sol-pi-online-context-compact-skipped",
				data: { reason: message },
			}),
		]));
		expect(notify).toHaveBeenCalledWith(`Online compaction skipped: ${message}`, "warning");
		expect(restoreOnlineState(manager.entries)).toMatchObject({
			nativeCompactionCount: 0,
			cacheDebtTokens: 0,
			cacheDebtRepaymentTokens: 0,
		});
		for (const id of ["restated", "rekeyed-again", "rekeyed-once-more"]) {
			await boundary(id);
			await settle();
		}
		expect(compact).toHaveBeenCalledTimes(1);
		expect(pi.sentMessages).toHaveLength(0);
		await pi.emit("turn_end", { message: assistant("new work"), toolResults: [{ toolName: "bash", isError: false }] }, ctx);
		await boundary("genuine-progress");
		await settle();
		expect(compact).toHaveBeenCalledTimes(2);
	});

	it.each([
		new Error("Compaction cancelled"),
		Object.assign(new Error("cancelled"), { name: "AbortError" }),
	])("does not record a skip when compaction is cancelled: $name / $message", async (error) => {
		const { pi, manager, boundary, settle } = await scenario(error);
		await boundary("first");
		await expect(settle()).resolves.toEqual({
			continue: true,
			additionalContext: PENDING_COMPACTION_PLAN_REMINDER,
		});
		expect(pi.sentMessages).toHaveLength(0);
		expect(manager.entries.some((entry) => entry.type === "custom" && entry.customType === "sol-pi-online-context-compact-skipped")).toBe(false);
		expect(restoreOnlineState(manager.entries)).toMatchObject({ nativeCompactionCount: 0, cacheDebtTokens: 0 });
	});

	it("logs a genuine compaction failure without charging debt", async () => {
		const { pi, manager, boundary, settle } = await scenario(new Error("summarizer unavailable"));
		await boundary("first");
		await expect(settle()).resolves.toEqual({
			continue: true,
			additionalContext: PENDING_COMPACTION_PLAN_REMINDER,
		});
		expect(pi.sentMessages).toHaveLength(0);
		expect(restoreOnlineState(manager.entries)).toMatchObject({
			nativeCompactionCount: 0,
			cacheDebtTokens: 0,
			cacheDebtRepaymentTokens: 0,
		});
	});

	it("does not charge a failed attempt's debt to another compaction during recovery", async () => {
		const { manager, boundary, settle } = await scenario(new Error("Already compacted"), true);
		await boundary("first");
		await settle();
		expect(restoreOnlineState(manager.entries)).toMatchObject({
			nativeCompactionCount: 1,
			cacheDebtTokens: 0,
			cacheDebtRepaymentTokens: 0,
		});
	});
});
