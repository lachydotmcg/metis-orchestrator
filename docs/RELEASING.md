# Releasing Metis Orchestrator

This is the short version of how to cut a real, versioned release so the
in-app update badge lights up and (later) electron-updater can auto-download
new builds.

## One-time local setup

electron-builder is listed in `package.json` `devDependencies` but is not
installed yet. Before you can build a package locally, run:

```
npm i -D electron-builder
```

You only need to do this once. `npm ci`/`npm install` after that will pick it
up automatically.

## Cutting a release

1. Bump the version in `package.json` (`"version": "0.1.0"` -> `"0.1.1"`,
   or whatever the next version is). Semantic versioning is fine, doesn't
   need to be perfect.
2. Commit that change:
   ```
   git add package.json
   git commit -m "Bump version to 0.1.1"
   ```
3. Tag the commit with a `v` prefix and push the tag:
   ```
   git tag v0.1.1
   git push --tags
   ```
4. Pushing the tag triggers `.github/workflows/release.yml`. It runs on
   Windows, macOS, and Linux, builds the app with `npm run build`, then runs
   `electron-builder --publish always`, which packages installers for each
   OS and publishes them as assets on a new GitHub Release matching the tag.
5. Once the workflow finishes (check the Actions tab), the release will show
   up at `https://github.com/lachydotmcg/metis-orchestrator/releases`.

No secrets need to be configured manually. The workflow uses the
automatically-provided `GITHUB_TOKEN`, which has enough permission to create
releases in this repo.

## Building locally without publishing

Two npm scripts cover local testing:

- `npm run pack` — builds an unpacked app directory under `release/` for
  quick smoke testing, without creating installers.
- `npm run dist` — runs the full build and produces real installers
  (`.exe`/`.dmg`/`.AppImage`) under `release/`, but does not publish them
  anywhere.

Both require `electron-builder` to be installed locally first (see above).

## How this connects to the in-app update badge

The app already checks
`https://api.github.com/repos/lachydotmcg/metis-orchestrator/releases/latest`
and shows an "update available" badge when the latest GitHub Release has a
newer version than the running app. That check only finds something once the
first tagged release exists, so cutting a release (steps above) is what
turns the badge on for the first time.

## What's next: electron-updater

`electron-builder.yml` already sets a GitHub `publish` target, which is the
piece electron-updater needs to find releases. Wiring `electron-updater`
into the Electron main process (so the app can download and install updates
in the background instead of just linking out to the badge) is a separate,
future change and is not part of this round.

## Signing caveats

These builds are not code-signed. That means:

- **Windows**: the NSIS installer will trigger a SmartScreen warning
  ("Windows protected your PC") on first run. Users have to click
  "More info" -> "Run anyway".
- **macOS**: the `.dmg` is not notarized, so Gatekeeper will block it by
  default. Users need to right-click the app and choose "Open", or clear the
  quarantine attribute manually.

Both are expected for an unsigned indie build. Fixing this needs a paid code
signing certificate (Windows) and an Apple Developer account (macOS
notarization), which is out of scope for now. Just make sure release notes
mention it so people aren't alarmed.
