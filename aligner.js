// aligner.js — timing brain: line-to-word alignment, similarity, audio-energy boundary refinement
// Native ES module. Only the two entry points the app needs are exported.

// ---------- constants ----------
  // --- character-stream monotonic matching (maps each user-edited line to whisper timing) ---
  // Thai has no spaces, so Whisper often returns one fused "word" covering
  // several script lines. Matching therefore happens on CHARACTERS, not
  // Whisper words: every Whisper word is expanded into a stream of characters
  // with interpolated times, and each line is located inside that stream.
  const CHAR_LOOKAHEAD_BASE = 100; // characters to scan ahead of the pointer (plus 2x the line length)
  const MAX_LOOKAHEAD_GROWTH = 4;  // search window may grow up to this multiple after consecutive misses
  const WINDOW_LEN_TOLERANCE = 0.25; // sliding-window length may differ from the line length by this fraction (min 1 char)
  const MIN_MATCH_SCORE = 0.30;    // Levenshtein similarity floor; below this a line is matched:false, start/end:null
  const DISTANCE_PENALTY = 0.003;  // per-character penalty for starting the match ahead of the pointer

  // --- display timing guards ---
  // Minimum time (seconds) a subtitle line stays on screen so a human can
  // actually read it. Used by PASS 2 (interpolated slots), PASS 3
  // (finishSegments) and by the energy refinement pass so an audio-energy
  // snap can never shrink a line below this floor.
  const MIN_DISPLAY_DURATION = 0.35;
  // Whisper's timestamps for matched lines run ~25ms early for Thai, so
  // PASS 3 nudges matched starts later by this much.
  const MATCHED_START_BIAS = 0.025;
  // A line that ends this close (seconds) before the next line starts is
  // stretched to meet it: continuous speech should not flash a blank frame.
  const CONTIGUOUS_GAP = 0.06;
  // Max fraction of a line's original (Whisper) duration an energy snap is
  // allowed to remove before the snap is rejected and Whisper's time kept.
  const MAX_SNAP_SHRINK_RATIO = 0.30;

