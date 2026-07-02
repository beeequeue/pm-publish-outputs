import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		reporters: ["verbose"],
		testTimeout: 30_000,

		maxConcurrency: 1,

		experimental: {
			viteModuleRunner: false,
			preParse: true,
			nodeLoader: true,
		},
	},
})
