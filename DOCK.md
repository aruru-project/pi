# Pi for Alu Dock

This fork builds every Pi runtime package that Alu Dock uses, including the SDK and the TUI that Dock imports directly. Package names, the `pi` command, `.pi` configuration, credentials and sessions are the same as upstream. Nothing is renamed or wrapped.

## Branches and tags

- `origin` is https://github.com/aruru-project/pi; `upstream` is https://github.com/earendil-works/pi.
- `main` mirrors upstream and carries no Dock changes.
- `dock/1.3.0` holds the Dock changes on top of upstream `v1.3.0` (`71023aec1546d6d677a65669c5665c0927ce0dd0`). `dock/0.99.2` keeps the previous release's source.
- Dock releases are tagged `dock-v<version>`, never `v*`, so upstream's inherited `v*` publishing workflows cannot fire.

`dock-release.json` holds the release version (`1.3.0-dock.4`), the Node requirement (`>=24.0.0`), the upstream tag and commit, and the packages Dock imports directly.

## What we change

Each change is its own commit so it can be reviewed and replayed on the next upstream release:

1. **Editable default prompt prose.** Dock's system templates edit five parts of the default prompt; Pi still builds the tool list, rules, docs paths, project context, skills and cwd, and still leaves hidden tools out of the list and rules. A resolver also lets Dock choose the prompt source explicitly.
2. **Thinking preference on model switch.** `setModel(model, { preserveThinkingLevel: true })` keeps the current thinking level.
3. **Extension model settings.** With `extensionModelMutationPolicy: "legacy-defaults"`, `pi.setModel` and `pi.setThinkingLevel` save defaults as Pi 0.84 did, for existing extensions.
4. **Default compaction prompts.** `getCompactionPromptTemplates()` lets Dock show what compaction asks for. It is read-only.
5. **Cache warming off by default.** Warming sends paid requests, so it runs only after the user sets `cacheWarming` to `"streaming"` or `"idle"` in global settings. The default lives in `settings-defaults.ts`, which also feeds the published settings JSON Schema.
6. **Model configuration and credentials from another process** (since `1.3.0-dock.2`). `ModelRuntime.create({ owner })` takes `models.json`, the stored catalogs and every credential from an owner, such as Dock's Main serving several machines; the runtime still sends and handles its own requests, and only the owner refreshes subscriptions. Every credential read goes through `getAuth`, so `ModelRegistry`'s entries for extensions use the owner too. Providers that only the runtime's extensions define keep their own credentials. The change is in `model-runtime-owner.ts`, `model-runtime.ts`, `model-config.ts` (`fromContent`), `models-store.ts` (`replace`) and `provider-composer.ts` (`resolveExtensionHeaders`); `FileModelsStore` is exported. On `dock/1.3.0` an earlier design and its revert precede it; replay the net change.
7. **A re-dated pi.dev catalog is used** (since `1.3.0-dock.3`). Pi uses a saved pi.dev catalog only when it is dated after the built-in model list. When pi.dev answers a refresh with "not modified", Pi now takes the date from that answer. Before, the saved copy kept its old date, so a catalog saved before the built-in list was generated stayed ignored until pi.dev changed its content, however often it was refreshed. The change is in `remote-catalog-provider.ts`.
8. **Packaging tools** in `scripts/` (described below). Since `1.3.0-dock.4`, they hydrate only the model snapshot pinned alongside the source, verify its SHA-256, and preserve it with the build inputs. They retain the built-in list's release-based date introduced in `1.3.0-dock.3`.
9. **Codex network-compression recovery** (since `1.3.0-dock.4`). A zstd HTTP/SSE request receiving 400 with `detail: "Bad Request"` retries the identical JSON without network compression once. A completed successful retry records that choice only for the current session. Adopting a new context summary, navigating the session tree or releasing the session clears it through `cleanupSessionResources`. The change is in `openai-codex-responses.ts` and `agent-session.ts`; callers managing their own summaries, such as Dock's assistant, clear resources after adopting them too.

Without the opt-ins (an owner is one), Pi's APIs behave as upstream; cache warming is off and Codex encoding recovery applies by default. API details are in [SDK: Dock additions](packages/coding-agent/docs/sdk.md#dock-additions).

## Building a package

On Node 24, from this repository:

```sh
npm ci --ignore-scripts
NODE_USE_ENV_PROXY=1 node scripts/build-dock-package.mjs --candidate --out /new/directory/outside/the/repo
```

Leave out `--candidate` for a release; a release build refuses uncommitted source. A candidate allows it and gets the version `<version>.candidate.<source hash>`. Candidates are for testing only and are never published.

