#!/usr/bin/env node
/**
 * build.mjs — static site generator for mikolajczyk.org
 *
 * Reads projects.json (source of truth) + template.html, then emits dist/:
 *   - index.html   front with data baked in (no runtime fetch)
 *   - feed.xml     RSS of all worklog entries (newest first)
 *   - admin/, img/, projects.json, schema.json, CNAME   copied verbatim
 *
 * Zero dependencies — runs as `node build.mjs`. Validation mirrors schema.json
 * essentials and FAILS the build on bad data, so a broken commit never ships.
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, "dist");
const SITE_URL = "https://mikolajczyk.org";

const read = (p) => readFileSync(join(ROOT, p), "utf8");

/* ============================================================
   validation (mirrors schema.json essentials) — throws on error
   ============================================================ */
export function validate(doc) {
  const errs = [];
  const ids = new Set();
  if (typeof doc !== "object" || doc === null) errs.push("root is not an object");
  if (!Array.isArray(doc.projects)) errs.push("projects is not a list");
  (doc.projects || []).forEach((p, i) => {
    const at = `project #${i + 1} (${p.id || "?"})`;
    if (!/^[a-z0-9-]+$/.test(p.id || "")) errs.push(`${at}: id must be [a-z0-9-]`);
    if (ids.has(p.id)) errs.push(`${at}: duplicate id "${p.id}"`);
    ids.add(p.id);
    if (!p.name) errs.push(`${at}: missing name`);
    if (!Number.isInteger(p.year) || p.year < 1990 || p.year > 2100) errs.push(`${at}: year out of range`);
    if (!["active", "done", "paused"].includes(p.status)) errs.push(`${at}: status must be active/done/paused`);
    if (!p.descHtml) errs.push(`${at}: missing description`);
    if (!Array.isArray(p.chips)) errs.push(`${at}: chips is not a list`);
    if (!Array.isArray(p.shots)) errs.push(`${at}: shots is not a list`);
    (p.worklog || []).forEach((e, j) => {
      const w = `${at} / entry #${j + 1}`;
      if (!["release", "note"].includes(e.kind)) errs.push(`${w}: kind must be release/note`);
      if (!e.ver) errs.push(`${w}: missing version/title`);
      if (!/^\d{4}(-\d{2})?(-\d{2})?$/.test(e.date || "")) errs.push(`${w}: date must be YYYY / YYYY-MM / YYYY-MM-DD`);
      if (!e.md) errs.push(`${w}: empty body`);
    });
  });
  const pids = new Set();
  (doc.posts || []).forEach((p, i) => {
    const at = `post #${i + 1} (${p.id || "?"})`;
    if (!/^[a-z0-9-]+$/.test(p.id || "")) errs.push(`${at}: id must be [a-z0-9-]`);
    if (pids.has(p.id)) errs.push(`${at}: duplicate id "${p.id}"`);
    pids.add(p.id);
    if (!/^\d{4}(-\d{2})?(-\d{2})?$/.test(p.date || "")) errs.push(`${at}: date must be YYYY / YYYY-MM / YYYY-MM-DD`);
    if (!p.md) errs.push(`${at}: empty body`);
  });
  if (errs.length) {
    throw new Error("projects.json validation failed:\n  - " + errs.join("\n  - "));
  }
}

/* ============================================================
   minimal markdown — same parser as the front (for RSS bodies)
   ============================================================ */
const EMOJI = {rocket:"🚀",sparkles:"✨",tada:"🎉",fire:"🔥",bug:"🐛",wrench:"🔧",hammer:"🔨","hammer_and_wrench":"🛠️",tools:"🛠️",gear:"⚙️",zap:"⚡",boom:"💥",warning:"⚠️",white_check_mark:"✅",x:"❌",heavy_check_mark:"✔️",heavy_plus_sign:"➕",heavy_minus_sign:"➖","+1":"👍","-1":"👎",art:"🎨",recycle:"♻️",lock:"🔒",unlock:"🔓",key:"🔑",book:"📖",books:"📚",memo:"📝",pencil:"✏️",bulb:"💡",rotating_light:"🚨",package:"📦",construction:"🚧",rainbow:"🌈",ambulance:"🚑",lipstick:"💄",green_heart:"💚",heart:"❤️",broken_heart:"💔",arrow_up:"⬆️",arrow_down:"⬇️",bookmark:"🔖",gem:"💎",tractor:"🚜",eyes:"👀",thumbsup:"👍",thumbsdown:"👎",point_right:"👉",point_left:"👈",star:"⭐","100":"💯",ok_hand:"👌",raised_hands:"🙌",pray:"🙏",clap:"👏",wave:"👋",computer:"💻",keyboard:"⌨️",floppy_disk:"💾",calendar:"📅",link:"🔗",mag:"🔍",label:"🏷️",robot:"🤖",alien:"👽",space_invader:"👾",video_game:"🎮",joystick:"🕹️",penguin:"🐧",crab:"🦀",snake:"🐍",coffee:"☕",seedling:"🌱",hourglass:"⏳",checkered_flag:"🏁",dart:"🎯",speech_balloon:"💬",thought_balloon:"💭",smile:"😄",grin:"😁",wink:"😉",thinking:"🤔",bell:"🔔",sound:"🔊",mute:"🔇",camera:"📷",scroll:"📜",sos:"🆘",new:"🆕",ok:"🆗"};
const emoji = (s) => s.replace(/:([a-z0-9_+-]+):/g, (m, n) => EMOJI[n] || m);

