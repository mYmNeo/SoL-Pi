/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import {
	complete,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type OptionsForApi,
} from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ArchiveObject } from "./archive.ts";
import type { ReducerConfig } from "./config.ts";
import { reducerInput, reducerInstructions } from "./receipt.ts";

/**
 * The reducer's completion seam: omp's `complete` by default, injectable so a
 * caller can drive `callReducer` without a provider.
 *
 * The `Record<string, unknown>` half carries the auth-scoped `env` passthrough,
 * which the host's `StreamOptions` does not name.
 */
export type CompatComplete = (
	model: Model<Api>,
	context: Context,
	options?: OptionsForApi<Api> & Record<string, unknown>,
) => Promise<AssistantMessage>;

/**
 * Authentication material the host resolves for one reducer request.
 *
 * Mirrors `ModelRegistry.getApiKeyAndHeaders` on omp 18.2.0: it reports no
 * `baseUrl`, and its `headers` are already null-free, so both pass straight
 * through.
 */
export type ReducerRequestAuth =
	| {
		readonly ok: true;
		readonly apiKey?: string;
		readonly headers?: Record<string, string>;
		readonly env?: Record<string, string>;
	}
	| { readonly ok: false; readonly error: string };

export interface NormalizedUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
}

export interface ProviderResult {
	readonly errorMessage: string | undefined;
	readonly model: string;
	readonly ok: boolean;
	readonly outputText: string;
	readonly provider: string;
	readonly stopReason: AssistantMessage["stopReason"];
	readonly usage: NormalizedUsage;
}

export class ReducerModelUnavailableError extends Error {
	override readonly name = "ReducerModelUnavailableError";
}

function responseOutputText(response: AssistantMessage): string {
	return response.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("");
}

function normalizedUsage(response: AssistantMessage): NormalizedUsage {
	return {
		input: response.usage.input,
		output: response.usage.output,
		cacheRead: response.usage.cacheRead,
		cacheWrite: response.usage.cacheWrite,
		totalTokens: response.usage.totalTokens,
	};
}

/**
 * Bound the reducer call by its own budget.
 *
 * omp's `ExtensionContext` carries no abort signal and a `tool_result` event
 * carries none either, so there is no parent signal to relay: this timeout is
 * the only cancellation the extension controls, and it is always armed. The
 * signal is what enforces the budget — omp's stream options have no total
 * request deadline, so the abort is threaded through `options.signal` instead.
 */
function operationSignal(timeoutMs: number): {
	readonly cleanup: () => void;
	readonly signal: AbortSignal;
} {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new DOMException("Reducer model call timed out", "AbortError")),
		timeoutMs,
	);
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
		},
	};
}

function resolveReducerModel(config: ReducerConfig, registry: ExtensionContext["modelRegistry"]): Model<Api> {
	const model = registry.find(config.reducerProvider, config.reducerModel);
	if (!model) {
		throw new ReducerModelUnavailableError(
			`Reducer model is unavailable: ${config.reducerProvider}/${config.reducerModel}`,
		);
	}
	return model;
}

/** Use the configured reducer model and host-resolved authentication for the reducer call. */
export async function callReducer(
	config: ReducerConfig,
	command: string,
	isError: boolean,
	archive: ArchiveObject,
	body: string,
	context: ExtensionContext,
	completeCall: CompatComplete = complete,
): Promise<ProviderResult> {
	const model = resolveReducerModel(config, context.modelRegistry);
	const auth: ReducerRequestAuth = await context.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	// A model that declares no output cap (`maxTokens: null`) is bounded by the
	// reducer budget alone.
	const modelCap = model.maxTokens;
	const maxTokens =
		typeof modelCap === "number" && modelCap > 0 ? Math.min(config.maxOutputTokens, modelCap) : config.maxOutputTokens;
	const operation = operationSignal(config.timeoutMs);
	try {
		const requestContext: Context = {
			systemPrompt: [reducerInstructions()],
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: reducerInput(command, isError, archive, body) }],
					timestamp: Date.now(),
				},
			],
		};
		const requestOptions = {
			cacheRetention: "none" as const,
			maxTokens,
			sessionId: config.runId,
			signal: operation.signal,
			...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
			...(auth.headers === undefined ? {} : { headers: auth.headers }),
			...(auth.env === undefined ? {} : { env: auth.env }),
		};
		const response = await completeCall(model, requestContext, requestOptions);
		return {
			errorMessage: response.errorMessage,
			model: response.model,
			ok: response.stopReason === "stop" || response.stopReason === "length",
			outputText: responseOutputText(response),
			provider: response.provider,
			stopReason: response.stopReason,
			usage: normalizedUsage(response),
		};
	} finally {
		operation.cleanup();
	}
}
