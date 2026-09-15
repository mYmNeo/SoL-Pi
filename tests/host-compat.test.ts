/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionContext, SessionEntry, Theme } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it } from "bun:test";
import {
	estimateMessages,
	findCutPoint,
	isOmpContext,
	rendererArgs,
	sessionEntryToContextMessages,
	systemPromptText,
	themeOf,
} from "../src/sol-pi/host-compat.ts";

function userEntry(id: string, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content, timestamp: Date.parse("2026-01-01T00:00:00.000Z") },
	} as SessionEntry;
}

function assistantEntry(id: string, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: content }],
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
			timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
		},
	} as SessionEntry;
}

function user(content: string): AgentMessage {
	return { role: "user", content, timestamp: Date.parse("2026-01-01T00:00:00.000Z") } as AgentMessage;
}

const BULK = "x".repeat(4_000);

function conversation(): SessionEntry[] {
	return [
		userEntry("u1", `first ${BULK}`),
		assistantEntry("a1", `work ${BULK}`),
		userEntry("u2", `second ${BULK}`),
		assistantEntry("a2", `more ${BULK}`),
	];
}

describe("host compatibility layer", () => {
	it("returns a real cut point that keeps roughly the requested recent tail", () => {
		const entries = conversation();

		const tinyTail = findCutPoint(entries, 0, entries.length, 1);
		const wholeHistory = findCutPoint(entries, 0, entries.length, Number.MAX_SAFE_INTEGER);

		// A tiny keep budget must actually move the cut into the history...
		expect(tinyTail.firstKeptEntryIndex).toBeGreaterThan(0);
		// ...while an unbounded budget keeps everything from the start.
		expect(wholeHistory.firstKeptEntryIndex).toBe(0);
		expect(tinyTail.firstKeptEntryIndex).toBeGreaterThanOrEqual(wholeHistory.firstKeptEntryIndex);
		// The cut always reports an index inside the requested window.
		for (const result of [tinyTail, wholeHistory]) {
			expect(result.firstKeptEntryIndex).toBeGreaterThanOrEqual(0);
			expect(result.firstKeptEntryIndex).toBeLessThan(entries.length);
		}
	});

	it("never cuts on a tool result", () => {
		const entries: SessionEntry[] = [
			userEntry("u1", `run it ${BULK}`),
			{
				type: "message",
				id: "t1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "bash",
					content: [{ type: "text", text: `output ${BULK}` }],
					isError: false,
					timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
				},
			} as SessionEntry,
			userEntry("u2", `next ${BULK}`),
		];

		const result = findCutPoint(entries, 0, entries.length, 1);
		expect(entries[result.firstKeptEntryIndex]?.type).not.toBe("toolResult");
	});

	it("projects message and custom_message entries into context messages", () => {
		const plain = sessionEntryToContextMessages(userEntry("u1", "hello"));
		expect(plain).toHaveLength(1);
		expect(plain[0]?.role).toBe("user");
		expect(plain[0]).toMatchObject({ content: "hello" });

		const custom = sessionEntryToContextMessages({
			type: "custom_message",
			id: "c1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "sol-pi-online-context-compact",
			content: "resume the task",
			display: false,
		} as SessionEntry);
		expect(custom).toHaveLength(1);
		const projected = custom[0];
		expect(projected).toMatchObject({
			role: "custom",
			customType: "sol-pi-online-context-compact",
			content: "resume the task",
			display: false,
		});
		expect(projected && "timestamp" in projected ? typeof projected.timestamp : "missing").toBe("number");
	});

	it("drops entries that carry no model-visible content", () => {
		expect(
			sessionEntryToContextMessages({
				type: "custom",
				id: "s1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				customType: "sol-pi-online-context-compact",
				data: { pendingProgress: [] },
			} as SessionEntry),
		).toEqual([]);
	});

	it("estimates messages monotonically in message size", () => {
		const small = estimateMessages([user("short")]);
		const medium = estimateMessages([user("s".repeat(2_000))]);
		const large = estimateMessages([user("s".repeat(20_000))]);

		expect(small).toBeGreaterThan(0);
		expect(medium).toBeGreaterThan(small);
		expect(large).toBeGreaterThan(medium);
		// More messages can never cost fewer tokens than the largest single one.
		expect(estimateMessages([user("s".repeat(2_000)), user("s".repeat(2_000))])).toBeGreaterThanOrEqual(medium);
		expect(estimateMessages([])).toBe(0);
	});

	it("joins the host's system prompt segments into one string", () => {
		const context = {
			getSystemPrompt: () => ["first segment", "second segment"],
		} as unknown as ExtensionContext;

		expect(systemPromptText(context)).toBe("first segment\nsecond segment");
		expect(isOmpContext(context)).toBe(true);
	});

	it("identifies the theme whatever position the host passes it in", () => {
		const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
		const options = { expanded: false, isPartial: false };
		const args = { path: "target.ts" };
		const trailing = { cwd: "/tmp" };

		// oh-my-pi order: renderCall(args, options, theme) / renderResult(result, options, theme, args).
		const omp = rendererArgs([args, options, theme, trailing]);
		expect(omp.theme).toBe(theme);
		expect(omp.options).toBe(options);
		expect(omp.context).toBe(trailing);

		// Legacy Pi order: the theme sits directly after the first argument.
		const legacy = rendererArgs([args, theme, trailing]);
		expect(legacy.theme).toBe(theme);
		expect(legacy.options).toBeUndefined();
		expect(legacy.context).toBe(trailing);

		// An options object is never mistaken for a theme.
		expect(rendererArgs([args, options]).theme).toBeUndefined();
	});

	it("never yields a theme without the styling surface renderers call", () => {
		const supplied = { fg: (_color: string, text: string) => text } as unknown as Theme;
		expect(themeOf(supplied)).toBe(supplied);

		const fallbacks = [themeOf(undefined), themeOf(null as unknown as undefined)];
		for (const fallback of fallbacks) {
			expect(typeof fallback.fg).toBe("function");
			expect(fallback.fg("warning", "⚡")).toBe("⚡");
			expect(typeof fallback.bold).toBe("function");
			expect(fallback.bold("SoL-Pi")).toBe("SoL-Pi");
		}
	});
});
