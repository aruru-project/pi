import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-codex-responses"> = {
	id: "fixture",
	name: "fixture",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://codex.test",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1050000,
	maxTokens: 128000,
};
const apiKey = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.fixture`;
// The optional local fixture is private, contains no credential headers, and is never uploaded.
// Its bytes were verified against the real failed request. CI uses synthetic data instead.
const fixtureFile = process.env.PI_TEST_CODEX_REQUEST_FILE;
const raw = fixtureFile
	? readFileSync(fixtureFile, "utf8")
	: JSON.stringify({
			model: "fixture",
			store: false,
			stream: true,
			instructions: "Reply OK.",
			input: [{ role: "user", content: [{ type: "input_text", text: "Saved conversation. ".repeat(100) }] }],
		});
const payload: unknown = JSON.parse(raw);
const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const expectedHash = hash(raw);
const success = `data: ${JSON.stringify({
	type: "response.completed",
	response: {
		id: "resp_fixture",
		status: "completed",
		output: [],
		usage: { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
	},
})}\n\n`;

afterEach(() => cleanupSessionResources());

type Answer = "ok" | "opaque" | "parameter";
function fixture(answers: Answer[]) {
	const sent: Array<{ encoding: string; hash: string; authorization: string | null; signal?: AbortSignal | null }> =
		[];
	const fetch: FetchFunction = async (_url, init) => {
		const headers = new Headers(init?.headers);
		const encoding = headers.get("content-encoding") ?? "identity";
		const body = typeof init?.body === "string" ? init.body : zstdDecompressSync(init?.body as Uint8Array);
		sent.push({ encoding, hash: hash(body), authorization: headers.get("authorization"), signal: init?.signal });
		const answer = answers.shift();
		expect(answer).toBeDefined();
		return answer === "ok"
			? new Response(success, { headers: { "content-type": "text/event-stream" } })
			: new Response(JSON.stringify({ detail: answer === "opaque" ? "Bad Request" : "Invalid model parameter" }), {
					status: 400,
				});
	};
	const call = (sessionId?: string, maxRetries = 0, signal?: AbortSignal) =>
		stream(model, normalizeContext({ messages: [] }), {
			apiKey,
			sessionId,
			transport: "sse",
			fetch,
			maxRetries,
			signal,
			onPayload: () => payload,
		}).result();
	return { call, sent };
}

// https://github.com/earendil-works/pi/issues/12060; real Dock failure 2026-11-15.
it("recovers identical content once, keeps that session usable, and retries compression after context cleanup", async () => {
	if (fixtureFile) expect(expectedHash).toBe("eec27958923dd77f0cffb73058c86d06bb78ad233772992cd03b4cda8d08d2c1");
	const f = fixture(["ok", "opaque", "ok", "ok", "ok", "ok"]);
	expect((await f.call("healthy")).stopReason).toBe("stop");
	expect((await f.call("affected")).stopReason).toBe("stop");
	expect((await f.call("affected")).stopReason).toBe("stop");
	expect((await f.call("healthy")).stopReason).toBe("stop");
	// Owners call this when a new summary replaces the model's context, and on disposal.
	cleanupSessionResources("affected");
	expect((await f.call("affected")).stopReason).toBe("stop");
	expect(f.sent.map((request) => request.encoding)).toEqual(["zstd", "zstd", "identity", "identity", "zstd", "zstd"]);
	for (const request of f.sent) {
		expect(request.hash).toBe(expectedHash);
		expect(request.authorization).toBe(`Bearer ${apiKey}`);
	}
});

it("returns a failed plain retry and keeps compression enabled; unrelated errors do not take the recovery path", async () => {
	const f = fixture(["opaque", "opaque", "ok", "parameter"]);
	expect((await f.call("affected", 2)).stopReason).toBe("error");
	expect((await f.call("affected")).stopReason).toBe("stop");
	expect((await f.call("other")).errorMessage).toContain("Invalid model parameter");
	expect(f.sent.map((request) => request.encoding)).toEqual(["zstd", "identity", "zstd", "zstd"]);
});

it("does not send the plain retry after cancellation", async () => {
	const controller = new AbortController();
	let calls = 0;
	const fetch: FetchFunction = async () => {
		calls++;
		controller.abort();
		return new Response('{"detail":"Bad Request"}', { status: 400 });
	};
	const result = await stream(model, normalizeContext({ messages: [] }), {
		apiKey,
		sessionId: "cancelled",
		transport: "sse",
		fetch,
		signal: controller.signal,
		onPayload: () => payload,
	}).result();
	expect(result.stopReason).toBe("aborted");
	expect(calls).toBe(1);
});
