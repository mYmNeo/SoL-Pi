/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Action Fusion - fuse a file mutation and its follow-up command into one turn.
 *
 * Rollouts repeatedly showed the same pair of turns: edit or write a file, then
 * run a command to test, build, or start it. This extension replaces the
 * built-in `edit` and `write` tools with versions that take an optional
 * `then_run` object, apply the mutation, run the command, and return one
 * combined observation. The model decision between the two turns disappears.
 *
 * Everything else about `edit` and `write` is inherited from the built-in
 * definitions: their schemas, descriptions, argument handling, and approval.
 *
 * This standalone version composes only the host's public tool definitions.
 */

import {
	EditTool,
	type ExtensionAPI,
	type ExtensionFactory,
	Settings,
	type Theme,
	type ToolSession,
	editToolRenderer,
	writeToolRenderer,
} from "@oh-my-pi/pi-coding-agent";
import {
	type BashToolOptions,
	createEditToolDefinition,
	createWriteToolDefinition,
	Type,
} from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
// The shim re-exports `Type` at runtime but not the `AnySchema` *type*, so the
// annotation stays on omptype. It is erased at compile time and never reaches
// the value boundary where the two instances above must agree.
import { type AnySchema } from "@oh-my-pi/omptype/typebox";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { rendererArgs, themeOf } from "../../host-compat.ts";
import { renderSolPiTool, showSolPiSavings } from "../../tui.ts";
import { resolveToolPath } from "./file-queue.ts";
import {
	createThenRunSchema,
	executeMutationThenRun,
	THEN_RUN_SUCCEEDED,
	type ThenRunInput,
} from "./then-run.ts";

const EDIT_THEN_RUN_DESCRIPTION =
	"Command to run next on this file after the edit succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the edit fails; a non-zero exit is reported but keeps the edit.";
const WRITE_THEN_RUN_DESCRIPTION =
	"Command to run next on this file after the write succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the write fails; a non-zero exit is reported but keeps the write.";

const SAVINGS = "1 model round-trip avoided";

export interface ActionFusionOptions {
	/** Optional programmatic bash overrides, primarily for tests and embedded runtimes. */
	readonly bashOptions?: BashToolOptions;
}

/**
 * Built-in tool definitions capture their cwd in closures, so keep one per
 * working directory instead of rebuilding them on every call and every redraw.
 */
function memoizeByCwd<T>(create: (cwd: string) => T): (cwd: string) => T {
	const cache = new Map<string, T>();
	return (cwd) => {
		const cached = cache.get(cwd);
		if (cached) return cached;
		const created = create(cwd);
		cache.set(cwd, created);
		return created;
	};
}

/**
 * The session shape the host's own legacy tool factories build for `edit`.
 * Sharing it keeps the argument inspector below on the same edit mode — and so
 * the same argument shape — as the definition it inspects.
 */
function toolSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	};
}

/**
 * The built-in parameter schema plus the model-facing `then_run` object. The
 * intersection keeps the inherited fields and the nested description the model
 * already knows, and accepts the host's injected `intent`/`i` field.
 *
 * Composition runs on the host's own `Type` (the compat shim re-exports the
 * omptype instance that owns the built-in definitions), because an extension
 * loaded through `loadLegacyPiModule` gets its own omptype copy: an
 * `Intersect` built from that copy re-parses the host's schema against a
 * different `IR_BRAND` and throws "thunk must return a Type (was object)".
 * Reusing the host instance keeps the embedded-type check satisfied.
 */
function withThenRun(base: unknown, description: string) {
	// The factory's schema is the callable form; only its annotation is erased,
	// so restate that much for composition.
	return Type.Intersect([base as AnySchema, Type.Object({ then_run: createThenRunSchema(description) })]);
}

/** True when the model asked for a follow-up command in these tool arguments. */
function thenRunRequested(args: unknown): boolean {
	if (typeof args !== "object" || args === null) return false;
	return "then_run" in args && args.then_run !== undefined;
}

