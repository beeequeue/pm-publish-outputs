// oxlint-disable vitest/expect-expect
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
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

const normalizePathSeparators = (value: string) => value.replaceAll("\\", path.posix.sep)

const cleanOutput = (output: string) =>
	output
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
		// redact dates
		.replace(/\d{4}-\d{1,2}-\d{1,2}/g, "[date]")
		// redact times
		.replace(/\d{1,2}[:_-]\d{1,2}[:_-]\d{1,2}(?:[:_-]\d{3})?Z?/g, "[time]")
		// redact machine-specific npm cache path
		.replace(
			/(?:[A-Za-z]:)?(?:[/\\][^"'\n/\\]+)*[/\\]\.?npm[/\\]_logs[/\\]\[date\]T\[time\]-debug-0\.log/g,
			(match) =>
				normalizePathSeparators(match).replace(/^.*\/\.?npm\/_logs\//, "[npm-cache]/npm/_logs/"),
		)
		// normalize redacted npm auth URLs
		.replace(/auth\/cli\/(?:[a-z0-9-]{36}|\*\*\*)/g, "auth/cli/[uuid]")
		.replace(/authId=(?:[a-z0-9-]{36}|\*\*\*)/g, "authId=[uuid]")
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
	yarn: ["3", "4"],
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
const userConfigPaths = [
	path.join(homeDir, ".npmrc"),
	path.join(homeDir, ".config", "pnpm", "auth.ini"),
	path.join(homeDir, ".yarnrc.yml"),
]

const isNotFoundError = (value: unknown) =>
	typeof value === "object" && value != null && "code" in value && value.code === "ENOENT"

async function backupUserConfigs() {
	const backupDir = await fs.mkdtemp(path.join(tmpdir(), "pm-publish-outputs-user-config-"))
	const backups: Array<{ sourcePath: string; backupPath: string; existed: boolean }> = []

	for (const sourcePath of userConfigPaths) {
		const backupPath = path.join(
			backupDir,
			path.relative(homeDir, sourcePath).replaceAll(path.sep, "__"),
		)

		try {
			await fs.copyFile(sourcePath, backupPath)
			backups.push({ sourcePath, backupPath, existed: true })
		} catch (e) {
			if (!isNotFoundError(e)) throw e
			backups.push({ sourcePath, backupPath, existed: false })
		}
	}

	await fs.writeFile(path.join(backupDir, "manifest.json"), JSON.stringify(backups, null, 2))
	console.info(`Backed up user package-manager config to ${backupDir}`)

	return async () => {
		for (const backup of backups) {
			if (backup.existed) {
				await fs.mkdir(path.dirname(backup.sourcePath), { recursive: true })
				await fs.copyFile(backup.backupPath, backup.sourcePath)
			} else {
				await fs.rm(backup.sourcePath, { force: true })
			}
		}
	}
}

const yarnScopeMatch = /^@([^/]+)\//.exec(testPackageManifest.name)
const yarnLock = (manifest: {
	name: string
	version: string
}) => `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 10
  cacheKey: 10c0

${JSON.stringify(`${manifest.name}@workspace:.`)}:
  version: ${JSON.stringify(manifest.version)}
  resolution: ${JSON.stringify(`${manifest.name}@workspace:.`)}
  languageName: unknown
  linkType: soft
`
const yarnAuthConfig = (token?: string) => {
	const registryLines = [
		`    npmPublishRegistry: "https://registry.npmjs.org"`,
		`    npmRegistryServer: "https://registry.npmjs.org"`,
	]
	const authLines =
		token == null ? [] : [`    npmAlwaysAuth: true`, `    npmAuthToken: ${JSON.stringify(token)}`]

	if (yarnScopeMatch == null) {
		return [
			`npmPublishRegistry: "https://registry.npmjs.org"`,
			`npmRegistryServer: "https://registry.npmjs.org"`,
			...(token == null ? [] : [`npmAlwaysAuth: true`, `npmAuthToken: ${JSON.stringify(token)}`]),
			"",
		].join("\n")
	}

	return [
		"npmScopes:",
		`  ${JSON.stringify(yarnScopeMatch[1])}:`,
		...registryLines,
		...authLines,
		"",
	].join("\n")
}

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
			await fs.writeFile(path.join(testPackageDir, "yarn.lock"), yarnLock(testPackageManifest))
			await fs.writeFile(path.join(testPackageDir, ".yarnrc.yml"), yarnAuthConfig())
		},
		login: async (token: string) => {
			await fs.writeFile(path.join(testPackageDir, ".yarnrc.yml"), yarnAuthConfig(token))
		},
	},
} as const

