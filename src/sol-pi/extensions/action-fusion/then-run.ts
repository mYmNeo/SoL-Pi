/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type BashToolOptions,
	createBashToolDefinition,
	Type,
} from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { withFusedFileQueue } from "./file-queue.ts";

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";

export interface ThenRunInput {
	command: string;
	timeout?: number;
}

export function createThenRunSchema(description: string) {
	return Type.Optional(
		Type.Object(
			{
				command: Type.String({ description: "Bash command to run" }),
				timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
			},
			{ description },
		),
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function thenRunSkippedError(error: unknown): Error {
	return new Error(
		`${errorText(error)}\n\n${THEN_RUN_SKIPPED} The file mutation did not complete successfully; the command was not run.`,
	);
}

async function fileSha256(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function assertUnchangedBeforeCommand(
	path: string,
	yieldForInterference: () => Promise<void> = () => new Promise<void>((resolve) => setImmediate(resolve)),
): Promise<void> {
	try {
		const mutationHash = await fileSha256(path);
		await yieldForInterference();
		const commandHash = await fileSha256(path);
		if (mutationHash !== commandHash) {
			throw new Error("target content changed after the fused mutation");
		}
	} catch (error) {
		throw new Error(`${THEN_RUN_SKIPPED} ${errorText(error)}; the command was not run.`);
	}
}

/**
 * Apply a file mutation and, when the model asked for one, run its follow-up
 * command before returning a single observation.
 *
 * Both steps run inside one SoL-Pi queue slot covering every mutated path, so
 * another fused mutation of the same file cannot interleave. The host's
 * built-in mutation tool keeps its own queue; the two queues are not nested.
 *
 * `absolutePaths` is empty when the host's own argument inspector could not name
 * a target file. The mutation still runs — it is the model's own edit — but the
 * follow-up is reported skipped rather than run without the pre-command content
 * guard.
 */
export async function executeMutationThenRun<TDetails>({
	toolCallId,
	absolutePaths,
	thenRun,
	mutate,
	bashOptions,
	signal,
	ctx,
}: {
	toolCallId: string;
	absolutePaths: readonly string[];
	thenRun: ThenRunInput | undefined;
	mutate: () => Promise<AgentToolResult<TDetails>>;
	bashOptions: BashToolOptions | undefined;
	signal: AbortSignal | undefined;
	ctx: ExtensionContext;
}): Promise<AgentToolResult<TDetails>> {
	const fused = async (): Promise<AgentToolResult<TDetails>> => {
		let mutationResult: AgentToolResult<TDetails>;
		try {
			mutationResult = await mutate();
		} catch (error) {
			if (thenRun !== undefined) throw thenRunSkippedError(error);
			throw error;
		}

		if (thenRun === undefined) {
			return mutationResult;
		}
		// A built-in mutation may report failure by returning `isError` instead of
		// throwing — the hashline edit rejects a stale snapshot tag that way — so a
		// returned result is not proof the mutation landed. Running the follow-up
		// would then execute a command against content the model believes it changed.
		if (mutationResult.isError === true) {
			throw thenRunSkippedError(new Error(resultText(mutationResult) || "The file mutation reported an error."));
		}
		if (absolutePaths.length === 0) {
			throw new Error(
				`${THEN_RUN_SKIPPED} The mutated file could not be identified from the tool arguments; the command was not run.`,
			);
		}

		for (const path of absolutePaths) {
			await assertUnchangedBeforeCommand(path);
		}
		const bash = createBashToolDefinition(ctx.cwd, bashOptions);
		try {
			const bashResult = await bash.execute(`${toolCallId}:then_run`, thenRun, signal, undefined, ctx);
			const output = resultText(bashResult);
			return {
				...mutationResult,
				content: [
					...mutationResult.content,
					{ type: "text", text: output ? `${THEN_RUN_SUCCEEDED}\n${output}` : THEN_RUN_SUCCEEDED },
				],
			};
		} catch (error) {
			const mutationOutput = resultText(mutationResult);
			throw new Error([mutationOutput, THEN_RUN_FAILED, errorText(error)].filter(Boolean).join("\n\n"));
		}
	};

	// Without a target there is nothing to serialize against: the queue exists to
	// order two fused mutations that touch the same file.
	const targets = [...new Set(absolutePaths)].sort();
	if (targets.length === 0) return fused();

	// Hold one queue slot per target for the whole mutation-plus-command span, so
	// an overlapping multi-file edit cannot interleave. Acquiring in sorted order
	// keeps two callers that share a subset of targets from deadlocking.
	let guarded = fused;
	for (let index = targets.length - 1; index >= 0; index -= 1) {
		const target = targets[index] as string;
		const inner = guarded;
		guarded = () => withFusedFileQueue(target, inner);
	}
	return guarded();
}
