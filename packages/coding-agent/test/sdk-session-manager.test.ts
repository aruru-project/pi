import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHarness } from "./suite/harness.ts";

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// Dock card 271: exercise the real services -> SDK factory, including runtime replacement and reload.
	it("forwards legacy extension policy through the runtime factory and leaves queued errors to the host", async () => {
		const harness = await createHarness({
			models: [
				{ id: "one", reasoning: true },
				{ id: "two", reasoning: true },
			],
		});
		let api: ExtensionAPI | undefined;
		const starts: string[] = [];
		const errors: string[] = [];
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				settingsManager,
				modelRuntime: harness.session.modelRuntime,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					extensionFactories: [
						(pi) => {
							api = pi;
							pi.on("session_start", async (event) => {
								starts.push(event.reason);
								await pi.setModel(harness.getModel("two")!);
								pi.setThinkingLevel("max");
							});
						},
					],
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: harness.getModel(),
					thinkingLevel: "low",
					tools: [],
					extensionModelMutationPolicy: "legacy-defaults",
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			const bind = async (session: typeof runtime.session) => {
				await session.bindExtensions({
					shutdownHandler: () => {},
					onError: (error) => {
						errors.push(error.error);
					},
				});
			};
			runtime.setRebindSession(bind);
			await bind(runtime.session);
			expect(settingsManager.getGlobalSettings()).toMatchObject({
				defaultProvider: harness.getModel().provider,
				defaultModel: "two",
				defaultThinkingLevel: "high",
			});
			await settingsManager.flush();
			const settingsPath = join(agentDir, "settings.json");
			expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(settingsManager.getGlobalSettings());
			await runtime.session.reload();
			expect(await api!.setModel(harness.getModel())).toBe(true);
			api!.setThinkingLevel("low");
			expect(settingsManager.getGlobalSettings()).toMatchObject({
				defaultModel: "one",
				defaultThinkingLevel: "low",
			});
			await runtime.newSession();
			expect(starts).toEqual(["startup", "reload", "new"]);
			expect(errors).toEqual([]);
			expect(runtime.session.model?.id).toBe("two");
			expect(runtime.session.thinkingLevel).toBe("high");
			expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
			await settingsManager.flush();
			expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(settingsManager.getGlobalSettings());

			// A queued disk error must remain available after another successful in-memory plugin mutation.
			rmSync(settingsPath);
			mkdirSync(settingsPath);
			expect(api!.setThinkingLevel("low")).toBeUndefined();
			await settingsManager.flush();
			expect(await api!.setModel(harness.getModel())).toBe(true);
			await settingsManager.flush();
			expect(settingsManager.getGlobalSettings()).toMatchObject({
				defaultModel: "one",
				defaultThinkingLevel: "low",
			});
			expect(settingsManager.drainErrors().length).toBeGreaterThanOrEqual(2);
		} finally {
			await runtime.dispose();
			harness.cleanup();
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
		});

		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const expectedSessionDir = join(agentDir, "sessions", safePath);
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionFile = session.sessionManager.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile?.startsWith(`${expectedSessionDir}/`)).toBe(true);

		session.dispose();
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		session.dispose();
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createAgentSession({
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`<cwd>\n${sessionCwd}\n</cwd>`);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", { command: "pwd" });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));

		session.dispose();
	});

	it("exposes current session state to the built-in bash tool", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			thinkingLevel: "high",
		});
		expect(session.sessionFile).toBeTruthy();
		expect(session.systemPrompt).toContain(
			"You can inspect PI_* environment variables for current model and session details.",
		);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", {
			command: `printf '%s\\n' "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"`,
		});
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(output.trim().split("\n")).toEqual([
			session.sessionId,
			session.sessionFile,
			model!.provider,
			model!.id,
			session.thinkingLevel,
		]);

		session.dispose();
	});
});
