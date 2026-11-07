// Genre hints: what a music service says a song is (Spotify's artist genres, a music app's genre tag), mapped to
// Tempolight's styles (party, poprock, hiphop, chill, emotional). Pure JavaScript, no I/O (it runs in the browser too).
//
// While listening live, the style is a guess from the drums and the tempo (live.js estimateStyle). A hint makes it a
// prior instead: the style is the hint's from the first second, unless what is heard clearly says otherwise (no drums
// at all for a hip hop artist's piano interlude). It matters most for the drop countdown (drops.js): an EDM drop is
// only predicted for party songs; in hip hop the "drop" is the beat coming back after a break.

// [style, label, words]: the first rule with a word found in a genre wins; rules are tried in this order, so "desi
// hip hop" is hip hop (not desi pop), "pop rap" is hip hop, "dance pop" is pop and "edm trap" is EDM.
const RULES = [
  ["party", "EDM", ["edm", "house", "techno", "trance", "dubstep", "drum and bass", "dnb", "electro", "big room", "hardstyle", "gabber", "future bass", "bass music", "brostep", "uk garage", "eurodance", "dance music", "rave", "breakbeat", "jungle", "psytrance", "moombahton", "melbourne bounce", "tech house", "uk funky"]],
  ["hiphop", "Hip hop", ["hip hop", "hip-hop", "hiphop", "rap", "trap", "drill", "grime", "boom bap", "phonk", "crunk", "gangsta", "horrorcore", "g-funk", "bounce", "desi hip hop", "indian hip hop", "gully"]],
  ["hiphop", "Desi beats", ["punjabi", "bhangra", "haryanvi", "dhol"]],
  ["chill", "Chill", ["lo-fi", "lofi", "chill", "ambient", "downtempo", "new age", "sleep", "meditation", "jazz", "bossa", "lounge", "classical", "instrumental", "study", "trip hop", "acoustic"]],
  ["emotional", "Ballad", ["ballad", "sad", "ghazal", "sufi", "soul", "singer-songwriter", "torch", "romantic"]],
  ["poprock", "Pop", ["bollywood", "filmi", "desi", "tollywood", "kollywood", "k-pop", "j-pop", "pop", "dance pop", "latin", "reggaeton", "afrobeat", "afrobeats", "amapiano", "funk", "disco", "r&b", "rnb"]],
  ["poprock", "Rock", ["rock", "metal", "punk", "indie", "grunge", "emo", "alternative", "country", "folk", "blues"]],
];
export const GENRE_STYLES = ["party", "poprock", "hiphop", "chill", "emotional"];
const LABEL = { party: "EDM", poprock: "Pop / rock", hiphop: "Hip hop", chill: "Chill", emotional: "Ballad" };
const has = (g, w) => { const i = g.indexOf(w); if (i < 0) return false; const a = g[i - 1], b = g[i + w.length]; return (!a || !/[a-z]/.test(a)) && (!b || !/[a-z]/.test(b)); };

/**
 * The style that a list of genres (any case, most important first) says, or null when none is known.
 * @param {string[]|string} genres
 * @returns {{style: string, label: string, genre: string} | null} genre: the genre it was read from
 */
export function styleOfGenres(genres) {
  const list = (Array.isArray(genres) ? genres : [genres]).map(g => String(g || "").toLowerCase().trim()).filter(Boolean).slice(0, 12);
  if (!list.length) return null;
  // each genre votes for the first rule it matches, the first genres (the artist's main ones) counting most
  const score = new Map(); let best = null;
  list.forEach((g, i) => { for (const [style, label, words] of RULES) if (words.some(w => has(g, w))) { const k = style + "|" + label, v = (score.get(k)?.v || 0) + 1 / (1 + i * 0.5); score.set(k, { style, label, v, genre: score.get(k)?.genre || g }); break; } });
  for (const s of score.values()) if (!best || s.v > best.v) best = s;
  return best ? { style: best.style, label: best.label, genre: best.genre } : null;
}

/**
 * A genre hint for the live analyser (an.genreHint), or null: from a list of genres and where they came from.
 * @param {string[]|string} genres @param {string} source "spotify" | "nowplaying" | ...
 * @returns {{style, label, genre, genres: string[], source} | null}
 */
export function genreHint(genres, source) {
  const s = styleOfGenres(genres); if (!s) return null;
  return { ...s, genres: (Array.isArray(genres) ? genres : [genres]).filter(Boolean).slice(0, 6).map(String), source: String(source || "") || null };
}
/** A short label for a hint: "Hip hop · from Spotify". */
export function hintLabel(h) {
  if (!h) return null; const src = { spotify: "Spotify", nowplaying: "the music app", music: "Apple Music", manual: "you" }[h.source] || h.source;
  return src ? `${h.label || LABEL[h.style]} · from ${src}` : h.label || LABEL[h.style];
}
