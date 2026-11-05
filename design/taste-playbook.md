Taste Skill landing page playbook
5 Nov 2026 · @Vaibhav
What Taste Skill is
Taste Skill is an open-source, MIT-licensed agent skill that makes Claude Code, Codex and Cursor build landing pages that look designed rather than generated. You install it with npx skills add Leonxlnx/taste-skill, and it needs Node 22+ and Chrome, Edge or Chromium.
This playbook has three layers you can use separately:
• The site's own design system (sections 2 to 4): the real tokens, components and page structure measured from the live tasteskill.dev at 1440x900. Use these to build a page that looks like theirs.
• The skill's rules (section 5): what the skill forces any landing page to do, whatever its look. Use these for every page you build.
• The build process (sections 6 and 7): the run the skill follows and the prompts that trigger it.
Two versions exist right now. The GitHub repo's design-taste-frontend is 2.5.0: it deals a hero with deal.mjs, uses a fixed system (system.css, 12-column grid, one section per screen) and checks with consistency.mjs and check.mjs. The live docs describe a newer run: draw.mjs deals three of 20 art directions distilled from 247 curated sites, assets.mjs finds licensed photographs, and inspect.mjs checks the page at 1440, 768 and 390. The principles below hold in both; where a script name differs, both are named.
Sources: tasteskill.dev, docs, guide, GitHub repo.
Design tokens
The site runs on one warm palette (cream ground, near-black brown ink, one orange accent), one variable font, and layered hairline-plus-glow shadows instead of borders. Values below are read from the rendered page's computed styles.
Token
Value
Used for
--cream
#f8f4ee
Page ground
--ink
#1a0e08
Text, primary dark button, dark band
--ink-deep
#140a05
Footer ground, hero top, code wells
--surface
#ffffff
Cards, secondary buttons
--sunk
#f3eee7
Inset fields, code chips, active nav item
--text-2
ink at 62%
Ledes, card descriptions, meta
--hair
ink-deep at 6%
Cell gaps, dividers
--orange
#ff5b14
Accent: chart highlight, caret, progress
--label
#c2410c
Eyebrows, small labels, focus ring (passes contrast on cream)
--rust / --peach
#7a2306 / #ffc9a3
Stops in the hero sunset gradient
Type
Desktop (1440)
Mobile (390)
Font
Google Sans Flex (variable 1 to 1000); Google Sans Code for code
same
H1 hero
84px / 600, line 1.02, tracking -0.042em
40px
H1 docs
60px / 600, tracking -0.042em

H2 section
44px / 600, line 1.08, tracking -0.035em
30px
Card title
19 to 20px / 600, tracking -0.025em

Lede
19px / 400, line 1.55, ink at 92% on dark, 62% on light
16px
Body
16px / 400, line 1.5
16px
Nav and buttons
15px / 500, tracking -0.01em

Eyebrow
15px / 600 in --label

UI fragments
11 to 13px