function md(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) =>
    emoji(esc(s)
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>"));
  return (src || "")
    .split(/\n\n+/)
    .map((b) => {
      const lines = b.split("\n");
      const hm = b.match(/^(#{1,6})\s+(.*)$/);
      if (lines.length === 1 && hm) { const n = hm[1].length; return `<h${n}>` + inline(hm[2]) + `</h${n}>`; }
      if (lines.every((l) => /^\s*[-*+]\s+/.test(l)))
        return "<ul>" + lines.map((l) => "<li>" + inline(l.replace(/^\s*[-*+]\s+/, "")) + "</li>").join("") + "</ul>";
      return "<p>" + inline(b) + "</p>";
    })
    .join("");
}

/* ============================================================
   helpers
   ============================================================ */
const xmlEsc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const stripTags = (s) => String(s || "").replace(/<[^>]*>/g, "");

// RSS readers need absolute image/link URLs; rewrite relative media/ refs.
const absoluteMedia = (html) => html.replace(/(src|href)="media\//g, `$1="${SITE_URL}/media/`);

// YYYY / YYYY-MM / YYYY-MM-DD -> Date at UTC noon (avoids TZ off-by-one)
function parseDate(d) {
  const [y, m = "01", day = "01"] = d.split("-");
  return new Date(Date.UTC(+y, +m - 1, +day, 12));
}

/* ============================================================
   RSS feed
   ============================================================ */
function buildFeed(doc) {
  const site = doc.site || {};
  const items = [];
  for (const p of doc.projects) {
    for (const e of p.worklog || []) {
      if (e.feed === false) continue;   // hidden from the feed (still on the project page)
      items.push({
        title: `${p.name} — ${e.ver}`,
        link: `${SITE_URL}/#/project/${p.id}`,
        guid: `${SITE_URL}/#/project/${p.id}#${e.date}-${e.ver}`,
        date: parseDate(e.date),
        kind: e.kind,
        html: absoluteMedia(md(e.md)),
      });
    }
  }
  for (const p of doc.posts || []) {
    items.push({
      title: p.title || `Post — ${p.date}`,
      link: `${SITE_URL}/#/post/${p.id}`,
      guid: `${SITE_URL}/#/post/${p.id}`,
      date: parseDate(p.date),
      kind: "post",
      html: absoluteMedia(md(p.md)),
    });
  }
  items.sort((a, b) => b.date - a.date);

  const built = items.length ? items[0].date : parseDate("1970");
  const channelTitle = `${site.name || "mikolajczyk"} — worklog`;
  const channelDesc = stripTags((site.bio && site.bio[0]) || "Project worklog.");

  const itemXml = items
    .map(
      (it) => `    <item>
      <title>${xmlEsc(it.title)}</title>
      <link>${xmlEsc(it.link)}</link>
      <guid isPermaLink="false">${xmlEsc(it.guid)}</guid>
      <category>${xmlEsc(it.kind)}</category>
      <pubDate>${it.date.toUTCString()}</pubDate>
      <description><![CDATA[${it.html}]]></description>
    </item>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEsc(channelTitle)}</title>
    <link>${SITE_URL}/</link>
    <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml"/>
    <description>${xmlEsc(channelDesc)}</description>
    <language>en</language>
    <lastBuildDate>${built.toUTCString()}</lastBuildDate>
${itemXml}
  </channel>
</rss>
`;
}

/* ============================================================
   HTML
   ============================================================ */
function buildHtml(doc, template) {
  const site = doc.site || {};
  const json = JSON.stringify(doc)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  const placeholder = '/*__DATA__*/ {"version":1,"site":{},"projects":[]}';
  if (!template.includes(placeholder)) throw new Error("Data marker not found in template.html");

  const name = stripTags(site.name || "Mikołaj Mikołajczyk");
  const desc = stripTags((site.bio && site.bio[0]) || "Project portfolio.").slice(0, 200);

  return template
    .replace(placeholder, "/*__DATA__*/ " + json)
    .replaceAll("__SITE_NAME__", xmlEsc(name))
    .replaceAll("__SITE_DESC__", xmlEsc(desc))
    .replaceAll("__SITE_URL__", SITE_URL);
}

/* ============================================================
   main
   ============================================================ */
function main() {
  const doc = JSON.parse(read("projects.json"));
  validate(doc);
  const template = read("template.html");

  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  writeFileSync(join(DIST, "index.html"), buildHtml(doc, template));
  writeFileSync(join(DIST, "feed.xml"), buildFeed(doc));

  // copy verbatim assets
  cpSync(join(ROOT, "admin"), join(DIST, "admin"), { recursive: true });
  if (existsSync(join(ROOT, "img"))) cpSync(join(ROOT, "img"), join(DIST, "img"), { recursive: true });
  if (existsSync(join(ROOT, "media"))) cpSync(join(ROOT, "media"), join(DIST, "media"), { recursive: true });
  for (const f of ["projects.json", "schema.json", "CNAME"]) {
    if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(DIST, f));
  }

  const entries = doc.projects.reduce((n, p) => n + (p.worklog?.length || 0), 0);
  const posts = (doc.posts || []).length;
  console.log(`build ok: ${doc.projects.length} projects, ${entries} worklog entries, ${posts} posts -> dist/`);
}

// run the build only when the file is executed directly (not when validate is imported)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
