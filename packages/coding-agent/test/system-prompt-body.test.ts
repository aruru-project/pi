import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { expect, test, vi } from "vitest";
import { buildSystemPrompt, buildSystemPromptSections } from "../src/core/system-prompt.ts";
import {
	type BuildSystemPromptOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
	DefaultResourceLoader,
	defineTool,
	getDefaultSystemPromptBody,
	parseDefaultSystemPromptBody,
	SessionManager,
	SettingsManager,
	type SystemPromptSelection,
} from "../src/index.ts";

// Frozen from unmodified v1.3.0 (71023aec1546d6d677a65669c5665c0927ce0dd0) with
// PI_PACKAGE_DIR=/pi-fixture. Do not regenerate it from the derived builder.
const baseline = JSON.parse(
	readFileSync(new URL("./fixtures/system-prompt/v1.3.0.json", import.meta.url), "utf8"),
) as Array<{ options: BuildSystemPromptOptions; sections: Record<string, string>; prompt: string }>;

test("unchanged and explicitly initialized default prompts match the original v1.3.0 output", () => {
	vi.stubEnv("PI_PACKAGE_DIR", "/pi-fixture");
	// Only the platform's absolute documentation paths vary from the frozen Linux output.
	const localize = (text: string) =>
		text.replace(/\/pi-fixture\/(README\.md|docs|examples)/g, (_, name: string) => resolve("/pi-fixture", name));
	for (const { options, sections, prompt } of baseline) {
		const expectedSections = Object.fromEntries(
			Object.entries(sections).map(([name, text]) => [name, localize(text)]),
		);
		for (const input of [options, { ...options, defaultSystemPromptBody: getDefaultSystemPromptBody() }]) {
			expect(buildSystemPromptSections(input)).toEqual(expectedSections);
			expect(buildSystemPrompt(input)).toBe(localize(prompt));
		}
	}
});

test("editable bodies require all fields, keep intentional empty prose, and have independent defaults", () => {
	const empty = { intro: "", toolNotes: "", guidelines: [], documentationHeading: "", documentationInstructions: [] };
	expect(parseDefaultSystemPromptBody(empty)).toEqual(empty);
	// Malformed edited configuration must report an error, not restore default prose.
	for (const key of Object.keys(empty)) {
		const missing: Record<string, unknown> = { ...empty };
		delete missing[key];
		expect(() => parseDefaultSystemPromptBody(missing)).toThrow(TypeError);
		expect(() => parseDefaultSystemPromptBody({ ...empty, [key]: 42 })).toThrow(TypeError);
	}
	expect(() => parseDefaultSystemPromptBody(null)).toThrow(TypeError);
	expect(() => parseDefaultSystemPromptBody({ ...empty, guidelines: [null] })).toThrow(TypeError);
	const first = getDefaultSystemPromptBody();
	first.guidelines.push("Only this copy");
	first.documentationInstructions.length = 0;
	expect(getDefaultSystemPromptBody().guidelines).toEqual([
		"Be concise in your responses",
		"Show file paths clearly when working with files",
	]);
	expect(getDefaultSystemPromptBody().documentationInstructions).toHaveLength(4);

	const sections = buildSystemPromptSections({ cwd: "/workspace", selectedTools: [], defaultSystemPromptBody: empty });
	expect(Object.keys(sections)).toEqual(["preamble", "tools", "docs", "cwd"]);
	expect(sections.preamble).toBe("");
	expect(sections.tools).toBe("<tools>\n(none)\n</tools>");
	expect(sections.docs).toMatch(/^<docs>\n- Main documentation: /);
	expect(buildSystemPrompt({ cwd: "/workspace", selectedTools: [], defaultSystemPromptBody: empty })).toMatch(
		/^<tools>\n\(none\)\n<\/tools>/,
	);

	const edited = { ...getDefaultSystemPromptBody(), intro: "Edited intro.", guidelines: ["Edited rule."] };
	const editedSections = buildSystemPromptSections({
		cwd: "/workspace",
		selectedTools: ["read"],
		toolSnippets: { read: "Read files" },
		toolGuidelines: { read: ["Read before editing."] },
		defaultSystemPromptBody: edited,
	});
	expect(editedSections.preamble).toBe("Edited intro.");
	expect(editedSections.rules).toBe("<rules>\n- Read before editing.\n- Edited rule.\n</rules>");
	// A native custom prompt still replaces the whole default prefix, including the edited body.
	const custom = buildSystemPromptSections({
		cwd: "/workspace",
		customPrompt: "Custom.",
		defaultSystemPromptBody: edited,
	});
	expect(custom).toEqual({ preamble: "Custom.", cwd: "<cwd>\n/workspace\n</cwd>" });
});

