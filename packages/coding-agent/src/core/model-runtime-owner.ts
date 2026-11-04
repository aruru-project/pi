import {
	type AnyModel,
	type Api,
	type AuthCheck,
	type AuthOperationOptions,
	type AuthResult,
	isModelType,
	type Model,
	type ModelsStoreEntry,
	type ModelType,
	type ModelTypeMap,
	type MutableModels,
} from "@earendil-works/pi-ai";
import type { ModelRuntimeAuthOverrides } from "./model-runtime.ts";

/** The owner's model configuration, as the files it keeps. */
export interface ModelRuntimeOwnerConfiguration {
	/** models.json contents; undefined when the owner has none. */
	modelsJson?: string;
	/** Catalogs the owner stored after refreshing them from the network, by provider. */
	modelsStore: Record<string, ModelsStoreEntry>;
}

/** What the owner's credentials make available. */
export interface ModelRuntimeOwnerAuthState {
	/**
	 * Providers the owner defines. The runtime asks the owner about these only; a provider that only
	 * this runtime's extensions define keeps its credentials in this runtime.
	 */
	providers: string[];
	/** Credential checks of the owner's configured providers. */
	checks: Record<string, AuthCheck>;
	/** Models of every type that the owner's credentials make available. */
	available: Array<{ provider: string; id: string }>;
	/** Providers with a credential stored at the owner. */
	stored: string[];
}

/**
 * Keeps a runtime's model configuration and credentials in another process, such as one machine
 * serving several. The runtime composes providers and sends requests itself, so replies are handled
 * where they are used; the owner resolves every credential and alone refreshes subscriptions, so
 * a refresh token never leaves it.
 */
export interface ModelRuntimeOwner {
	/** Names the owner in errors, e.g. "Main". */
	readonly name: string;
	readConfiguration(options?: AuthOperationOptions): Promise<ModelRuntimeOwnerConfiguration>;
	readAuthState(options?: AuthOperationOptions): Promise<ModelRuntimeOwnerAuthState>;
	getAuth(providerOrModel: string | AnyModel, overrides: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
}

const modelKey = (model: { provider: string; id: string }) => `${model.provider}\0${model.id}`;

/** Availability of an owned runtime: the owner's for its providers, the runtime's own for the rest. */
export class OwnedAuth
	implements Pick<MutableModels, "checkAuth" | "getAvailable" | "getAllAvailable" | "getAvailableOfType">
{
	private state: ModelRuntimeOwnerAuthState = { providers: [], checks: {}, available: [], stored: [] };
	private owned = new Set<string>();
	private available = new Set<string>();

	readonly owner: ModelRuntimeOwner;
	private readonly local: MutableModels;

	constructor(owner: ModelRuntimeOwner, local: MutableModels) {
		this.owner = owner;
		this.local = local;
	}

	async refresh(signal?: AbortSignal): Promise<void> {
		const state = await this.owner.readAuthState({ signal });
		signal?.throwIfAborted();
		this.state = state;
		this.owned = new Set(state.providers);
		this.available = new Set(state.available.map(modelKey));
	}

	owns(providerId: string): boolean {
		return this.owned.has(providerId);
	}

	stored(): readonly string[] {
		return this.state.stored;
	}

	async checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		if (!this.owns(providerId)) return this.local.checkAuth(providerId, options);
		return Object.hasOwn(this.state.checks, providerId) ? this.state.checks[providerId] : undefined;
	}

	async getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		const providers = providerId ? [providerId] : this.local.getProviders().map((provider) => provider.id);
		const lists = await Promise.all(
			providers.map(async (id) =>
				this.owns(id)
					? this.local.getAllModels(id).filter((model) => this.available.has(modelKey(model)))
					: this.local.getAllAvailable(id, options),
			),
		);
		return lists.flat();
	}

	async getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		return this.getAvailableOfType("chat", providerId, options);
	}

	async getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return (await this.getAllAvailable(providerId, options)).filter((model): model is ModelTypeMap[TType] =>
			isModelType(model, type),
		);
	}
}
