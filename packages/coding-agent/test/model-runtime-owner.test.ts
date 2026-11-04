import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyModel } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ModelRuntimeOwner, ModelRuntimeOwnerAuthState } from "../src/core/model-runtime-owner.ts";

const model = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** An owner that has no answer about credentials, like Main while its model service is restarting. */
function silentOwner(modelsJson: unknown) {
	const asked: string[] = [];
	const owner: ModelRuntimeOwner = {
		name: "Main",
		readConfiguration: async () => ({ modelsJson: JSON.stringify(modelsJson), modelsStore: {} }),
		readAuthState: async (): Promise<ModelRuntimeOwnerAuthState> => {
			throw new Error("not reachable");
		},
		getAuth: async (target: string | AnyModel) => {
			asked.push(typeof target === "string" ? target : target.provider);
			return undefined;
		},
	};
	return { owner, asked };
}

describe("ModelRuntime with an owner", () => {
	const saved = process.env.OPENAI_API_KEY;
	afterEach(() => {
		if (saved === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = saved;
	});

	// Card #303: a Work takes credentials only from Main. Before Main had answered, every provider
	// counted as the Work's own and resolved from the Work's environment.
	it("never resolves an owner's provider from this machine, even before the owner answers", async () => {
		process.env.OPENAI_API_KEY = "key-of-this-machine";
		const { owner, asked } = silentOwner({ providers: {} });
		const runtime = await ModelRuntime.create({ owner });

		expect(await runtime.getAuth("openai")).toBeUndefined();
		expect(asked).toEqual(["openai"]);
		expect(await runtime.checkAuth("openai")).toBeUndefined();
	});

	// Main's models.json reaches the Work whole. When Main has no credential for a provider, its
	// configured headers, which may run commands, must not be resolved on the Work's machine.
	it("does not resolve the owner's configured headers when the owner has no credential", async () => {
		const marker = join(mkdtempSync(join(tmpdir(), "pi-owner-")), "ran");
		const { owner } = silentOwner({
			providers: {
				custom: {
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					headers: { "x-token": `!touch ${marker}` },
					models: [model],
				},
			},
		});
		const runtime = await ModelRuntime.create({ owner });
		const registry = new ModelRegistry(runtime);

		const auth = await registry.getApiKeyAndHeaders(runtime.getModel("custom", "m")!);
		expect(auth.ok).toBe(false);
		expect(existsSync(marker)).toBe(false);
	});

	it("keeps the credentials of a provider only its extensions define", async () => {
		const { owner, asked } = silentOwner({ providers: {} });
		const runtime = await ModelRuntime.create({ owner });
		runtime.registerProvider("extension-only", {
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
			apiKey: "extension-key",
			models: [model],
		});

		expect((await runtime.getAuth("extension-only"))?.auth.apiKey).toBe("extension-key");
		expect(asked).toEqual([]);
	});
});
