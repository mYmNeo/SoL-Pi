/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

/**
 * Regression guard for the renderer argument contract.
 *
 * oh-my-pi calls a tool's renderers as
 *   renderCall(args, options, theme)
 *   renderResult(result, options, theme, args)
 * with the theme LAST and the options object in slot 2. The legacy Pi order put
 * the theme directly after the first argument and a render-context object in the
 * final slot. A renderer that still reads the theme positionally therefore
 * receives the options object, and the defect is silent at runtime — the host
 * catches the throw and quietly falls back to its default tool line.
 *
 * These tests drive the real exported renderers in the host's order and require
 * the theme's styling to be observable in the produced text, so a positional
 * read fails loudly and a no-op/fallback theme cannot masquerade as a pass.
 */

import type { ExtensionAPI, Theme, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createTheme, loadThemeJsonSync } from "@oh-my-pi/pi-coding-agent/modes/theme/loader";
import { describe, expect, it } from "bun:test";
import { createActionFusionExtension, type ActionFusionOptions } from "../src/sol-pi/extensions/action-fusion/index.ts";
import { createObservationPackExtension } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { registerOnlineContextCompact } from "../src/sol-pi/extensions/online-context-compact/index.ts";
import { FakePi, componentText } from "./helpers.ts";

/**
 * Every styled fragment produced through this theme is wrapped in a marker, so
 * the output proves the real theme object reached `fg` rather than a fallback.
 *
 * Everything else is delegated to a genuine omp theme: the host's built-in
 * renderers read far more than `fg`/`bg`/`bold` (language glyphs, box-drawing
 * corners, spinner frames), and a partial double silently breaks them. Methods
 * resolve against the real instance so its private state stays reachable.
 */
const STAMP = "<<theme>>";

const realTheme = createTheme(loadThemeJsonSync("dark"));

const stampingTheme: Theme = new Proxy(realTheme, {
 get(target, property) {
  if (property === "fg") return (color: string, text: string) => `${STAMP}${color}${STAMP}${text}`;
  const value = Reflect.get(target, property, target);
  // Bind to the real instance: an unbound method invoked through the proxy
  // would receive the proxy as `this` and lose access to the theme's private
  // state.
  return typeof value === "function" ? value.bind(target) : value;
 },
}) as Theme;

/**
 * The options object oh-my-pi passes in slot 2. It deliberately carries a `cwd`
 * and an `args` field so a renderer written against the legacy signature reads
 * a plausible-looking but wrong value instead of failing immediately.
 */
interface HostRenderOptions {
 readonly expanded: boolean;
 readonly isPartial: boolean;
 readonly spinnerFrame?: number;
 readonly cwd: string;
 readonly args: unknown;
}

function hostOptions(args: unknown): HostRenderOptions {
 return { expanded: true, isPartial: false, spinnerFrame: 0, cwd: process.cwd(), args };
}

function loadActionFusion(options: ActionFusionOptions = {}): { edit: ToolDefinition; write: ToolDefinition } {
 const pi = new FakePi();
 createActionFusionExtension(options)(pi.asExtensionApi());
 return { edit: pi.tool("edit"), write: pi.tool("write") };
}

function loadObservationPack(): ToolDefinition {
 const pi = new FakePi();
 createObservationPackExtension()(pi.asExtensionApi());
 return pi.tool("obs_recall");
}

function loadUpdatePlan(): ToolDefinition {
 const pi = new FakePi();
 registerOnlineContextCompact(pi.asExtensionApi());
 return pi.tool("update_plan");
}

/** Run a renderer exactly the way oh-my-pi does, then flatten it to text. */
function renderCallText(tool: ToolDefinition, args: unknown, options: HostRenderOptions): string {
 const renderCall = tool.renderCall;
 if (!renderCall) throw new Error(`${tool.name} exposes no renderCall`);
 const component = renderCall(args as never, options as never, stampingTheme);
 // A renderer may legitimately decline to render (the host then falls back to
 // its own default tool line), so treat that as empty text rather than an error.
 return component ? componentText(component) : "";
}

function renderResultText(
 tool: ToolDefinition,
 result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
 options: HostRenderOptions,
): string {
 const renderResult = tool.renderResult;
 if (!renderResult) throw new Error(`${tool.name} exposes no renderResult`);
 const component = renderResult(result as never, options as never, stampingTheme, options.args as never);
 return component ? componentText(component) : "";
}

