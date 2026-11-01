import { expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";

it("does not replay an explicitly non-retryable uncertain model-service result", async () => {
	const failure = {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "Model request failed; outcome uncertain; no automatic replay: terminated",
		}),
		retryable: false as const,
	};
	expect(isRetryableAssistantError(failure)).toBe(false);
	let calls = 0;
	const result = await retryAssistantCall(
		async () => {
			calls++;
			return failure;
		},
		{ enabled: true, maxRetries: 3, baseDelayMs: 0, maxAgentDelayMs: 0 },
		undefined,
	);
	expect(result).toBe(failure);
	expect(calls).toBe(1);
	expect(
		isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })),
	).toBe(true);
});
