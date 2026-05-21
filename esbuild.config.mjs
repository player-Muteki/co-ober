import * as esbuild from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

const mode = process.argv.includes("--minify") ? "production" : "development";
const entryPath = path.join(process.cwd(), "src", "main.ts");
const entryDir = path.dirname(entryPath);

const localResolver = {
  name: "local-resolver",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.path.startsWith(".") || path.isAbsolute(args.path)) {
        const resolved = resolveLocalImport(args.resolveDir, args.path);
        if (resolved) {
          return { path: resolved, namespace: "local" };
        }
        return { path: args.path, external: true };
      }

      return { path: args.path, external: true };
    });

    build.onLoad({ filter: /.*/, namespace: "local" }, (args) => {
      const ext = path.extname(args.path).toLowerCase();
      const loader = ext === ".js" ? "js" : ext === ".json" ? "json" : "ts";
      return {
        contents: readFileSync(args.path, "utf8"),
        resolveDir: path.dirname(args.path),
        loader,
      };
    });
  },
};

function resolveLocalImport(resolveDir, specifier) {
  const abs = path.isAbsolute(specifier) ? specifier : path.resolve(resolveDir, specifier);
  const ext = path.extname(abs);
  const candidates = ext
    ? [abs]
    : [
        abs,
        `${abs}.ts`,
        `${abs}.tsx`,
        `${abs}.js`,
        `${abs}.mjs`,
        `${abs}.cjs`,
        `${abs}.json`,
        path.join(abs, "index.ts"),
        path.join(abs, "index.tsx"),
        path.join(abs, "index.js"),
        path.join(abs, "index.mjs"),
        path.join(abs, "index.cjs"),
        path.join(abs, "index.json"),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

await esbuild.build({
  stdin: {
    contents: readFileSync(entryPath, "utf8"),
    resolveDir: entryDir,
    sourcefile: "src/main.ts",
    loader: "ts",
  },
  bundle: true,
  write: true,
  outfile: "main.js",
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: ["obsidian"],
  logLevel: "info",
  sourcemap: mode === "development",
  minify: mode === "production",
  metafile: true,
  plugins: [localResolver],
});

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
manifest.version = pkg.version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
copyFileSync("styles/main.css", "styles.css");

mkdirSync("release", { recursive: true });
copyFileSync("main.js", path.join("release", "main.js"));
copyFileSync("manifest.json", path.join("release", "manifest.json"));
copyFileSync("styles.css", path.join("release", "styles.css"));

console.log(`Build complete (${mode}). Version: ${manifest.version}`);
