# Online demo on Cloudflare

The online demo is the real Tempolight app running entirely in the visitor's browser: the same core, runtime, director
and effects as the home install, with three pretend WLED controllers instead of a network. Visitors can play songs,
use the pads, edit the room, save scenes and set a PIN; everything they change stays in their own browser.

Cloudflare only serves static files (a Worker with static assets), so it's free and needs no server code.

## Set up once (from a phone works too)

1. Sign in to [dash.cloudflare.com](https://dash.cloudflare.com) and open **Workers & Pages**.
2. **Create** → **Import a repository** → connect GitHub and pick `D4RKGEEK/tempolight`.
3. Use these settings:

   | Setting | Value |
   | --- | --- |
   | Project name | `tempolight` |
   | Production branch | `main` |
   | Build command | `node scripts/build-site.js` |
   | Deploy command | `npx wrangler deploy` |
   | Root directory | `/` (leave empty) |

4. **Save and deploy.** The demo is live at `https://tempolight.<your-account>.workers.dev` in about a minute.

From then on every push to `main` rebuilds and redeploys automatically. Pull requests get their own preview link.

To use your own domain: Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain**.

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
npx wrangler deploy                 # deploy by hand, if you're signed in to wrangler
```

`wrangler.jsonc` points Cloudflare at `dist/site` and serves `index.html` for unknown paths.
