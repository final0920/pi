/**
 * Built-in purge extension.
 *
 * Injects the purge prompt as a dedicated system-prompt section and exposes the
 * `/purge` command for inspection, editing, and toggling. The prompt is provider
 * neutral: it is one section among Pi's structured sections, so `diffSystemPromptSections`
 * keeps the rest of the prompt cached and only this section invalidates the prefix
 * when it changes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { PURGE_PROMPT } from "./prompt.ts";

/** Name of the system-prompt section. Must satisfy Pi's section-name pattern. */
const SECTION_NAME = "purge";

/** Prompt text loaded from disk and used for the next request. */
let activePrompt = PURGE_PROMPT;

/** Whether the section is injected at all. */
let enabled = true;

function promptPath(): string {
	return join(getAgentDir(), "purge-prompt.md");
}

/**
 * Load the on-disk override when present.
 *
 * A missing file means "use the built-in prompt"; an empty file is treated the same
 * way so clearing the editor restores the default instead of silently disabling the
 * section.
 */
function loadPromptFromDisk(): { text: string; source: "disk" | "builtin"; path: string } {
	const path = promptPath();
	if (existsSync(path)) {
		try {
			const text = readFileSync(path, "utf8");
			if (text.trim()) return { text, source: "disk", path };
		} catch {
			// Fall through to the built-in prompt; a read failure must not break startup.
		}
	}
	return { text: PURGE_PROMPT, source: "builtin", path };
}

function refreshPrompt(): void {
	activePrompt = loadPromptFromDisk().text;
}

function writePrompt(text: string): void {
	const path = promptPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`, "utf8");
	activePrompt = text;
}

function statusLine(ctx: ExtensionContext): string {
	const from = loadPromptFromDisk();
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no model)";
	return [
		`purge: ${enabled ? "enabled" : "disabled"}`,
		`  section:     ${SECTION_NAME}`,
		`  model:       ${model}`,
		`  prompt from: ${from.source === "disk" ? from.path : "built-in"}`,
		`  length:      ${activePrompt.length} chars`,
		`  override:    ${from.path}${from.source === "disk" ? "" : " (not present)"}`,
	].join("\n");
}

export default function purgeExtension(pi: ExtensionAPI): void {
	pi.registerFlag("no-purge-prompt", {
		description: "Disable the built-in purge system prompt",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("purge", {
		description: `Purge prompt controls (${enabled ? "on" : "off"})`,
		getArgumentCompletions: (prefix) => {
			const items = ["status", "on", "off", "edit", "reset"].filter((name) => name.startsWith(prefix));
			return items.length > 0 ? items.map((name) => ({ value: name, label: name })) : null;
		},
		handler: async (args, ctx) => handlePurgeCommand(args.trim(), ctx),
	});

	// `-e`/`--no-purge-prompt` and the runtime flag both land here. Reading the flag
	// lazily keeps a later `/purge on` from being reverted by this handler.
	pi.on("session_start", () => {
		enabled = pi.getFlag("no-purge-prompt") !== true;
		refreshPrompt();
	});

	pi.on("before_agent_start", (event) => {
		refreshPrompt();
		if (!enabled || !activePrompt.trim()) {
			delete event.systemPromptOptions.sections[SECTION_NAME];
			return;
		}
		event.systemPromptOptions.sections[SECTION_NAME] = activePrompt;
	});
}

async function handlePurgeCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const sub = (args.split(/\s+/)[0] || "status").toLowerCase();

	switch (sub) {
		case "status": {
			ctx.ui.notify(statusLine(ctx), "info");
			return;
		}
		case "on": {
			enabled = true;
			refreshPrompt();
			ctx.ui.notify(`Purge prompt enabled (${activePrompt.length} chars).`, "info");
			return;
		}
		case "off": {
			enabled = false;
			ctx.ui.notify("Purge prompt disabled.", "info");
			return;
		}
		case "edit": {
			const current = loadPromptFromDisk();
			const edited = await ctx.ui.editor("Purge prompt", current.text);
			if (edited === undefined) return;
			if (!edited.trim()) {
				ctx.ui.notify("Empty input ignored. Use /purge reset to restore the built-in prompt.", "warning");
				return;
			}
			writePrompt(edited);
			ctx.ui.notify(`Saved to ${promptPath()} (${edited.length} chars).`, "info");
			return;
		}
		case "reset": {
			const path = promptPath();
			if (!existsSync(path)) {
				ctx.ui.notify("No on-disk override; already using the built-in prompt.", "info");
				return;
			}
			if (!(await ctx.ui.confirm("Reset purge prompt", `Delete ${path} and use the built-in prompt?`))) return;
			writeFileSync(path, "", "utf8");
			activePrompt = PURGE_PROMPT;
			ctx.ui.notify("Reverted to the built-in prompt.", "info");
			return;
		}
		default: {
			ctx.ui.notify("Usage: /purge status | on | off | edit | reset", "warning");
		}
	}
}
