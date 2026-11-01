import type { ModelRuntime } from "./model-runtime.ts";

/** Read-only session view. No provider objects, credentials, or registration authority. */
export type ModelCatalog = Pick<
	ModelRuntime,
	| "getModel"
	| "getPhysicalModel"
	| "getModels"
	| "getAvailableSnapshot"
	| "hasConfiguredAuth"
	| "checkAuth"
	| "isUsingOAuth"
>;

/** The operations the session loop consumes, independent of where providers execute.
 * Types are selected from the canonical implementation to avoid duplicating Pi's model DTOs.
 * Management and provider callbacks are not remote operations on this interface.
 */
export type ModelConsumer = ModelCatalog & Pick<ModelRuntime, "streamSimple" | "resolveModel">;

export function requireLocalModelRuntime(runtime: ModelRuntime | undefined): ModelRuntime {
	if (!runtime)
		throw new Error(
			"Provider management and credentials belong to the model service. Use the model consumer to infer.",
		);
	return runtime;
}
