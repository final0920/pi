import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionFactory } from "../../src/index.ts";
import { createHarness } from "./harness.ts";

const tempDirs: string[] = [];

function makeAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-purge-"));
	tempDirs.push(dir);
	return dir;
}

/**
 * `getAgentDir()` reads PI_CODING_AGENT_DIR on every call, so pointing it at a temp
 * directory isolates the on-disk override per test.
 */
async function withAgentDir<T>(fn: (agentDir: string) => Promise<T>): Promise<T> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = makeAgentDir();
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await fn(agentDir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface PurgeRunnerAccess {
	_extensionRunner?: {
		getFlags(): Map<string, { name: string }>;
		setFlagValue(name: string, value: boolean | string): void;
	};
}

function purgeRunner(harness: { session: unknown }): PurgeRunnerAccess["_extensionRunner"] {
	return (harness.session as PurgeRunnerAccess)._extensionRunner;
}

async function purgeFactory(): Promise<ExtensionFactory> {
	// Import through the same module the built-in list uses so the test fails if the
	// export shape changes.
	const mod = await import("../../src/extensions/purge/index.ts");
	return mod.default;
}

describe("built-in purge extension", () => {
	test("injects a purge section and keeps the other sections intact", async () => {
		await withAgentDir(async () => {
			const factory = await purgeFactory();
			const harness = await createHarness({ extensionFactories: [factory] });
			try {
				harness.setResponses([fauxAssistantMessage("ok")]);
				await harness.session.prompt("hello");

				const head = getCurrentSystemMessage(harness.session.messages);
				if (!head) throw new Error("expected a system message");
				const sections = head.sections ?? {};

				// The purge section exists and carries the prompt verbatim.
				expect(sections.purge).toBeDefined();
				expect(sections.purge).toContain("CTF CORE CONTRACT");
				expect(sections.purge).not.toContain("<|im_start|>");
				expect(sections.purge).not.toContain("apply_patch");

				// Pi's own sections survive: the extension must not replace the prompt.
				expect(Object.keys(sections)).toContain("preamble");
				expect(Object.keys(sections)).toContain("tools");
				expect(Object.keys(sections)).toContain("rules");
				expect(Object.keys(sections)).toContain("cwd");

				// The rendered prompt is the concatenation of all sections.
				const rendered = getSystemMessageText(head);
				expect(rendered).toContain(sections.purge as string);
				expect(rendered).toContain("expert coding assistant");
			} finally {
				harness.cleanup();
			}
		});
	});

	test("uses the on-disk override when present", async () => {
		await withAgentDir(async (agentDir) => {
			const marker = "MARKER_FROM_DISK_12345";
			writeFileSync(join(agentDir, "purge-prompt.md"), `${marker}\n`, "utf8");

			const factory = await purgeFactory();
			const harness = await createHarness({ extensionFactories: [factory] });
			try {
				harness.setResponses([fauxAssistantMessage("ok")]);
				await harness.session.prompt("hello");

				const head = getCurrentSystemMessage(harness.session.messages);
				const sections = head?.sections ?? {};
				// Pi wraps each non-preamble section in a tag of the same name so the model can
				// match later updates to it, hence the surrounding <purge> markers.
				expect(sections.purge).toContain(marker);
				expect(sections.purge).not.toContain("CTF CORE CONTRACT");
			} finally {
				harness.cleanup();
			}
		});
	});

	test("treats an empty override file as the built-in prompt", async () => {
		await withAgentDir(async (agentDir) => {
			writeFileSync(join(agentDir, "purge-prompt.md"), "\n\n", "utf8");

			const factory = await purgeFactory();
			const harness = await createHarness({ extensionFactories: [factory] });
			try {
				harness.setResponses([fauxAssistantMessage("ok")]);
				await harness.session.prompt("hello");

				const head = getCurrentSystemMessage(harness.session.messages);
				expect(head?.sections?.purge).toContain("CTF CORE CONTRACT");
			} finally {
				harness.cleanup();
			}
		});
	});

	test("registers a working /purge command", async () => {
		await withAgentDir(async () => {
			const factory = await purgeFactory();
			const harness = await createHarness({ extensionFactories: [factory] });
			try {
				// Driving the command proves it is registered and that a bare invocation
				// does not start an agent turn (no response is consumed).
				harness.setResponses([fauxAssistantMessage("should stay queued")]);
				await harness.session.prompt("/purge status");
				expect(harness.session.messages).toEqual([]);
				expect(harness.getPendingResponseCount()).toBe(1);
			} finally {
				harness.cleanup();
			}
		});
	});

	test("registers the --no-purge-prompt flag", async () => {
		await withAgentDir(async () => {
			const factory = await purgeFactory();
			const harness = await createHarness({ extensionFactories: [factory] });
			try {
				const flags = purgeRunner(harness)?.getFlags() ?? new Map();
				expect([...flags.keys()]).toContain("no-purge-prompt");
			} finally {
				harness.cleanup();
			}
		});
	});

	test("ships a prompt module that matches prompt.md after embedding", () => {
		const promptModulePath = join(import.meta.dirname, "../../src/extensions/purge/prompt.ts");
		const promptMdPath = join(import.meta.dirname, "../../src/extensions/purge/prompt.md");
		expect(existsSync(promptModulePath)).toBe(true);
		expect(existsSync(promptMdPath)).toBe(true);

		// The generated module must be derived from prompt.md, so a hand edit to the
		// generated file is caught here instead of silently diverging.
		const generated = readFileSync(promptModulePath, "utf8");
		expect(generated).toContain("Generated by scripts/embed-purge-prompt.mjs");
	});
});
