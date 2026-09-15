/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	buildSessionContext,
	type ExtensionContext,
	type ExtensionFactory,
	type SessionEntry,
} from "@oh-my-pi/pi-coding-agent";
import {
	estimateMessages,
	findCutPoint,
	sessionEntryToContextMessages,
	systemPromptText,
} from "../../host-compat.ts";
import { formatSavingsCount, showSolPiSavings } from "../../tui.ts";
import {
	DEFAULT_COMPACTION_ECONOMICS,
	decideCompaction,
	type CompactionDecision,
} from "./economics.ts";
import { analyzePlanTransition, formatPlanSnapshot, parsePlanSteps } from "./plan.ts";
import {
	appendOnlineState,
	initialOnlineState,
	recordBoundary,
	recordCompaction,
	recordCorrection,
	recordProviderRequest,
	restoreOnlineState,
	type OnlineState,
	type ProgressSummary,
} from "./state.ts";
import { registerOnlineTools, type PlanUpdateInput } from "./tools.ts";

export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE = 1_000;
export const BOUNDARY_COMPACTION_INSTRUCTIONS =
	"Preserve completed work, verification results, important decisions, and remaining work.";
export const POST_COMPACTION_PLAN_REMINDER =
	"Online context compaction finished. The parent task is still active. " +
	"Before continuing work, call update_plan with a fresh plan for the remaining work.";
// omp's session_stop handler must return inside a 30 second budget, so the
// continuation resumes while the boundary compaction is still running. The
// wording must not claim the rewrite already finished.
export const PENDING_COMPACTION_PLAN_REMINDER =
	"Online context compaction is in progress. The parent task is still active. " +
	"Before continuing work, call update_plan with a fresh plan for the remaining work.";

export type OnlineContextCompactOptions = {
	readonly cacheWriteReadRatio?: number | null;
	readonly keepRecentTokens?: number;
};

type PendingBoundary = { readonly toolCallId: string };
type SelectedCompaction = { readonly decision: CompactionDecision };
type CacheDebt = { readonly debtTokens: number; readonly repaymentTokens: number };

export function resolveKeepRecentTokens(value: number | undefined): number {
	const resolved = value ?? DEFAULT_KEEP_RECENT_TOKENS;
	if (!Number.isSafeInteger(resolved) || resolved < 1) {
		throw new Error("Online Context Compact keepRecentTokens must be a positive safe integer");
	}
	return resolved;
}

function resolveCacheWriteReadRatio(value: number | null | undefined): number | null {
	if (value === undefined || value === null) return null;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error("Online Context Compact cacheWriteReadRatio must be finite and non-negative");
	}
	return value;
}

function tokenEstimate(text: string): number {
	return Math.ceil(Buffer.byteLength(text) / 4);
}

function result(text: string, details: Readonly<Record<string, unknown>>): AgentToolResult<Readonly<Record<string, unknown>>> {
	return { content: [{ type: "text", text }], details };
}

function progressSummary(input: PlanUpdateInput, completedStepId: string): ProgressSummary | undefined {
	const step = input.steps.find((item) => item.id === completedStepId);
	if (!step || !input.progress) return;
	return {
		stepId: step.id,
		goal: step.goal,
		filesChanged: [...input.progress.files_changed],
		verification: [...input.progress.verification],
		decisions: [...input.progress.decisions],
		nextWork: input.steps.filter((item) => item.status !== "completed").map((item) => item.goal),
	};
}

function compactionMessageCount(entries: readonly SessionEntry[], startIndex: number, endIndex: number): number {
	let count = 0;
	for (let index = startIndex; index < endIndex; index++) {
		const entry = entries[index];
		if (entry && entry.type !== "compaction" && sessionEntryToContextMessages(entry).length > 0) count++;
	}
	return count;
}

/// Whether the native cut-point search can free history at all. Evaluated on the
/// real branch: the boundary runs on a natural stop, so the branch ends on the
/// ordinary assistant turn plus its tool results — there is no aborted terminal
/// turn to model.
function nativeCompactionFeasible(entries: readonly SessionEntry[], keepRecentTokens: number): boolean {
	const path = [...entries];
	let startIndex = 0;
	for (let index = path.length - 1; index >= 0; index--) {
		const entry = path[index];
		if (entry?.type !== "compaction") continue;
		const keptIndex = path.findIndex((item) => item.id === entry.firstKeptEntryId);
		startIndex = keptIndex >= 0 ? keptIndex : index + 1;
		break;
	}

	const cut = findCutPoint(path, startIndex, path.length, keepRecentTokens);
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
	const historyMessages = historyEnd > startIndex ? compactionMessageCount(path, startIndex, historyEnd) : 0;
	const prefixMessages =
		cut.isSplitTurn && cut.turnStartIndex >= 0
			? compactionMessageCount(path, cut.turnStartIndex, cut.firstKeptEntryIndex)
			: 0;
	return historyMessages > 0 || prefixMessages > 0;
}

function validPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function createOnlineContextCompactExtension(options: OnlineContextCompactOptions = {}): ExtensionFactory {
	const keepRecentTokens = resolveKeepRecentTokens(options.keepRecentTokens);
	const cacheWriteReadRatio = resolveCacheWriteReadRatio(options.cacheWriteReadRatio);

	return (pi) => {
		let state: OnlineState = initialOnlineState();
		let restored = false;
		let observedMessages: readonly AgentMessage[] = [];
		let pendingBoundary: PendingBoundary | undefined;
		let selected: SelectedCompaction | undefined;
		let activeDebt: CacheDebt | undefined;
		let compactionInFlight = false;

		const restore = (context: ExtensionContext): void => {
			state = restoreOnlineState(context.sessionManager.getBranch());
			restored = true;
			observedMessages = buildSessionContext(
				context.sessionManager.getEntries(),
				context.sessionManager.getLeafId(),
			).messages;
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			compactionInFlight = false;
		};
		const ensureRestored = (context: ExtensionContext): void => {
			if (!restored) restore(context);
		};
		const save = (): void => appendOnlineState(pi, state);
		// omp's compact() returns Promise<void> that can reject IN ADDITION to
		// invoking onError, so both channels are claimed through one `settle` and
		// the rejection is always handled — an unhandled rejection here would
		// otherwise escape as a process-fatal event.
		const startBoundaryCompaction = (context: ExtensionContext, pending: SelectedCompaction): void => {
			let outcomeClaimed = false;
			const claim = (): boolean => {
				if (outcomeClaimed) return false;
				outcomeClaimed = true;
				return true;
			};
			const settle = (error: Error | undefined): void => {
				compactionInFlight = false;
				activeDebt = undefined;
				if (!error || error.name === "AbortError" || error.message === "Compaction cancelled") return;
				pi.logger.error("Online Context Compact boundary compaction failed", {
					error: error.message,
				});
			};
			const promise = context.compact({
				internalGuidance: BOUNDARY_COMPACTION_INSTRUCTIONS,
				onComplete: (compaction) => {
					if (!claim()) return;
					const removed = Math.max(0, pending.decision.archiveTokens - tokenEstimate(compaction.summary));
					if (removed > 0) {
						showSolPiSavings(
							context,
							"Online Context Compact",
							formatSavingsCount(removed, "context tokens removed"),
						);
					}
					settle(undefined);
				},
				onError: (error) => {
					if (!claim()) return;
					settle(error);
				},
			});
			void promise.catch((error: unknown) => {
				if (!claim()) return;
				settle(error instanceof Error ? error : new Error(String(error)));
			});
		};
		const contextTokens = (context: ExtensionContext): number => {
			const visible = estimateMessages(observedMessages);
			const estimated = visible + tokenEstimate(systemPromptText(context));
			const reported = context.getContextUsage()?.tokens;
			return validPositiveInteger(reported) ? Math.max(reported, estimated) : estimated;
		};

		registerOnlineTools(pi, {
			updatePlan: async (input) => {
				ensureRestored(input.context);
				if (input.signal?.aborted) throw new Error("Plan update was aborted");
				const steps = parsePlanSteps(input.steps);
				if (!steps || steps.length === 0) throw new Error("Plan must contain at least one valid step");

				const transition = analyzePlanTransition(state.plan, steps);
				const completedIds = transition.completedSteps.map((step) => step.id);
				if (completedIds.length > 0) {
					state = recordBoundary(state, steps, progressSummary(input, completedIds[0] ?? ""));
					if (!pendingBoundary) pendingBoundary = { toolCallId: input.toolCallId };
				} else if (JSON.stringify(state.plan) !== JSON.stringify(steps)) {
					state = { ...state, plan: [...steps] };
				}
				save();

				return result(
					[formatPlanSnapshot(steps), ...transition.advice].join("\n"),
					{
						boundary: completedIds.length > 0,
						completed_step_ids: completedIds,
						progress_recorded: completedIds.length > 0 && input.progress !== undefined,
						task_status: "active",
						plan: steps,
					},
				);
			},
		});

		pi.on("session_start", (_event, context) => restore(context));
		pi.on("session_before_tree", () => (compactionInFlight ? { cancel: true } : undefined));
		pi.on("session_tree", (_event, context) => restore(context));

		pi.on("context", (event, context) => {
			ensureRestored(context);
			observedMessages = [...event.messages];
		});

		pi.on("before_provider_request", (_event, context) => {
			ensureRestored(context);
			state = recordProviderRequest(state, contextTokens(context));
			save();
		});

		// omp's InputEvent carries no streaming-behavior field; its `source` is
		// "interactive" | "rpc" | "extension", and the result shape is
		// { handled?, text?, images? }. Returning undefined passes the turn
		// through untouched, which is what the pass-through case wants: `handled`
		// would short-circuit sibling extensions, and `text` would rewrite the
		// user's prompt since omp chains each extension's replacement text.
		pi.on("input", (event, context) => {
			if (event.source !== "interactive" && !event.text.startsWith("CORRECTION:")) return undefined;
			ensureRestored(context);
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			state = recordCorrection(state);
			save();
			return undefined;
		});

		pi.on("turn_end", (event, context) => {
			const boundary = pendingBoundary;
			pendingBoundary = undefined;
			if (!boundary || selected) return;
			const toolResult = event.toolResults.find((item) => item.toolCallId === boundary.toolCallId);
			if (
				event.message.role !== "assistant" ||
				event.message.stopReason === "error" ||
				event.message.stopReason === "aborted" ||
				!toolResult ||
				toolResult.isError
			) {
				return;
			}

			const usage = context.getContextUsage();
			const writeTokens = contextTokens(context);
			const fixedTokens = tokenEstimate(systemPromptText(context));
			const archiveTokens = Math.max(0, writeTokens - fixedTokens - keepRecentTokens);
			const contextWindowTokens = validPositiveInteger(usage?.contextWindow)
				? usage.contextWindow
				: validPositiveInteger(context.model?.contextWindow)
					? context.model.contextWindow
					: null;
			const averageContextTokenIncrement =
				state.positiveContextDeltaCount === 0
					? null
					: state.positiveContextDeltaTotal / state.positiveContextDeltaCount;
			const priced = decideCompaction({
				writeTokens,
				archiveTokens,
				memoTokens: DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE,
				contextTokens: writeTokens,
				completedBoundaryRequestCounts: state.completedBoundaryRequestCounts,
				remainingBoundaries: state.plan.filter((step) => step.status !== "completed").length,
				averageContextTokenIncrement,
				contextWindowTokens,
				priorCompactionCount: state.nativeCompactionCount,
				carriedDebtTokens: state.cacheDebtTokens,
				cacheDebtRepaymentTokens: state.cacheDebtRepaymentTokens,
				cacheWriteReadRatio,
				economics: DEFAULT_COMPACTION_ECONOMICS,
			});
			const decision: CompactionDecision =
				priced.compact && !nativeCompactionFeasible(context.sessionManager.getBranch(), keepRecentTokens)
					? { ...priced, compact: false, reason: "native_not_compactable" }
					: priced;
			if (!decision.compact) return;

			// Record the selection only. The run is deliberately NOT aborted: on
			// omp an aborted assistant stop takes the host's aborted fast path,
			// which returns before the `session_stop` dispatch, so an
			// extension-initiated abort would swallow the settle hook that has to
			// start the compaction. Letting the turn end naturally is what carries
			// the selection to `session_stop`.
			selected = { decision };
		});

		// omp's settle/continuation hook, and the only continuation-capable event
		// on this host. There is no upstream settled event, and a registration
		// under that old name would be stored but never fire. Returning
		// `{ continue: true, additionalContext }` IS the resume mechanism, so this
		// path must NOT also call pi.sendMessage — that would resume twice. The
		// handler also must not await the compaction: omp caps every non-shutdown
		// handler at 30 seconds and discards an overrun handler's result, so the
		// compaction is started and the return value produced immediately.
		pi.on("session_stop", (_event, context) => {
			const pending = selected;
			selected = undefined;
			if (!pending || compactionInFlight) return undefined;

			activeDebt = {
				debtTokens: pending.decision.writeTokens * (pending.decision.incrementalCacheCostRatio ?? 0),
				repaymentTokens: Math.max(0, pending.decision.archiveTokens - pending.decision.memoTokens),
			};
				compactionInFlight = true;
			// Started on a later macrotask rather than inline: context.compact()
			// aborts the session synchronously, and an abort raised before this
			// handler returns invalidates the very continuation we are about to
			// return (omp discards a session_stop result once promptGeneration has
			// moved). The managed timer is cleared on session_shutdown.
			context.setTimeout(() => startBoundaryCompaction(context, pending), 0);
			return { continue: true, additionalContext: PENDING_COMPACTION_PLAN_REMINDER };
		});

		pi.on("session_compact", (event, context) => {
			ensureRestored(context);
			state = recordCompaction(
				state,
				event.fromExtension || !activeDebt ? { debtTokens: 0, repaymentTokens: 0 } : activeDebt,
			);
			save();
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			observedMessages = buildSessionContext(
				context.sessionManager.getEntries(),
				context.sessionManager.getLeafId(),
			).messages;
		});

		pi.on("session_shutdown", () => {
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			compactionInFlight = false;
		});
	};
}
