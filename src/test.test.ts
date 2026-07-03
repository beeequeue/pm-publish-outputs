// oxlint-disable vitest/expect-expect
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import { stripVTControlCharacters as removeAnsi, parseEnv } from "node:util"
import path from "path"

import { inc } from "semver"
import { x } from "tinyexec"
import type { Options, Output } from "tinyexec"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import testPackageManifest from "../test-package/package.json" with { type: "json" }

const requiredTokens = [
	// can only read the testing package
	"NPM_READONLY_TOKEN",
	// can read+write but does not have 2fa bypass
	"NPM_WRITE_NO_BYPASS_TOKEN",
	// can read+write and has 2fa bypass
	"NPM_WRITE_WITH_BYPASS_TOKEN",
] as const
type Env = Record<(typeof requiredTokens)[number], string>

const readEnvFile = async (): Promise<Env> => {
	if (!existsSync(".env")) throw new Error(".env file not found")

	let env: Record<string, unknown>
	try {
		const contents = await fs.readFile(path.resolve(import.meta.dirname, "..", ".env"), "utf8")
		env = parseEnv(contents)
	} catch (e) {
		throw new Error("Failed to read .env file", { cause: e })
	}

	for (const name of requiredTokens) {
		if (env[name] == null) {
			throw new Error(`Missing required token: ${name}`)
		}
	}

	return env as Env
}

const env = await readEnvFile()

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/")

const cleanOutput = (output: string) =>
	normalizePathSeparators(output)
		.replace(/\\\\/g, "/")
		// remove package name
		.replace(new RegExp(testPackageManifest.name.replace("/", ".+?"), "g"), "[pkg-name]")
		// remove package version 1
		.replace(
			new RegExp(testPackageManifest.version.replace(/\./g, "\\."), "g"),
			"[current-version]",
		)
		// remove package version 2
		.replace(
			new RegExp(inc(testPackageManifest.version, "patch")!.replace(/\./g, "\\."), "g"),
			"[next-version]",
		)
		// redact machine-specific npm cache path
		.replace(/in: .*?\/\.?npm\/_logs\//, "in: [npm-cache]/npm/_logs/")
		// normalize redacted npm auth URLs
		.replace(/auth\/cli\/(?:[a-z0-9-]{36}|\*\*\*)/g, "auth/cli/[uuid]")
		.replace(/authId=(?:[a-z0-9-]{36}|\*\*\*)/g, "authId=[uuid]")
		// redact dates
		.replace(/\d{4}-\d{1,2}-\d{1,2}/g, "[date]")
		// redact times
		.replace(/\d{1,2}[:_-]\d{1,2}[:_-]\d{1,2}(?:[:_-]\d{3})?Z?/g, "[time]")
		// redact uuids (used in npm auth URLs)
		.replace(/[a-z0-9]{8}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{12}/g, "[uuid]")
		// redact npm tokens
		.replace(/npm_\w+?/g, "[npm token]")
		// redact github tokens
		.replace(/gh.?_\w+?]/g, "[gh token]")

function assertMatchesSnapshot(result: Output) {
	expect({
		code: result.exitCode,
		stdout: removeAnsi(cleanOutput(result.stdout)),
		stderr: removeAnsi(cleanOutput(result.stderr)),
	}).toMatchSnapshot()
}

const testPackageDir = path.resolve(import.meta.dirname, "../test-package")
const execOptions = (tty: "tty" | "no-tty" = "no-tty"): Partial<Options> => ({
	nodeOptions: {
		stdio: tty === "tty" ? "inherit" : "pipe",
		cwd: testPackageDir,
	},
})

const instances = {
	pnpm: ["10", "11"],
	npm: ["10", "11"],
	yarn: ["4"],
} as const

const yarnScopeMatch = /^@([^/]+)\//.exec(testPackageManifest.name)
const yarnAuthConfig = (token?: string) => {
	const registryLines = [
		'nodeLinker: "pnpm"',
		`npmPublishRegistry: "https://registry.npmjs.org"`,
		`npmRegistryServer: "https://registry.npmjs.org"`,
	]
	const authLines =
		token == null ? [] : [`npmAlwaysAuth: true`, `npmAuthToken: ${JSON.stringify(token)}`]

	if (yarnScopeMatch == null) {
		return [
			...registryLines,
			...authLines,
			"",
		].join("\n")
	}

	return [
		""
		"npmScopes:",
		`  ${JSON.stringify(yarnScopeMatch[1])}:`,
		...registryLines.map(line => `    ${line}`),
		...authLines.map(line => `    ${line}`),
		"",
	].join("\n")
}

