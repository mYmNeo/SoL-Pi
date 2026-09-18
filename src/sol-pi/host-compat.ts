/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

/**
 * Host compatibility layer for oh-my-pi.
 *
 * SoL-Pi runs only on omp. Where omp's public surface differs in shape from the
 * legacy Pi surface this code was written against, the difference is normalized
 * here once so no mechanism module has to know about it:
 *
 *  - `findCutPoint` — omp takes a `Tokenizer` as its second argument. We own the
 *    tokenizer instance, construct it lazily, and cache it.
 *  - `sessionEntryToContextMessages` — omp has no counterpart, so the session
 *    entry projection is implemented here over omp's message factories.
 *  - `estimateMessages` — token counting over a message list, sharing the same
 *    tokenizer as `findCutPoint`.
 *  - `systemPromptText` — omp returns the system prompt as `string[]`.
 *  - `rendererArgs` / `themeOf` — omp's tool renderers pass
 *    `(args, options, theme)` and `(result, options, theme, args)`; Pi passed
 *    the theme in a different slot and a context object instead of trailing args.
 *  - `isOmpContext` — always true on this host, kept so call sites stay explicit.
 *
 * This is the only module in the tree permitted a namespace import: it is the
 * single place that needs several runtime values and types out of one host
 * package, and centralizing that keeps the host boundary to one file.
 *
 * The tokenizer is a native-backed counter. When it cannot be constructed (for
 * example under a plain Node/Bun test runner with no omp native addon loaded)
 * every entry point degrades to a character-count / 4 estimate rather than
 * throwing, so the mechanisms stay usable outside the omp process.
 */

import * as agentCore from "@oh-my-pi/pi-agent-core";
import type { ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { Theme } from "@oh-my-pi/pi-tui/theme";

export type { Theme } from "@oh-my-pi/pi-tui/theme";
export type { AgentMessage, CutPointResult } from "@oh-my-pi/pi-agent-core";

/** Crude byte-to-token ratio used by the degraded path when no tokenizer exists. */
const CHARS_PER_TOKEN = 4;

/** Host-neutral signature for the compaction cut-point search. */
export type FindCutPoint = (
 entries: SessionEntry[],
 startIndex: number,
 endIndex: number,
 keepRecentTokens: number,
) => agentCore.CutPointResult;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

let cachedTokenizer: agentCore.Tokenizer | null | undefined;

/**
 * The shared tokenizer, or `null` when the native counter is unavailable.
 *
 * Construction is attempted at most once; a failure is remembered so a degraded
 * host does not pay for a throwing constructor on every call.
 */
function tokenizer(): agentCore.Tokenizer | null {
 if (cachedTokenizer !== undefined) return cachedTokenizer;
 try {
  cachedTokenizer = new agentCore.Tokenizer();
 } catch {
  cachedTokenizer = null;
 }
 return cachedTokenizer;
}

/** Character-count / 4 estimate for one message, used when no tokenizer exists. */
function fallbackMessageTokens(message: agentCore.AgentMessage): number {
 return Math.ceil(stringWeight(message) / CHARS_PER_TOKEN);
}

/**
 * Total length of the text carried by a value, ignoring structure.
 *
 * Deliberately cheap: it walks only string and number leaves, so it never
 * serializes large tool payloads into an intermediate string.
 */
function stringWeight(value: unknown): number {
 if (typeof value === "string") return value.length;
 if (typeof value === "number" || typeof value === "boolean") return String(value).length;
 if (Array.isArray(value)) {
  let total = 0;
  for (const item of value) total += stringWeight(item);
  return total;
 }
 if (typeof value === "object" && value !== null) {
  let total = 0;
  for (const item of Object.values(value)) total += stringWeight(item);
  return total;
 }
 return 0;
}

/** Token estimate for one message under the shared tokenizer. */
function messageTokens(message: agentCore.AgentMessage): number {
 const counter = tokenizer();
 return counter ? counter.countMessage(message) : fallbackMessageTokens(message);
}

/** Token estimate for a message list. */
export function estimateMessages(messages: readonly agentCore.AgentMessage[]): number {
 let total = 0;
 for (const message of messages) total += messageTokens(message);
 return total;
}

// ---------------------------------------------------------------------------
// Compaction cut point
// ---------------------------------------------------------------------------

/**
 * Index of the user/bashExecution message that opens the turn containing
 * `entryIndex`, or -1 when there is none.
 *
 * Only reached on the degraded path, where the host's own implementation cannot
 * be used because it needs a real `Tokenizer`.
 */
function turnStartIndex(entries: readonly SessionEntry[], entryIndex: number, startIndex: number): number {
 for (let i = entryIndex; i >= startIndex; i -= 1) {
  const entry = entries[i];
  if (!entry) continue;
  if (entry.type === "branch_summary" || entry.type === "custom_message") return i;
  if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "bashExecution")) {
   return i;
  }
 }
 return -1;
}

