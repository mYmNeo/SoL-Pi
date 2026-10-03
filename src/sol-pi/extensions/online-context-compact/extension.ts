/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { AgentMessage, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type {
	ExtensionContext,
	ExtensionFactory,
	SessionEntry,
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
import { projectedEntryTokens } from "./projection.ts";
import {
	appendOnlineState,
	initialOnlineState,
	recordBoundary,
	recordCompaction,
	recordCompletedPlanHandoff,
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
// The continuation must reach the model before native compaction starts.
// The wording must not claim the rewrite already finished, and it must keep
// existing step IDs: a freshly keyed completed plan is history, not a new boundary.
export const PENDING_COMPACTION_PLAN_REMINDER =
	"Online context compaction is scheduled. The parent task is still active. " +
	"Continue the remaining work from the current plan. Preserve existing step IDs when updating progress.";

// The host rejects these before committing a replacement summary, so the current
// context is still usable. Unknown errors and user cancellation remain distinct.
const RECOVERABLE_COMPACTION_ERRORS = new Set([
	"Nothing to compact (session too small)",
	"Already compacted",
	"Summarization failed: generation hit the token cap and the summary is incomplete",
]);

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

function messageTokens(message: AgentMessage): number {
	return estimateMessages([message]);
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

function compactionTokenEstimate(
	entries: readonly SessionEntry[],
	startIndex: number,
	endIndex: number,
	projected?: ReadonlyMap<string, number>,
): number {
	let tokens = 0;
	for (let index = startIndex; index < endIndex; index++) {
		const entry = entries[index];
		if (!entry || entry.type === "compaction") continue;
		if (projected) {
			tokens += projected.get(entry.id) ?? 0;
			continue;
		}
		const message = sessionEntryToContextMessages(entry)[0];
		if (message) tokens += messageTokens(message);
	}
	return tokens;
}

/**
 * Tokens the host can actually remove, priced from the latest observed projection
 * when one was provided. Evaluated on the real branch: the boundary runs on a
 * natural stop, so there is no aborted terminal turn to model. Dropped messages
 * contribute nothing — the estimate never substitutes their raw size.
 */
export function estimateNativeCompactionTokens(
	entries: readonly SessionEntry[],
	keepRecentTokens: number,
	projectedMessages?: readonly AgentMessage[],
): number {
	const path = [...entries];
	const projected = projectedMessages === undefined ? undefined : projectedEntryTokens(entries, projectedMessages);
	let startIndex = 0;
	let previousSummaryTokens = 0;
	for (let index = path.length - 1; index >= 0; index--) {
		const entry = path[index];
		if (entry?.type !== "compaction") continue;
		const keptIndex = path.findIndex((item) => item.id === entry.firstKeptEntryId);
		startIndex = keptIndex >= 0 ? keptIndex : index + 1;
		const previousSummary = sessionEntryToContextMessages(entry)[0];
		previousSummaryTokens = projected
			? projected.get(entry.id) ?? 0
			: previousSummary ? messageTokens(previousSummary) : 0;
		break;
	}

	const cut = findCutPoint(path, startIndex, path.length, keepRecentTokens);
	const firstKept = cut.firstKeptEntryIndex;
	if (compactionTokenEstimate(path, startIndex, firstKept) === 0) return 0;
	return previousSummaryTokens + compactionTokenEstimate(path, startIndex, firstKept, projected);
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
		let queuedCompaction: SelectedCompaction | undefined;
		let continuationProjected = false;
		let activeDebt: CacheDebt | undefined;
		let compactionInFlight = false;
		let compactionRefused = false;

		const restore = (context: ExtensionContext): void => {
			state = restoreOnlineState(context.sessionManager.getBranch());
			restored = true;
			// Restoring raw history is not evidence of a provider-visible projection.
			observedMessages = [];
			pendingBoundary = undefined;
			selected = undefined;
			queuedCompaction = undefined;
			continuationProjected = false;
			activeDebt = undefined;
			compactionInFlight = false;
			compactionRefused = false;
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
				if (RECOVERABLE_COMPACTION_ERRORS.has(error.message)) {
					// The continuation turn is already armed. Record the skip so a
					// plan-only restatement cannot immediately compact again, and do
					// not charge debt for a summary that was never committed.
					compactionRefused = true;
					pi.appendEntry("sol-pi-online-context-compact-skipped", { reason: error.message });
					if (context.mode === "tui") {
						context.ui.notify(`Online compaction skipped: ${error.message}`, "warning");
					}
					return;
				}
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
					// Drop the debt before yielding so a compaction the host emits
					// from this same failure cannot inherit it.
					activeDebt = undefined;
					settle(error);
				},
			});
			void promise.catch((error: unknown) => {
				if (!claim()) return;
				activeDebt = undefined;
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
				} else {
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

		// `context` runs for every provider-bound projection. `before_provider_request`
		// is the same request on the CLI path, but in-process mock sessions never
		// emit it, so the projection has to count the request itself. Whichever
		// arrives first counts; the other half of the pair must not count again.
		let providerRequestCounted = false;
		const noteProviderRequest = (context: ExtensionContext): void => {
			ensureRestored(context);
			state = recordProviderRequest(state, contextTokens(context));
			save();
			providerRequestCounted = true;
		};

		pi.on("context", (event, context) => {
			ensureRestored(context);
			observedMessages = [...event.messages];
			noteProviderRequest(context);
			if (queuedCompaction && event.messages.some((message) =>
				message.role === "custom" &&
				message.customType === "session-stop-continuation" &&
				message.content === PENDING_COMPACTION_PLAN_REMINDER,
			)) continuationProjected = true;
		});

		pi.on("before_provider_request", (_event, context) => {
			if (providerRequestCounted) {
				providerRequestCounted = false;
				return;
			}
			noteProviderRequest(context);
			providerRequestCounted = false;
		});

		// omp's InputEvent has no steer/follow-up flag. Its `source` is only
		// "interactive" on the one path that emits it, and the result shape is
		// `{ handled?, text?, images? }`. A normal prompt must not wipe unpaid
		// cache debt: once every step is completed it is a task handoff. Only an
		// explicit correction resets the plan and the debt.
		pi.on("input", (event, context) => {
			compactionRefused = false;
			ensureRestored(context);
			if (!event.text.startsWith("CORRECTION:")) {
				const next = recordCompletedPlanHandoff(state);
				if (next !== state) {
					state = next;
					save();
				}
				return undefined;
			}
			pendingBoundary = undefined;
			selected = undefined;
			activeDebt = undefined;
			state = recordCorrection(state);
			save();
			return undefined;
		});

		pi.on("turn_end", (event, context) => {
			// omp 18.4.12's compact() aborts the live prompt and drops one that is
			// still in setup, before the model sees it. Wait until this turn's
			// projection included the reminder, then start on the next macrotask
			// so the abort cannot discard the continuation that was just admitted.
			if (continuationProjected && queuedCompaction) {
				continuationProjected = false;
				const pending = queuedCompaction;
				queuedCompaction = undefined;
				context.setTimeout(() => startBoundaryCompaction(context, pending), 0);
			}
			// Plan chatter cannot make a rejected compact feasible. Require actual
			// tool work or new user input before attempting another boundary.
			if (event.toolResults.some((item) => item.toolName !== "update_plan" && !item.isError)) compactionRefused = false;
			const boundary = pendingBoundary;
			pendingBoundary = undefined;
			if (!boundary || selected || compactionRefused) return;
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
			const archiveTokens = estimateNativeCompactionTokens(
				context.sessionManager.getBranch(),
				keepRecentTokens,
				observedMessages,
			);
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
				requestsSinceLastCompaction:
					state.lastCompactionRequestCount === null
						? null
						: state.requestCount - state.lastCompactionRequestCount,
				carriedDebtTokens: state.cacheDebtTokens,
				cacheDebtRepaymentTokens: state.cacheDebtRepaymentTokens,
				cacheWriteReadRatio,
				economics: DEFAULT_COMPACTION_ECONOMICS,
			});
			const decision: CompactionDecision =
				priced.compact && archiveTokens === 0
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
		// on this host. Returning `{ continue: true, additionalContext }` IS the
		// resume mechanism, so this path must NOT also call pi.sendMessage.
		// The handler also must not await or schedule compaction: omp caps every
		// non-shutdown handler at 30 seconds and discards an overrun handler's
		// result, and compact() aborts synchronously. On omp 18.4.12 that abort
		// drops a continuation prompt that is still in setup, so the reminder
		// never reaches the model. Compaction starts from the continuation
		// turn's `turn_end` instead.
		pi.on("session_stop", () => {
			const pending = selected;
			selected = undefined;
			if (!pending || compactionInFlight) return undefined;

			activeDebt = {
				debtTokens: pending.decision.postCompactionTokens * (pending.decision.incrementalCacheCostRatio ?? 0),
				repaymentTokens: Math.max(0, pending.decision.archiveTokens - pending.decision.memoTokens),
			};
			compactionInFlight = true;
			queuedCompaction = pending;
			continuationProjected = false;
			return { continue: true, additionalContext: PENDING_COMPACTION_PLAN_REMINDER };
		});

		pi.on("session_compact", (event, context) => {
			ensureRestored(context);
			compactionRefused = false;
			state = recordCompaction(
				state,
				event.fromExtension || !activeDebt ? { debtTokens: 0, repaymentTokens: 0 } : activeDebt,
			);
			save();
			pendingBoundary = undefined;
			selected = undefined;
			queuedCompaction = undefined;
			continuationProjected = false;
			activeDebt = undefined;
			observedMessages = [];
		});

		pi.on("session_shutdown", () => {
			pendingBoundary = undefined;
			selected = undefined;
			queuedCompaction = undefined;
			continuationProjected = false;
			activeDebt = undefined;
			compactionInFlight = false;
		});
	};
}
