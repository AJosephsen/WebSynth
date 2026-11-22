// Builds the shareable snippets page: node scripts/build-artifact.mjs <output.html>
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) throw new Error("usage: build-artifact.mjs <output.html>");
const r = await build({
  entryPoints: ["src/snippets.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "WS",
  minify: true,
});
const tpl = readFileSync("scripts/artifact-template.html", "utf8");
writeFileSync(out, tpl.replace("/*BUNDLE*/", () => r.outputFiles[0].text));
