import type {
	Api,
	AssistantImages,
	AssistantMessage,
	AssistantMessageEventStream,
	AuthOperationOptions,
	AuthResult,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	Context,
	ImageApi,
	ImageModel,
	ImagesContext,
	Model,
	ModelsApiStreamOptions,
	ModelsClassifierOptions,
	ModelsImagesOptions,
	ModelsRefreshOptions,
	ModelsRefreshResult,
	ModelsSimpleStreamOptions,
	ModelType,
	ModelTypeMap,
	Provider,
} from "@earendil-works/pi-ai";
import { type ModelConsumer, requireLocalModelRuntime } from "./model-consumer.ts";
import type { ModelRuntime, ResolvedRequestAuth } from "./model-runtime.ts";
import type { AuthStatus, ProviderConfigInput } from "./provider-composer.ts";
import type { VirtualModelDefinition } from "./virtual-models.ts";

export type { ResolvedRequestAuth } from "./model-runtime.ts";
export type { ProviderConfigInput } from "./provider-composer.ts";
export { clearApiKeyCache } from "./provider-composer.ts";

/**
 * Synchronous compatibility facade exposed to extensions.
 * Coding-agent internals use ModelRuntime directly.
 */
export class ModelRegistry {
	private readonly localRuntime: ModelRuntime | undefined;
	private readonly consumer: ModelConsumer;

	constructor(runtime: ModelRuntime | undefined, consumer?: ModelConsumer) {
		this.localRuntime = runtime;
		const models = consumer ?? runtime;
		if (!models) throw new Error("ModelRegistry requires model execution");
		this.consumer = models;
	}

	private get runtime(): ModelRuntime {
		return requireLocalModelRuntime(this.localRuntime);
	}

	/** Reload models.json asynchronously. Await before making synchronous registry reads. */
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
		return this.runtime.refresh(options);
	}

	getError(): string | undefined {
		return this.consumer.getError();
	}

	getAll(): Model<Api>[] {
		return [...this.consumer.getModels()];
	}

	getAvailable(): Model<Api>[] {
		return [...this.consumer.getAvailableSnapshot()];
	}

	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.consumer.getModel(provider, modelId);
	}

	/** Find a model of a non-chat type, e.g. `findOfType("classifier", "typesafe", "jev-latest")`. */
	findOfType<TType extends ModelType>(
		type: TType,
		provider: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		return this.runtime.getModelOfType(type, provider, modelId);
	}

	hasConfiguredAuth(model: Model<Api>): boolean {
		return this.consumer.hasConfiguredAuth(model.provider);
	}

	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		return this.consumer.getRequestAuth(model);
	}

	getProviderAuthStatus(provider: string): AuthStatus {
		return this.runtime.getProviderAuthStatus(provider);
	}

	getProvider(provider: string): Provider | undefined {
		return this.runtime.getProvider(provider);
	}

	/** Stream through the configured provider with request-time authentication. */
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return this.consumer.stream(model, context, options);
	}

	/** Stream with provider-neutral options and request-time authentication. */
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return this.consumer.streamSimple(model, context, options);
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.consumer.stream(model, context, options).result();
	}

	/** Every known model of a type (chat, image, classifier), optionally for one provider. */
	getModelsOfType<TType extends ModelType>(type: TType, provider?: string): readonly ModelTypeMap[TType][] {
		return this.runtime.getModelsOfType(type, provider);
	}

	/** Models of a type whose provider has working credentials. */
	getAvailableOfType<TType extends ModelType>(
		type: TType,
		provider?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return this.runtime.getAvailableOfType(type, provider, options);
	}

	getModelOfType<TType extends ModelType>(
		type: TType,
		provider: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		return this.runtime.getModelOfType(type, provider, modelId);
	}

	/** Classify structured state with request-time authentication. Never rejects. */
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		return this.runtime.classify(model, context, options);
	}

	/** Generate images with request-time authentication. Never rejects. */
	generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		return this.runtime.generateImages(model, context, options);
	}

	getProviderDisplayName(provider: string): string {
		return this.runtime.getProvider(provider)?.name ?? provider;
	}

	getProviderAuth(provider: string): Promise<AuthResult | undefined> {
		return this.consumer.getAuth(provider);
	}

	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		try {
			return (await this.consumer.getAuth(provider))?.auth.apiKey;
		} catch {
			return undefined;
		}
	}

	isUsingOAuth(model: Model<Api>): boolean {
		return this.consumer.isUsingOAuth(model.provider);
	}

	registerProvider(provider: Provider): void;
	registerProvider(providerName: string, config: ProviderConfigInput): void;
	registerProvider(providerOrName: Provider | string, config?: ProviderConfigInput): void {
		if (typeof providerOrName === "string") {
			if (!config) throw new Error("Provider config is required when registering by name");
			this.runtime.registerProvider(providerOrName, config);
			return;
		}
		this.runtime.registerNativeProvider(providerOrName);
	}

	unregisterProvider(providerName: string): void {
		this.runtime.unregisterProvider(providerName);
	}

	registerVirtualModel(definition: VirtualModelDefinition): void {
		this.runtime.registerVirtualModel(definition);
	}

	unregisterVirtualModel(providerName: string, id: string): void {
		this.runtime.unregisterVirtualModel(providerName, id);
	}

	getRegisteredProviderConfig(providerName: string): ProviderConfigInput | undefined {
		return this.runtime.getRegisteredProviderConfig(providerName);
	}

	getRegisteredNativeProvider(providerName: string): Provider | undefined {
		return this.runtime.getRegisteredNativeProvider(providerName);
	}

	getRegisteredProviderIds(): readonly string[] {
		return this.runtime.getRegisteredProviderIds();
	}
}
