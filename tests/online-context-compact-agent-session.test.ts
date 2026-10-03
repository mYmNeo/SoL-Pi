/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockModel, registerMockApi, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import {
	AuthStorage,
	createAgentSession,
	ModelRegistry,
	SessionManager,
	Settings,
	SqliteAuthCredentialStore,
	type AgentSession,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
import { describe, expect, it } from "bun:test";
import { DEFAULT_CONFIG } from "../src/sol-pi/config.ts";
import {
	ONLINE_STATE_ENTRY,
	PENDING_COMPACTION_PLAN_REMINDER,
	restoreOnlineState,
} from "../src/sol-pi/extensions/online-context-compact/index.ts";

const PROGRESS = {
	files_changed: ["src/a.ts"],
	verification: ["tests passed"],
	decisions: ["kept the implementation small"],
};
/**
 * Bytes of user-prompt filler that must fall outside the retained tail.
 * The host cuts at the newest assistant group once that group alone exceeds
 * `DEFAULT_KEEP_RECENT_TOKENS`, so only messages before that group are
 * removable. A short prompt archives nothing and the boundary never compacts.
 */
const PREFIX_BYTES = 80_000;
/** Bytes of assistant text that fill the retained tail past the keep budget. */
const WORK_BYTES = 140_000;

/**
 * Non-repeating filler. omp's stream guard rejects degenerate repeats ("the
 * model repeated near-identical content — an exact 2-character cycle"), so the
 * payload that pushes the context past the retained-tail budget must vary.
 */
function filler(tag: string, bytes: number): string {
	const words: string[] = [];
	let state = 0x2545f491;
	let total = 0;
	while (total < bytes) {
		state = (state * 1664525 + 1013904223) >>> 0;
		const word = `${tag}${state.toString(36)}`;
		words.push(word);
		total += word.length + 1;
	}
	return `${tag} ${words.join(" ")}`;
}

/** The assistant text committed by the plan-completing turn of `phase`. */
function phaseWorkText(phase: number): string {
	return filler(`phase${phase}`, WORK_BYTES);
}

/** User prompt for `phase`: a removable prefix plus the instruction. */
function phasePrompt(phase: number): string {
	return `${filler(`prompt${phase}`, PREFIX_BYTES)}\nfinish plan step ${phase}`;
}

function step(phase: number, status: "in_progress" | "completed") {
	return { id: `step-${phase}`, goal: `build phase ${phase}`, status };
}

/**
 * Concatenated text of a message, however the provider bound it. `AgentMessage`
 * is a union that includes content-less variants (e.g. a branch summary), so the
 * field is narrowed rather than assumed.
 */
function messageText(message: AgentMessage | undefined): string {
	if (!message || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * One real in-process session with Online Context Compact loaded through the
 * package entrypoint, driven by real `session.prompt` turns through `phases`
 * completed-step plan cycles. This test NEVER calls `session.compact`: the
 * mechanism under test is the extension's own decision to compact at a
 * completed-step boundary.
 *
 * The extension does not abort the run to reach that decision. On omp an
 * extension-initiated abort takes the host's aborted fast path, which returns
 * BEFORE the `session_stop` dispatch, so an abort would swallow the very settle
 * hook that starts the compaction. Instead the boundary turn ends naturally and
 * `session_stop` returns `{ continue: true, additionalContext:
 * PENDING_COMPACTION_PLAN_REMINDER }`. Compaction starts on the macrotask after
 * the continuation turn's `turn_end`, once that turn's projection included the
 * reminder — `compact()` aborts a prompt that is still in setup, so starting
 * any earlier can drop the reminder before the model sees it.
 *
 * Delivery is observed through the host's own receipt and the model request.
 * `#emitSessionStopEvent` returns true only when the handler produced a
 * non-empty `additionalContext`, and omp then emits `agent_end` with
 * `willContinue: true` and queues that text as a hidden next-turn message.
 * `willContinue` is exactly "the settle handler's continuation was accepted".
 * The hidden turn is where the reminder reaches the model; its last message is
 * that text verbatim. Compaction is deferred until after that turn, so the
 * host's compact abort cannot delete the queued continuation first.
 *
 * Each `prompt()` is one phase: open the step, complete it, then answer with
 * text so the agent stops and `session_stop` can compact. A post-compaction
 * replay sees a rewritten context whose tool results are gone; once the phase
 * has completed, later calls stay on the final reply so that replay cannot
 * open the step again.
 *
 * omp specifics this test cannot express through Pi's `DefaultResourceLoader`:
 *
 *  - `session_start` is emitted by `initializeExtensions`, not by
 *    `createAgentSession`; the entrypoint registers every mechanism from its
 *    `session_start` handler.
 *  - `SessionBeforeCompactEvent` carries only
 *    `{ preparation, branchEntries, customInstructions?, signal }` — there is no
 *    `reason` and no `internalGuidance`. The boundary text the extension passes
 *    to `ctx.compact` is deliberately invisible to the hook, so the hook can
 *    never observe what the extension asked for.
 *  - The mock provider resolves through the custom-API registry, so
 *    `registerMockApi()` runs first and the model still needs a credential.
 *  - The extension resolves its own `keepRecentTokens` / `cacheWriteReadRatio`
 *    at registration; it does not read `compaction.keepRecentTokens`.
 */
async function runBoundaryScenario(phases: 1 | 2): Promise<void> {
	registerMockApi();
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-occ-session-"));
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir);
	await mkdir(join(cwd, CONFIG_DIR_NAME));
	// `cacheWriteReadRatio: 0` drops the cache-repayment breakeven gate, which is
	// what lets the extension's own economic check pass at a completed-step
	// boundary.
	await writeFile(
		join(cwd, CONFIG_DIR_NAME, "sol-pi.json"),
		JSON.stringify({ ...DEFAULT_CONFIG, onlineContextCompact: true, cacheWriteReadRatio: 0 }),
	);

	let session: AgentSession | undefined;
	try {
		// One phase per prompt. `opened`/`completed` reset with the phase so a
		// compaction that drops tool results cannot look like a fresh plan.
		let currentPhase = 1;
		let phaseOpened = false;
		let phaseCompleted = false;
		const respond = (_messages: readonly AgentMessage[]): MockResponse => {
			if (phaseCompleted) {
				return { content: [{ type: "text", text: `final reply after ${currentPhase} online compactions` }] };
			}
			if (!phaseOpened) {
				phaseOpened = true;
				return {
					content: [
						{
							type: "toolCall",
							id: `plan-open-${currentPhase}`,
							name: "update_plan",
							arguments: { steps: [step(currentPhase, "in_progress")] },
						},
					],
				};
			}
			phaseCompleted = true;
			return {
				content: [
					{ type: "text", text: phaseWorkText(currentPhase) },
					{
						type: "toolCall",
						id: `plan-done-${currentPhase}`,
						name: "update_plan",
						arguments: { steps: [step(currentPhase, "completed")], progress: PROGRESS },
					},
				],
			};
		};
		/**
		 * Model-visible text of the FINAL message of every provider request whose
		 * trailing message is exactly the settle handler's continuation. This
		 * test's own prompts are plain user text and never land here.
		 */
		const deliveredContinuations: string[] = [];
		// Both boundary effects below are produced by post-prompt work, so the wait
		// is notified from either side.
		const boundaryEffectWaiters: Array<() => void> = [];
		const notifyBoundaryEffect = (): void => {
			boundaryEffectWaiters.splice(0).forEach((resolve) => resolve());
		};
		const model = createMockModel({
			id: `sol-pi-occ-model-${phases}`,
			provider: "mock",
			contextWindow: 200_000,
			maxTokens: 1_024,
			handler: (context) => {
				const last = context.messages[context.messages.length - 1];
				const lastText = messageText(last);
				if (lastText === PENDING_COMPACTION_PLAN_REMINDER) deliveredContinuations.push(lastText);
				return respond(context.messages);
			},
		});

		// Deterministic run: automatic compaction and provider retry are disabled, so
		// every effect observed below is the extension's own doing.
		// `tools.xdev` must be off: omp mounts discoverable tools (every extension
		// tool, by default) under `xd://`, and this scenario calls `update_plan`
		// directly as a top-level tool.
		// `compaction.autoContinue` must be off: the extension already resumes via
		// the stop-hook continuation, and the host's post-compact resume would
		// start another plan cycle against the summarized context.
		const settings = await Settings.loadIsolated({
			cwd,
			agentDir,
			inMemory: true,
			overrides: {
				"compaction.enabled": false,
				"retry.enabled": false,
				"tools.xdev": false,
				"compaction.autoContinue": false,
			},
		});
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		authStorage.keys.setRuntime(model.provider, `occ-key-${phases}`);
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory(cwd);

		// Observer on the same real session: supplies a deterministic compaction
		// result whenever the HOST is asked to compact, records the host's own
		// attribution and continuation receipts, and resolves the waits from those
		// notifications.
		const seenGuidance: Array<string | undefined> = [];
		const compactionFromExtension: boolean[] = [];
		/** One entry per settle: true exactly when that settle scheduled a continuation turn. */
		const continuationReceipts: boolean[] = [];
		const observer: ExtensionFactory = (pi) => {
			pi.on("session_before_compact", (event) => {
				seenGuidance.push(event.customInstructions);
				return {
					compaction: {
						summary: filler("summary", 4_000),
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			});
			pi.on("session_compact", (event) => {
				compactionFromExtension.push(event.fromExtension);
				notifyBoundaryEffect();
			});
			pi.on("agent_end", (event) => {
				continuationReceipts.push(event.willContinue === true);
			});
		};
		/**
		 * Wait for the host's own notification that `count` boundary compactions
		 * landed. Compaction starts on a macrotask after the continuation turn, so
		 * it can still be in flight when `prompt()` returns; this waits on the
		 * notification, never on a duration.
		 */
		const waitForCompactions = async (count: number): Promise<void> => {
			while (compactionFromExtension.length < count) {
				await new Promise<void>((resolve) => boundaryEffectWaiters.push(resolve));
			}
		};

		const created = await createAgentSession({
			cwd,
			agentDir,
			settingsManager: settings,
			authStorage,
			modelRegistry,
			sessionManager,
			extensions: [observer],
			additionalExtensionPaths: [join(process.cwd(), "src/sol-pi/index.ts")],
			disableExtensionDiscovery: true,
			model,
			thinkingLevel: "off",
		});
		session = created.session;
		expect(created.extensionsResult.errors).toEqual([]);
		await initializeExtensions(session, {
			reportSendError: () => {},
			reportRuntimeError: () => {},
		});
		// omp presents extension tools as `discoverable` rather than top-level
		// active, so registration (plus the real execution asserted below) is the
		// correct probe for the mechanism's plan tool being live.
		expect(session.getAllToolNames()).toContain("update_plan");

		for (let phase = 1; phase <= phases; phase++) {
			currentPhase = phase;
			phaseOpened = false;
			phaseCompleted = false;
			await session.prompt(phasePrompt(phase), { expandPromptTemplates: false });
			await session.waitForIdle();
			// Let this boundary's compaction land before driving the next phase:
			// compaction starts after the continuation turn and calls `abort()`
			// internally, so prompting into that window would abort the next prompt
			// instead of reaching its own boundary.
			await waitForCompactions(phase);
			await session.waitForIdle();
		}

		const branch = sessionManager.getBranch();

		// The mechanism's plan tool ran for real. A boundary compaction rewrites the
		// context back to the retained tail, so the boundary turns replay on the
		// continuation: the count is therefore at least the two turns per phase, and
		// every execution must have succeeded.
		const planResults = branch
			.flatMap((branchEntry) =>
				branchEntry.type === "message" && branchEntry.message.role === "toolResult"
					? [branchEntry.message]
					: [],
			)
			.filter((result) => result.toolName === "update_plan");
		expect(planResults.length).toBeGreaterThanOrEqual(phases * 2);
		expect(planResults.every((result) => !result.isError)).toBe(true);

		// The mechanism's durable output: it detected the completed-step boundary
		// and recorded it BEFORE the compaction it selected, and the plan state it
		// tracks holds the completed step.
		expect(
			branch.some((branchEntry) => branchEntry.type === "custom" && branchEntry.customType === ONLINE_STATE_ENTRY),
		).toBe(true);
		const firstCompactionIndex = branch.findIndex((branchEntry) => branchEntry.type === "compaction");
		expect(firstCompactionIndex).toBeGreaterThan(0);
		const boundaryState = restoreOnlineState(branch.slice(0, firstCompactionIndex));
		expect(boundaryState.completedBoundaryRequestCounts.length).toBeGreaterThanOrEqual(1);
		expect(boundaryState.plan.some((planStep) => planStep.status === "completed")).toBe(true);

		// The abort is gone. On omp an extension-initiated abort settles the turn on
		// the host's aborted fast path, which returns BEFORE the `session_stop`
		// dispatch — so an aborted assistant turn here would mean the old design
		// crept back and the settle hook that drives compaction is being skipped.
		const abortedTurns = branch.filter(
			(branchEntry) =>
				branchEntry.type === "message" &&
				branchEntry.message.role === "assistant" &&
				branchEntry.message.stopReason === "aborted",
		);
		expect(abortedTurns).toHaveLength(0);

		// The extension, NOT this test, compacted the history: one compaction per
		// completed-step boundary, each attributed to an extension. This test never
		// calls `session.compact` and automatic compaction is disabled, so a
		// compaction the extension did not drive would have to be attributed to a
		// manual/auto path and would fail here.
		const compactionEntries = branch.filter((branchEntry) => branchEntry.type === "compaction");
		expect(compactionEntries).toHaveLength(phases);
		expect(compactionEntries.every((entry) => entry.fromExtension === true)).toBe(true);
		expect(compactionFromExtension).toEqual(Array.from({ length: phases }, () => true));
		// Every compaction went through the host pipeline the extension asked for,
		// even though the boundary guidance it passed is invisible to the hook.
		expect(seenGuidance).toHaveLength(compactionFromExtension.length);
		// The mechanism's own durable counter agrees with the branch.
		expect(restoreOnlineState(branch).nativeCompactionCount).toBe(phases);

		// Each accepted continuation reaches a real provider request before the
		// corresponding compaction. The final developer message is delivered
		// verbatim, not merely queued by `session_stop`.
		expect(continuationReceipts.filter(Boolean)).toHaveLength(phases);
		expect(deliveredContinuations).toEqual(Array.from({ length: phases }, () => PENDING_COMPACTION_PLAN_REMINDER));

		// The run ended idle with no extension-load errors.
		expect(session.isStreaming).toBe(false);
	} finally {
		await session?.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
}

describe("Online Context Compact with a real AgentSession", () => {
	it("compacts on its own at a completed-step boundary", async () => {
		await runBoundaryScenario(1);
	}, 30_000);

	it("compacts again at a second consecutive completed-step boundary", async () => {
		await runBoundaryScenario(2);
	}, 30_000);
});
