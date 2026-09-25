import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

// Vite plugin for OpenFront's dev server and build:
//  - lets Vite serve source files from the OpenFly checkout (../fly), which
//    sits outside OpenFront's project root;
//  - serves the brain files (../brain) at /openfly/ in dev and copies them
//    into the build output.

const OPENFLY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const BRAIN_DIR = path.join(OPENFLY_ROOT, "brain");

export function openflyPlugin(): Plugin {
  let outDir = "static";
  return {
    name: "openfly",
    config() {
      return { server: { fs: { allow: [OPENFLY_ROOT] } } };
    },
    configResolved(cfg) {
      outDir = path.resolve(cfg.root, cfg.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ? new URL(req.url, "http://x").pathname : "";
        if (!url.startsWith("/openfly/")) return next();
        const rel = decodeURIComponent(url.slice("/openfly/".length));
        if (rel.includes("..") || rel.includes("/")) return next();
        const file = path.join(BRAIN_DIR, rel);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.statusCode = 404;
          res.end();
          return;
        }
        // Raw bytes: the worker gunzips .gz itself.
        res.setHeader(
          "Content-Type",
          rel.endsWith(".json")
            ? "application/json"
            : "application/octet-stream",
        );
        res.setHeader("Cache-Control", "no-cache");
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (!fs.existsSync(outDir)) return;
      const dest = path.join(outDir, "openfly");
      fs.mkdirSync(dest, { recursive: true });
      for (const f of fs.readdirSync(BRAIN_DIR)) {
        if (!/\.(json|gz)$/.test(f)) continue;
        fs.copyFileSync(path.join(BRAIN_DIR, f), path.join(dest, f));
      }
    },
  };
}