const publishArgs = {
	pnpm: (version: string, _options?: { otp?: string }) => [
		"exec",
		`pnpm@${version}`,
		"--",
		"pnpm",
		"publish",
		"--json",
		"--no-git-checks",
	],
	npm: (version: string, _options?: { otp?: string }) => [
		"exec",
		`npm@${version}`,
		"--",
		"npm",
		"publish",
		"--json",
	],
	yarn: (version: string, options?: { otp?: string }) => [
		"exec",
		`yarn@${version}`,
		"--",
		"yarn",
		"npm",
		"publish",
		"--json",
		"--access",
		"public",
		...(options?.otp == null ? [] : ["--otp", options.otp]),
	],
} satisfies Record<
	keyof typeof instances,
	(version: string, options?: { otp?: string }) => string[]
>

async function updateTestManifest(fn: (manifest: { version: string }) => void) {
	const filePath = path.join(testPackageDir, "package.json")
	const data = JSON.parse(await fs.readFile(filePath, "utf8"))
	fn(data)
	await fs.writeFile(filePath, JSON.stringify(data, null, 2))
	await fs.writeFile(path.join(testPackageDir, "yarn.lock"), yarnLock(data))
}

const resetTestManifestVersion = async () =>
	updateTestManifest((manifest) => {
		manifest.version = testPackageManifest.version
	})

const bumpTestManifest = async () =>
	updateTestManifest((manifest) => {
		manifest.version = inc(manifest.version, "patch")!
	})

let restoreUserConfigs = async () => {}
let cleanup = async () => {}

afterAll(async () => {
	await cleanup()
	await resetTestManifestVersion()
	await Promise.all([
		fs.rm(path.join(testPackageDir, ".npmrc"), { force: true }),
		fs.rm(path.join(testPackageDir, ".yarn"), { force: true, recursive: true }),
		fs.rm(path.join(testPackageDir, ".yarnrc.yml"), { force: true }),
		fs.rm(path.join(testPackageDir, "yarn.lock"), { force: true }),
	])
	await restoreUserConfigs()
})

restoreUserConfigs = await backupUserConfigs()
cleanup = await initPackageManagers()

beforeEach(async () => {
	await resetTestManifestVersion()
	await pmFuncs.npm.reset()
	await pmFuncs.pnpm.reset()
	await pmFuncs.yarn.reset()
})

for (const key in instances) {
	const pmName = key as keyof typeof instances
	for (const version of instances[pmName]) {
		describe(`${pmName}@${version}`, async () => {
			it("1. publish need-login (noTTY)", async () => {
				await bumpTestManifest()

				const result = await x(
					"mise",
					publishArgs[pmName](version, { otp: "000000" }),
					execOptions(),
				)

				assertMatchesSnapshot(result)
			})

			it("2. publish not allowed (noTTY)", async () => {
				await bumpTestManifest()
				await pmFuncs[pmName].login(env.NPM_READONLY_TOKEN)

				const result = await x("mise", publishArgs[pmName](version), execOptions())

				assertMatchesSnapshot(result)
			})

			it("3. publish need-2fa (noTTY)", async () => {
				await bumpTestManifest()
				await pmFuncs[pmName].login(env.NPM_WRITE_NO_BYPASS_TOKEN)

				const result = await x("mise", publishArgs[pmName](version), execOptions())

				assertMatchesSnapshot(result)
			})

			it("4. publish already-published (noTTY)", async () => {
				await resetTestManifestVersion()
				await pmFuncs[pmName].login(env.NPM_WRITE_WITH_BYPASS_TOKEN)

				const result = await x("mise", publishArgs[pmName](version), execOptions())

				assertMatchesSnapshot(result)
			})
		})
	}
}
