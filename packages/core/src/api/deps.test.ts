import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TUNING } from "../contracts/types.ts";
import { defaultDeps, loadConfig } from "./deps.ts";

let home: string;
let cwd: string;

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "spatz-api-deps-"));
	home = join(root, "home");
	cwd = join(root, "proj");
	mkdirSync(home);
	mkdirSync(cwd);
});
afterEach(() => {
	rmSync(join(home, ".."), { recursive: true, force: true });
});

describe("loadConfig", () => {
	test("defaults: jev on, empty aliases/descriptions when files are missing, DEFAULT_TUNING", async () => {
		const c = await loadConfig({ env: {}, homeDir: home, cwd });
		expect(c).toEqual({
			jevEnabled: true,
			tuning: DEFAULT_TUNING,
			aliases: {},
			descriptions: {},
		});
	});

	test("SPATZ_NO_JEV=1 opts out", async () => {
		const c = await loadConfig({
			env: { SPATZ_NO_JEV: "1" },
			homeDir: home,
			cwd,
		});
		expect(c.jevEnabled).toBe(false);
	});

	test('<cwd>/.spatz.json {"jev": false} opts out', async () => {
		await Bun.write(join(cwd, ".spatz.json"), JSON.stringify({ jev: false }));
		const c = await loadConfig({ env: {}, homeDir: home, cwd });
		expect(c.jevEnabled).toBe(false);
	});

	test('<cwd>/.spatz.json {"jev": true} and broken JSON keep jev on', async () => {
		await Bun.write(join(cwd, ".spatz.json"), JSON.stringify({ jev: true }));
		expect((await loadConfig({ env: {}, homeDir: home, cwd })).jevEnabled).toBe(
			true,
		);
		await Bun.write(join(cwd, ".spatz.json"), "{nope");
		expect((await loadConfig({ env: {}, homeDir: home, cwd })).jevEnabled).toBe(
			true,
		);
	});

	test("reads ~/.spatz/aliases.json and descriptions.json", async () => {
		await Bun.write(
			join(home, ".spatz", "aliases.json"),
			JSON.stringify({ opus: "anthropic/claude-opus-5.5" }),
		);
		await Bun.write(
			join(home, ".spatz", "descriptions.json"),
			JSON.stringify({ "openai/gpt-6-sol": "solid all-rounder" }),
		);
		const c = await loadConfig({ env: {}, homeDir: home, cwd });
		expect(c.aliases).toEqual({ opus: "anthropic/claude-opus-5.5" });
		expect(c.descriptions).toEqual({ "openai/gpt-6-sol": "solid all-rounder" });
	});
});

describe("defaultDeps", () => {
	test("paths under <HOME>/.spatz and real seams", () => {
		const d = defaultDeps({ HOME: home }, cwd);
		expect(d.homeDir).toBe(home);
		expect(d.cwd).toBe(cwd);
		expect(d.dbPath).toBe(join(home, ".spatz", "spatz.db"));
		expect(d.openRouterCachePath).toBe(
			join(home, ".spatz", "openrouter-models.json"),
		);
		expect(typeof d.clock.now()).toBe("number");
		const r = d.random();
		expect(r >= 0 && r < 1).toBe(true);
		expect(d.newId()).toMatch(/^[0-9a-f-]{36}$/);
		expect(d.config).toBeUndefined();
	});

	test("jev is null when TYPESAFE_AI_API_KEY is unset", () => {
		expect(defaultDeps({ HOME: home }, cwd).jev).toBeNull();
	});

	test("jev client exists when TYPESAFE_AI_API_KEY is set (no network)", () => {
		const d = defaultDeps({ HOME: home, TYPESAFE_AI_API_KEY: "fake" }, cwd);
		expect(typeof d.jev?.systemOne).toBe("function");
	});

	test("openStore opens a working store", () => {
		const s = defaultDeps({ HOME: home }, cwd).openStore(":memory:");
		expect(s.getSuggestion("x")).toBeNull();
		s.dispose();
	});
});

test("project models override user models without changing Jev opt-out", async () => {
	await Bun.write(
		join(home, ".spatz/config.json"),
		JSON.stringify({ models: "gpt-6-luna" }),
	);
	expect((await loadConfig({ env: {}, homeDir: home, cwd })).models).toEqual({
		value: "gpt-6-luna",
		source: "user",
	});
	await Bun.write(
		join(cwd, ".spatz.json"),
		JSON.stringify({ jev: false, models: "claude-opus-5-5" }),
	);
	const cfg = await loadConfig({ env: {}, homeDir: home, cwd });
	expect(cfg.models).toEqual({ value: "claude-opus-5-5", source: "project" });
	expect(cfg.jevEnabled).toBe(false);
	await Bun.write(join(cwd, ".spatz.json"), JSON.stringify({ jev: false }));
	expect(
		(await loadConfig({ env: {}, homeDir: home, cwd })).models?.source,
	).toBe("user");
});

test.each(["{bad", "[]", "null"])(
	"ignores malformed optional config %s",
	async (text) => {
		await Bun.write(join(cwd, ".spatz.json"), text);
		await Bun.write(join(home, ".spatz/config.json"), text);
		expect(
			(await loadConfig({ env: {}, homeDir: home, cwd })).models,
		).toBeUndefined();
	},
);
