# Online demo on Cloudflare

The online demo is the real Tempolight app running entirely in the visitor's browser: the same core, runtime, director
and effects as the home install, with three pretend WLED controllers instead of a network. Visitors can play songs,
use the pads, edit the room, save scenes and set a PIN; everything they change stays in their own browser.

Cloudflare Pages only serves static files, so it's free and needs no server code. To drive real lights, install
Tempolight at home: [Your first show](guides/first-run.md).

## Set up once (from a phone works too)

1. Sign in to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**, and pick `D4RKGEEK/tempolight`.
2. Use these build settings:

   | Setting | Value |
   | --- | --- |
   | Project name | `tempolight` |
   | Production branch | `main` |
   | Framework preset | None |
   | Build command | `node scripts/build-site.js` |
   | Build output directory | `dist/site` |

3. **Save and deploy.** The demo is live at `https://tempolight.pages.dev` in about a minute.

Already created the project without a build command (the site shows 404)? Open the project → **Settings** →
**Build** → **Build configuration** → **Edit**, set the build command and output directory above, then go to
**Deployments** and press **Retry deployment** on the latest one.

From then on every push to `main` rebuilds and redeploys automatically, and pull requests get their own preview link.
To use your own domain: project → **Custom domains** → **Set up a custom domain**.

## Install it on an iPhone

Open the demo (or your home install) in **Safari** → **Share** → **Add to Home Screen**. It opens full screen like an
app, with its own icon. On Android, Chrome offers **Install app**.

The home install works as an app too: open `http://<your computer's IP>:8080` in Safari and add it to the home
screen. Offline caching needs HTTPS, so on a home network the app needs the Tempolight server running, which it
always does anyway.

## Build it yourself

```bash
node scripts/build-site.js          # writes dist/site
node scripts/e2e-demo.js            # clicks through the demo in a real browser (needs Playwright)
npx wrangler pages deploy           # deploy by hand, if you're signed in to wrangler
```

`wrangler.jsonc` tells Cloudflare Pages to publish `dist/site`. Pages serves `index.html` for unknown paths, and `_headers`
keeps the service worker uncached so updates arrive straight away.