// ---------- helpers ----------
  function stripWs(s){
    return String(s == null ? '' : s).replace(/\s+/g, '');
  }

  function round2(x){
    return Math.round(x * 100) / 100;
  }

  // =========================================================
  // STEP B — Character-stream monotonic matching + two-pass finishing
  // PASS 1 (Character-Stream Monotonic Matching): all Whisper text is laid
  // out as one stream of characters, each with its own start/end time
  // (linear interpolation across its word's duration). A pointer
  // `charPointer` marks the first character not yet consumed and only ever
  // moves forward. Each script line is located by sliding a window of about
  // its own length across the stream (starting at the pointer, bounded by a
  // lookahead) and scoring Levenshtein similarity. The best window at or
  // above MIN_MATCH_SCORE gives the line its start (first character's
  // start) and end (last character's end), and the pointer jumps past it —
  // so a phrase spoken twice (a Hook) is matched once per occurrence, in
  // order. Because matching is per character, a line may be a small slice
  // of one fused Whisper token, or several lines may share one token.
  // A line with no acceptable window gets { matched:false, start:null,
  // end:null } and the pointer stays put (see the note in the matcher).
  // PASS 2 (block-based interpolation): every run of consecutive unmatched
  // lines is spread across the gap between the anchor before it and the
  // anchor after it, proportionally to character length, each line getting
  // at least MIN_DISPLAY_DURATION.
  // PASS 3 (display timing, simple linear scan): lines are fixed one at a
  // time, front to back. Every line gets at least MIN_DISPLAY_DURATION. If a
  // line's end reaches the next line's start, it ends exactly there when
  // there is room; otherwise it is held for the minimum and the next line
  // starts when it ends. Nothing overlaps and time never jumps over a gap.
  // =========================================================

  export function alignLinesToWords(lines, whisperWords) {
    const words = Array.isArray(whisperWords) ? whisperWords : [];
    const safeLines = Array.isArray(lines) ? lines : [];
    const stream = buildCharStream(words);
    return finishSegments(matchLinesToCharStream(safeLines, stream), words);
  }

  // ---- Whisper words -> continuous character stream [{ char, start, end }] ----
  function buildCharStream(whisperWords) {
    const stream = [];
    for (let wi = 0; wi < whisperWords.length; wi++) {
      const w = whisperWords[wi];
      const chars = Array.from(stripWs(w.text));
      const len = chars.length;
      if (len === 0) continue;
      const ws = Number(w.start) || 0;
      const we = Math.max(ws, Number(w.end) || ws);
      const dur = we - ws;
      for (let k = 0; k < len; k++) {
        stream.push({
          char: chars[k],
          start: ws + dur * (k / len),
          end: ws + dur * ((k + 1) / len)
        });
      }
    }
    return stream;
  }

  // ---- PASS 1: monotonic forward matching on the character stream ----
  function matchLinesToCharStream(lines, stream) {
    const M = stream.length;
    const streamText = stream.map(c => c.char).join('');
    const rawSegments = [];
    let charPointer = 0; // only ever moves forward
    let misses = 0;      // consecutive unmatched lines, widens the search window

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const target = stripWs(line);
      if (!target) continue; // empty line: skipped entirely

      const tLen = target.length;
      let best = null;

      if (charPointer < M) {
        const lookahead = (CHAR_LOOKAHEAD_BASE + tLen * 2) * Math.min(MAX_LOOKAHEAD_GROWTH, 1 + misses);
        const searchLimit = Math.min(M - 1, charPointer + lookahead);
        const tol = Math.max(1, Math.round(tLen * WINDOW_LEN_TOLERANCE));
        const minL = Math.max(1, tLen - tol);
        const maxL = tLen + tol;

        for (let s = charPointer; s <= searchLimit; s++) {
          const penalty = (s - charPointer) * DISTANCE_PENALTY;
          // nothing further away can beat what we already have
          if (best && 1 - penalty <= best.score) break;
          for (let L = minL; L <= maxL; L++) {
            if (s + L > M) break;
            const rawScore = textSimilarity(target, streamText.slice(s, s + L));
            const score = rawScore - penalty;
            if (!best || score > best.score) {
              best = { start: s, end: s + L - 1, score, rawScore };
            }
          }
        }
      }

      if (best && best.rawScore >= MIN_MATCH_SCORE) {
        rawSegments.push({
          text: line,
          start: stream[best.start].start,
          end: stream[best.end].end,
          matched: true,
          score: best.rawScore
        });
        charPointer = best.end + 1; // strictly forward: consumed characters are never reused
        misses = 0;
      } else {
        // Whisper missed it: leave it honest for PASS 2. The pointer is NOT
        // advanced: a line that is absent from the audio has no characters
        // in the stream, so skipping ahead by its length would swallow the
        // next real line (and every repeat after it). The next line simply
        // searches from the same pointer, with a wider window.
        rawSegments.push({ text: line, start: null, end: null, matched: false, score: 0 });
        misses++;
      }
    }
    return rawSegments;
  }

  // ---- PASS 2 + PASS 3: finishing pipeline ----
  function finishSegments(rawSegments, whisperWords) {
    const n = rawSegments.length;
    if (n === 0) return [];

    // PASS 2: Block-based Continuous Interpolation (distribute time across
    // unmatched blocks so nothing disappears)
    const firstWordStart = whisperWords.length > 0 && whisperWords[0].start != null ? whisperWords[0].start : 0;
    const totalAudioDuration = whisperWords.length > 0 ? whisperWords[whisperWords.length - 1].end : 30;
    let idx = 0;

    while (idx < n) {
      if (rawSegments[idx].matched) {
        idx++;
        continue;
      }

      const blockStart = idx;
      while (idx < n && !rawSegments[idx].matched) idx++;
      const blockEnd = idx; // exclusive
      const count = blockEnd - blockStart;

      // previous anchor (end of previous matched line) or start of speech
      let tPrev = firstWordStart;
      if (blockStart > 0 && rawSegments[blockStart - 1].end != null) {
        tPrev = rawSegments[blockStart - 1].end;
      }

      // next anchor (start of next matched line) or end of audio
      let tNext = totalAudioDuration;
      if (blockEnd < n && rawSegments[blockEnd].start != null) {
        tNext = rawSegments[blockEnd].start;
      }

      let totalChars = 0;
      for (let k = blockStart; k < blockEnd; k++) {
        totalChars += Math.max(1, stripWs(rawSegments[k].text).length);
      }

      // Every line first receives MIN_DISPLAY_DURATION; the rest of the gap
      // is split by character length. If the gap is too small for the
      // floor, it is widened (PASS 3 pushes following lines forward).
      const floorTotal = count * MIN_DISPLAY_DURATION;
      const gap = Math.max(floorTotal, tNext - tPrev);
      const extra = gap - floorTotal;
      let cursor = tPrev;

      for (let k = blockStart; k < blockEnd; k++) {
        const charLen = Math.max(1, stripWs(rawSegments[k].text).length);
        const slot = MIN_DISPLAY_DURATION + extra * (charLen / totalChars);
        rawSegments[k].start = cursor;
        rawSegments[k].end = cursor + slot;
        cursor += slot; // contiguous slots: no blank screen inside a block
      }
    }

    // PASS 3: linear scan, one line at a time, front to back.
    const starts = new Array(n);
    const ends = new Array(n);
    for (let i = 0; i < n; i++) {
      const cur = rawSegments[i];
      let s = cur.start;
      let e = Math.max(cur.end, s);
      if (cur.matched) {
        const nudged = s + MATCHED_START_BIAS;
        if (nudged < e) s = nudged;
      }
      starts[i] = s;
      ends[i] = e;
    }

    const finalSegments = [];
    let prevEnd = -Infinity;

    for (let i = 0; i < n; i++) {
      const cur = rawSegments[i];
      // a start already pushed forward by the previous line is respected
      const start = Math.max(starts[i], prevEnd);
      // every line lasts at least MIN_DISPLAY_DURATION
      let end = Math.max(ends[i], start + MIN_DISPLAY_DURATION);

      if (i + 1 < n) {
        const nextStart = starts[i + 1];
        if (end >= nextStart) {
          if (nextStart - start >= MIN_DISPLAY_DURATION) {
            end = nextStart;                     // enough room: seamless hand-off
          } else {
            end = start + MIN_DISPLAY_DURATION;  // not enough room: hold the minimum...
            starts[i + 1] = end;                 // ...and the next line starts right after
          }
        } else if (nextStart - end <= CONTIGUOUS_GAP) {
          end = nextStart;                       // close a hair-thin blank frame
        }
      }
      prevEnd = end;

      const rs = round2(start);
      let re = round2(end);
      // rounding must never leave a line under the floor
      if (re - rs < MIN_DISPLAY_DURATION - 1e-6) re = round2(rs + MIN_DISPLAY_DURATION);

      finalSegments.push({
        text: cur.text,
        start: rs,
        end: re,
        // an interpolated (never-matched) line was never anchored to real
        // ASR text, so it always carries a hard 0 review flag
        score: cur.matched ? (cur.score != null ? cur.score : 1) : 0
      });
    }

    return finalSegments;
  }


  function levenshteinDistance(a, b){
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++){
      curr[0] = i;
      for (let j = 1; j <= n; j++){
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      const tmp = prev; prev = curr; curr = tmp;
    }
    return prev[n];
  }

  function textSimilarity(a, b){
    if (a.length === 0 && b.length === 0) return 1;
    if (a.length === 0 || b.length === 0) return 0;
    const dist = levenshteinDistance(a, b);
    return 1 - dist / Math.max(a.length, b.length);
  }


  // =========================================================
  // AUDIO-ENERGY BOUNDARY REFINEMENT
  // Whisper's word-level timestamps are estimated from cross-attention
  // weights, not measured directly against the waveform — they can drift
  // by anywhere from ~50ms to several hundred ms, especially right at the
  // edge of an utterance. That drift is exactly what makes a subtitle look
  // "kind of right but not quite" even when the line-to-word matching
  // itself is correct. This pass corrects for it using the ACTUAL decoded
  // audio (already in memory for rendering, so this costs nothing extra to
  // fetch): for every segment boundary that borders real silence (start of
  // a line after a gap, end of a line before a gap — including the very
  // start/end of the clip), it scans a short window of real RMS energy
  // around Whisper's reported timestamp and snaps to the closest point
  // where the waveform actually crosses from silence to speech (or back).
  // Boundaries between two touching lines (no gap — a script split in the
  // middle of continuous speech) are left alone on purpose: there is no
  // real acoustic event to snap to there, only a text-alignment choice,
  // and snapping would just introduce noise.
  // =========================================================
  export function refineSegmentBoundariesWithEnergy(segments, audioBuffer){
    const sr = audioBuffer.sampleRate;
    const totalSamples = audioBuffer.length;
    if (totalSamples === 0) return segments;

    const numCh = audioBuffer.numberOfChannels;
    let monoData;
    if (numCh === 1){
      monoData = audioBuffer.getChannelData(0);
    } else {
      monoData = new Float32Array(totalSamples);
      const chans = [];
      for (let c = 0; c < numCh; c++) chans.push(audioBuffer.getChannelData(c));
      for (let i = 0; i < totalSamples; i++){
        let s = 0;
        for (let c = 0; c < numCh; c++) s += chans[c][i];
        monoData[i] = s / numCh;
      }
    }

    const FRAME = Math.max(1, Math.round(sr * 0.01));   // 10ms analysis window
    const HOP = Math.max(1, Math.round(sr * 0.005));    // 5ms hop
    const frameCount = Math.max(1, Math.floor((totalSamples - FRAME) / HOP) + 1);
    const envelope = new Float32Array(frameCount);
    for (let f = 0; f < frameCount; f++){
      const s0 = f * HOP;
      let sumSq = 0;
      for (let i = 0; i < FRAME; i++){
        const v = monoData[s0 + i] || 0;
        sumSq += v * v;
      }
      envelope[f] = Math.sqrt(sumSq / FRAME);
    }
    const frameTime = (f) => f * HOP / sr;
    const timeToFrame = (t) => Math.max(0, Math.min(frameCount - 1, Math.round((t * sr) / HOP)));

    // dynamic noise floor from the quietest ~15% of the whole clip, so this
    // adapts to each recording's own room tone / mic gain instead of a
    // fixed number that would be wrong half the time
    const sortedEnv = Array.from(envelope).sort((a, b) => a - b);
    const noiseFloor = sortedEnv[Math.floor(sortedEnv.length * 0.15)] || 0;

    // Onset vs offset need different thresholds, not one shared value.
    // A breath intake or a lip-smack right before speech starts is quieter
    // than real speech but still well above room-tone noise floor — a low
    // threshold (tuned for "has speech definitely stopped yet") happily
    // treats that breath as the onset and snaps the subtitle's start back
    // into it. Onset therefore uses a much higher bar so only genuine
    // speech-level energy counts as "sound started". Offset keeps a low
    // bar on purpose, so the subtitle holds through natural tapering
    // instead of cutting off the instant loudness dips.
    const thresholdOnset = Math.max(noiseFloor * 5.0, noiseFloor + 0.015);
    const thresholdOffset = Math.max(noiseFloor * 2.5, noiseFloor + 0.003);

    // Onset search is asymmetric on purpose. Looking backward has a tight
    // 40ms leash so the scan can never wander back far enough to land on a
    // pre-utterance breath/mouth-open transient (those typically sit
    // 60-150ms before real speech). Looking forward gets much more room
    // (150ms) because Whisper's Thai timestamps trend EARLY due to
    // cross-attention activating as soon as the mouth starts moving — the
    // real onset is usually somewhere ahead of Whisper's reported start,
    // never far behind it.
    const maxLookbackFrames = Math.max(1, Math.round(0.04 / (HOP / sr)));
    const maxLookaheadFrames = Math.max(1, Math.round(0.15 / (HOP / sr)));
    const SEARCH_SEC_OFFSET = 0.2; // how far around Whisper's end timestamp to look
    const offsetSearchSpan = Math.max(1, Math.round(SEARCH_SEC_OFFSET / (HOP / sr)));
    // how many consecutive low-energy frames must follow a candidate
    // offset point before it counts as "speech actually stopped" —
    // rejects a single quiet syllable gap from being mistaken for the end
    const OFFSET_SUSTAIN_FRAMES = Math.max(1, Math.round(0.03 / (HOP / sr)));

    function snapOnset(t){ // nearest silence -> speech transition
      const centerF = timeToFrame(t);
      const lo = Math.max(1, centerF - maxLookbackFrames);
      const hi = Math.min(frameCount - 1, centerF + maxLookaheadFrames);
      let best = null, bestDist = Infinity;
      for (let f = lo; f <= hi; f++){
        if (envelope[f - 1] < thresholdOnset && envelope[f] >= thresholdOnset){
          const d = Math.abs(f - centerF);
          if (d < bestDist){ bestDist = d; best = f; }
        }
      }
      return best != null ? frameTime(best) : t;
    }
    function snapOffset(t){ // nearest speech -> silence transition, sustained
      const centerF = timeToFrame(t);
      const lo = Math.max(1, centerF - offsetSearchSpan);
      const hi = Math.min(frameCount - 1, centerF + offsetSearchSpan);
      let best = null, bestDist = Infinity;
      for (let f = lo; f <= hi; f++){
        if (envelope[f - 1] >= thresholdOffset && envelope[f] < thresholdOffset){
          // require energy to stay below threshold for a short sustain
          // window afterward, so a brief dip mid-word doesn't get read as
          // the final offset
          let sustained = true;
          const sustainEnd = Math.min(frameCount - 1, f + OFFSET_SUSTAIN_FRAMES);
          for (let s = f; s <= sustainEnd; s++){
            if (envelope[s] >= thresholdOffset){ sustained = false; break; }
          }
          if (!sustained) continue;
          const d = Math.abs(f - centerF);
          if (d < bestDist){ bestDist = d; best = f; }
        }
      }
      return best != null ? frameTime(best) : t;
    }

    // Safety guard: an energy snap may only be applied if it doesn't eat
    // into the spoken line. A snap that lengthens (or keeps) the line is
    // always fine. A snap that SHRINKS it is rejected when the result would
    // fall under MIN_DISPLAY_DURATION, or when it removes more than 30% of
    // the line's original Whisper duration — in both cases Whisper's own
    // timestamp is kept. This stops the energy detector from mistaking a
    // quiet Thai syllable tail (or a dip between words) for "speech ended".
    function snapIsSafe(newStart, newEnd, originalDuration){
      const newDuration = newEnd - newStart;
      if (newDuration >= originalDuration) return true; // not shrinking
      if (newDuration < MIN_DISPLAY_DURATION) return false;
      return (originalDuration - newDuration) <= originalDuration * MAX_SNAP_SHRINK_RATIO;
    }

    const GAP_EPSILON = 0.03;
    for (let i = 0; i < segments.length; i++){
      const seg = segments[i];
      if (!seg.matched) continue;
      const prev = segments[i - 1];
      const next = segments[i + 1];
      const hasGapBefore = !prev || !prev.matched || (seg.start - prev.end) > GAP_EPSILON;
      const hasGapAfter = !next || !next.matched || (next.start - seg.end) > GAP_EPSILON;
      // duration as Whisper/PASS 3 gave it, before any energy snapping
      const originalDuration = seg.end - seg.start;
      if (hasGapBefore){
        const snapped = snapOnset(seg.start);
        if (snapped < seg.end - 0.02 && snapIsSafe(snapped, seg.end, originalDuration)) seg.start = snapped;
      }
      if (hasGapAfter){
        const snapped = snapOffset(seg.end);
        if (snapped > seg.start + 0.02 && snapIsSafe(seg.start, snapped, originalDuration)) seg.end = snapped;
      }
    }
    // re-clamp in case refinement nudged two segments into each other
    for (let i = 0; i < segments.length - 1; i++){
      if (segments[i].matched && segments[i + 1].matched && segments[i].end > segments[i + 1].start){
        segments[i].end = segments[i + 1].start;
      }
    }
    return segments;
  }

