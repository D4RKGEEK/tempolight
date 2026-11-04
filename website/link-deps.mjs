// The pages live in ../docs, outside this folder, and the Markdown compiled into Vue components imports "vue" from
// there. Node looks for node_modules next to the file, so point docs/node_modules at this folder's (a junction on
// Windows). It's git-ignored and excluded from the site.
import { existsSync, lstatSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)), link = path.join(here, "../docs/node_modules"), target = path.join(here, "node_modules");
try { if (lstatSync(link).isSymbolicLink()) unlinkSync(link); } catch {}
if (!existsSync(link)) symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
