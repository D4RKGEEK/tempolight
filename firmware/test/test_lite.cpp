// Host test for the Tempolight Lite core (firmware/core): synthetic songs -> emulated WLED GEQ frames -> analyser and
// effects. Build and run: firmware/test/run.sh (or `npm run test:firmware`). Set TL_TRACE=1 to print a frame trace.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <array>
#include <vector>

#include "../core/tempolight_lite.h"
#include "synth.h"

using namespace tempolight;

static int failures = 0, checks = 0;
#define CHECK(cond, ...) do { checks++; if (!(cond)) { failures++; printf("  FAIL %s:%d: ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

struct Trace { double t; LiteState s; };

static std::vector<Trace> analyse(const synth::Song& song, LiteAnalyser& a, double noise = 0.0, bool print = false) {
  synth::Geq geq; auto frames = geq.run(song.x, song.sr, 0.3, noise);
  std::vector<Trace> tr; a.reset();
  for (auto& f : frames) {
    const uint32_t ms = (uint32_t)(f.t * 1000 + 0.5) + 1000;  // the device clock doesn't start at 0
    a.update(f.fft, f.volume, ms);
    tr.push_back({f.t, a.state()});
    if (print) { const LiteState& s = a.state();
      printf("%7.3f %s%s%s bpm=%6.2f lock=%d beat#%3u/%u %-6s loud=%.2f bass=%.2f bp=%.2f |", f.t, s.kick ? "K" : ".", s.snare ? "S" : ".", s.beat ? "B" : ".",
        s.bpm, s.locked, s.beatCount, s.beatInBar, sectionName(s.section), s.loud, s.bass, s.buildProgress);
      for (int i = 0; i < 16; i++) printf("%4d", f.fft[i]);
      printf("\n"); }
  }
  return tr;
}

static double secOf(const Trace& t, const LiteState& s, uint32_t ms) { return t.t - (s.nowMs - ms) / 1000.0; }

static void testEdm(double bpm, double noise) {
  printf("EDM %.0f BPM, noise %.3f\n", bpm, noise);
  synth::Song song = synth::edm(bpm);
  LiteAnalyser a; const bool print = getenv("TL_TRACE") != nullptr;
  auto tr = analyse(song, a, noise, print);
  const double beat = 60 / bpm, drop = song.dropStart, dropEnd = drop + 8 * song.bar, build = song.buildStart;

  // tempo: right by the middle of the drop and at its end
  float midBpm = 0, endBpm = 0; for (auto& x : tr) { if (x.t < drop + 4 * song.bar) midBpm = x.s.bpm; if (x.t < dropEnd) endBpm = x.s.bpm; }
  CHECK(fabs(midBpm - bpm) < 1.5, "tempo mid-drop %.2f, want %.0f", midBpm, bpm);
  CHECK(fabs(endBpm - bpm) < 1.5, "tempo at end of drop %.2f, want %.0f", endBpm, bpm);

  // kicks: one per beat in the drop, none in the intro (there are none)
  int kicksDrop = 0, kicksIntro = 0;
  for (auto& x : tr) if (x.s.kick) { if (x.t > drop && x.t < dropEnd + 0.1) kicksDrop++; if (x.t < build) kicksIntro++; }
  CHECK(abs(kicksDrop - 32) <= 3, "kicks in the drop: %d, want ~32", kicksDrop);
  CHECK(kicksIntro == 0, "kicks in the intro: %d, want 0", kicksIntro);

  // beats: one per beat in the second half of the drop, each close to the real beat time
  int beats = 0; double err = 0, worst = 0;
  for (auto& x : tr) if (x.s.beat && x.t > drop + 4 * song.bar && x.t < dropEnd) {
    beats++; const double bt = (x.s.lastBeatMs - 1000) / 1000.0, rel = (bt - drop) / beat, d = fabs(rel - floor(rel + 0.5)) * beat; err += d; worst = fmax(worst, d); }
  CHECK(abs(beats - 16) <= 1, "beats in the second half of the drop: %d, want 16", beats);
  CHECK(beats && err / beats < 0.02 && worst < 0.04, "beat grid error %.0f ms mean, %.0f ms worst; want < 20 / 40 ms (frames are 23 ms)", beats ? err / beats * 1000 : 0, worst * 1000);

  // song parts: calm intro, a build-up, the drop found within a beat or two of its start, no drop before it
  int introCalm = 0, introN = 0, buildN = 0, buildB = 0, dropN = 0, dropD = 0, earlyDrop = 0;
  for (auto& x : tr) {
    if (x.t > 1.5 && x.t < build) { introN++; if (x.s.section == Section::Calm) introCalm++; }
    if (x.t > build + 2 && x.t < drop) { buildN++; if (x.s.section == Section::Build) buildB++; }
    if (x.t > drop + 1 && x.t < dropEnd) { dropN++; if (x.s.section == Section::Drop) dropD++; }
    if (x.t < drop - 0.2 && x.s.section == Section::Drop) earlyDrop++;
  }
  const LiteState& last = tr.back().s;
  CHECK(introCalm > 0.9 * introN, "intro calm %d/%d", introCalm, introN);
  CHECK(buildB > 0.7 * buildN, "build-up detected %d/%d frames", buildB, buildN);
  CHECK(dropD > 0.9 * dropN, "drop held %d/%d frames", dropD, dropN);
  CHECK(earlyDrop == 0, "drop before the drop: %d frames", earlyDrop);
  double firstDrop = -1; for (auto& x : tr) if (x.s.drops && firstDrop < 0) firstDrop = secOf(x, x.s, x.s.dropMs);
  CHECK(firstDrop >= drop - 0.05 && firstDrop < drop + 2 * beat, "drop detected at %.2f s, want %.2f s (+2 beats)", firstDrop, drop);
  CHECK(last.drops == 1, "drops counted: %u, want 1", last.drops);
  // build-up progress rises
  float bpA = 0, bpB = 0; for (auto& x : tr) { if (x.t < build + 3.5) bpA = x.s.buildProgress; if (x.t < drop - 0.1) bpB = x.s.buildProgress; }
  CHECK(bpB > bpA && bpB > 0.6f, "build progress %.2f -> %.2f", bpA, bpB);
  // the drop's downbeat is beat 0 of the bar
  int onDown = 0, nDown = 0;
  for (auto& x : tr) if (x.s.beat && x.t > drop + 4 * song.bar && x.t < dropEnd) { const long bi = lround(((x.s.lastBeatMs - 1000) / 1000.0 - drop) / beat); nDown++; if ((bi & 3) == x.s.beatInBar) onDown++; }
  CHECK(nDown && onDown >= nDown - 1, "beat in bar right %d/%d", onDown, nDown);
  // after the drop: not a drop any more by the end of the outro, silent in the final silence
  Section outro = Section::Drop, tail = Section::Drop;
  for (auto& x : tr) { if (x.t < song.end - 0.1) outro = x.s.section; tail = x.s.section; }
  CHECK(outro != Section::Drop, "outro section %s", sectionName(outro));
  CHECK(tail == Section::Silent, "final silence section %s", sectionName(tail));
  printf("  bpm %.2f, drop at %.2f s, %d kicks in the drop, %d beats checked (mean error %.0f ms)\n", endBpm, firstDrop, kicksDrop, beats, beats ? err / beats * 1000 : 0);
}

