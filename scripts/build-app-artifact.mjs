// Builds the full app as a publishable page: node scripts/build-app-artifact.mjs <outDir>
// Writes <outDir>/app.html (the page fragment) and <outDir>/assets/* (script and worklet).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) throw new Error("usage: build-app-artifact.mjs <outDir>");
const dist = "dist-app";
rmSync(dist, { recursive: true, force: true });
execFileSync("npx", ["vite", "build", "--base=./", "--outDir", dist], { stdio: "inherit" });
const html = readFileSync(`${dist}/index.html`, "utf8");
const style = html.match(/<style>[\s\S]*?<\/style>/)[0];
const script = html.match(/<script type="module"[^>]*src="([^"]+)"/)[1].replace(/^\.\//, "");
mkdirSync(out, { recursive: true });
cpSync(`${dist}/assets`, `${out}/assets`, { recursive: true });
writeFileSync(
  `${out}/app.html`,
  `<title>WebSynth</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n${style}\n<div id="app"></div>\n<script type="module" src="${script}"></script>\n`,
);
console.log(readdirSync(`${out}/assets`));
