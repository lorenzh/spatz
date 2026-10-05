#!/usr/bin/env bun
import { createApi, defaultDeps, type SpatzApi } from "@spatz/core";
import { main } from "./main.ts";

// Lazy: the core is built on first call, so wiring errors flow through main's
// error handling (hook still exits 0) and usage errors never open the store.
let core: SpatzApi | undefined;
const api = () => (core ??= createApi(defaultDeps(process.env, process.cwd())));

const code = await main(
	process.argv.slice(2),
	{
		stdout: (text) => process.stdout.write(`${text}\n`),
		stderr: (text) => process.stderr.write(`${text}\n`),
		readStdin: () => Bun.stdin.text(),
	},
	{
		suggest: async (input) => api().suggest(input),
		usage: async (input) => api().usage(input),
		report: async (input) => api().report(input),
		handleHook: async (event, stdin) => api().handleHook(event, stdin),
		stats: async (input) => api().stats(input),
	},
);
process.exit(code);