static void testQuiet() {
  printf("silence and drumless pads\n");
  LiteAnalyser a; uint8_t zero[16] = {0};
  for (uint32_t ms = 0; ms < 10000; ms += 23) a.update(zero, 0, ms);
  CHECK(a.state().section == Section::Silent && !a.state().kicksTotal && !a.state().drops, "silence: %s, %u kicks", sectionName(a.state().section), a.state().kicksTotal);
  synth::Song song = synth::pads(); auto tr = analyse(song, a);
  CHECK(tr.back().s.drops == 0, "pads: %u drops", tr.back().s.drops);
  CHECK(tr.back().s.kicksTotal <= 2, "pads: %u kicks", tr.back().s.kicksTotal);
  int calm = 0, n = 0; for (auto& x : tr) if (x.t > 3) { n++; if (x.s.section == Section::Calm) calm++; }
  CHECK(calm > 0.9 * n, "pads calm %d/%d", calm, n);
}

static void testFlashWindow() {
  printf("flash limiter\n");
  FlashWindow w{}; std::vector<uint32_t> fl;
  for (uint32_t ms = 1000; ms < 11000; ms += 47) if (w.allow(ms, 3)) fl.push_back(ms);
  bool ok = true; for (size_t i = 3; i < fl.size(); i++) if (fl[i] - fl[i - 3] < 1000) ok = false;
  CHECK(ok, "more than 3 flashes in a second");
  CHECK(fl.size() >= 27, "flashes in 10 s: %zu, want ~30", fl.size());
  FlashWindow v{}; CHECK(v.allow(5000, 9), "first flash"); CHECK(v.allow(5010, 9), "same flash, second segment");
  CHECK(v.allow(5300) && v.allow(5600) && !v.allow(5900), "max 3 (asked for 9)");
  FlashWindow z{}; CHECK(!z.allow(100, 0), "max 0 = no flashes");
}

struct Buf : PixelSink {
  std::vector<std::array<uint8_t, 2>> px; std::vector<uint8_t> wh;
  explicit Buf(int n) : px(n), wh(n) {}
  void clear() { for (auto& p : px) p = {0, 0}; std::fill(wh.begin(), wh.end(), 0); }
  void set(int i, uint8_t pal, uint8_t bri) override { if (i < 0 || i >= (int)px.size()) { fprintf(stderr, "pixel %d out of range\n", i); abort(); } px[i] = {pal, bri}; wh[i] = 0; }
  void white(int i, uint8_t bri) override { if (i < 0 || i >= (int)px.size()) { fprintf(stderr, "pixel %d out of range\n", i); abort(); } px[i] = {0, 0}; wh[i] = bri; }
  int lit() const { int c = 0; for (size_t i = 0; i < px.size(); i++) if (px[i][1] > 40 || wh[i]) c++; return c; }
  double mean() const { double s = 0; for (auto& p : px) s += p[1]; return s / px.size(); }
};

