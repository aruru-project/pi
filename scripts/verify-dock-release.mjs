#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyFields, inspectCohortResolutions, inspectInstalledCohort, isolatedEnvironment, within } from "./dock-package-validation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = "@earendil-works/pi-coding-agent";
const tui = "@earendil-works/pi-tui";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
	console.log("Usage: node scripts/verify-dock-release.mjs --manifest <manifest.json> --out <new-directory>\nNode24 only. Installs published SDK/TUI URLs without overrides or a seeded lock, then verifies npm ci. No models are called.");
	process.exit(0);
}
assert.equal(process.versions.node.split(".")[0], "24", "Release verification requires Node24");
assert.equal(args.length, 4, "Expected --manifest <manifest.json> --out <new-directory>");
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
	assert.ok(["--manifest", "--out"].includes(args[index]) && !options.has(args[index]) && !args[index + 1].startsWith("--"), "Expected --manifest <manifest.json> --out <new-directory>");
	options.set(args[index], args[index + 1]);
}
const out = resolve(options.get("--out"));
// Requiring an existing parent lets realpath reject symlink aliases into the repo.
assert.ok(!existsSync(out) && !within(realpathSync(root), join(realpathSync(dirname(out)), out.split(/[\\/]/).at(-1))), "Output must be a new directory outside the source repository, with an existing parent");
const manifestBytes = readFileSync(resolve(options.get("--manifest")));
const manifest = JSON.parse(manifestBytes);
const { artifacts: artifactList, validation: _developmentValidation, ...provenance } = manifest;
assert.equal(provenance.schemaVersion, 2);
assert.equal(provenance.candidate, false, "Candidates are development evidence, not releases");
assert.equal(provenance.source.dirty, false, "Release source must be clean");
assert.match(provenance.source.commit, /^[a-f0-9]{40}$/);
assert.match(provenance.source.sha256, /^[a-f0-9]{64}$/);
assert.match(provenance.version, /^\d+\.\d+\.\d+-dock\.\d+$/);
assert.equal(provenance.source.repository, "https://github.com/aruru-project/pi");
assert.equal(provenance.engine, ">=24.0.0");
assert.deepEqual(provenance.release, { tag: `dock-v${provenance.version}`, assetBase: `${provenance.source.repository}/releases/download/dock-v${provenance.version}` });
assert.deepEqual([...provenance.runtimeRoots].sort(), [sdk, tui].sort());
const artifacts = new Map(artifactList.map((artifact) => [artifact.name, artifact]));
assert.equal(artifacts.size, artifactList.length, "Duplicate manifest artifacts");
for (const artifact of artifacts.values()) {
	assert.match(artifact.name, /^@earendil-works\/[a-z0-9-]+$/);
	assert.equal(artifact.version, provenance.version);
	assert.equal(artifact.filename, `${artifact.name.replace(/^@/, "").replaceAll("/", "-")}-${provenance.version}.tgz`);
	assert.equal(artifact.url, `${provenance.release.assetBase}/${artifact.filename}`);
	assert.match(artifact.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
	assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
}
const visited = new Set();
function visit(name) {
	if (visited.has(name)) return;
	const artifact = artifacts.get(name);
	assert.ok(artifact, `Missing runtime artifact: ${name}`);
	visited.add(name);
	for (const field of dependencyFields) {
		for (const [dependency, spec] of Object.entries(artifact.dependencies[field] ?? {})) {
			if (!dependency.startsWith("@earendil-works/")) continue;
			assert.equal(spec, artifacts.get(dependency)?.url, `Pi dependency must use its cohort URL: ${dependency}`);
			visit(dependency);
		}
	}
}
for (const name of provenance.runtimeRoots) visit(name);
assert.equal(visited.size, artifacts.size, "Manifest includes unused Pi packages");
mkdirSync(out);
const home = join(out, "home");
const consumer = join(out, "consumer");
mkdirSync(home);
mkdirSync(consumer);
const env = isolatedEnvironment(home);
writeFileSync(env.npm_config_userconfig, "");
writeFileSync(env.npm_config_globalconfig, "");
writeFileSync(join(out, "manifest.json"), manifestBytes);
const consumerManifest = { private: true, type: "module", dependencies: Object.fromEntries(provenance.runtimeRoots.map((name) => [name, artifacts.get(name).url])) };
writeFileSync(join(consumer, "package.json"), `${JSON.stringify(consumerManifest, null, 2)}\n`);
function run(command, parameters) {
	const result = spawnSync(command, parameters, { cwd: consumer, env, encoding: "utf8", shell: process.platform === "win32" && command === "npm", timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
	writeFileSync(join(out, `${command === "npm" ? parameters[0] : "imports"}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`);
	assert.equal(result.status, 0, `${command} ${parameters.join(" ")} failed; see logs in ${out}`);
	return result.stdout.trim();
}
const probe = join(consumer, "imports.mjs");
writeFileSync(probe, `import assert from "node:assert/strict";
import { createAgentSession } from "${sdk}";
import { TuiMainScreen, Text } from "${tui}";
assert.equal(typeof createAgentSession, "function");
assert.equal(typeof TuiMainScreen, "function");
assert.equal(typeof Text, "function");
console.log("SDK and TUI imports passed; no session or model calls");
`);
const phases = [];
for (const command of ["install", "ci"]) {
	if (command === "install") assert.ok(!existsSync(join(consumer, "package-lock.json")), "Do not seed the consumer lock");
	run("npm", [command, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
	const shrinkwrap = JSON.parse(readFileSync(join(consumer, "node_modules", sdk, "npm-shrinkwrap.json"), "utf8"));
	assert.equal(shrinkwrap.version, provenance.version);
	for (const [path, record] of Object.entries(shrinkwrap.packages)) {
		const artifact = artifacts.get(path.split("node_modules/").at(-1));
		if (artifact) {
			assert.equal(record.version, artifact.version, path);
			assert.equal(record.resolved, artifact.url, path);
			assert.equal(record.integrity, artifact.integrity, path);
		}
	}
	const installedPackages = inspectInstalledCohort({ consumer, provenance, artifacts, lockedPackages: shrinkwrap.packages, resolvedFor: (artifact) => artifact.url });
	inspectCohortResolutions({ consumer, installedPackages, artifacts, runtimeRoots: provenance.runtimeRoots, env });
	const imports = run(process.execPath, [probe]);
	const lockSha256 = createHash("sha256").update(readFileSync(join(consumer, "package-lock.json"))).digest("hex");
	if (phases.length) assert.equal(lockSha256, phases[0].lockSha256, "npm ci changed the generated lock");
	phases.push({ command, lockSha256, installedPackages, imports });
}
const receipt = { manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"), version: provenance.version, node: process.version, npm: run("npm", ["--version"]), phases };
writeFileSync(join(out, "verification.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`Release install and ci verified: ${join(out, "verification.json")}`);