/** Indices of entries a cut may land on: user-like messages, never tool results. */
function validCutPoints(entries: readonly SessionEntry[], startIndex: number, endIndex: number): number[] {
 const points: number[] = [];
 for (let i = startIndex; i < endIndex; i += 1) {
  const entry = entries[i];
  if (!entry) continue;
  if (entry.type === "branch_summary" || entry.type === "custom_message") {
   points.push(i);
   continue;
  }
  if (entry.type !== "message") continue;
  const role = entry.message.role as string;
  if (role !== "toolResult") points.push(i);
 }
 return points;
}

/**
 * Degraded cut-point search mirroring omp's algorithm with a character-count
 * estimate. Used only when the native tokenizer could not be constructed.
 */
function fallbackFindCutPoint(
 entries: SessionEntry[],
 startIndex: number,
 endIndex: number,
 keepRecentTokens: number,
): agentCore.CutPointResult {
 const cutPoints = validCutPoints(entries, startIndex, endIndex);
 if (cutPoints.length === 0) {
  return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
 }

 let accumulatedTokens = 0;
 let cutIndex = cutPoints[0] ?? startIndex;
 for (let i = endIndex - 1; i >= startIndex; i -= 1) {
  const entry = entries[i];
  if (!entry || entry.type !== "message") continue;
  accumulatedTokens += fallbackMessageTokens(entry.message);
  if (accumulatedTokens >= keepRecentTokens) {
   for (const point of cutPoints) {
    if (point >= i) {
     cutIndex = point;
     break;
    }
   }
   break;
  }
 }

 // Pull in any non-message entries (settings changes, etc.) that precede the cut.
 while (cutIndex > startIndex) {
  const previous = entries[cutIndex - 1];
  if (!previous || previous.type === "compaction" || previous.type === "message") break;
  cutIndex -= 1;
 }

 const cutEntry = entries[cutIndex];
 const isUserMessage = cutEntry?.type === "message" && cutEntry.message.role === "user";
 const start = isUserMessage ? -1 : turnStartIndex(entries, cutIndex, startIndex);
 return {
  firstKeptEntryIndex: cutIndex,
  turnStartIndex: start,
  isSplitTurn: !isUserMessage && start !== -1,
 };
}

/**
 * Find where to cut the context so roughly `keepRecentTokens` recent tokens are
 * kept. Delegates to omp's implementation unless the tokenizer is unavailable.
 *
 * omp ships two structurally near-identical `SessionEntry` unions: the
 * coding-agent one the extension sees, and the agent-core one `findCutPoint`
 * accepts. The agent-core union is a subset — the coding-agent adds entries
 * (`model_usage`, `title_change`, `credential_pin`, …) that carry no messages.
 * `findCutPoint` only reads message/compaction entries, so passing the same
 * array through is what the host itself does; the assertion is a no-op at
 * runtime and exists solely to name the compile-time divergence.
 */
export const findCutPoint: FindCutPoint = (entries, startIndex, endIndex, keepRecentTokens) => {
 const counter = tokenizer();
 if (!counter) return fallbackFindCutPoint(entries, startIndex, endIndex, keepRecentTokens);
 // The coding-agent union is a superset that adds message-free entry kinds
 // (model_usage, title_change, credential_pin). `findCutPoint` switches on
 // entry type and ignores anything it does not know, so passing them through
 // is inert — the cast only names the divergence the compiler cannot express.
 const coreEntries = entries as agentCore.SessionEntry[];
 return agentCore.findCutPoint(coreEntries, counter, startIndex, endIndex, keepRecentTokens);
};

