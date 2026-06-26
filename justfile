# mikolajczyk.org — task runner. Install: https://github.com/casey/just
# Run `just` with no args to list recipes. Needs Node (and `just`).

# list available recipes
default:
    @just --list

# local dev server: front + admin at http://localhost:<port> (admin = no login)
dev port="4321":
    PORT={{port}} node dev.mjs

# build the static site into dist/ (validates projects.json; fails on bad data)
build:
    node build.mjs

# validate + build, but only report (alias of build — the build is the gate)
check: build

# remove build output
clean:
    rm -rf dist

# clean rebuild
rebuild: clean build

# open the admin panel in a browser (dev server must be running)
admin port="4321":
    xdg-open http://localhost:{{port}}/admin/

# open the live draft preview in a browser (dev server must be running)
preview port="4321":
    xdg-open "http://localhost:{{port}}/?preview"

# one-time: initialise git on `main` and make the first commit
init:
    git init -b main
    git add -A
    git commit -m "Initial commit: static portfolio + admin"

# commit everything with a message, e.g. `just commit "tweak bio"`
commit msg:
    git add -A
    git commit -m "{{msg}}"

# push main (triggers the GitHub Action: build + deploy to Pages)
push:
    git push origin main
