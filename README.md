# mikolajczyk.org

Static portfolio site. The repo is the source of truth: `projects.json` holds the data.
**Build on push** (`build.mjs`, run by a GitHub Action) generates the finished
`index.html` + `feed.xml` and deploys to GitHub Pages. The front end is static —
data is injected into the HTML at build time, **with no runtime fetch**.

```
projects.json  ──(commit from admin panel or by hand)──>  push to main
      │
      └──> GitHub Action: node build.mjs ──> dist/ ──> deploy to Pages
```

## Files

| file | role |
|------|------|
| `projects.json`        | **data (source of truth)**: `site` section (texts) + `projects` |
| `schema.json`          | JSON Schema (draft 2020-12) — format documentation + validation in the admin panel |
| `template.html`        | front-end template; `build.mjs` injects data into it (marker `/*__DATA__*/`) |
| `build.mjs`            | generator (Node, zero dependencies): json + template → `dist/index.html` + `dist/feed.xml`, copies `admin/`, `img/`, `CNAME` |
| `dev.mjs`              | local dev server: panel without login, saving writes straight to `projects.json` + rebuild |
| `.github/workflows/deploy.yml` | push to main → build → deploy to Pages |
| `admin/index.html`     | admin panel — GitHub App login, CRUD, commit via Contents API |
| `admin/github-auth.js` | OAuth client (PKCE) for the broker Worker |
| `admin/vendor/`        | vendored [EasyMDE](https://github.com/Ionaru/easy-markdown-editor) (markdown editor) — `easymde.min.{js,css}`, offline, no CDN |
| `img/`                 | screenshots |
| `media/`               | images uploaded via the admin **Media** tab; referenced from markdown as `media/<name>` |
| `dist/`                | **generated** (gitignored) — not committed, the Action does it |

## Build locally

```bash
node build.mjs        # -> dist/index.html, dist/feed.xml + copied assets
```

Validation of `projects.json` is a **hard gate**: bad JSON → build fail → nothing ships.
The build is deterministic (`lastBuildDate` in RSS = date of the newest entry, not the build
time), so there are no spurious diffs.

## Local mode (dev) — editing without login

```bash
node dev.mjs          # http://localhost:4321
```

Open `http://localhost:4321/admin/` — the panel detects the dev server (`GET /__local`)
and **skips GitHub login**.

**Working-copy model:** add / delete / edit project / edit site texts all mutate a working
copy held in the browser (`localStorage`) — nothing touches `projects.json` until you save.
The draft survives a page reload; "reload from repo" discards it. Only the two save buttons,
pinned to the bottom of the left sidebar, persist data:

- **save** — writes straight to `projects.json` (`POST /__save`) and rebuilds `dist/`. Fast iteration, no git.
- **save + commit** — the above plus a local `git commit` (`POST /__save?commit=1`). Needs the repo to be `git init`-ed.

Either way it validates against the schema rules **before** saving (bad input won't corrupt
the file). The front end at `http://localhost:4321/` shows the change immediately. No GitHub,
no Worker, no OAuth.

On GitHub Pages the same sidebar shows a single **save (commit)** button (commit via Contents API).

### Edit links

On localhost (or once you've logged into the admin — it leaves an `admin_session` hint in
`localStorage`), the front end shows a small **edit** link on every feed item, post and
project. Clicking it opens the admin in a named tab on exactly the right tab/item (the target
is passed via `localStorage` so it survives the OAuth redirect and tab reuse). Visitors who
aren't on localhost and never logged in see no edit links.

### Live preview (no save, no commit)

The sidebar **↗ preview** button opens the front end at `/?preview` in a second tab. In preview
mode the front renders the admin's **unsaved working copy** (read from the same `localStorage`
draft the admin autosaves) instead of the published data, with a "PREVIEW" banner. Editing in the
admin updates the preview tab **live** (via the `storage` event) — so you see exactly how the page
will look before saving or committing. The normal site (without `?preview`) never reads the draft,
so visitors are unaffected.

The same site on GitHub Pages (where `/__local` returns 404) runs in GitHub
App mode — see below. A single `admin/index.html` file handles both.

## GitHub Pages — how to publish

1. Repo → **Settings → Pages → Source: GitHub Actions** (not "Deploy from a branch" —
   the site is built and published by the workflow from `dist/`).
2. A push to `main` triggers `deploy.yml`: build → `upload-pages-artifact` → `deploy-pages`.
3. Custom domain: the `CNAME` file (`mikolajczyk.org`) is already in the repo and copied to `dist/`.
   In *Pages → Custom domain* enter `mikolajczyk.org` and set up DNS:
   - apex: `A` → `185.199.108.153` (+ .109/.110/.111) or `ALIAS`/`ANAME` to `<user>.github.io`
   - `www`: `CNAME` → `<user>.github.io`
4. Check **Enforce HTTPS**.

RSS lives at `https://mikolajczyk.org/feed.xml` (the `rel="alternate"` link is in `<head>`).

## Admin panel (`/admin`)

Static panel at `admin/index.html`. Login via GitHub App (PKCE, broker Worker
with `github-auth.js`), saving goes **directly through the GitHub Contents API** — a commit
of `projects.json` from the browser to `main`. That commit triggers the Action, which rebuilds
the front end and RSS. The loop closes itself: *edit → save → ~1 min → site updated*.