// ---------------------------------------------------------------------------
// Session entry projection
// ---------------------------------------------------------------------------

/**
 * Project one session entry into the messages it contributes to LLM context.
 *
 * omp has no exported equivalent, so this follows the same rules the host
 * applies internally: plain `custom` entries are display/state only, and a
 * `message` entry whose content was lost to a legacy or hand-edited session
 * file is normalized to an empty content list rather than dropped.
 */
export function sessionEntryToContextMessages(entry: SessionEntry): agentCore.AgentMessage[] {
 if (entry.type === "message") {
  const message = entry.message;
  if (
   (message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
   message.content == null
  ) {
   return [{ ...message, content: [] }];
  }
  return [message];
 }
 if (entry.type === "custom_message") {
  return [
   agentCore.createCustomMessage(
    entry.customType,
    entry.content ?? [],
    entry.display,
    entry.details,
    entry.timestamp,
   ),
  ];
 }
 if (entry.type === "branch_summary" && entry.summary) {
  return [agentCore.createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
 }
 if (entry.type === "compaction") {
  return [
   agentCore.createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp, {
    shortSummary: entry.shortSummary,
    method: entry.method,
    tokensAfter: entry.tokensAfter,
    warning: entry.warning,
   }),
  ];
 }
 return [];
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

/** The effective system prompt as one string; omp returns it as `string[]`. */
export function systemPromptText(ctx: ExtensionContext): string {
 return ctx.getSystemPrompt().join("\n");
}

/** True on every host this extension supports; keeps host checks explicit. */
export function isOmpContext(_ctx: ExtensionContext): true {
 return true;
}

// ---------------------------------------------------------------------------
// Renderer arguments
// ---------------------------------------------------------------------------

/** A theme is the renderer argument exposing `fg`; this is how the two argument layouts are told apart. */
function isTheme(value: unknown): value is Theme {
 if (typeof value !== "object" || value === null || !("fg" in value)) return false;
 return typeof value.fg === "function";
}

/**
 * Normalize a tool renderer's positional arguments.
 *
 * omp calls `renderCall(args, options, theme)` and
 * `renderResult(result, options, theme, args)`; the legacy Pi order put the
 * theme directly after the first argument and passed a context object last.
 * The theme is the argument exposing `fg`, which is enough to tell the two
 * layouts apart deterministically.
 */
export function rendererArgs(hostArgs: readonly unknown[]): {
 theme: Theme | undefined;
 options: unknown;
 context: unknown;
} {
 const themeIndex = hostArgs.findIndex(isTheme);
 const candidate = themeIndex < 0 ? undefined : hostArgs[themeIndex];
 if (!isTheme(candidate)) return { theme: undefined, options: hostArgs[1], context: hostArgs[3] };
 return {
  theme: candidate,
  options: themeIndex === 1 ? undefined : hostArgs[1],
  context: themeIndex === 1 ? hostArgs[2] : hostArgs[3],
 };
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** Identity styling: returns text unchanged, so an unthemed render stays literal. */
function plain(text: string): string {
 return text;
}

function createFallbackTheme(): Theme {
 const fallback = {
  fg: (_color: string, text: string) => text,
  fgResolved: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bgFill: (_color: string, text: string) => text,
  fgOnBg: (_color: string, _background: string, text: string) => text,
  bold: plain,
  italic: plain,
  underline: plain,
  strikethrough: plain,
  inverse: plain,
  symbol: () => "",
  styledSymbol: () => "",
  getColorHex: () => "",
  getBgHex: () => "",
  status: { success: "", error: "", warning: "", info: "" },
 };
 // `Theme` is a class with many unrelated members the extension never reads.
 // Only the rendering surface above is meaningful here.
 return fallback as unknown as Theme;
}

let fallbackTheme: Theme | undefined;

/**
 * The theme itself, or a never-throwing identity stand-in when the host could
 * not supply one. Any non-nullish value is returned untouched, so a caller's
 * own theme object — including a test double — keeps its exact behavior.
 */
export function themeOf(theme: Theme | undefined): Theme {
 if (theme !== undefined && theme !== null) return theme;
 fallbackTheme ??= createFallbackTheme();
 return fallbackTheme;
}
