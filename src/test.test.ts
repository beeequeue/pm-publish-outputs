// oxlint-disable vitest/expect-expect
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import { stripVTControlCharacters as removeAnsi, parseEnv } from "node:util"
import path from "path"

import { inc } from "semver"
import { x } from "tinyexec"
import type { Options, Output } from "tinyexec"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

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

const redactOutput = (output: string) =>
	output
		// fix path separators
		.replace(/\\\\/g, "/")
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
		stdout: removeAnsi(redactOutput(result.stdout)),
		stderr: removeAnsi(redactOutput(result.stderr)),
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
	// yarn: ["3", "4"],
} as const

const keep = new Set(["pnpm@11"])

const allInstances = new Set(
	Object.keys(instances).flatMap((pmName) => {
		const versions = instances[pmName as keyof typeof instances]
		return versions.map((version) => `${pmName}@${version}`)
	}),
)

async function initPackageManagers() {
	const versionsToInstall = allInstances.difference(keep)
	await x("mise", ["install", ...versionsToInstall], { throwOnError: true })

	return async () => {
		const versionsToUninstall = allInstances.difference(keep)

		const result = await x("mise", ["uninstall", "-y", ...versionsToUninstall])
		if (result.exitCode !== 0) {
			throw new Error("Failed to uninstall:\n" + result.stderr)
		}
	}
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
} as const

async function updateTestManifest(fn: (manifest: { version: string }) => void) {
	const filePath = path.join(testPackageDir, "package.json")
	const data = JSON.parse(await fs.readFile(filePath, "utf8"))
	fn(data)
	await fs.writeFile(filePath, JSON.stringify(data, null, 2))
}

const resetTestManifestVersion = async () =>
	updateTestManifest((manifest) => {
		manifest.version = "0.0.3"
	})

const bumpTestManifest = async (type: "patch" | "minor" | "major" = "patch") =>
	updateTestManifest((manifest) => {
		manifest.version = inc(manifest.version, type)!
	})

let cleanup = await initPackageManagers()

afterAll(async () => {
	await cleanup()
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

				const result = await x(
					"mise",
					["exec", `${pmName}@${version}`, "--", pmName, "publish", "--json", "--no-git-checks"],
					execOptions(),
				)

				assertMatchesSnapshot(result)
			})

			it("2. publish not allowed (noTTY)", async () => {
				await bumpTestManifest()
				await pmFuncs[pmName].login(env.NPM_READONLY_TOKEN)

				const result = await x(
					"mise",
					["exec", `${pmName}@${version}`, "--", pmName, "publish", "--json", "--no-git-checks"],
					execOptions(),
				)

				assertMatchesSnapshot(result)
			})

			it("3. publish need-2fa (noTTY)", async () => {
				await bumpTestManifest()
				await pmFuncs[pmName].login(env.NPM_WRITE_NO_BYPASS_TOKEN)

				const result = await x(
					"mise",
					["exec", `${pmName}@${version}`, "--", pmName, "publish", "--json", "--no-git-checks"],
					execOptions(),
				)

				assertMatchesSnapshot(result)
			})

			it("4. publish already-published (noTTY)", async () => {
				await resetTestManifestVersion()
				await pmFuncs[pmName].login(env.NPM_WRITE_WITH_BYPASS_TOKEN)

				const result = await x(
					"mise",
					["exec", `${pmName}@${version}`, "--", pmName, "publish", "--json", "--no-git-checks"],
					execOptions(),
				)

				assertMatchesSnapshot(result)
			})
		})
	}
}
