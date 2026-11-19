import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPinnedModelCatalog } from "./update-model-catalog-pin.mjs";

// 2026-11-15: the Dock producer accepted live-generated model data alongside
// a fixed Pi release, breaking that release's model-dependent checks.
test("Dock reads the committed model snapshot online or offline without changing its pin", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "dock-model-catalog-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "nix"));
	const bytes = Buffer.from('{"fixture":[]}\n');
	const revision = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
	const pin = JSON.stringify({ revision });
	await writeFile(join(root, "nix/model-catalog.json"), pin);
	const originalFetch = globalThis.fetch;
	context.after(() => { globalThis.fetch = originalFetch; });
	const urls = [];
	globalThis.fetch = async (url) => {
		urls.push(String(url));
		return new Response(bytes);
	};
	const downloaded = await readPinnedModelCatalog(root);
	assert.equal(downloaded.revision, revision);
	assert.equal(Buffer.compare(downloaded.bytes, bytes), 0);
	assert.deepEqual(urls, [`https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`]);

	const local = join(root, "snapshot.json");
	await writeFile(local, bytes);
	globalThis.fetch = async () => assert.fail("an explicit offline snapshot does not need the network");
	const offline = await readPinnedModelCatalog(root, local);
	assert.equal(Buffer.compare(offline.bytes, bytes), 0);
	await writeFile(local, '{"another-snapshot":[]}');
	await assert.rejects(readPinnedModelCatalog(root, local), /does not match the pinned revision/);
	assert.equal(await readFile(join(root, "nix/model-catalog.json"), "utf8"), pin);
});