**Built-in model list.** Source, dependency locks and `nix/model-catalog.json` form one versioned set of build inputs. Upstream's release/Nix flow pins the catalog in that file; the Dock producer reads its immutable revision, verifies its SHA-256 and uses upstream's hydrator before building. It replaces generated working-directory data rather than trusting it. It does not discover the latest catalog or change the pin. The download uses no credentials and calls no model; behind a proxy, set `NODE_USE_ENV_PROXY=1`.

For an already downloaded snapshot, add `--model-catalog /path/to/model-catalog.json`. The producer applies the same hash verification and needs no model-catalog network access. The snapshot is saved as `inputs/model-catalog.json` in the output. For a fresh source checkout, this prepares the matching model data for `npm run check` too. Do not use `hydrate:model-data` to prepare checks or releases of a fixed fork: that command discovers live data, which can disagree with this source's model-dependent types and tests.

**The list's date.** Pi prefers an owner-saved pi.dev catalog only when it is newer than the built-in list. The producer dates the built-in snapshot at the upstream release commit, not at build time, preserving the behavior fixed in `1.3.0-dock.3`. The manifest records the pinned revision, `generatedAt` and the generated-data manifest checksum. Runtime catalog refresh remains independent; it does not update build inputs.

The build:

1. Checks that the source descends from the upstream tag and records a fingerprint and patch of the source.
2. Verifies and hydrates the pinned model snapshot, then builds everything from source with upstream's `build:offline`.
3. Packs the runtime packages that the SDK and TUI actually depend on, found from their manifests. For 1.3.0 that is pi-telemetry, pi-ai, pi-agent-core, pi-codemode, pi-mcp, pi-tui and pi-coding-agent; chord is no longer one of them. All get one version, Node 24 as the engine, our repository, and Pi dependencies that point at our release URLs instead of upstream's exact versions. pi-tui's prebuilt native helpers come from the tagged upstream source as they are.
4. Installs the packages into a separate test project and checks one copy of each, the shared version and provenance, the lockfile entries, and that the SDK and the TUI it uses are the same files. Since 1.0 upstream publishes no `npm-shrinkwrap.json`, so the test install starts from upstream's installer lock (`packages/coding-agent/install-lock`), which the build first checks is current.
5. Runs a smoke test: SDK and TUI import, the editable prompt and resolver, tool changes, compaction prompts, cache warming off, a pi.dev catalog saved after the upstream release in use, the thinking preference on model switch, and `pi --version`. No model request is sent.

Keep from the output: every `.tgz`, `manifest.json`, `SHA256SUMS`, `inputs/source.patch` and `inputs/model-catalog.json`. `consumer/` shows the test install. `raw/`, `stage/` and `home/` are scratch. Each package also contains `dock-provenance.json`; pi-coding-agent carries this file as `docs/dock-maintenance.md`.

The test install uses the local files in place of the release URLs. It shows that the packages work together. It does not show that a normal npm install from GitHub works; that is checked after publishing.

## Publishing (owner approval required)

1. Build a release from clean, reviewed source.
2. Check the fork's GitHub Actions settings, then publish all `.tgz` files, `manifest.json`, `SHA256SUMS` and the archived `model-catalog.json` as one release under `dock-v<version>`. Turn on release immutability and never replace a published asset.
3. Check the published release with a normal npm install from the real URLs:

```sh
node scripts/verify-dock-release.mjs --manifest /path/to/manifest.json --out /new/directory
```

It installs the SDK and TUI with plain `npm install`, then `npm ci` from the generated lock, and checks versions, sources, integrity and imports both times. Third-party versions that differ from the build's installer lock are listed, not rejected; run it from this repository so it can read that lock at the release commit. It does not rebuild from source or check release immutability.

## Using it in Dock

Dock points its SDK and TUI dependencies at the release assets, lets npm generate its own lockfile, and assembles Linux and Windows with `npm ci`. Dock's build and install never compile or patch Pi; a Dock-only change reuses the same Pi release. To roll back, restore the previous release and Dock lockfile; Pi settings and sessions are left alone.

## Next upgrade

Sync `main` with upstream, create `dock/<new version>` from the selected upstream tag, and take that tag's dependency locks and model-catalog pin together. Replay only the Dock changes still needed; rebuild a change where upstream restructured the code instead of forcing the old patch in. Update `dock-release.json`, build a candidate and run the checks. A patch to the current fork keeps its existing source baseline, dependency locks and catalog pin; syncing upstream or rebuilding does not itself upgrade any of them.
