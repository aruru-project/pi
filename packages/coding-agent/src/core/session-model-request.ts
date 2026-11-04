import type { Api, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionRunner } from "./extensions/runner.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { SettingsManager } from "./settings-manager.ts";

/** Hooks that see or change the provider request itself; they run only where the provider runs. */
export const PROVIDER_REQUEST_HOOK_EVENTS = [
	"before_provider_headers",
	"before_provider_request",
	"after_provider_response",
	"provider_stream_event",
] as const;

/** Session settings are data; provider callbacks execute beside the provider. */
export function sessionModelRequestOptions(
	model: Model<Api>,
	options: ModelsSimpleStreamOptions,
	settings: SettingsManager,
	runner: ExtensionRunner | undefined,
	localProvider: boolean,
): ModelsSimpleStreamOptions {
	const retry = settings.getProviderRetrySettings();
	const idle = settings.getHttpIdleTimeoutMs();
	const common = {
		...options,
		timeoutMs: options.timeoutMs ?? retry.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
		websocketConnectTimeoutMs: options.websocketConnectTimeoutMs ?? settings.getWebSocketConnectTimeoutMs(),
		maxRetries: options.maxRetries ?? retry.maxRetries,
		maxRetryDelayMs: options.maxRetryDelayMs ?? retry.maxRetryDelayMs,
	};
	if (!localProvider) {
		// Provider request hooks do not run when another process executes the request; services reports
		// them once per extension. The request still goes out, so the rest of the extension keeps working.
		return {
			...common,
			headers: mergeProviderAttributionHeaders(model, settings, options.sessionId, options.headers),
		};
	}
	return {
		...common,
		transformHeaders: async (requestHeaders) => {
			const headers = mergeProviderAttributionHeaders(model, settings, options.sessionId, requestHeaders);
			return runner?.hasHandlers("before_provider_headers")
				? runner.emitBeforeProviderHeaders(headers ?? {})
				: (headers ?? {});
		},
	};
}