describe("tool renderers under the oh-my-pi argument order", () => {
 it("renders an Action Fusion write call with the banner and the host theme", () => {
  const { write } = loadActionFusion();
  const args = { path: "target.ts", content: "export {};\n", then_run: { command: "npm test" } };

  const text = renderCallText(write, args, hostOptions(args));

  expect(text).toContain("SoL-Pi · Action Fusion");
  expect(text).toContain("Money saved · 1 model round-trip avoided");
  // The theme object — not the options object — produced the styling.
  expect(text).toContain(STAMP);
 });

 it("renders an Action Fusion write result using the args from slot 4", () => {
  const { write } = loadActionFusion();
  const args = { path: "target.ts", content: "export {};\n", then_run: { command: "npm test" } };

  const text = renderResultText(
   write,
   { content: [{ type: "text", text: "[then_run:succeeded]" }], details: undefined, isError: false },
   hostOptions(args),
  );

  expect(text).toContain("SoL-Pi · Action Fusion");
  expect(text).toContain(STAMP);
 });

 it("renders an Action Fusion edit call with the banner and the host theme", () => {
  const { edit } = loadActionFusion();
  const args = { path: "target.ts", edits: [{ oldText: "a", newText: "b" }], then_run: { command: "npm test" } };

  const text = renderCallText(edit, args, hostOptions(args));

  expect(text).toContain("SoL-Pi · Action Fusion");
  expect(text).toContain(STAMP);
 });

 it("brands only the fused call, leaving a plain mutation to the host renderer", () => {
  const { write } = loadActionFusion();
  const fusedArgs = { path: "target.ts", content: "export {};\n", then_run: { command: "npm test" } };
  const plainArgs = { path: "target.ts", content: "export {};\n" };

  const fused = renderCallText(write, fusedArgs, hostOptions(fusedArgs));
  const plain = renderCallText(write, plainArgs, hostOptions(plainArgs));

  // The differential is the point: with then_run the banner is added...
  expect(fused).toContain("SoL-Pi · Action Fusion");
  expect(fused).toContain(STAMP);
  // ...without it the call is delegated to the host renderer, which is free to
  // render nothing under a stub theme, so only the banner's absence is required.
  expect(plain).not.toContain("SoL-Pi · Action Fusion");
  expect(plain).not.toContain("Money saved");
 });

 it("renders an Observation Pack recall call and result", () => {
  const recall = loadObservationPack();
  const args = { id: "obs_0123456789abcdef01234567", offset: 0 };

  const call = renderCallText(recall, args, hostOptions(args));
  expect(call).toContain("SoL-Pi · Observation Pack");
  expect(call).toContain("obs_0123456789abcdef01234567");
  expect(call).toContain(STAMP);

  const result = renderResultText(
   recall,
   { content: [{ type: "text", text: "recalled" }], details: { bytes: 12, lines: 2 }, isError: false },
   hostOptions(args),
  );
  expect(result).toContain("SoL-Pi · Observation Pack");
  expect(result).toContain("12 bytes");
  expect(result).toContain(STAMP);
 });

 it("renders an Online Context Compact plan call and result", () => {
  const updatePlan = loadUpdatePlan();
  const args = {
   steps: [
    { id: "inspect", goal: "inspect", status: "completed" },
    { id: "verify", goal: "verify", status: "in_progress" },
   ],
  };

  const call = renderCallText(updatePlan, args, hostOptions(args));
  expect(call).toContain("SoL-Pi · Online Context Compact");
  expect(call).toContain("2 steps, 1 completed");
  expect(call).toContain(STAMP);

  const result = renderResultText(
   updatePlan,
   { content: [{ type: "text", text: "recorded" }], details: { boundary: true }, isError: false },
   hostOptions(args),
  );
  expect(result).toContain("SoL-Pi · Online Context Compact");
  expect(result).toContain("Progress boundary recorded");
  expect(result).toContain(STAMP);
 });

 it("renders every mechanism's result without the trailing args slot", () => {
  // omp's custom-tool bridge drops slot 4 (sdk.ts customToolToDefinition
  // wraps renderResult to (result, {expanded,isPartial,spinnerFrame}, theme)),
  // so a renderer must tolerate absent args.
  const tools: Array<[ToolDefinition, unknown]> = [
   [loadActionFusion().write, { path: "target.ts", content: "x", then_run: { command: "npm test" } }],
   [loadObservationPack(), { id: "obs_0123456789abcdef01234567", offset: 0 }],
   [loadUpdatePlan(), { steps: [{ id: "a", goal: "a", status: "pending" }] }],
  ];

  for (const [tool] of tools) {
   const renderResult = tool.renderResult;
   if (!renderResult) throw new Error(`${tool.name} exposes no renderResult`);
   const text = componentText(
    renderResult(
     { content: [{ type: "text", text: "output" }], details: undefined, isError: false } as never,
     hostOptions(undefined) as never,
     stampingTheme,
    ),
   );
   expect(text, tool.name).toContain(STAMP);
   expect(text, tool.name).not.toBe("");
  }
 });

 it("keeps the extension API surface reachable for the render path", () => {
  // Guards the test double itself: a FakePi that stopped exposing tools would
  // make every assertion above vacuous.
  const pi = new FakePi();
  createObservationPackExtension()(pi.asExtensionApi() as ExtensionAPI);
  expect(pi.registeredTools.map((tool) => tool.name)).toEqual(["obs_recall"]);
 });
});