/** The single target path a `write` call names, if any. */
function writeTargetPath(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const candidate = "path" in input ? input.path : undefined;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/** A short target label for the `edit` call header. */
function editTargetLabel(input: unknown): string {
	if (typeof input !== "object" || input === null) return "";
	const direct = "path" in input ? input.path : "file_path" in input ? input.file_path : undefined;
	if (typeof direct === "string") return direct;
	// Hashline and apply_patch payloads name their target inside the body.
	const body = "input" in input ? input.input : undefined;
	if (typeof body !== "string") return "";
	const match = /^\[([^\]\r\n]+?)(?:#[0-9a-fA-F]{4})?\]\s*$/mu.exec(body.trimStart());
	return match?.[1] ?? "";
}

/**
 * Decode the escaped target forms the model uses into what the built-in
 * mutation tool accepts.
 *
 * The host resolves `file://` URLs and relative paths itself, but it rejects a
 * URI-like `write` target outright and does not understand the `@` escape on
 * `edit`'s `[PATH#TAG]` header, so both are decoded here. A `file://` header is
 * deliberately left encoded: its percent-escapes are what keep a literal `#` in
 * the filename from being read as the tag separator, and decoding it would make
 * the host reject the header.
 */
function normalizeMutationInput(input: Record<string, unknown>, cwd: string): Record<string, unknown> {
	let normalized = input;

	const body = normalized["input"];
	if (typeof body === "string") {
		const lineEnd = body.indexOf("\n");
		const firstLine = lineEnd === -1 ? body : body.slice(0, lineEnd);
		const match = /^(\s*\[)@([^\]\r\n]*\]\s*)$/u.exec(firstLine);
		if (match !== null) {
			const header = `${match[1]}${match[2]}`;
			normalized = { ...normalized, input: lineEnd === -1 ? header : `${header}${body.slice(lineEnd)}` };
		}
	}

	for (const key of ["path", "file_path"]) {
		const value = normalized[key];
		if (typeof value !== "string") continue;
		if (!value.startsWith("@") && !value.startsWith("file://")) continue;
		normalized = { ...normalized, [key]: resolveToolPath(cwd, value) };
	}

	return normalized;
}

/**
 * Invoke a host renderer, tolerating its absence or failure.
 *
 * The legacy built-in definitions ship no renderers at all, and the canonical
 * registry renderers expect the live render context and a full theme. Neither
 * may cost the caller its tool card, so a missing or throwing renderer renders
 * nothing here rather than propagating out of the render pass.
 */
function safeRender(render: unknown, args: readonly unknown[]): Component | undefined {
	if (typeof render !== "function") return undefined;
	try {
		return (render as (...callArgs: readonly unknown[]) => Component | undefined)(...args);
	} catch {
		return undefined;
	}
}

/** The result's own text, themed, for when no host renderer could draw it. */
function resultText(result: unknown): string {
	if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
		return "";
	}
	return result.content
		.flatMap((block) =>
			typeof block === "object" && block !== null && "text" in block && typeof block.text === "string"
				? [block.text]
				: [],
		)
		.join("\n");
}

/**
 * The header line the host itself falls back to when a tool renders no call.
 * Defining `renderCall` suppresses that fallback, so a wrapper that has nothing
 * better to show must still name the tool and its target.
 */
function fallbackCall(label: string, target: string, theme: Theme): Component {
	const path = theme.fg("accent", target);
	return new Text(theme.fg("toolTitle", theme.bold(`${label} ${path}`)), 0, 0);
}

type CanonicalRenderer = typeof editToolRenderer | typeof writeToolRenderer;

/**
 * Wrap the host's canonical renderer for a mutated tool, prefixing the SoL-Pi
 * savings banner only when this call actually fused a command.
 *
 * `then_run` is read from the call's own arguments — `renderCall`'s first
 * argument, or the trailing args slot omp passes to `renderResult` — never from
 * a positional render context, because `renderCall` gets `(args, options,
 * theme)` and `renderResult` gets `(result, options, theme, args)`.
 */
function fusedCall(renderer: CanonicalRenderer, label: string, target: string, hostArgs: readonly unknown[]): Component {
	const { theme, options } = rendererArgs(hostArgs);
	const resolved = themeOf(theme);
	const base = safeRender(renderer.renderCall, [hostArgs[0], options, resolved]);
	if (thenRunRequested(hostArgs[0])) return renderSolPiTool(resolved, "Action Fusion", SAVINGS, base);
	return base ?? fallbackCall(label, target, resolved);
}