test("SDK selection keeps its real source and prose while Pi rebuilds tools and loads native resources", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-system-body-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	const projectSystem = join(cwd, ".pi", "SYSTEM.md");
	const globalSystem = join(agentDir, "SYSTEM.md");
	const bodyPath = join(root, "selected.json");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(join(agentDir, "skills", "fixture-skill"), { recursive: true });
	writeFileSync(projectSystem, "Native project fixture.");
	writeFileSync(globalSystem, "Native global fixture.");
	writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "Append fixture.");
	writeFileSync(join(cwd, "AGENTS.md"), "Project context fixture.");
	writeFileSync(
		join(agentDir, "skills", "fixture-skill", "SKILL.md"),
		"---\nname: fixture-skill\ndescription: A fixture skill.\n---\nSkill fixture.\n",
	);
	writeFileSync(
		bodyPath,
		JSON.stringify({
			intro: "Selected intro.",
			toolNotes: "Selected tool note.",
			guidelines: ["Selected working rule."],
			documentationHeading: "Selected docs heading:",
			documentationInstructions: ["Selected docs instruction."],
		}),
	);
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	let selection: "default" | "project" | "global" = "default";
	const resolveSelection = async (): Promise<SystemPromptSelection> => {
		if (selection === "default")
			return {
				kind: "default",
				body: parseDefaultSystemPromptBody(JSON.parse(await readFile(bodyPath, "utf8"))),
				source: { path: bodyPath },
			};
		const path = selection === "project" ? projectSystem : globalSystem;
		return { kind: "custom", text: await readFile(path, "utf8"), source: { path } };
	};
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	try {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				noExtensions: true,
				noThemes: true,
				systemPromptResolver: resolveSelection,
				systemPromptOverride: () => "Old override must not win.",
			},
		});
		const result = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			customTools: [
				defineTool({
					name: "lookup",
					label: "Lookup",
					description: "Fixture lookup",
					promptSnippet: "Look up fixture facts",
					promptGuidelines: ["Use lookup for fixture facts."],
					parameters: Type.Object({}),
					execute: async () => ({ content: [], details: {} }),
				}),
			],
		});
		session = result.session;
		const loader = services.resourceLoader;
		expect(loader.getSystemPrompt()).toBeUndefined();
		expect(loader.getSystemPromptSource()).toEqual({ path: bodyPath });
		expect(session.systemPrompt.startsWith("Selected intro.\n\n<tools>")).toBe(true);
		for (const text of [
			"Selected tool note.",
			"Selected working rule.",
			"Selected docs heading:",
			"Selected docs instruction.",
			"Append fixture.",
			"Project context fixture.",
			"<name>fixture-skill</name>",
			`<cwd>\n${cwd.replace(/\\/g, "/")}\n</cwd>`,
			"- lookup: Look up fixture facts",
			"- read:",
			"Use bash for file operations like ls, rg, find",
		])
			expect(session.systemPrompt).toContain(text);
		expect(session.systemPrompt).not.toContain("Native project fixture.");
		expect(session.systemPrompt).not.toContain("Old override must not win.");
		expect(session.systemPrompt).not.toContain("Be concise in your responses");
		// Tool changes reuse the loaded body; they do not read the file again.
		writeFileSync(bodyPath, "invalid edited JSON");
		session.setActiveToolsByName(["lookup"]);
		expect(session.systemPrompt).toContain("Selected working rule.");
		expect(session.systemPrompt).toContain("Use lookup for fixture facts.");
		expect(session.systemPrompt).not.toContain("- read:");
		expect(session.systemPrompt).not.toContain("Use bash for file operations");
		expect(session.systemPrompt).not.toContain("<available_skills>");
		// Failed reads keep the previous choice instead of falling back to another source.
		await expect(loader.reload()).rejects.toThrow(SyntaxError);
		expect(loader.getSystemPromptSource()).toEqual({ path: bodyPath });
		expect(loader.getDefaultSystemPromptBody?.()?.intro).toBe("Selected intro.");
		rmSync(bodyPath);
		await expect(loader.reload()).rejects.toMatchObject({ code: "ENOENT" });
		expect(loader.getSystemPrompt()).toBeUndefined();
		expect(loader.getSystemPromptSource()).toEqual({ path: bodyPath });
		for (const [choice, path, text] of [
			["project", projectSystem, "Native project fixture."],
			["global", globalSystem, "Native global fixture."],
		] as const) {
			selection = choice;
			await loader.reload();
			session.setActiveToolsByName(["read", "bash"]);
			expect(loader.getSystemPromptSource()).toEqual({ path });
			expect(loader.getDefaultSystemPromptBody?.()).toBeUndefined();
			expect(session.systemPrompt.startsWith(text)).toBe(true);
			expect(session.systemPrompt).toContain("Append fixture.");
			expect(session.systemPrompt).toContain("<name>fixture-skill</name>");
			expect(session.systemPrompt).not.toContain("<tools>");
		}
		// Without a resolver, native discovery and the empty-file behavior are unchanged.
		const nativeLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true });
		await nativeLoader.reload();
		expect(nativeLoader.getSystemPrompt()).toBe("Native project fixture.");
		expect(nativeLoader.getSystemPromptSource()).toEqual({ path: projectSystem });
		expect(nativeLoader.getDefaultSystemPromptBody()).toBeUndefined();
		writeFileSync(projectSystem, "");
		await nativeLoader.reload();
		expect(nativeLoader.getSystemPrompt()).toBe("");
		expect(buildSystemPrompt({ cwd, customPrompt: nativeLoader.getSystemPrompt() })).toContain("<tools>");
	} finally {
		session?.dispose();
		await settingsManager.flush();
		rmSync(root, { recursive: true, force: true });
	}
});
