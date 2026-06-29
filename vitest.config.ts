import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		reporters: ["verbose"],

		maxConcurrency: 1,

		experimental: {
			viteModuleRunner: false,
			preParse: true,
			nodeLoader: true,
		},
	},
})