const homeDir = process.env.HOME ?? process.env.userprofile!
const pmFuncs = {
	pnpm: {
		reset: async () =>
			await Promise.all([
				fs.rm(path.join(homeDir, ".npmrc"), { force: true }),
				fs.rm(path.join(homeDir, ".config", "pnpm", "auth.ini"), { force: true }),
				fs.rm(path.join(testPackageDir, ".npmrc"), { force: true }),
			]),
		login: async (token: string) => {
			await fs.writeFile(path.join(homeDir, ".npmrc"), `//registry.npmjs.org/:_authToken=${token}`)
		},
	},
	npm: {
		reset: async () =>
			await Promise.all([
				fs.rm(path.join(homeDir, ".npmrc"), { force: true }),
				fs.rm(path.join(testPackageDir, ".npmrc"), { force: true }),
			]),
		login: async (token: string) => {
			await fs.writeFile(
				path.join(testPackageDir, ".npmrc"),
				`//registry.npmjs.org/:_authToken=${token}`,
			)
		},
	},
	yarn: {
		reset: async () => {
			await Promise.all([
				fs.rm(path.join(homeDir, ".yarnrc.yml"), { force: true }),
				fs.rm(path.join(testPackageDir, ".yarn"), { force: true, recursive: true }),
				fs.rm(path.join(testPackageDir, ".yarnrc.yml"), { force: true }),
			])
			await fs.writeFile(path.join(testPackageDir, ".yarnrc.yml"), yarnAuthConfig())
		},
		login: async (token: string) => {
			await fs.writeFile(path.join(testPackageDir, ".yarnrc.yml"), yarnAuthConfig(token))
		},
	},
} as const

async function updateTestManifest(fn: (manifest: { version: string }) => void) {
	const filePath = path.join(testPackageDir, "package.json")
	const data = JSON.parse(await fs.readFile(filePath, "utf8"))
	fn(data)
	await fs.writeFile(filePath, JSON.stringify(data, null, 2))
}

const resetTestManifestVersion = async () =>
	updateTestManifest((manifest) => {
		manifest.version = testPackageManifest.version
	})

const bumpTestManifest = async () =>
	updateTestManifest((manifest) => {
		manifest.version = inc(manifest.version, "patch")!
	})

beforeEach(async () => {
	await resetTestManifestVersion()
	await pmFuncs.npm.reset()
	await pmFuncs.pnpm.reset()
})

for (const key in instances) {
	const pmName = key as keyof typeof instances
	for (const version of instances[pmName]) {
		describe(`${pmName}@${version}`, async () => {
			it("1. publish need-login (noTTY)", async () => {
				await bumpTestManifest()

				const args = publishArgs[pmName](version)
				const result = await x(args[0]!, args.slice(1), execOptions())

				assertMatchesSnapshot(result)
			})

			it("2. publish not allowed (noTTY)", async () => {
				await bumpTestManifest()
				await pmFuncs[pmName].login(env.NPM_READONLY_TOKEN)

				const args = publishArgs[pmName](version)
				const result = await x(args[0]!, args.slice(1), execOptions())

				assertMatchesSnapshot(result)
			})

			it("3. publish need-2fa (noTTY)", async () => {
				await bumpTestManifest()
				await pmFuncs[pmName].login(env.NPM_WRITE_NO_BYPASS_TOKEN)

				const args = publishArgs[pmName](version)
				const result = await x(args[0]!, args.slice(1), execOptions())

				assertMatchesSnapshot(result)
			})

			it("4. publish already-published (noTTY)", async () => {
				await resetTestManifestVersion()
				await pmFuncs[pmName].login(env.NPM_WRITE_WITH_BYPASS_TOKEN)

				const args = publishArgs[pmName](version)
				const result = await x(args[0]!, args.slice(1), execOptions())

				assertMatchesSnapshot(result)
			})
		})
	}
}