function fusedResult(renderer: CanonicalRenderer, hostArgs: readonly unknown[]): Component {
	const { theme, options, context } = rendererArgs(hostArgs);
	const resolved = themeOf(theme);
	const base = safeRender(renderer.renderResult, [hostArgs[0], options, resolved, context]);
	if (thenRunRequested(context)) return renderSolPiTool(resolved, "Action Fusion", SAVINGS, base);
	// A result that renders nothing would drop the model-visible output, so fall
	// back to the result's own text.
	return base ?? new Text(resolved.fg("toolOutput", resultText(hostArgs[0])), 0, 0);
}

export function createActionFusionExtension(options: ActionFusionOptions = {}): ExtensionFactory {
	const baseEdit = memoizeByCwd((cwd: string) => createEditToolDefinition(cwd));
	const baseWrite = memoizeByCwd((cwd: string) => createWriteToolDefinition(cwd));
	// The host's own argument inspector: it resolves the active edit mode and
	// reads the target paths out of whichever argument shape that mode uses —
	// a hashline/apply_patch payload or a plain `path`.
	const editInspector = memoizeByCwd((cwd: string) => new EditTool(toolSession(cwd)));

	return (pi: ExtensionAPI) => {
		const editParameters = withThenRun(baseEdit(process.cwd()).parameters, EDIT_THEN_RUN_DESCRIPTION);
		const writeParameters = withThenRun(baseWrite(process.cwd()).parameters, WRITE_THEN_RUN_DESCRIPTION);

		pi.registerTool({
			...baseEdit(process.cwd()),
			parameters: editParameters,
			async execute(toolCallId, input, signal, onUpdate, ctx) {
				const { then_run, ...editInput } = input as typeof input & { then_run?: ThenRunInput };
				const result = await executeMutationThenRun({
					toolCallId,
					absolutePaths: (editInspector(ctx.cwd).matcherPaths(editInput) ?? []).map((path) =>
						resolveToolPath(ctx.cwd, path),
					),
					thenRun: then_run,
					bashOptions: options.bashOptions,
					signal,
					ctx,
					mutate: () => baseEdit(ctx.cwd).execute(toolCallId, normalizeMutationInput(editInput, ctx.cwd), signal, onUpdate, ctx),
				});
				if (
					then_run &&
					result.content.some((block) => block.type === "text" && block.text.includes(THEN_RUN_SUCCEEDED))
				) {
					showSolPiSavings(ctx, "Action Fusion", SAVINGS);
				}
				return result;
			},
			renderCall: (...hostArgs) => fusedCall(editToolRenderer, "edit", editTargetLabel(hostArgs[0]), hostArgs),
			renderResult: (...hostArgs) => fusedResult(editToolRenderer, hostArgs),
		});

		pi.registerTool({
			...baseWrite(process.cwd()),
			parameters: writeParameters,
			async execute(toolCallId, input, signal, onUpdate, ctx) {
				const { then_run, ...writeInput } = input as typeof input & { then_run?: ThenRunInput };
				const path = writeTargetPath(writeInput);
				const result = await executeMutationThenRun({
					toolCallId,
					absolutePaths: path === undefined ? [] : [resolveToolPath(ctx.cwd, path)],
					thenRun: then_run,
					bashOptions: options.bashOptions,
					signal,
					ctx,
					mutate: () => baseWrite(ctx.cwd).execute(toolCallId, normalizeMutationInput(writeInput, ctx.cwd), signal, onUpdate, ctx),
				});
				if (
					then_run &&
					result.content.some((block) => block.type === "text" && block.text.includes(THEN_RUN_SUCCEEDED))
				) {
					showSolPiSavings(ctx, "Action Fusion", SAVINGS);
				}
				return result;
			},
			renderCall: (...hostArgs) =>
				fusedCall(writeToolRenderer, "write", writeTargetPath(hostArgs[0]) ?? "", hostArgs),
			renderResult: (...hostArgs) => fusedResult(writeToolRenderer, hostArgs),
		});
	};
}

export type { ThenRunInput } from "./then-run.ts";
export {
	assertUnchangedBeforeCommand,
	executeMutationThenRun,
	THEN_RUN_FAILED,
	THEN_RUN_SKIPPED,
	THEN_RUN_SUCCEEDED,
} from "./then-run.ts";

export function registerActionFusion(pi: ExtensionAPI): void {
	createActionFusionExtension()(pi);
}

export default registerActionFusion;
