#!/usr/bin/env node
/**
 * dev.mjs — local dev server. No login, no GitHub.
 *
 *   node dev.mjs            # http://localhost:4321  (front + /admin)
 *
 * The admin panel detects this server via GET /__local and switches to local
 * mode: you edit and click "save", and POST /__save writes straight to
 * projects.json (source of truth) and rebuilds dist/ — front updates instantly.
 *
 *   GET  /__local          -> {"local":true}  (mode marker)
 *   GET  /projects.json     -> source file (always current, independent of the build)
 *   POST /__save            -> write projects.json + rebuild
 *   POST /__save?commit=1   -> the above + local `git commit` (batches projects.json + media/)
 *   GET  /__media           -> list of files in media/
 *   POST /__upload?name=    -> write media/<name> (raw image bytes)
 *   POST /__media-delete?name= -> remove media/<name>
 *   GET  /media/<file>      -> serve from source media/ (no rebuild needed)
 *   everything else         -> served statically from dist/
 */
import { createServer } from "node:http";
import { readFile, writeFile, readdir, unlink, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { validate } from "./build.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "dist");
const MEDIA = join(ROOT, "media");
const PORT = process.env.PORT || 4321;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
};
const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"]);
const safeName = (n) => (n || "").split("/").pop().replace(/[^a-zA-Z0-9._-]/g, "-");

const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd: ROOT }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || stdout || err.message).trim())) : resolve(stdout.trim())
    )
  );

const build = () => run(process.execPath, [join(ROOT, "build.mjs")]);

const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
async function readBodyBuffer(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname);

  // ---- dev endpoints ----
  if (path === "/__local") return json(res, 200, { local: true });

  if (path === "/projects.json") {
    try {
      res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
      res.end(await readFile(join(ROOT, "projects.json")));
    } catch {
      json(res, 404, { error: "projects.json not found" });
    }
    return;
  }

  if (path === "/__save" && req.method === "POST") {
    try {
      const text = await readBody(req);
      const doc = JSON.parse(text); // 1. JSON syntax
      validate(doc);                // 2. schema rules — BEFORE writing, so a bad payload can't corrupt the file
      await writeFile(join(ROOT, "projects.json"), JSON.stringify(doc, null, 2) + "\n");
      const out = await build();    // 3. rebuild dist/
      let committed = false;
      if (url.searchParams.get("commit") === "1") {  // 4. optional local git commit
        // batch projects.json + any pending media adds/deletes into one commit
        await run("git", ["add", "-A", "projects.json", "media"]);
        await run("git", ["commit", "-m", `admin: update content (${doc.projects.length} projects, ${(doc.posts || []).length} posts)`]);
        committed = true;
      }
      console.log((committed ? "saved + committed + " : "saved + ") + out);
      json(res, 200, { ok: true, build: out, committed });
    } catch (err) {
      console.error("save error:", err.message);
      json(res, 400, { error: err.message });
    }
    return;
  }

  // ---- media (source dir; served live so uploads show without a rebuild) ----
  if (path === "/__media") {
    try {
      await mkdir(MEDIA, { recursive: true });
      const names = (await readdir(MEDIA)).filter((n) => IMG_EXT.has(extname(n).toLowerCase()));
      const files = await Promise.all(names.map(async (name) => ({ name, size: (await stat(join(MEDIA, name))).size })));
      files.sort((a, b) => a.name.localeCompare(b.name));
      json(res, 200, { files });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }
  if (path === "/__upload" && req.method === "POST") {
    try {
      const name = safeName(url.searchParams.get("name"));
      if (!name || !IMG_EXT.has(extname(name).toLowerCase())) throw new Error("bad image name");
      await mkdir(MEDIA, { recursive: true });
      await writeFile(join(MEDIA, name), await readBodyBuffer(req));
      console.log("uploaded media/" + name);
      json(res, 200, { ok: true, name });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }
  if (path === "/__media-delete" && req.method === "POST") {
    try {
      const name = safeName(url.searchParams.get("name"));
      await unlink(join(MEDIA, name));
      console.log("deleted media/" + name);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }
  if (path.startsWith("/media/")) {
    const file = join(MEDIA, safeName(path.slice("/media/".length)));
    try {
      res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(await readFile(file));
    } catch {
      json(res, 404, { error: "not found" });
    }
    return;
  }

  // ---- static from dist/ ----
  let rel = normalize(path).replace(/^(\.\.[/\\])+/, "");
  if (rel.endsWith("/")) rel += "index.html";
  const file = join(DIST, rel);
  if (!file.startsWith(DIST)) return json(res, 403, { error: "forbidden" });

  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    json(res, 404, { error: "not found: " + rel });
  }
});

if (!existsSync(DIST)) {
  console.log("no dist/ — building…");
}
try {
  console.log(await build());
} catch (err) {
  console.error("⚠ build failed (fix projects.json):\n" + err.message);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  dev → http://localhost:${PORT}        (front)`);
  console.log(`        http://localhost:${PORT}/admin/  (panel, local mode)\n`);
});
