import { expect, test } from "bun:test";
import { releaseVersion } from "./release-version.ts";

test("release tags require strict semver and detect prereleases", () => {
	expect(releaseVersion("v1.2.3")).toEqual({
		version: "1.2.3",
		prerelease: false,
	});
	expect(releaseVersion("v1.2.3-rc.1+build.42")).toEqual({
		version: "1.2.3-rc.1+build.42",
		prerelease: true,
	});
	expect(releaseVersion("v1.2.3+build-with-hyphens").prerelease).toBe(false);
	for (const tag of [
		"1.2.3",
		"v1.2",
		"v01.2.3",
		"v1.2.3-01",
		"v1.2.3-",
		"v1.2.3+",
		"v1.2.3\n",
		"v1.2.3/evil",
	]) {
		expect(() => releaseVersion(tag)).toThrow("Invalid release tag");
	}
});
