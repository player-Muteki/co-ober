import * as esbuild from "esbuild";
import { readFileSync, writeFileSync } from "fs";

const config = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  metafile: true,
  outfile: "main.js",
  platform: "node", // Electron has Node.js built-ins
  target: "es2022",
  external: ["obsidian"],
  logLevel: "info",
  sourcemap: false,
  plugins: [
    {
      name: "manifest-copy",
      setup(build) {
        build.onEnd(() => {
          const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
          manifest.version = readFileSync("package.json", "utf8").match(/"version":\s*"([^"]+)"/)?.[1] ?? "0.1.0";
          writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
        });
      },
    },
  ],
};

const mode = process.argv.includes("--minify") ? "production" : "development";

await esbuild.build({
  ...config,
  minify: mode === "production",
  sourcemap: mode === "development",
});

// Copy manifest and styles
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
manifest.version = pkg.version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

console.log(`Build complete (${mode}). Version: ${manifest.version}`);