static void testEffects() {
  printf("effects on the EDM song (every effect, 1, 7, 60 and 300 LEDs, 40 fps)\n");
  synth::Song song = synth::edm(128); synth::Geq geq; auto frames = geq.run(song.x, song.sr);
  const int lens[] = {1, 7, 60, 300};
  for (int len : lens) for (int f = 0; f < kFxCount; f++) {
    const Fx fx = (Fx)f; LiteAnalyser a; Buf buf(len); FxParams p;
    std::vector<uint8_t> mem(fxMemory(fx, len) + 16, 0xEE); std::fill(mem.begin(), mem.end() - 16, 0);
    size_t fi = 0; std::vector<uint32_t> flashes; bool wasFlash = false; double dropMean = 0, introMean = 0; int nd = 0, ni = 0;
    std::vector<Fx> autoSeen;
    for (uint32_t ms = 1000; fi < frames.size(); ms += 25) {  // LED frames at 40 fps, audio frames at 43 fps
      while (fi < frames.size() && frames[fi].t * 1000 + 1000 <= ms) { a.update(frames[fi].fft, frames[fi].volume, (uint32_t)(frames[fi].t * 1000) + 1000); fi++; }
      buf.clear(); renderFx(fx, a, ms, len, p, mem.data(), buf);
      const bool fl = buf.wh[0] > 0; if (fl && !wasFlash) flashes.push_back(ms); wasFlash = fl;
      const double t = (ms - 1000) / 1000.0;
      if (t > song.dropStart + 1 && t < song.dropStart + 8 * song.bar) { dropMean += buf.mean(); nd++; }
      if (t > 1 && t < song.buildStart) { introMean += buf.mean(); ni++; }
      if (fx == Fx::Auto) { const Fx c = autoChoice(a.state(), a.barAt(ms)); if (autoSeen.empty() || autoSeen.back() != c) autoSeen.push_back(c); }
    }
    for (int k = 0; k < 16; k++) CHECK(mem[mem.size() - 16 + k] == 0xEE, "%s len %d wrote past its memory", fxName(fx), len);
    bool safe = true; for (size_t i = 3; i < flashes.size(); i++) if (flashes[i] - flashes[i - 3] < 1000) safe = false;
    CHECK(safe, "%s len %d: more than 3 flashes in a second", fxName(fx), len);
    if (len == 60) {
      if (fx == Fx::DropStrobe) CHECK(flashes.size() >= 8, "%s: %zu flashes in the drop", fxName(fx), flashes.size());
      else if (fx != Fx::Auto) CHECK(flashes.empty(), "%s flashed", fxName(fx));
      if (fx != Fx::BuildFill) CHECK(nd && dropMean / nd > 20, "%s too dark in the drop (%.1f)", fxName(fx), nd ? dropMean / nd : 0);
      if (fx == Fx::Auto) {
        bool sawBuild = false, sawStrobe = false, sawOther = false;
        for (Fx c : autoSeen) { if (c == Fx::BuildFill) sawBuild = true; if (c == Fx::DropStrobe) sawStrobe = true; if (c == Fx::KickShockwave) sawOther = true; }
        CHECK(sawBuild && sawStrobe && sawOther, "auto went through build fill (%d), drop strobe (%d), shockwave after 8 bars (%d)", sawBuild, sawStrobe, sawOther);
        printf("  auto:"); for (Fx c : autoSeen) printf(" %s,", fxName(c) + 3); printf("\n");
      }
      printf("  %-18s mean brightness intro %5.1f, drop %5.1f, flashes %zu\n", fxName(fx), ni ? introMean / ni : 0, nd ? dropMean / nd : 0, flashes.size());
    }
  }
  // strobe off: no flashes at all
  { LiteAnalyser a; Buf buf(30); FxParams p; p.strobe = false; std::vector<uint8_t> mem(fxMemory(Fx::DropStrobe, 30), 0); size_t fi = 0; int fl = 0;
    for (uint32_t ms = 1000; fi < frames.size(); ms += 25) { while (fi < frames.size() && frames[fi].t * 1000 + 1000 <= ms) { a.update(frames[fi].fft, frames[fi].volume, (uint32_t)(frames[fi].t * 1000) + 1000); fi++; }
      renderFx(Fx::DropStrobe, a, ms, 30, p, mem.data(), buf); if (buf.wh[0]) fl++; }
    CHECK(fl == 0, "strobe off still flashed %d frames", fl); }
}

int main() {
  testEdm(128, 0.0);
  testEdm(128, 0.01);  // with a noisy microphone
  testEdm(100, 0.0);
  testEdm(140, 0.0);
  testEdm(120, 0.02);
  testEdm(150, 0.01);
  testEdm(132, 0.03);  // a noisy room, squelch just above it
  testQuiet();
  testFlashWindow();
  testEffects();
  printf("%d checks, %d failed\n", checks, failures);
  return failures ? 1 : 0;
}
