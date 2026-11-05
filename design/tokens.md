# Tempolight design system (revamp, Nov 2026)

Follows design/taste-playbook.md (the Taste Skill rules): neutral interface, colour lives in the lights and ONE accent,
depth from a 1px ring plus a long soft tinted shadow (no borders, no glassmorphism cards, no gradient text, no purple),
headings carried by size and tight tracking (600 max), one font family + one mono, sentence case, no emoji, no em-dashes.
Tempolight is about light in a dark room: the app and the landing hero are dark-first; light theme is warm cream.

Font: "Google Sans Flex" (Google Fonts, variable), fallback -apple-system, "Segoe UI", system-ui, sans-serif.
Mono: "Google Sans Code", ui-monospace, Menlo, monospace. Load with a <link> where online; the app must look fine offline
(system fallback). Banned: Inter, Roboto, Open Sans, Lato, Montserrat, Poppins, Space Grotesk, Plus Jakarta Sans.

```css
:root, [data-theme="dark"] {
  --bg: #0f0d0b; --bg-deep: #0a0807; --surface: #17140f; --surface-2: #1e1a14; --sunk: #0b0a08;
  --text: #f4efe8; --text-2: rgb(244 239 232 / .64); --text-3: rgb(244 239 232 / .42);
  --hair: rgb(255 255 255 / .07); --ring: 0 0 0 1px rgb(255 255 255 / .06);
  --accent: #ff8a1f; --accent-ink: #1a0e08; --label: #ffb366; --focus: #ffb366;
  --ok: #3ecf7a; --warn: #f5b83d; --bad: #ff5c5c; --calm: #5b8cff; --build: #f5b83d; --drop: #ff4f8b;
  --shadow-card: var(--ring), 0 1px 2px rgb(0 0 0 / .3), 0 18px 40px -28px rgb(0 0 0 / .8);
  --shadow-lift: 0 0 0 1px rgb(255 255 255 / .1), 0 1px 2px rgb(0 0 0 / .3), 0 24px 44px -26px rgb(0 0 0 / .9);
}
[data-theme="light"] {
  --bg: #f8f4ee; --bg-deep: #140a05; --surface: #ffffff; --surface-2: #fffaf6; --sunk: #f3eee7;
  --text: #1a0e08; --text-2: rgb(26 14 8 / .62); --text-3: rgb(26 14 8 / .42);
  --hair: rgb(20 10 5 / .06); --ring: 0 0 0 1px rgb(20 10 5 / .05);
  --accent: #ff5b14; --accent-ink: #ffffff; --label: #c2410c; --focus: #c2410c;
  --ok: #1f6b37; --warn: #a15c00; --bad: #c0262d;
  --shadow-card: var(--ring), 0 1px 2px rgb(20 10 5 / .04), 0 18px 40px -28px rgb(80 30 5 / .25);
  --shadow-lift: 0 0 0 1px rgb(20 10 5 / .08), 0 1px 2px rgb(20 10 5 / .05), 0 24px 44px -26px rgb(80 30 5 / .34);
}
:root {
  --sans: "Google Sans Flex", -apple-system, "Segoe UI", system-ui, sans-serif;
  --mono: "Google Sans Code", ui-monospace, Menlo, monospace;
  --r-btn: 11px; --r-field: 11px; --r-card: 24px; --r-inner: 18px; --r-pill: 999px;
  --ease: cubic-bezier(.2,.8,.2,1); --ease-out-expo: cubic-bezier(.16,1,.3,1); --t-in: .14s; --t-out: .2s;
  --space: 4px 8px 12px 16px 24px 32px 48px 64px 96px 128px; /* scale (reference) */
}
```

Components (one style each, used everywhere): button primary (accent fill, accent-ink text, 44px, radius 11, 15px/500,
hover up 1px, press down 1px scale .985), button secondary (surface, ring + soft shadow), card (surface, radius 24,
shadow-card, linked cards lift 2px on hover), cells grid (one rounded container on --hair with 1px gaps), pill (radius
999, sunk ground), field (sunk ground, radius 11, ring, focus ring in --focus), segmented control, toggle, slider,
table (hairline rows, mono numbers), status dot (ok/warn/bad), code block (bg-deep, radius 12, mono 13.5).
Type: h1 64-84px/600 tracking -0.042em on marketing, page title 28px/600 -0.03em in the app; h2 44/30px marketing,
section title 17px/600 in the app; body 16/1.5; meta 13px text-2. Reading text ≥16px. Motion 140ms in / 200ms out,
no bounce, everything rests under prefers-reduced-motion.
Copy rules: buttons are verb + object ("Play the demo track", "Copy the setup prompt"), never Learn more/Explore/Discover;
banned words: seamless, effortless, cutting-edge, unlock, elevate, supercharge, reimagine, next-generation,
game-changing, powerful, robust; no exclamation marks, no question headlines, no invented stats/reviews/logos.
