import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
	site: "https://usegandalf.com",
	integrations: [mdx(), react(), sitemap()],
	output: "static",
	// Keep v6 HTML-aware whitespace; v7 defaults to "jsx", which drops spaces between inline elements.
	compressHTML: true,
	build: {
		assets: "_assets",
	},
	redirects: {
		"/docs": "https://docs.usegandalf.com",
	},
});
