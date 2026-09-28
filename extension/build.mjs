#!/usr/bin/env node
/**
 * Bundles the extension's three TypeScript entry points (background/content/
 * popup) into standalone, dependency-free IIFEs in extension/dist/, then
 * copies the static files (manifest, popup.html/css, content.css, icons)
 * alongside them -- extension/dist/ becomes the complete "Load unpacked"
 * target. Plain esbuild, not Vite: content scripts and MV3 service workers
 * can run ES modules, but bundling each entry into one self-contained file
 * avoids any of that nuance entirely, and esbuild's JS API needs no project
 * config of its own.
 *
 * Reuses ../src (this repo's real oracle/astronomy modules) directly --
 * background.ts imports from "../../src/oracle" etc., and esbuild inlines
 * astronomy-engine (an ordinary npm dependency) the same way it would for
 * any other bundled import.
 */
import { build } from "esbuild";
import { readFile, mkdir, copyFile, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "dist");

async function main() {
  await mkdir(distDir, { recursive: true });

  await build({
    entryPoints: {
      background: path.join(__dirname, "src/background.ts"),
      content: path.join(__dirname, "src/content.ts"),
      popup: path.join(__dirname, "src/popup.ts"),
    },
    outdir: distDir,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome100"],
    sourcemap: true,
    logLevel: "info",
    // background.ts pulls in src/oracle.ts, which unconditionally imports
    // src/config.ts, which reads `import.meta.env.VITE_ORACLE`/`_WORKER_URL`
    // at module-load time (Vite's own build-time substitution, which this
    // esbuild-based build has no equivalent of). Without this, `import.meta`
    // is an empty object under esbuild's "iife" format, and accessing
    // `.env.VITE_ORACLE` on it would throw at load -- background.ts never
    // reads config.ts's exports at all (it constructs JevOracle directly),
    // so these just need to evaluate to `undefined`, not actually be correct.
    define: {
      "import.meta.env.VITE_ORACLE": "undefined",
      "import.meta.env.VITE_WORKER_URL": "undefined",
    },
  });

  for (const file of ["manifest.json", "popup.html", "popup.css", "content.css"]) {
    await copyFile(path.join(__dirname, file), path.join(distDir, file));
  }
  await cp(path.join(__dirname, "icons"), path.join(distDir, "icons"), { recursive: true });

  // Sanity-check the copied manifest.json is valid JSON and references files
  // that actually exist in dist/ now, rather than silently shipping a broken
  // "Load unpacked" target.
  const manifestText = await readFile(path.join(distDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  const referenced = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    ...(manifest.content_scripts ?? []).flatMap((entry) => [...(entry.js ?? []), ...(entry.css ?? [])]),
  ].filter(Boolean);
  for (const rel of referenced) {
    await readFile(path.join(distDir, rel));
  }

  console.log(`\nExtension built to ${distDir}`);
  console.log('Load it via chrome://extensions -> "Load unpacked" -> select that folder.');
}

main().catch((error) => {
  console.error("Extension build failed:", error);
  process.exitCode = 1;
});