**Before you use it — fill in `CONFIG` at the top of `admin/index.html`** (`clientId` +
`workerUrl` of your GitHub App; `owner/repo/branch/path` are already set):

```js
const CONFIG = {
  clientId:   "Iv1.xxxx",                        // client_id of your GitHub App
  workerUrl:  "https://gh-auth.xxx.workers.dev", // OAuth broker (Worker)
  owner:      "mikolajmikolajczyk",
  repo:       "mikolajczyk.org",
  branch:     "main",
  path:       "projects.json",                   // source of truth at the repo root
  redirectUri: location.origin + location.pathname,
};
```

In the GitHub App settings add `https://mikolajczyk.org/admin/` as the
**Authorization callback URL** — it must match `redirectUri`.

Markdown fields (worklog entries, posts) use a vendored **EasyMDE** editor — a toolbar
(bold / italic / code / list / link) plus syntax highlighting, served from `admin/vendor/`
so it works offline with no CDN. The live preview below each editor uses the front end's
own minimal markdown parser, so it shows exactly how the site will render.

Write security relies on the GitHub App: only someone with write access to the repo
can commit. Validation in the panel is a convenience; the hard gate is the Contents API
(it rejects a commit without permissions) plus validation in `build.mjs` (it rejects bad JSON at build time).

## Data format

```jsonc
{
  "version": 1,
  "site": {                          // editable site texts
    "name": "mikolajczyk",
    "role": "Platform / DevOps engineer · <b>Warsaw</b> · ~15 years in IT",
    "bio": ["paragraph 1…", "paragraph 2…"],
    "footer": [ { "label": "GitHub", "href": "https://…" } ]
  },
  "projects": [
    {
      "id": "madside",              // slug for #/project/<id>, [a-z0-9-]
      "name": "madside",
      "year": 2025,
      "status": "active",           // active | done | paused
      "descHtml": "…<b>…</b>…",     // short description, simple <b> allowed
      "chips": ["TypeScript", "AGPL"],
      "github": "https://…",        // or null
      "site": "https://…",          // or null
      "shots": [
        { "src": "img/x.png", "badge": "welcome", "alt": "…" },  // real screenshot
        { "placeholder": "img/y.png" }                            // placeholder
      ],
      "worklog": [
        { "kind": "release", "ver": "v0.18.0", "date": "2025-06", "md": "…markdown…" },
        { "kind": "note",    "ver": "Why I'm doing this", "date": "2025-04", "md": "…" }
      ]
    }
  ],
  "posts": [                           // loose standalone posts (notes / microblog)
    { "id": "hello", "date": "2026-06", "title": "Optional title", "md": "…markdown…" },
    { "id": "quick-note", "date": "2026-05", "md": "title omitted = microblog entry" }
  ]
}
```

In `site.role` and `site.bio` you can use the token `{{years:YYYY}}` — it is replaced
**at render time** (client-side) with `current year − YYYY`. E.g. `~{{years:2011}} years in IT`
shows `~15` in 2026, `~16` in 2027, with no rebuild or yearly edit. Change `2011` to your
actual start year.

**Posts** are loose, standalone notes that don't belong to a single project. On the
front end they sit in their own column: **posts left, projects right**, split by a
vertical divider on desktop. The left column is a **merged feed** — standalone posts
**plus every project's worklog entries**, newest first — so project activity surfaces on
the home page. A post opens its own detail (slides left); a worklog item links to its
project (slides right) and shows a source chip with the project name. Below ~860px the two collapse into a **`Projects | Posts`
tab toggle** (projects shown first). `title` is optional — omit it for a microblog-style
note. Each post shows a first-paragraph teaser with a **more »** that opens the full post
in its own detail pane — sliding in **from the left**, mirroring projects (whose worklog
detail slides in from the right). Posts are deep-linkable at `#/post/<id>` and feed the same
RSS as the worklog.

`date` accepts `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. Every `worklog` entry **and every post**
becomes an item in the RSS (`feed.xml`), sorted descending by date. `md` is markdown
(paragraphs, `-` lists, `**bold**`, `*italic*`, `` `code` ``, links) rendered by the same
mini-parser on the front end and in the RSS generator.

## Media (images)

The admin **Media** tab manages images stored in the repo under `media/`. Upload (drag-drop
or file picker) — the browser **converts each image to AVIF, or WebP if AVIF encoding isn't
available**, downscaling to ≤1920px, before uploading. The grid shows every image; each card
copies a markdown snippet `![](media/<name>)`, copies the path, or deletes.

Reference images in any markdown body (worklog entries, posts) as `media/<name>` — the
front-end markdown parser renders `![alt](media/x.webp)` as an `<img>`. In RSS, relative
`media/` URLs are rewritten to absolute (`https://mikolajczyk.org/media/…`).

Persistence is **immediate and separate** from the JSON save flow:
- **Local mode** (`dev.mjs`): writes/deletes the file in `media/` directly (no commit per image).
  The **save + commit** button then batches `projects.json` and all pending `media/` changes into a single commit.
- **GitHub mode**: each upload/delete is its own commit via the Contents API (which triggers
  a Pages rebuild). Fine for the low volume this is meant for.

`build.mjs` copies `media/` into `dist/`.

## Pulling changelogs from GitHub (optional)

The GitHub Releases API maps 1:1 onto a worklog entry:

```
GET /repos/{owner}/{repo}/releases
  tag_name      -> ver
  published_at  -> date
  body          -> md
  kind = "release"
```
