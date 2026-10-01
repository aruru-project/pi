#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyFields, inspectCohortResolutions, inspectInstalledCohort, isolatedEnvironment, within } from "./dock-package-validation.mjs";
import { findPackageDirectories } from "./package-workspaces.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(root, "dock-release.json"), "utf8"));
const name = "@earendil-works/pi-coding-agent";
const args = process.argv.slice(2);
const candidate = args.includes("--candidate");
const outIndex = args.indexOf("--out");
if (args.includes("--help")) {
	console.log("Usage: node scripts/build-dock-package.mjs --out <new-directory> [--candidate]\nBuilds the fork runtime cohort with locked inputs on Node24+. --candidate permits dirty source; never publish it.\nRun `npm run hydrate:model-data` first to create the built-in model list.");
	process.exit(0);
}
if (outIndex < 0 || !args[outIndex + 1] || args.some((arg, index) => arg !== "--candidate" && arg !== "--out" && index !== outIndex + 1)) {
	throw new Error("Expected --out <new-directory> and optional --candidate");
}
const out = resolve(args[outIndex + 1]);
if (within(root, out) || existsSync(out)) throw new Error("Output must be a new directory outside the source repository");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function run(command, parameters, options = {}) {
	const result = spawnSync(command, parameters, {
		cwd: root, encoding: "utf8", shell: process.platform === "win32", timeout: 300_000,
		maxBuffer: 32 * 1024 * 1024, ...options,
	});
	if (result.status !== 0) throw new Error(`${command} ${parameters.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`);
	return result.stdout;
}
const git = (...parameters) => run("git", parameters).trim();
const paths = [".", ":!.pi-subagents"];
const sourceCommit = git("rev-parse", "HEAD");
assert.equal(git("rev-parse", `${config.upstream.tag}^{commit}`), config.upstream.commit);
git("merge-base", "--is-ancestor", config.upstream.commit, "HEAD");
const dirty = git("status", "--porcelain", "--untracked-files=all", "--", ...paths) !== "";
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 24) throw new Error("All cohort builds require Node >=24");
if (!candidate && dirty) throw new Error("Release build requires clean source; use --candidate only for unpublished development evidence");
const workspaces = new Map(findPackageDirectories(join(root, "packages")).map((directory) => {
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	return [manifest.name, { name: manifest.name, directory, manifest }];
}));
const cohort = new Map();
function visit(packageName, visiting = new Set()) {
	if (cohort.has(packageName)) return;
	assert.ok(!visiting.has(packageName), `Cyclic runtime dependency: ${packageName}`);
	const pkg = workspaces.get(packageName);
	assert.ok(pkg && !pkg.manifest.private, `Missing public runtime workspace: ${packageName}`);
	visiting.add(packageName);
	for (const field of dependencyFields) {
		for (const dependency of Object.keys(pkg.manifest[field] ?? {})) {
			if (workspaces.has(dependency)) visit(dependency, visiting);
			else assert.ok(!dependency.startsWith("@earendil-works/"), `Unknown Pi runtime dependency: ${dependency}`);
		}
	}
	visiting.delete(packageName);
	cohort.set(packageName, pkg);
}
for (const packageName of config.runtimeRoots) visit(packageName);
assert.ok(cohort.has(name), "Runtime roots must include coding-agent");
function sourceFingerprint() {
	const files = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...paths]).split("\0").filter(Boolean).sort();
	return hash(JSON.stringify(files.map((path) => [path, existsSync(join(root, path)) ? hash(readFileSync(join(root, path))) : null])));
}
const sourceSha256 = sourceFingerprint();
// Upstream 1.x publishes no npm-shrinkwrap.json. Its installer lock pins the third-party tree for
// a top-level coding-agent install; the local smoke installs from that lock, so it must be current.
run(process.execPath, [join(root, "scripts/generate-coding-agent-install-lock.mjs"), "--check"]);
const installLockBytes = readFileSync(join(root, "packages/coding-agent/install-lock/package-lock.json"));
const installLock = JSON.parse(installLockBytes.toString("utf8"));
// The built-in model list is generated data that upstream keeps out of git. Its content is not
// important (users refresh it with `aludock update model`); the build only needs a valid copy.
const modelDataManifest = join(root, "packages/ai/src/providers/data/.manifest.json");
if (!existsSync(modelDataManifest)) {
	throw new Error("The built-in model list is missing. Run `npm run hydrate:model-data` first (behind a proxy, set NODE_USE_ENV_PROXY=1).");
}
const modelDataBytes = readFileSync(modelDataManifest);
const modelData = { generatedAt: JSON.parse(modelDataBytes.toString("utf8")).generatedAt, manifestSha256: hash(modelDataBytes) };
const version = candidate ? `${config.version}.candidate.${sourceSha256.slice(0, 12)}` : config.version;
mkdirSync(out, { recursive: true });
const home = join(out, "home");
mkdirSync(home);
const env = isolatedEnvironment(home);
const inputs = join(out, "inputs");
mkdirSync(inputs);
// Save the uncommitted patch as well as its fingerprint so development candidates remain inspectable.
let patch = run("git", ["diff", "HEAD", "--binary", "--", ...paths]);
for (const path of run("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths]).split("\0").filter(Boolean)) {
	const diff = spawnSync("git", ["diff", "--no-index", "--binary", "--", "/dev/null", path], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	if (diff.status !== 1) throw new Error(`Could not capture new source file ${path}: ${diff.stderr}`);
	patch += diff.stdout;
}
writeFileSync(join(inputs, "source.patch"), patch);
run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { env, stdio: "inherit" });
// Upstream build:offline also compiles development-only build prerequisites.
// Only the manifest-derived runtime closure is packed for distribution.
for (const directory of findPackageDirectories(join(root, "packages"))) {
	if (existsSync(join(directory, "tsconfig.build.json"))) rmSync(join(directory, "dist"), { recursive: true, force: true });
}
run("npm", ["run", "build:offline"], { env, stdio: "inherit" });
// Keep Dock releases outside the upstream v* binary/npm publishing workflow.
const releaseTag = `dock-v${version}`;
const assetBase = `${config.repository}/releases/download/${releaseTag}`;
const filenameFor = (packageName) => `${packageName.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
const urlFor = (packageName) => `${assetBase}/${filenameFor(packageName)}`;
function rewriteDependencies(record) {
	for (const field of dependencyFields) {
		for (const dependency of Object.keys(record[field] ?? {})) {
			if (cohort.has(dependency)) record[field][dependency] = urlFor(dependency);
			else assert.ok(!dependency.startsWith("@earendil-works/"), `Unexpected Pi dependency: ${dependency}`);
		}
	}
}
function pack(directory, destination) {
	mkdirSync(destination, { recursive: true });
	const output = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], { cwd: directory, env }));
	const packed = Array.isArray(output) ? output[0] : Object.values(output)[0];
	return join(destination, packed.filename);
}
const provenance = {
	schemaVersion: 3, version, candidate, source: { repository: config.repository, commit: sourceCommit, dirty, sha256: sourceSha256 },
	release: { tag: releaseTag, assetBase }, runtimeRoots: config.runtimeRoots,
	upstream: config.upstream, engine: config.node,
	inputs: { sourcePatchSha256: hash(patch), modelData,
		packageLockSha256: hash(readFileSync(join(root, "package-lock.json"))),
		installLockSha256: hash(installLockBytes) },
	build: { node: process.version, npm: run("npm", ["--version"], { env }).trim(), platform: process.platform, arch: process.arch },
};
const artifacts = new Map();
for (const pkg of cohort.values()) {
	const original = pack(pkg.directory, join(out, "raw"));
	const stageDir = join(out, "stage", pkg.name.split("/")[1]);
	mkdirSync(stageDir, { recursive: true });
	run("tar", ["-xf", original, "-C", stageDir], { env });
	const stage = join(stageDir, "package");
	const manifestPath = join(stage, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	assert.equal(manifest.name, pkg.name);
	assert.equal(manifest.version, config.upstream.version);
	manifest.version = version;
	manifest.engines = { ...manifest.engines, node: config.node };
	manifest.repository = { ...manifest.repository, url: `git+${config.repository}.git` };
	rewriteDependencies(manifest);
	assert.ok(!existsSync(join(stage, "npm-shrinkwrap.json")), `Review any new runtime shrinkwrap before releasing: ${pkg.name}`);
	manifest.files.push("dock-provenance.json");
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	writeFileSync(join(stage, "dock-provenance.json"), `${JSON.stringify({ ...provenance, name: pkg.name }, null, 2)}\n`);
	if (pkg.name === name) {
		assert.equal(manifest.piConfig.configDir, ".pi");
		cpSync(join(root, "DOCK.md"), join(stage, "docs/dock-maintenance.md"));
	}
	const tarball = pack(stage, out);
	assert.equal(relative(out, tarball), filenameFor(pkg.name));
	const bytes = readFileSync(tarball);
	artifacts.set(pkg.name, { name: pkg.name, version, filename: relative(out, tarball), url: urlFor(pkg.name),
		sha256: hash(bytes), integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
		dependencies: Object.fromEntries(dependencyFields.filter((field) => manifest[field]).map((field) => [field, manifest[field]])) });
}
const consumer = join(out, "consumer");
mkdirSync(consumer);
const overrides = Object.fromEntries([...artifacts].map(([packageName, artifact]) => [packageName, `file:${join(out, artifact.filename)}`]));
const consumerManifest = { private: true, type: "module",
	dependencies: Object.fromEntries(config.runtimeRoots.map((packageName) => [packageName, overrides[packageName]])), overrides };
writeFileSync(join(consumer, "package.json"), `${JSON.stringify(consumerManifest, null, 2)}\n`);
// A plain install would re-resolve non-Pi transitive ranges. Seed the installer's locked
// tree, pointing its Pi entries at the local candidate files, and use ci.
const consumerLock = structuredClone(installLock);
delete consumerLock.name;
delete consumerLock.version;
consumerLock.packages[""] = { dependencies: consumerManifest.dependencies };
for (const packageName of artifacts.keys()) assert.ok(consumerLock.packages[`node_modules/${packageName}`], `Installer lock lacks ${packageName}`);
for (const [path, record] of Object.entries(consumerLock.packages)) {
	if (!path) continue;
	assert.equal(record.link, undefined, `No workspace link: ${path}`);
	const packageName = path.split("node_modules/").at(-1);
	rewriteDependencies(record);
	const artifact = artifacts.get(packageName);
	if (artifact) Object.assign(record, { version, resolved: overrides[packageName], integrity: artifact.integrity,
		engines: { ...record.engines, node: config.node } });
	else assert.ok(!packageName.startsWith("@earendil-works/"), `Unexpected Pi lock entry: ${path}`);
}
writeFileSync(join(consumer, "package-lock.json"), `${JSON.stringify(consumerLock, null, 2)}\n`);
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer, env, stdio: "inherit" });
const installedPackages = inspectInstalledCohort({ consumer, provenance, artifacts,
	lockedPackages: installLock.packages, resolvedFor: (artifact) => overrides[artifact.name] });
inspectCohortResolutions({ consumer, installedPackages, artifacts, runtimeRoots: config.runtimeRoots, env });
const installed = join(consumer, "node_modules", name);
const installedManifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
assert.equal(installedManifest.version, version);
assert.equal(installedManifest.engines.node, config.node);
assert.deepEqual(JSON.parse(readFileSync(join(installed, "dock-provenance.json"), "utf8")), { ...provenance, name });
const probe = join(consumer, "smoke-sdk.mjs");
writeFileSync(probe, `import assert from "node:assert/strict";
import { createAgentSession, DefaultResourceLoader, getCompactionPromptTemplates, getDefaultSystemPromptBody, parseDefaultSystemPromptBody, SessionManager, SettingsManager } from "${name}";
import { TuiMainScreen, Text } from "@earendil-works/pi-tui";
assert.equal(typeof TuiMainScreen, "function");
assert.equal(typeof Text, "function");
const body = getDefaultSystemPromptBody();
assert.equal(body.intro, "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.");
assert.deepEqual(parseDefaultSystemPromptBody(body), body);
const templates = getCompactionPromptTemplates();
assert.deepEqual(Object.keys(templates).sort(), ["summarize", "system", "turnPrefix", "update"]);
for (const text of Object.values(templates)) assert.ok(typeof text === "string" && text.length > 0);
assert.equal(SettingsManager.inMemory().getCacheWarmingMode(), "off");
body.intro = "Installed Dock candidate fixture.";
const selectedThinking = [];
const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, systemPromptResolver: () => ({kind: "default", body}), extensionFactories: [(pi) => { pi.on("model_select", (_event, ctx) => { selectedThinking.push(ctx.thinkingLevel); }); }] });
await loader.reload();
const { session } = await createAgentSession({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader: loader, sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory() });
try {
 assert.match(session.systemPrompt, /^Installed Dock candidate fixture\\.\\n\\n<tools>\\n/);
 session.setActiveToolsByName(["read"]);
 assert.match(session.systemPrompt, /^Installed Dock candidate fixture\\./);
 assert.match(session.systemPrompt, /- read:/);
 session.modelRuntime.registerProvider("dock-package-smoke", { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "unused-local-fixture", models: ["one", "two"].map((id) => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) });
 await session.setModel(session.modelRuntime.getModel("dock-package-smoke", "one"));
 session.setThinkingLevel("high");
 session.settingsManager.setDefaultThinkingLevel("low");
 selectedThinking.length = 0;
 await session.setModel(session.modelRuntime.getModel("dock-package-smoke", "two"), { preserveThinkingLevel: true });
 assert.equal(session.thinkingLevel, "high");
 assert.deepEqual(selectedThinking, ["high"]);
 assert.equal(session.settingsManager.getDefaultThinkingLevel(), "low");
} finally { session.dispose(); }
console.log("Installed SDK and direct TUI share one fork cohort; default body, resolver, tool rebuild, compaction prompts, cache warming off and model-selection preference passed");
`);
const sdkOutput = run(process.execPath, [probe], { cwd: consumer, env }).trim();
const cliOutput = run(process.execPath, [join(installed, installedManifest.bin.pi), "--version"], { cwd: consumer, env }).trim();
assert.equal(cliOutput, version);
assert.equal(sourceFingerprint(), sourceSha256, "Source changed during build; rebuild from stable inputs");
const receipt = { ...provenance, artifacts: [...artifacts.values()],
	validation: { node: process.version, node24: nodeMajor === 24, sdk: sdkOutput, cli: { entry: installedManifest.bin.pi, version: cliOutput }, installedPackages } };
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(receipt, null, 2)}\n`);
writeFileSync(join(out, "SHA256SUMS"), [...artifacts.values()].map((artifact) => `${artifact.sha256}  ${artifact.filename}\n`).join(""));
console.log(JSON.stringify(receipt, null, 2));
