import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectCohortResolutions, inspectInstalledCohort, isolatedEnvironment } from "./dock-package-validation.mjs";

const script = fileURLToPath(new URL("./verify-dock-release.mjs", import.meta.url));
function temporary(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-release-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

test("CLI help and invalid arguments never start installation", (t) => {
	const cwd = temporary(t);
	const env = isolatedEnvironment(cwd);
	assert.equal(spawnSync(process.execPath, [script, "--help"], { cwd, env }).status, 0);
	for (const args of [[], ["--manifest", "missing"], ["--out", "one", "--out", "two"]]) {
		const result = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Expected --manifest/);
	}
});

test("normal manifest/out arguments reject old candidate or v* release before any install", (t) => {
	const cwd = temporary(t);
	const manifest = { schemaVersion: 3, candidate: true };
	const manifestPath = join(cwd, "manifest.json");
	const out = join(cwd, "output");
	const run = () => spawnSync(process.execPath, [script, "--manifest", manifestPath, "--out", out], { cwd, env: isolatedEnvironment(cwd), encoding: "utf8" });
	writeFileSync(manifestPath, JSON.stringify(manifest));
	assert.match(run().stderr, /Candidates are development evidence/);
	Object.assign(manifest, { candidate: false, source: { dirty: false, repository: "https://github.com/aruru-project/pi", commit: "a".repeat(40), sha256: "b".repeat(64) }, version: "0.85.1-dock.1", engine: ">=24.0.0", release: { tag: "v0.85.1-dock.1", assetBase: "https://github.com/aruru-project/pi/releases/download/v0.85.1-dock.1" } });
	writeFileSync(manifestPath, JSON.stringify(manifest));
	const result = run();
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /dock-v0.85.1-dock.1/);
	assert.equal(existsSync(out), false);
});

test("shared cohort check detects provenance, SRI, URL, non-Pi lock drift and duplicates", (t) => {
	const consumer = temporary(t);
	const name = "@earendil-works/pi-tui";
	const provenance = { version: "0.85.1-dock.1", engine: ">=24.0.0", source: { repository: "https://github.com/aruru-project/pi", sha256: "a".repeat(64) } };
	const artifact = { name, url: "https://github.com/aruru-project/pi/releases/download/dock-v0.85.1-dock.1/tui.tgz", integrity: "sha512-fixture", dependencies: { dependencies: { marked: "18.0.5" } } };
	const artifacts = new Map([[name, artifact]]);
	const directory = join(consumer, "node_modules", name);
	const pkg = { name, version: provenance.version, engines: { node: provenance.engine }, repository: { url: `git+${provenance.source.repository}.git` }, ...artifact.dependencies };
	const write = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data)); };
	write(join(directory, "package.json"), pkg);
	write(join(directory, "dock-provenance.json"), { ...provenance, name });
	write(join(consumer, "node_modules/marked/package.json"), { name: "marked", version: "18.0.5" });
	const lockedPackages = { "node_modules/marked": { version: "18.0.5", resolved: "https://registry.npmjs.org/marked/-/marked-18.0.5.tgz", integrity: "sha512-marked" } };
	const lock = { packages: { "": {}, [`node_modules/${name}`]: { version: provenance.version, resolved: artifact.url, integrity: artifact.integrity }, ...lockedPackages } };
	const lockPath = join(consumer, "package-lock.json");
	write(lockPath, lock);
	const check = () => inspectInstalledCohort({ consumer, provenance, artifacts, lockedPackages, resolvedFor: (value) => value.url });
	assert.equal(check().length, 1);
	for (const field of ["integrity", "resolved"]) {
		const changed = structuredClone(lock);
		changed.packages[`node_modules/${name}`][field] = "wrong";
		write(lockPath, changed);
		assert.throws(check);
	}
	const changed = structuredClone(lock);
	changed.packages["node_modules/marked"].integrity = "wrong";
	write(lockPath, changed);
	assert.throws(check, /Non-Pi dependency left engine lock/);
	write(lockPath, lock);
	write(join(directory, "dock-provenance.json"), { ...provenance, name, source: {} });
	assert.throws(check);
	write(join(directory, "dock-provenance.json"), { ...provenance, name });
	const nested = join(directory, "node_modules", name);
	write(join(nested, "package.json"), pkg);
	write(join(nested, "dock-provenance.json"), { ...provenance, name });
	lock.packages[`node_modules/${name}/node_modules/${name}`] = lock.packages[`node_modules/${name}`];
	write(lockPath, lock);
	assert.throws(check, /Exactly one installed copy/);
	rmSync(join(directory, "node_modules"), { recursive: true });
	const external = temporary(t);
	write(join(external, "package.json"), { name: "external", version: "1" });
	symlinkSync(external, join(consumer, "node_modules/external"), "dir");
	assert.throws(check, /resolves outside consumer/);
});

