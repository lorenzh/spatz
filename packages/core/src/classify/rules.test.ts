import { describe, expect, test } from "bun:test";
import { classifyByRules, containsSecret } from "./rules.ts";

describe("classifyByRules", () => {
	test("returns the fixed fallback values and keeps the reason", () => {
		expect(classifyByRules("Rename a variable", "timeout")).toEqual({
			task_type: "other",
			difficulty: "medium",
			criticality: "none",
			best_candidate: null,
			probabilities: null,
			model_ref: null,
			fallback_used: true,
			fallback_reason: "timeout",
		});
	});

	test.each([
		["Fix the OAuth login redirect", "security"],
		["Check permission for admins", "security"],
		["Rotate the API token", "security"],
		["Store the secret in the vault", "security"],
		["Passwort-Feld prüfen", "security"],
		["Anmeldung schlägt fehl", "security"],
		["Berechtigungen für Gäste", "security"],
		["Write a migration for the users table", "data_integrity"],
		["Delete old rows nightly", "data_integrity"],
		["Restore the backup", "data_integrity"],
		["Prevent data loss on crash", "data_integrity"],
		["Alte Einträge löschen", "data_integrity"],
		["Schutz vor Datenverlust", "data_integrity"],
		["Fix the payment webhook", "business_logic"],
		["Update the price table", "business_logic"],
		["Billing cycle is off by one day", "business_logic"],
		["Generate the invoice PDF", "business_logic"],
		["Contract renewal date", "business_logic"],
		["Zahlung wird doppelt gebucht", "business_logic"],
		["Preise runden", "business_logic"],
		["Abrechnung pro Monat", "business_logic"],
		["Vertrag kündigen", "business_logic"],
		["Verträge prüfen", "business_logic"],
		["Passwörter zurücksetzen", "security"],
		["Kennwörter rotieren", "security"],
		["Fix the auth middleware", "security"],
		["Geheimnis im Code entfernen", "security"],
		["Kennwort ändern", "security"],
		["Sicherung einspielen", "data_integrity"],
		["Rechnung erstellen", "business_logic"],
		["Fix the off-by-one in the pagination helper", "none"],
	])("%p -> %p", (task, criticality) => {
		expect(classifyByRules(task, "error").criticality).toBe(
			criticality as never,
		);
	});
});

describe("containsSecret", () => {
	test.each([
		["use sk-abcdefghijklmnopqrstuvwxyz123 for the call"],
		["key AKIAIOSFODNN7EXAMPLE in config"],
		["-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----"],
		["-----BEGIN PRIVATE KEY-----"],
		["login with password=hunter2"],
		["PASSWORD = s3cret"],
		[`key sk-${"a".repeat(20)} end`],
		[`push with ghp_${"A1b2".repeat(9)}`],
		[`token gho_${"x".repeat(36)}`],
		[`github_pat_${"a1B2c3D4e5".repeat(3)}`],
		[`gitlab glpat-${"a".repeat(20)}`],
		["slack xoxb-1234567890-abcdefghij"],
		[`google AIza${"b".repeat(35)}`],
		[`stripe sk_live_${"c".repeat(24)}`],
		[`npm token npm_${"d".repeat(36)}`],
		["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig"],
		['config {"password":"hunter2"}'],
		["config { 'api_key': 'abc123' }"],
		['password: "hunter2"'],
		['client_secret = "abc"'],
		["DB_PASSWORD=hunter2 bun run x"],
	])("true for %p", (text) => {
		expect(containsSecret(text)).toBe(true);
	});

	test.each([
		["fix the password reset form"],
		["sk-short"],
		[`key sk-${"a".repeat(19)} end`],
		["AKIA is a prefix"],
		["Refactor the pagination helper"],
		["password: field label in the login form"],
		["Rotate the GitHub token ghp_ prefix docs"],
		["max_tokens: 100"],
	])("false for %p", (text) => {
		expect(containsSecret(text)).toBe(false);
	});
});
