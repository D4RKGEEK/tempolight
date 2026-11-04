# Installing Tempolight

Every way to get Tempolight running, from easiest to most hands-on. They all run the same app and keep your settings
in the same place (`~/.tempolight`, or `%USERPROFILE%\.tempolight` on Windows), so you can switch between them.

| Way | Needs | Updates |
| --- | --- | --- |
| [One-file app](#one-file-app) | nothing | download the new version |
| [Homebrew](#homebrew-macos-linux) (macOS, Linux) | Homebrew | `brew upgrade tempolight` |
| [winget](#winget-windows) (Windows) | Windows 10/11 | `winget upgrade D4RKGEEK.Tempolight` |
| [Scoop](#scoop-windows) (Windows) | Scoop | `scoop update tempolight` |
| [npx / npm](#npx-and-npm) | Node.js 20+ | `npx` always runs the latest |
| [Docker](#docker) | Docker | rebuild or pull the image ([docker.md](guides/docker.md#update)) |
| [Installer scripts](#installer-scripts) | nothing (installs Node.js) | one click in Settings |
| [From source](#from-source) | Node.js 20+, git | `git pull`, or one click in Settings |

Whichever you choose: when Windows or macOS asks whether Tempolight may accept incoming connections, allow it (on
private networks), so your phone can open it and your lights can be found. Then follow [Your first show](guides/first-run.md).

## One-file app

A single file with everything inside, Node.js included. Download the one for your computer from the
[latest release](https://github.com/D4RKGEEK/tempolight/releases/latest):

| Computer | File |
| --- | --- |
| Windows 10/11 (64-bit) | `tempolight-windows-x64.exe` |
| Mac with Apple silicon (M1 and later) | `Tempolight-macos-arm64.dmg` (or `tempolight-macos-arm64.zip` for the terminal) |
| Mac with an Intel processor | `Tempolight-macos-x64.dmg` (or `tempolight-macos-x64.zip`) |
| Linux PC (64-bit) | `tempolight-linux-x64.tar.gz` |
| Raspberry Pi 3/4/5 with 64-bit Raspberry Pi OS, other ARM64 Linux | `tempolight-linux-arm64.tar.gz` |

**Double-click it.** A window opens with the addresses Tempolight is running on, and your browser opens the app.
Close the window (or press Ctrl+C in it) to stop Tempolight. From a terminal it takes the same options as always
(`tempolight --help`); started without any, it opens the browser.

- **Windows:** the file isn't signed yet, so SmartScreen may say *Windows protected your PC*: click **More info** →
  **Run anyway**. Put it wherever you like (for example in `%LOCALAPPDATA%\Programs\Tempolight`) and pin it to Start.
- **macOS (.dmg):** open the .dmg and drag **Tempolight** to **Applications**. The first time, right-click (or
  Control-click) Tempolight in Applications → **Open** → **Open** (it isn't notarised by Apple yet). Opening it starts
  Tempolight and opens it in your browser; it has no window or Dock icon, so open the app again to get back to it, and
  quit it from **Settings → About → Quit Tempolight**. If macOS says it's damaged, run
  `xattr -dr com.apple.quarantine /Applications/Tempolight.app` once in Terminal.
- **macOS (.zip, for the terminal):** unzip it (double-click the zip). The app isn't notarised by Apple, so the first time, right-click (or
  Control-click) `tempolight` → **Open** → **Open**. If macOS still refuses, run
  `xattr -d com.apple.quarantine ~/Downloads/tempolight` once in Terminal. Homebrew avoids both steps.
- **Linux / Raspberry Pi:**

  ```bash
  curl -fsSLO https://github.com/D4RKGEEK/tempolight/releases/latest/download/tempolight-linux-arm64.tar.gz  # or -x64
  tar -xzf tempolight-linux-*.tar.gz && sudo mv tempolight /usr/local/bin/
  tempolight --open
  ```

  Listening to a sound card needs `ffmpeg` or `arecord` (`sudo apt install ffmpeg`), as with every other install.

Check a download against `SHA256SUMS.txt` from the same release: `sha256sum -c SHA256SUMS.txt --ignore-missing`
(Linux), `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` (macOS) or `Get-FileHash tempolight-windows-x64.exe`
(PowerShell).

The one-file app can't update itself: Settings shows how to get the new version.

## Homebrew (macOS, Linux)

```bash
brew install d4rkgeek/tempolight/tempolight
tempolight --open
```

To keep it running in the background and start it at login: `brew services start tempolight`, then open
<http://localhost:8080>. Update with `brew upgrade tempolight`.

## winget (Windows)

```powershell
winget install D4RKGEEK.Tempolight
tempolight --open
```

Open a new terminal after installing so it finds the `tempolight` command. Update with
`winget upgrade D4RKGEEK.Tempolight`.

## Scoop (Windows)

```powershell
scoop bucket add tempolight https://github.com/D4RKGEEK/homebrew-tempolight
scoop install tempolight
```

This also adds a **Tempolight** shortcut to the Start menu. Update with `scoop update tempolight`.

## npx and npm

With [Node.js](https://nodejs.org) 20 or newer, no download needed:

```bash
npx tempolight --open            # runs the latest version
npm install -g tempolight        # or install the tempolight command for good
```

Tempolight has no dependencies, so this installs one small package.

## Docker

```bash
docker run -d --name tempolight --network host -v tempolight:/data --restart unless-stopped ghcr.io/d4rkgeek/tempolight
```

The image is built for `amd64` and `arm64` (Raspberry Pi 4/5 with a 64-bit OS). Host networking lets Tempolight find
WLED controllers and stream to them. With Docker Compose, use [docker-compose.yml](../docker-compose.yml) (Linux,
Raspberry Pi) or [docker-compose.desktop.yml](../docker-compose.desktop.yml) (Docker Desktop on Windows or Mac, where
host networking is off by default: add controllers by IP on the Devices page). Tags: `latest`, `0.3`, `0.3.0`.

Every command, updating, and what doesn't work in Docker Desktop (discovery, Apple Home, now playing) and why:
[docker.md](guides/docker.md).

## Installer scripts

They install Node.js if needed, put Tempolight in your home folder with git (so it updates with one click in
Settings) and add a `tempolight` command.

```bash
# Linux, Raspberry Pi, macOS
curl -fsSL https://raw.githubusercontent.com/D4RKGEEK/tempolight/main/install/install.sh | sh
# Raspberry Pi that should run all the time: also start it at boot (systemd)
curl -fsSL https://raw.githubusercontent.com/D4RKGEEK/tempolight/main/install/install.sh | sh -s -- --service
```

```powershell
# Windows (PowerShell): also adds Start menu and desktop shortcuts
irm https://raw.githubusercontent.com/D4RKGEEK/tempolight/main/install/install.ps1 | iex
```

## From source

```bash
git clone https://github.com/D4RKGEEK/tempolight.git
cd tempolight
npm start                     # Node.js 20+; opens http://localhost:8080. No npm install needed
```

## Building the one-file app yourself

```bash
node scripts/build-sea.js --smoke    # dist/tempolight-<os>-<arch>[.exe], then starts it and checks that it answers
```

It bundles the server into one script (`scripts/bundle.js`, no dependencies), packs the web app's files in as
[SEA](https://nodejs.org/api/single-executable-applications.html) assets, and injects both into a copy of the Node.js
running the build (or `--node <path>`) with [postject](https://github.com/nodejs/postject), fetched by `npx` (set
`POSTJECT` to use another copy). On macOS it re-signs the result ad hoc (`codesign --sign -`), which Apple silicon
requires. Each executable is built on its own platform; there's no cross-building.

## For maintainers: publishing a release

Bump `version` in package.json, update CHANGELOG.md, then tag and push: `git tag v0.3.0 && git push origin v0.3.0`.
[.github/workflows/release.yml](../.github/workflows/release.yml) builds and smoke-tests the executables on Windows,
macOS (arm64 and x64) and Linux (x64 and arm64), creates the GitHub Release with them, `SHA256SUMS.txt` and
`tempolight-<version>-manifests.zip`, and pushes the Docker image to `ghcr.io/d4rkgeek/tempolight`. The rest is opt-in:

1. **npm** (`npx tempolight`): add an npm automation token as the repository secret `NPM_TOKEN`. Each release then runs
   `npm publish --provenance` (versions with a `-` go to the `next` tag). Check first that the name `tempolight` is
   free on npm.
2. **Homebrew tap and Scoop bucket**: create the public repository `D4RKGEEK/homebrew-tempolight` (an empty README is
   enough), and add a fine-grained token with *Contents: read and write* on that repository as the secret
   `HOMEBREW_TAP_TOKEN`. Each release then commits `Formula/tempolight.rb` (Homebrew) and `bucket/tempolight.json`
   (Scoop) there. Without the token, copy them from the release's manifests zip by hand.
3. **winget**: the first version goes in by hand: fork [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs),
   copy `winget/manifests/d/D4RKGEEK/Tempolight/<version>/` from the manifests zip into the same path, check it with
   `winget validate --manifest <that folder>` and `winget install --manifest <that folder>`, and open a pull request.
   Once it's merged, add a classic token with the `public_repo` scope as the secret `WINGET_TOKEN`, and later releases
   are sent automatically with `wingetcreate update`.
4. **Docker**: after the first push, make the package public under *GitHub → Packages → tempolight → Package
   settings*, so `docker pull` works without signing in.

The templates live in [packaging/](../packaging/) (`homebrew/`, `scoop/`, `winget/`); `{{version}}` and
`{{sha256:<file>}}` are filled in by `scripts/release-manifests.js`, which also works on an existing release:

```bash
node scripts/release-manifests.js --release v0.3.0    # writes dist/packaging/ from that release's SHA256SUMS.txt
```

Run the Release workflow by hand (*Actions → Release → Run workflow*) to build and test everything without publishing.
