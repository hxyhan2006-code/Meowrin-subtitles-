// aligner.js — timing brain: line-to-word alignment, similarity, audio-energy boundary refinement
// Native ES module. Only the two entry points the app needs are exported.

// ---------- constants ----------
  // --- word-level monotonic matching (maps each user-edited line to whisper timing) ---
  const WORD_LOOKAHEAD = 20;      // whisper words to scan ahead for a line's start (grows after consecutive misses, see MAX_LOOKAHEAD_GROWTH)
  const MAX_LOOKAHEAD_GROWTH = 4; // lookahead window may grow up to this multiple of WORD_LOOKAHEAD after unmatched lines
  const WORD_MAX_SPAN = 25;       // whisper words a single line may consume
  const MIN_MATCH_SCORE = 0.35;   // similarity floor below which a line is treated as unmatched (matched:false, start/end:null)
  const EARLY_BREAK_SCORE = 0.65; // score at which the inner span-search stops early once long enough
  const DISTANCE_PENALTY = 0.03;  // per-word penalty for starting the match ahead of the pointer

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
  // STEP B — Monotonic forward matching + two-pass finishing
  // PASS 1 (Monotonic Forward Window Matching, the only matcher):
  // lines are matched to Whisper words strictly front-to-back in timeline
  // order. A pointer `wp` marks the first Whisper word not yet consumed;
  // each line searches only a bounded window ahead of it and, once matched,
  // moves the pointer past the words it used. The pointer never moves
  // backward, so a phrase spoken twice (a Hook, a repeated chorus line) is
  // matched once per occurrence, in order: the first occurrence consumes the
  // first set of words, the second occurrence can only see words after it.
  // A line scoring below MIN_MATCH_SCORE is reported honestly as
  // { matched:false, start:null, end:null } and left for PASS 2.
  // (The old global character-level Needleman-Wunsch alignment is gone: on
  // Thai and repeated passages it collapsed many lines onto a single point
  // — start == end — and marked everything matched:true, so nothing ever
  // reached the recovery pass and subtitles vanished.)
  // PASS 2 (block-based continuous interpolation): every run of consecutive
  // unmatched lines is spread across the gap between the anchor before it
  // and the anchor after it, proportionally to character length, with every
  // line guaranteed at least MIN_DISPLAY_DURATION.
  // PASS 3 (display timing): no line is ever shorter than
  // MIN_DISPLAY_DURATION or has zero length, and no line is ever dropped.
  // Where lines collide (same/overlapping starts, or starts closer than the
  // minimum), the colliding group shares its time span evenly (weighted by
  // character count) as a seamless hand-off instead of one line being
  // squeezed to 0 seconds.
  // =========================================================

  export function alignLinesToWords(lines, whisperWords) {
    const words = Array.isArray(whisperWords) ? whisperWords : [];
    const safeLines = Array.isArray(lines) ? lines : [];
    return finishSegments(alignLinesToWordsWindowed(safeLines, words), words);
  }

  // ---- PASS 1: monotonic forward window matcher ----
  function alignLinesToWordsWindowed(lines, whisperWords) {
    const words = whisperWords.map(w => stripWs(w.text));
    const N = words.length;
    let wp = 0;          // first whisper word not yet consumed — only ever moves forward
    let misses = 0;      // consecutive unmatched lines, widens the search window
    const rawSegments = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const target = stripWs(line);

      // empty line (or no whisper words left): nothing to match, leave for PASS 2
      if (!target || wp >= N) {
        rawSegments.push({ text: line, start: null, end: null, matched: false, score: 0 });
        continue;
      }

      let best = null;
      const lookahead = WORD_LOOKAHEAD * Math.min(MAX_LOOKAHEAD_GROWTH, 1 + misses);
      const searchLimit = Math.min(N, wp + lookahead);

      for (let start = wp; start < searchLimit; start++) {
        let acc = '';
        const spanLimit = Math.min(N, start + WORD_MAX_SPAN);
        // Distance penalty: discourage matches far from the pointer, so a
        // repeated phrase is taken at its nearest not-yet-used occurrence.
        const distancePenalty = (start - wp) * DISTANCE_PENALTY;
        for (let end = start; end < spanLimit; end++) {
          acc += words[end];
          if (!acc) continue; // punctuation-only words carry no text
          const rawScore = textSimilarity(target, acc);
          const score = rawScore - distancePenalty;

          if (!best || score > best.score) {
            best = { start, end, score, rawScore };
          }
          if (acc.length >= target.length && rawScore > EARLY_BREAK_SCORE) break;
          if (acc.length > target.length * 1.5 + 4) break;
        }
      }

      if (best && best.rawScore >= MIN_MATCH_SCORE) {
        const ws = whisperWords[best.start];
        const we = whisperWords[best.end];
        rawSegments.push({
          text: line,
          start: ws.start,
          end: Math.max(we.end, ws.start), // real acoustic end time, never before start
          matched: true,
          score: best.rawScore
        });
        wp = best.end + 1; // strictly forward: consumed words are never reused
        misses = 0;
      } else {
        // honest miss: PASS 2 will interpolate it. The pointer stays put so
        // the next line can still find the words this one failed to match;
        // the search window widens instead.
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

      // find the start/end of this unmatched block of lines
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

      // total character length of the unmatched block
      let totalChars = 0;
      for (let k = blockStart; k < blockEnd; k++) {
        totalChars += Math.max(1, stripWs(rawSegments[k].text).length);
      }

      // The gap is split by character length, but every line first receives
      // MIN_DISPLAY_DURATION so none can be shorter than the floor. If the
      // gap is too small for that, it is widened (PASS 3 resolves overlap).
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

    // PASS 3: display timing.
    // Step 1 — natural start/end per line. Matched starts get the small
    // late-nudge; starts are forced non-decreasing; an end is never < start.
    const starts = new Array(n);
    const ends = new Array(n);
    for (let i = 0; i < n; i++) {
      const cur = rawSegments[i];
      let s = cur.start;
      let e = cur.end;
      if (e < s) e = s;
      if (cur.matched) {
        const nudged = s + MATCHED_START_BIAS;
        if (nudged < e) s = nudged;
      }
      if (i > 0 && s < starts[i - 1]) s = starts[i - 1];
      if (e < s) e = s;
      starts[i] = s;
      ends[i] = e;
    }

    // Step 2 — walk front to back in "collision groups". A group is a chain
    // of lines whose consecutive starts are closer than MIN_DISPLAY_DURATION
    // (including identical or overlapping starts), so they cannot each have
    // the minimum on screen from their own start. The group is given one
    // time span and shares it (weighted by characters, each line never less
    // than the minimum) with contiguous hand-offs: no line is cut, none is
    // reduced to zero, none overlaps the next. A group of one line is just
    // the normal case.
    const finalSegments = [];
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && starts[j + 1] - starts[j] < MIN_DISPLAY_DURATION) j++;
      const cnt = j - i + 1;
      const spanStart = starts[i];
      const nextStart = j + 1 < n ? starts[j + 1] : null;

      // natural end of the group, capped at the next line (seamless hand-off)
      // and closed up when only a hair of silence separates them
      let e = ends[j];
      if (nextStart != null) {
        if (e > nextStart) e = nextStart;
        else if (nextStart - e <= CONTIGUOUS_GAP) e = nextStart;
      }
      const spanEnd = Math.max(e, spanStart + cnt * MIN_DISPLAY_DURATION);

      // if the group needed more room than the gap allowed, the following
      // line starts when the group ends instead of overlapping it
      if (nextStart != null && spanEnd > nextStart) starts[j + 1] = spanEnd;

      let totalW = 0;
      for (let k = i; k <= j; k++) totalW += Math.max(1, stripWs(rawSegments[k].text).length);
      const extra = spanEnd - spanStart - cnt * MIN_DISPLAY_DURATION;
      let cursor = spanStart;

      for (let k = i; k <= j; k++) {
        const cur = rawSegments[k];
        const w = Math.max(1, stripWs(cur.text).length);
        const dur = MIN_DISPLAY_DURATION + extra * (w / totalW);
        const segStart = cursor;
        const segEnd = k === j ? spanEnd : cursor + dur;
        cursor += dur;

        let rs = round2(segStart);
        let re = round2(segEnd);
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
      i = j + 1;
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

