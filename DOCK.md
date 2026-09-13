# Dock's Pi distribution

This fork supplies every Pi runtime package used by Alu Dock, including the SDK
and directly imported TUI. Canonical npm names, the `pi` command, native `.pi`
configuration, credentials and sessions are unchanged. No compatibility shell or
renamed runtime is introduced.

## Source and release isolation

`origin` is https://github.com/aruru-project/pi; `upstream` is
https://github.com/earendil-works/pi. Keep `main` as a pure upstream mirror.
`dock/0.85.1-system` carries implementation changes from the fixed v0.85.1 release
(commit `d981de1229ef899957bbe968bc8dcda02a21f477`). Dock tags use `dock-v<VERSION>`
so they cannot trigger upstream's inherited `v*` binary/npm publishing workflow.
They identify reviewed fork source, not mirror updates or a moving branch.

`dock-release.json` owns the derivative version (`0.85.1-dock.1`), Node requirement
(`>=24.0.0`), fork repository, runtime roots and pinned model-data input integrity.
Keep prompt-body changes separate from model-selection compatibility changes when
committing so both can be reviewed and replayed independently.

Dock build, prepack and install ONLY reuse fixed Pi artifacts and their lockfile.
They must not invoke this producer, compile Pi, repack it, or patch an installed
community package. Changing Dock alone does not require a Pi rebuild. SDK, TUI,
Worker, shell and nested Pi must resolve the same controlled cohort. Resolve the
CLI using the installed package's `bin.pi` (currently `dist/bundle/cli.js`).

## Independent producer

From this repository on Node 24:

```sh
node scripts/build-dock-package.mjs --out /tmp/pi-dock-release
```

The output directory must be new and outside the repository. Release builds
require clean tracked and untracked source. Only `.pi-subagents/` execution
artifacts are excluded from source checks and hashes. For unpublished development:

```sh
node scripts/build-dock-package.mjs --candidate --out /tmp/pi-dock-candidate
```

