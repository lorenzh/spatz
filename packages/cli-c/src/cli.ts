#!/usr/bin/env bun
import { run } from "./index.ts";

try {
	console.log(run(process.argv.slice(2)));
} catch (error) {
	console.error((error as Error).message);
	process.exit(1);
}