Shape and depth
Value
Button radius
11px (48px tall in hero, 44px elsewhere)
Card radius
24 to 28px outer, inner art 19 to 22px (outer minus 6px padding)
Pill radius
999px
Card shadow
0 0 0 1px #140a050d, 0 1px 2px #140a050a, 0 18px 40px -28px #501e0540
Hover lift shadow
0 0 0 1px #140a0514, 0 1px 2px #140a050d, 0 24px 44px -26px #501e0557
Motion
ease cubic-bezier(.2,.8,.2,1), 140ms in, 200ms out; entrance ease-out-expo 0.9s, 70ms stagger, 28px rise
Widths
text column 880px, wide column 1080px, gutter 16px
Ready-to-paste root block:
:root {
  --cream: #f8f4ee; --ink: #1a0e08; --ink-deep: #140a05;
  --surface: #fff; --surface-hover: #fffaf6; --sunk: #f3eee7;
  --text: var(--ink); --text-2: #1a0e089e; --hair: #140a050f;
  --orange: #ff5b14; --label: #c2410c; --focus: #c2410c;
  --rust: #7a2306; --peach: #ffc9a3;
  --ring: 0 0 0 1px #140a050d;
  --shadow-card: var(--ring), 0 1px 2px #140a050a, 0 18px 40px -28px #501e0540;
  --shadow-lift: 0 0 0 1px #140a0514, 0 1px 2px #140a050d, 0 24px 44px -26px #501e0557;
  --w: 880px; --w-wide: 1080px; --gutter: 16px;
  --ease: cubic-bezier(.2,.8,.2,1); --t-in: .14s; --t-out: .2s;
  --ease-out-expo: cubic-bezier(.16,1,.3,1);
  --sans: "Google Sans Flex", -apple-system, "Segoe UI", sans-serif;
  --mono: "Google Sans Code", ui-monospace, Menlo, monospace;
}
body { background: var(--cream); color: var(--text); font: 400 16px/1.5 var(--sans); }
h1, h2 { font-weight: 600; letter-spacing: -0.04em; line-height: 1.04; }
The principle to copy, not just the hex values: the interface stays mostly neutral, colour lives inside the pictures and one accent, depth comes from a 1px ring plus a long soft tinted shadow, and headings get size and tight tracking rather than heavy weight.
Component catalogue
Every component is a variation of three recipes: a white card with the ring-and-glow shadow, a dark ink surface, or a translucent pill on a busy ground. Specs are measured at 1440 wide.
Component
Spec
Notes
Nav (floating)
Fixed, 18px from top, 720px wide, 50px tall, radius 16px, 3-column grid (logo, links, CTA); backdrop-filter: blur(14px) saturate(1.4)
Links 15px at ink 72%; the GitHub star button is the one filled dark button (36px). On mobile the links become 46px rows, the active one on --sunk
Hero pill
30px tall, radius 999px, padding 4px 12px 4px 4px, white at 10% with a 1px inner white ring at 12%, blur 10px
Announces one piece of news ("TasteCode is out"), links to it
H1 hero
84px/600, two lines, cream on the dark gradient, words split into spans for a staggered rise
Centred; at most two lines
Install chip (primary CTA)
48px tall, radius 11px, ink at 90%, 1px white ring at 12%, mono 12px command, 36px copy square on the right
The main action is copying the command, not a link
Secondary button
48px, radius 11px, white fill, 15px/500 ink, shadow 0 0 0 1px ink 5% + 0 4px 12px -6px rust 30%
Verb-plus-object label ("Read the docs")
Dark button
44px, radius 13px, ink fill, white 16px/500, padding 0 22px 0 24px, deeper glow shadow
Used once per section at most
Segmented tabs
42px track, radius 13px, white at 50%, blur 12px; each tab 12.5px/500, active tab white with a small shadow
Switches the hero showcase (Coffee shop, Club night, Architects, Contracts)
Showcase frame
Radius 26px, 6px padding, white at 68%, long warm shadow 0 40px 90px -40px; inner stage radius 14px on ink
Real screenshots of pages built with the skill
Eyebrow
15px/600 in --label, inline-flex with a 7px gap
Sits above every H2 (note: the skill bans eyebrows on pages it builds; the site uses them)
Cells grid
One rounded container (radius 20 to 22px) on --hair, gap: 1px, white cells inside
Sponsors, FAQ and the 20-direction list all use it: the 1px gap draws the dividers
Feature card
Radius 28px, 6px padding, white, card shadow; 2 columns: art panel (radius 22px, 64px 44px padding) + copy (26px 22px 28px)
Art panel holds a live UI fragment; copy has a 14.5px orange label, title, 16px description, and a mono file chip
UI fragment
Radius 16px, white, 13px text, title bar 12px at ink 58%, footer row on #fdfaf6, status chips 11px/600 (orange on #ffe4d6 for FAIL, green #1f6b37 for OK)
Real product UI at true size, never a toy screenshot
Deal card
Radius 14px, white, padding 11px 20px 12px 15px, orange number, 20px/600 name, 15px meta
Shows the three dealt directions
Before/after
2 columns: step list with a 2px rail on the left, framed screen (radius 24px) on the right
A sticky scroll scene stepping 1 of 4
Code block
Ink ground, radius 12px, 13.5px mono, cream text at 92%
Inline code: 15.5px on ink at 6%, radius 6px
Footer
--ink-deep ground, cream text at 72%, three link columns of 224px, links 14.5px
A huge wordmark band precedes it ("Stop guessing, start deciding.")
Three recipes to reuse anywhere:
.card { background: var(--surface); border-radius: 28px; padding: 6px; box-shadow: var(--shadow-card); transition: transform var(--t-in) var(--ease), box-shadow var(--t-in) var(--ease); }
a.card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.cells { display: grid; gap: 1px; background: var(--hair); border-radius: 20px; overflow: hidden; box-shadow: var(--shadow-card); }
.cells > * { background: var(--surface); padding: 18px 18px 20px; }
.pill { display: inline-flex; gap: 9px; padding: 4px 12px 4px 4px; border-radius: 999px; background: rgb(255 255 255 / .1); box-shadow: inset 0 0 0 1px rgb(255 255 255 / .12); backdrop-filter: blur(10px); font-size: 14px; }
How the landing page is put together
The page tells one story in order: show the result, explain the method, prove it, make install trivial, answer doubts, then close on one line.
Three structural habits carry it. Content sits in an 880px text column with a 1080px wide column for cards and frames, so headings and copy stay on one measure while visuals get more room. Sections start 104px below the previous one and are parted by space and ground changes, never by rules. Three moments use sticky scroll scenes (the draw, before and after, the closing line); everything else is static with a hover layer.
To reuse the pattern for your own product, keep the order and swap the content: hero with your real product, a proof strip, how it works as feature cards with live UI, a before and after, setup, FAQ, a closing line, footer.
Rules for any landing page
The skill's core claim: a page looks designed when it says plainly what is sold, shows the real thing on every screen, and holds to one system. The bar it names is figma.com and x.ai.
Decide the kind first. The type of business sets everything else.
Kind
Examples
Leads with
Effects allowed
Software
SaaS, AI, dev tools, fintech app
The product's own UI as live HTML in one app frame
One effect, one or two moments, card loops
Gaming
A game launch
Name in the h1, key art full bleed
One effect, moments
Hardware
Drone, keyboard, robot arm
Photographs, else a 3D render
One effect
Product
Chair, bike, coffee beans
Photographs of the product, big
None: photographs, flat colour, type
Service
Clinic, law firm, agency
People, rooms, the work
None
Place
Cafe, bakery, guesthouse, shop
12 to 20 photographs of the place
None
Layout
• The hero fills the first screen alone; nothing of the next section shows at load.
• Every section is exactly one or two screens tall, with its h2 first and top-aligned.
• One .wrap of 1280px (80px gutters at 1440), 12 columns, 24px gutter. Equal left and right edges everywhere.
• Splits put text left and the visual right, every time. Never mirrored or alternating.
• Sections are separated by a full-width ground change or space only. No rules or shadows between them.
• Spacing scale 4, 8, 12, 16, 24, 32, 48, 64, 96, 128. Heading to content 48px; cards 24px apart.
Type and colour
• One family, or a display face plus a text face. Never three. Banned faces: Inter, Roboto, Open Sans, Lato, Montserrat, Poppins, Space Grotesk, Plus Jakarta Sans.
• Headlines at 400 (500 on tech), carried by size and tight tracking, never 700 or 800. Sizes h1 72/38, h2 48/30, lead 20/18, body 16/26.
• Reading text 16px or larger at 7:1 contrast. Muted grey only for labels and meta. Sentence case; no all-caps labels.
• Interface 90 to 95% neutral. One accent at most, used for the primary button, focus and links. Never violet or lavender.
Copy
• The h1 names the category and the buyer in 2 to 8 words ("Shift planning for restaurant teams", not "Every shift, sorted").
• The first screen holds one hard fact: a number, price, place or date.
• Buttons are a verb plus what you get ("Start a free trial"). Never "Learn more", "Explore" or "Discover".
• At most two hero actions; the main action reads the same in nav, hero, close and mobile bar.
• 60 to 80 words per screen on tech pages; about 900 words for the whole page.
• No invented reviews, logos, stats or testimonials. No placeholders, "lorem ipsum" or # links.
• Banned words: seamless, effortless, cutting-edge, unlock, elevate, supercharge, reimagine, next-generation, game-changing, powerful, robust. No em-dashes, no exclamation marks, no question headlines.
Motion
• Every page has the hover layer: buttons step up 1px and press down 1px at 0.985 scale, linked cards lift 2px, photographs zoom 1.02 to 1.03 inside their frame, underlines draw left to right.
• Timing: 140ms in, 200ms out, 90ms press, ease cubic-bezier(.2,.8,.2,1). No bounce.
• Card loops on tech pages cycle every 2.5 to 4s and restart on hover; anything moving past 5s gets a pause button.
• No tilt, carousels, timed tabs, scroll-snap or scroll-jacking. Everything rests under reduced motion.
Banned outright: purple gradients, glassmorphism cards, emoji, gradient text, three equal icon cards, section-number eyebrows (01/02/03), scroll cues, stock photos passed off as the product, captions under images, centred hero text wider than half the page.
How to build one with the skill
Install once, write a brief, and let the skill run its six steps; a build takes about 30 to 45 minutes and a few hundred thousand tokens, including up to three rounds of fixing its own screenshots.
npx skills add https://github.com/Leonxlnx/taste-skill --skill "design-taste-frontend"
# Claude Code plugin instead:
/plugin marketplace add Leonxlnx/taste-skill
/plugin install taste-skill@taste-skill
1. Inventory. List 8 to 12 things only this client has: the name and what it means, the numbers, the one constraint, the materials, the hours. Write the page as claims with proof, one line per section.
2. Draw (or deal). draw.mjs deals three of 20 art directions away from your recent builds; pick the one the inventory can carry. In repo 2.5, deal.mjs deals the hero and start.mjs deals three palettes and three font pairings. Never choose by taste.
3. The idea. One sentence: something from the subject becomes the device the direction calls for. It must fail for the nearest competitor. Write all copy before any markup.
4. Build. Build from the dealt sheet. Real pictures come from assets.mjs (Openverse, Wikimedia Commons, the Met, Art Institute of Chicago; CC0, public domain, CC BY, CC BY-SA only), credited in one footer line.
5. Gate. lint.mjs scans the source for banned patterns; inspect.mjs opens the page at 1440, 768 and 390 and fails it on slop. Every FAIL is fixed.
6. Look and fix. Score the screenshots (design 40%, usability 30%, creativity 20%, content 10%), fix the top three problems, inspect again. Three rounds at most, then report.
Prompt for a new site (from the site's guide):
Use the design-taste-frontend skill.
Page kind: landing page
Product: <name> - <one-line description>
Audience: <who, with concrete adjectives>
Vibe: <2 to 4 concrete adjectives>
References: <real URLs or product names>
Avoid: <slop patterns you hate>

First state your design read in one sentence and stop for my approval.
Then build the page with real images and one theme.
End with: em-dash audit, pre-flight check (pass/fail each item),
section-layout repetition audit, hero discipline audit. Any fail blocks completion.
Prompt for a redesign: give the URL or repo path, the mode (preserve brand, overhaul, or unsure), the audience, two or three things that work today, two or three that are broken, and any routes, headings or anchors SEO needs kept. The skill audits first (brand tokens, information architecture, patterns to keep and retire), stops for approval, declares its mode, then changes the page while keeping URLs, nav labels, form field names, logo and legal copy.
To keep your own brand, paste your style guide at the top of SKILL.md; the agent reads it on every run and it takes priority.
Docs page anatomy and pre-ship checklist
The docs page reuses the landing page's tokens in a calmer layout: same floating nav, cream ground and dark footer, no hero art.
• Header block: H1 60px/600 ("How Taste Skill works."), lede 18px at ink 62% capped at 576px, starting 140px from the top.
• Two columns: content 808px from x 180, plus a sticky table of contents 200px wide at x 1060.
• Sections: H2 32px/600, H3 17px/600, code blocks on ink with radius 12px, inline code chips, quiet notes at 15px.
• Order: Install, How a build runs, Pages and app screens, Redesigning a page, What the inspector checks, The library, Pictures and credits, Moved skills, Questions, then an install call-to-action band and the footer.
Before shipping any landing page, check:
[ ] The first screen says what is sold, for whom, with one hard fact, and holds only the hero with its main button.
[ ] Every section is one or two screens, h2 first, top-aligned, with nothing of the next section peeking in.
[ ] Left and right content edges are equal at 1440, 1024, 768 and 390; nothing scrolls sideways.
[ ] Every visual renders at every width; real photographs or real product UI, no captions under them.
[ ] One button pair, one card style, one radius scale, one link look, at most two font families.
[ ] Body text 16px or larger, contrast 7:1 for reading text, sentence case, no em-dashes.
[ ] Buttons are a verb plus an object; at most two hero actions; the main action worded the same everywhere.
[ ] Every button, link and linked card visibly answers hover and press; nothing tilts or moves on scroll.
[ ] Under reduced motion everything rests and nothing stays hidden.
[ ] No invented proof, no placeholders, no # links, credits in one footer line.
[ ] At 390: one column, full-width buttons, a full-screen menu.