import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"];

export function within(parent, path) {
	const part = relative(parent, path);
	return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

export function isolatedEnvironment(home) {
	const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
		XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
		XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_RUNTIME_DIR: join(home, "run"),
		TMPDIR: home, TMP: home, TEMP: home, PI_CODING_AGENT_DIR: join(home, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0",
		npm_config_cache: join(home, "npm-cache"), npm_config_userconfig: join(home, "npmrc"),
		npm_config_globalconfig: join(home, "global-npmrc") };
	for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "ComSpec", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
	return env;
}

/** Check ESM resolution from each actual importer; Pi SDK entries need not export require. */
export function inspectCohortResolutions({ consumer, installedPackages, artifacts, runtimeRoots, env }) {
	const resolveAt = (directory, names) => {
		const probe = join(directory, `.dock-resolution-${randomUUID()}.mjs`);
		writeFileSync(probe, `import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(name => [name, realpathSync(fileURLToPath(import.meta.resolve(name)))]))));
`, { flag: "wx", mode: 0o600 });
		try {
			const result = spawnSync(process.execPath, [probe], { cwd: consumer, env, encoding: "utf8", timeout: 10_000 });
			assert.equal(result.status, 0, `ESM resolution failed in ${directory}: ${result.stderr ?? result.error?.message ?? ""}`);
			return JSON.parse(result.stdout);
		} finally { unlinkSync(probe); }
	};
	const entries = new Map();
	const resolutions = new Map();
	for (const pkg of installedPackages) {
		const dependencies = new Set([pkg.name]);
		for (const field of dependencyFields) {
			for (const dependency of Object.keys(artifacts.get(pkg.name).dependencies[field] ?? {})) {
				if (artifacts.has(dependency)) dependencies.add(dependency);
			}
		}
		const resolved = resolveAt(join(consumer, pkg.path), [...dependencies]);
		entries.set(pkg.name, resolved[pkg.name]);
		resolutions.set(pkg.name, resolved);
	}
	for (const [name, path] of Object.entries(resolveAt(consumer, runtimeRoots))) assert.equal(path, entries.get(name));
	for (const [importer, resolved] of resolutions) {
		for (const [name, path] of Object.entries(resolved)) assert.equal(path, entries.get(name), `${importer} must share ${name}`);
	}
}

// Shared by the local asset smoke and the normal remote npm install/ci gate.
// npm owns lock generation and dependency placement; this only checks its result.
export function inspectInstalledCohort({ consumer, provenance, artifacts, lockedPackages, resolvedFor }) {
	const installedLock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
	const installedPackages = [];
	function inspectInstalled(nodeModules) {
		if (!existsSync(nodeModules)) return;
		for (const entry of readdirSync(nodeModules)) {
			if (entry.startsWith(".")) continue;
			const directories = entry.startsWith("@") ? readdirSync(join(nodeModules, entry)).map((child) => join(nodeModules, entry, child)) : [join(nodeModules, entry)];
			for (const directory of directories) {
				const real = realpathSync(directory);
				assert.ok(within(consumer, real), `Installed dependency resolves outside consumer: ${directory}`);
				if (!existsSync(join(real, "package.json"))) continue;
				const pkg = JSON.parse(readFileSync(join(real, "package.json"), "utf8"));
				const installedPath = relative(consumer, real).replaceAll("\\", "/");
				assert.equal(pkg.version, installedLock.packages[installedPath]?.version, `Installed bytes must match locked version: ${installedPath}`);
				if (pkg.name.startsWith("@earendil-works/")) {
					const artifact = artifacts.get(pkg.name);
					assert.ok(artifact, `Unused Pi package installed: ${pkg.name}`);
					assert.equal(pkg.version, provenance.version, pkg.name);
					assert.equal(pkg.engines.node, provenance.engine, pkg.name);
					assert.equal(pkg.repository.url, `git+${provenance.source.repository}.git`, pkg.name);
					assert.deepEqual(JSON.parse(readFileSync(join(real, "dock-provenance.json"), "utf8")), { ...provenance, name: pkg.name });
					assert.deepEqual(Object.fromEntries(dependencyFields.filter((field) => pkg[field]).map((field) => [field, pkg[field]])), artifact.dependencies, pkg.name);
					installedPackages.push({ name: pkg.name, version: pkg.version, path: relative(consumer, real) });
				}
				inspectInstalled(join(real, "node_modules"));
			}
		}
	}
	inspectInstalled(join(consumer, "node_modules"));
	assert.deepEqual(installedPackages.map((pkg) => pkg.name).sort(), [...artifacts.keys()].sort(), "Exactly one installed copy of every runtime Pi package");
	for (const [path, record] of Object.entries(installedLock.packages)) {
		if (!path) continue;
		assert.equal(record.link, undefined, path);
		const packageName = path.split("node_modules/").at(-1);
		const artifact = artifacts.get(packageName);
		if (artifact) {
			assert.equal(record.version, provenance.version, path);
			assert.equal(record.integrity, artifact.integrity, path);
			assert.equal(record.resolved, resolvedFor(artifact), path);
		} else {
			assert.ok(!packageName.startsWith("@earendil-works/"), path);
			assert.ok(Object.entries(lockedPackages).some(([lockedPath, locked]) =>
				lockedPath.split("node_modules/").at(-1) === packageName && locked.version === record.version &&
				locked.resolved === record.resolved && locked.integrity === record.integrity), `Non-Pi dependency left engine lock: ${path}`);
		}
	}
	return installedPackages;
}