Candidates permit dirty source, not older Node. Every package receives the same
`.candidate.<source-hash>` version and embedded candidate provenance. Never publish
a candidate as a clean release. Node24 is locally verified for the current
candidate; still confirm deployment target readiness with the user before merge
and completion (card checklist #1306). Do not change their default Node or service.

The producer:

1. Verifies the upstream tag/commit and source ancestry, records the source patch,
   fingerprint and lock hashes. Runtime dependencies are traversed from the SDK
   and TUI manifests, not an assumed list. Currently this is chord, pi-telemetry,
   pi-ai, pi-agent-core, pi-tui and pi-coding-agent under `@earendil-works`.
2. Installs root locked build dependencies with lifecycle scripts disabled. It
   fetches the exact upstream Pi AI tarball solely for ignored model-data JSON,
   checks its pinned SHA-512, and restores that data. No compiled community Pi
   runtime is copied into the cohort; no current catalogs or providers are queried.
3. Clears old TypeScript outputs and runs upstream `build:offline`. Development-only
   prerequisites are compiled because the upstream build needs them; they are not
   distributed. All runtime JavaScript is built from the fixed fork source.
4. Uses upstream npm file selection to stage and pack each runtime package in
   dependency order. Stage manifests share one version and Node24 requirement,
   retain canonical identities, and point repository metadata at the fork. Every
   Pi runtime dependency becomes an exact URL under
   `https://github.com/aruru-project/pi/releases/download/dock-v<VERSION>/<PACKAGE>-<VERSION>.tgz`.
   Coding-agent shrinkwrap Pi entries receive these URLs, cohort versions and
   actual asset SHA-512 integrity. Non-Pi lock records remain unchanged. Source
   workspace versions and lockfiles are not rewritten.
5. Installs exact local tgz overrides for these as-yet-unpublished URLs in a
   separate consumer, with coding-agent and pi-tui as direct dependencies, scripts
   disabled, isolated HOME/XDG/Pi directories and offline model behavior. The
   consumer lock is seeded from the upstream shrinkwrap plus cohort assets and
   installed with `npm ci`: plain `npm install` with overrides can re-resolve
   third-party ranges. The fully expanded consumer lock does not ask npm to
   inflate another nested shrinkwrap tree. It checks installed package versions,
   the installed lock's Pi asset paths/SRI, one copy per Pi package, fork provenance,
   common version, absence of workspace links and unchanged locked non-Pi inputs.
6. Imports both SDK and TUI outside the repository and verifies they resolve the
   same TUI; checks prompt-body APIs, resolver, tool rebuild, explicit thinking
   preference preservation and the manifest CLI version. No model request is sent.
   It rechecks the source fingerprint and writes the final receipt only on success.

Retain together:

- All six runtime `.tgz` assets, `manifest.json` and `SHA256SUMS`. The manifest lists
  the whole cohort with URLs, versions, SHA-256, SRI, source and build provenance.
- `inputs/source.patch` and the verified upstream model-data tarball.
- `stage/<package>/package/`, `consumer/` and its exact-local-asset overrides and
  lockfile. `raw/` contains intermediate upstream-named packs, not release assets;
  `home/` is disposable isolated build/install state.

Each final package contains `dock-provenance.json`; coding-agent also carries this
file as `docs/dock-maintenance.md`. Output hashes cannot be embedded in the same
bytes they hash, so they live in the outer manifest. Candidate URLs express the
intended release references but are not published or availability-tested. The
local override test proves local asset bytes and SDK/TUI integration only. It does
not prove normal npm dependency resolution, embedded shrinkwrap installation or
GitHub downloads. The expanded development lock is not a production install recipe.
The old candidate-5 has working runtime APIs but uses obsolete `v*` asset metadata;
it must not be published. Rebuild reviewed clean source to obtain `dock-v*` release
assets. Publication status is not embedded in immutable packages; verify it remotely.

## Independent model-selection addition

`session.setModel(model, { preserveThinkingLevel: true })`, typed by
`ModelSelectionOptions extends ModelMutationOptions`, preserves the current
thinking preference when leaving a reasoning model, or the saved default (Pi's
default when absent) when leaving a non-reasoning model. Pi clamps and records the
final level before `model_select` observes it. Omitting the option retains v0.85.1
behavior; persistence defaults and cycle/thinking APIs are unchanged. Dock owns
its existing global-settings save/error contract through public APIs. This patch
is separate from the prompt-body patch and should be reviewed independently.

## Release, upgrade and rollback

The producer never commits, tags, pushes or publishes. Remote publication requires
owner authorization after review and a clean Node24 build. Inspect the fork's Actions
settings before pushing any release tag; never use an upstream `v*` tag for Dock.
Publish all assets and manifest/checksums as one immutable fork release; enable
release immutability and never replace assets at an existing version/URL. Pin Dock's direct SDK and TUI to
those exact assets and SRI, including its nested runtime install paths. Do not
retain registry Pi overrides or community companion packages. Candidates are only
for isolated development trees, never production dependencies.

Before changing the engine, first sync the pure upstream mirror, compare the
proposed fixed release with the current implementation branch, then replay needed
patches onto that release. Review `dock-release.json`, closure changes and the
model-data integrity before building a new cohort. Mirror synchronization alone
must not upgrade Dock.

After publishing all assets, download the reviewed release's `manifest.json` and run
the independent acceptance entry on Node24 (the output must be new, outside this
repository, with an existing parent):

```sh
PATH=/home/luziyi/.nvm/versions/node/v24.21.0/bin:$PATH \
  node scripts/verify-dock-release.mjs \
  --manifest /tmp/pi-dock-release/manifest.json \
  --out /tmp/pi-dock-release-verification
```

This entry accepts only clean `dock-v*` releases. Its consumer declares only the
actual SDK and TUI asset URLs, without overrides or a prebuilt consumer lock.
Normal `npm install --omit=dev --ignore-scripts` generates the lock; the entry checks
all installed Pi versions, embedded source provenance, dependency URLs and lock SRI,
one copy of each cohort package, every Pi dependency's resolved entry (including
SDK versus direct TUI), and non-Pi version/URL/SRI identities against the SDK's
embedded shrinkwrap. It then runs `npm ci` from the generated lock and repeats the
checks and SDK/TUI imports. HOME, XDG, Pi and npm configuration/cache are isolated;
no sessions or model requests are created. No compilation is performed.

Retain the copied manifest, consumer package/lock, npm logs and `verification.json`.
The receipt is written only after both phases pass. Manifest SRI is checked against
npm's installed lock; npm verifies downloaded tarball integrity. This does not
independently reproduce the source build or verify GitHub release immutability.
Until actual URLs are published and this command passes, normal remote install and
shrinkwrap behavior remain **unverified**. Do not repair a failing gate with overrides
or a seeded lock. Dock must not adopt a release that passes only the development
asset smoke. Verify the Linux nested Dock installation and Windows `npm ci` assembly
separately through their normal entry points.

Before release, run source checks and focused prompt-interface tests, Dock's SDK
upgrade gate, model/thinking persistence and error checks, same-package Worker and
nested Pi checks, and current plugin compatibility flows. Verify Linux and Windows
packaging use the cohort. The producer smoke does not prove native Windows
execution or official-client system-selection workflows. Rollback restores the
previous entire fixed cohort and Dock lockfile, without moving or rewriting native
Pi configuration or sessions.