test("normal consumers record their third-party resolution instead of copying the producer build tree", (t) => {
	const consumer = temporary(t);
	const directory = join(consumer, "node_modules", "ordinary-lib");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "ordinary-lib", version: "2.0.0" }));
	const record = { version: "2.0.0", resolved: "https://registry.npmjs.org/ordinary-lib/-/ordinary-lib-2.0.0.tgz", integrity: "sha512-fixture" };
	const lock = { packages: { "": {}, "node_modules/ordinary-lib": record } };
	const save = () => writeFileSync(join(consumer, "package-lock.json"), JSON.stringify(lock));
	save();
	const options = { consumer, provenance: {}, artifacts: new Map(), resolvedFor: () => "unused" };
	assert.deepEqual(inspectInstalledCohort(options), []);
	assert.throws(() => inspectInstalledCohort({ ...options, lockedPackages: { "node_modules/ordinary-lib": { ...record, version: "1.0.0" } } }), /Non-Pi dependency left engine lock/);
	delete record.integrity;
	save();
	assert.throws(() => inspectInstalledCohort(options), /Dependency integrity is not recorded/);
});

test("Pi SDK and TUI import-only exports resolve from their real ESM importers", (t) => {
	// Card 271: createRequire.resolve rejects Pi's import-only SDK exports.
	const consumer = temporary(t);
	const sdk = "@earendil-works/pi-coding-agent", tui = "@earendil-works/pi-tui";
	const artifacts = new Map([[sdk, { dependencies: { dependencies: { [tui]: "fixture" } } }], [tui, { dependencies: {} }]]);
	const installedPackages = [sdk, tui].map((name) => {
		const path = `node_modules/${name}`;
		mkdirSync(join(consumer, path), { recursive: true });
		writeFileSync(join(consumer, path, "package.json"), JSON.stringify({ name, type: "module", exports: { ".": { import: "./index.js" } } }));
		writeFileSync(join(consumer, path, "index.js"), "export {};\n");
		return { name, path };
	});
	inspectCohortResolutions({ consumer, installedPackages, artifacts, runtimeRoots: [sdk, tui], env: isolatedEnvironment(consumer) });
});

test("environment excludes inherited credentials, npm settings and Node preload hooks", () => {
	const env = isolatedEnvironment("/tmp/isolated-pi-release");
	assert.equal(env.PI_OFFLINE, "1");
	assert.equal(env.PI_TELEMETRY, "0");
	assert.equal(env.NODE_OPTIONS, undefined);
	assert.equal(env.OPENAI_API_KEY, undefined);
	assert.equal(env.npm_config_userconfig, "/tmp/isolated-pi-release/npmrc");
});

test("public release downloads retain the existing proxy route without inheriting provider keys", () => {
	// Card 271: removing proxy routing made npm's real GitHub-asset download time out.
	const previous = process.env.HTTPS_PROXY;
	try {
		process.env.HTTPS_PROXY = "http://127.0.0.1:1234";
		const env = isolatedEnvironment("/tmp/isolated-pi-release");
		assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:1234");
		assert.equal(env.OPENAI_API_KEY, undefined);
	} finally {
		if (previous === undefined) delete process.env.HTTPS_PROXY;
		else process.env.HTTPS_PROXY = previous;
	}
});
