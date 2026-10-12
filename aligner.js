// aligner.js — timing brain: line-to-word alignment, similarity, audio-energy boundary refinement
// Native ES module. Only the two entry points the app needs are exported.

// ---------- constants ----------
  // --- word-level monotonic matching (maps each user-edited line to whisper timing) ---
  const WORD_LOOKAHEAD = 20;      // whisper words to scan ahead for a line's start (widened to stop fast/short words from falling outside the window)
  const WORD_MAX_SPAN = 25;       // whisper words a single line may consume
  const MIN_MATCH_SCORE = 0.25;   // similarity floor below which a line is treated as unmatched
  const EARLY_BREAK_SCORE = 0.65; // score at which the inner span-search stops early once long enough

  // --- display timing guards ---
  // Minimum time (seconds) a subtitle line stays on screen so a human can
  // actually read it. Used by PASS 3 (finishSegments) to stretch too-short
  // lines, and by the energy refinement pass so an audio-energy snap can
  // never shrink a line below this floor.
  const MIN_DISPLAY_DURATION = 0.35;
  // Whisper's timestamps for matched lines run ~25ms early for Thai, so
  // PASS 3 nudges matched starts later by this much.
  const MATCHED_START_BIAS = 0.025;
  // Max fraction of a line's original (Whisper) duration an energy snap is
  // allowed to remove before the snap is rejected and Whisper's time kept.
  const MAX_SNAP_SHRINK_RATIO = 0.30;

// ---------- helpers ----------
  function stripWs(s){
    return s.replace(/\s+/g, '');
  }

  // =========================================================
  // STEP B — Global alignment + two-pass finishing
  // PASS 0 (global alignment, primary path): the old per-line greedy
  // matcher picked a "best so far" window for line 1, then started
  // line 2's search from wherever line 1 stopped — one bad local pick
  // (very common with repeated words/names in Thai, or a filler word
  // Whisper heard that isn't in the script) permanently shifts every
  // line after it forward or backward. That's the "1 good clip out of
  // 10" symptom: cascading, not random. Instead we run a single global
  // sequence alignment (Needleman-Wunsch edit-distance DP) between the
  // FULL edited script (all lines concatenated) and the FULL Whisper
  // transcript (all words concatenated) once. This finds the
  // minimum-total-edit-distance alignment across the whole clip at
  // once, so a mismatch in one spot doesn't drag every later line off
  // with it — deterministic and reproducible for the same inputs/edits.
  // Each line boundary in the script is then read off the alignment
  // path and converted to a timestamp by locating the matching
  // position inside the aligned Whisper word and interpolating across
  // that word's [start,end] by character offset.
  // PASS 1 (windowed fallback): kept for pathologically long audio
  // (alignLinesToWordsWindowed) where the O(N×M) DP grid would be too
  // large to build responsively on a phone; same greedy logic as
  // before.
  // PASS 2 (linear interpolation): any line that still comes back
  // unmatched (e.g. truly empty line) gets a start/end carved out of
  // the silent gap between the anchors before and after it. With PASS 0
  // this should be rare — nearly everything gets *some* real anchor —
  // but the safety net stays so nothing silently disappears.
  // PASS 3 (acoustic lock + minimum display duration): a line's start is
  // the real Whisper-detected onset of its speech. Its end is the real
  // detected offset, EXCEPT that a line shorter than MIN_DISPLAY_DURATION
  // (0.35s) is stretched forward so it stays readable instead of flashing
  // for a frame — but never past the next line's start. If the next line
  // follows immediately (no real silence), this line's end lands exactly on
  // the next line's start: contiguous, no blank frame, no overlap.
  // =========================================================

  // Guard: above this many (targetChars × asrChars) DP cells, fall back
  // to the windowed matcher rather than risk locking up a phone browser.
  const GLOBAL_ALIGN_CELL_BUDGET = 12000000;

  export function alignLinesToWords(lines, whisperWords) {
    const rawSegments = globalAlignLines(lines, whisperWords);
    if (rawSegments) return finishSegments(rawSegments, whisperWords);
    // fallback path for very long audio
    return finishSegments(alignLinesToWordsWindowed(lines, whisperWords), whisperWords);
  }

  // ---- PASS 0: global Needleman-Wunsch alignment over the whole clip ----
  function globalAlignLines(lines, whisperWords) {
    const strippedLines = lines.map(stripWs);
    const targetText = strippedLines.join('');
    const N = targetText.length;

    // asrText: every Whisper word's stripped text concatenated, plus a
    // parallel array so any character position can be mapped back to
    // (which word, offset within that word) for time interpolation.
    let asrText = '';
    const asrCharMeta = [];
    whisperWords.forEach((w, wi) => {
      const t = stripWs(w.text);
      for (let k = 0; k < t.length; k++) {
        asrText += t[k];
        asrCharMeta.push({ wordIdx: wi, offsetInWord: k, wordLen: t.length });
      }
    });
    const M = asrText.length;

    if (N === 0 || M === 0) return null;
    if (N * M > GLOBAL_ALIGN_CELL_BUDGET) return null; // let caller fall back

    // Needleman-Wunsch DP: match=0, mismatch=1, gap=1
    const W = M + 1;
    const dp = new Int32Array((N + 1) * W);
    for (let j = 0; j <= M; j++) dp[j] = j;
    for (let i = 0; i <= N; i++) dp[i * W] = i;

    for (let i = 1; i <= N; i++) {
      const rowBase = i * W;
      const prevRowBase = (i - 1) * W;
      const tc = targetText[i - 1];
      for (let j = 1; j <= M; j++) {
        const cost = tc === asrText[j - 1] ? 0 : 1;
        const sub = dp[prevRowBase + j - 1] + cost;
        const del = dp[prevRowBase + j] + 1;
        const ins = dp[rowBase + j - 1] + 1;
        let best = sub;
        if (del < best) best = del;
        if (ins < best) best = ins;
        dp[rowBase + j] = best;
      }
    }

    // Traceback: for every target position i (0..N), record the aligned
    // asr position j — walking end-to-start and filling as we go.
    const targetPosToAsrPos = new Int32Array(N + 1);
    let i = N, j = M;
    targetPosToAsrPos[N] = M;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && dp[i * W + j] === dp[(i - 1) * W + (j - 1)] + (targetText[i - 1] === asrText[j - 1] ? 0 : 1)) {
        i--; j--;
        targetPosToAsrPos[i] = j;
        continue;
      }
      if (i > 0 && dp[i * W + j] === dp[(i - 1) * W + j] + 1) {
        i--;
        targetPosToAsrPos[i] = j;
        continue;
      }
      if (j > 0 && dp[i * W + j] === dp[i * W + (j - 1)] + 1) {
        j--;
        continue;
      }
      // shouldn't happen, but never loop forever
      if (i > 0) { i--; targetPosToAsrPos[i] = j; } else { j--; }
    }

    // Two boundary-time readings are needed, not one — a "start" boundary
    // (beginning of the char at `pos`) and an "end" boundary (end of the
    // char just before `pos`) are usually the same instant, but NOT when
    // Whisper recorded a real acoustic gap between that word and the next
    // one. Using a single function for both collapsed a line's end into
    // the START of whatever comes after the gap instead of the true END
    // of its own last word — silently erasing short real silences and
    // dragging the previous line's on-screen time into the gap.
    // Tier-2 fix: when a line boundary falls in the middle of a Whisper
    // word (script splits where Whisper heard one continuous word), don't
    // fabricate a timestamp by guessing a proportional point inside the
    // word by character count — that point is not a real acoustic event.
    // Instead SNAP the boundary to whichever real edge of that word (its
    // detected start or its detected end) is closer. This trades "exactly
    // where the script text splits" for "a timestamp Whisper actually
    // measured", which is the worthwhile trade: the boundary now always
    // lands on a real onset/offset instead of an estimated midpoint.
    // Note: asrStartTime(pos) and asrEndTime(pos) are always called on the
    // SAME pos for one line's end and the next line's start, and resolve
    // to the same frac/word when the split is mid-word — so both sides of
    // a boundary snap the same direction and stay contiguous (no new gap
    // or overlap is introduced by snapping).
    function snapToNearestWordEdge(w, frac) {
      // Linear interpolation across the word's own duration instead of a
      // hard round to whichever edge frac is closer to. The old version
      // used `frac < 0.5 ? w.start : w.end`, which meant any line split
      // that happened to land in the first half of a fused multi-syllable
      // Thai word token (Whisper frequently emits one timestamp for an
      // unspaced run like "และนี่ก็คือ") snapped ALL THE WAY back to the
      // start of that whole token — dragging the subtitle's on-screen time
      // far earlier than the actual audio for that portion of the word.
      // Interpolating proportionally by character offset keeps the
      // boundary continuous and roughly tracks where in the token the
      // audio actually is, instead of teleporting to one extreme.
      const duration = Math.max(0, w.end - w.start);
      return w.start + (duration * Math.max(0, Math.min(1, frac)));
    }
    function asrStartTime(pos) {
      if (pos <= 0) return whisperWords[0].start;
      if (pos >= M) return whisperWords[whisperWords.length - 1].end;
      const meta = asrCharMeta[pos];
      const w = whisperWords[meta.wordIdx];
      const frac = meta.wordLen > 0 ? meta.offsetInWord / meta.wordLen : 0;
      return snapToNearestWordEdge(w, frac);
    }
    function asrEndTime(pos) {
      if (pos <= 0) return whisperWords[0].start;
      if (pos >= M) return whisperWords[whisperWords.length - 1].end;
      const meta = asrCharMeta[pos - 1];
      const w = whisperWords[meta.wordIdx];
      const frac = meta.wordLen > 0 ? (meta.offsetInWord + 1) / meta.wordLen : 1;
      return snapToNearestWordEdge(w, frac);
    }

    const rawSegments = [];
    let cursor = 0;
    for (let li = 0; li < lines.length; li++) {
      const sl = strippedLines[li];
      if (!sl) { rawSegments.push({ text: lines[li], start: null, end: null, matched: false, score: 0 }); continue; }
      const startPos = targetPosToAsrPos[cursor];
      const endPos = targetPosToAsrPos[cursor + sl.length];
      cursor += sl.length;
      const st = asrStartTime(startPos);
      const en = Math.max(st + 0.02, asrEndTime(endPos));
      // confidence score: how well the ASR text actually spanned by this
      // line's aligned range resembles the line's own text — a real
      // mismatch (Whisper misheard a word, script paraphrases the audio,
      // a filler word got absorbed into the wrong line) shows up here as
      // a low score even though the *global* alignment overall succeeded,
      // which is exactly the "just this one line" case a uniform offset
      // slider can never fix.
      const asrSlice = asrText.slice(Math.max(0, startPos), Math.min(M, Math.max(startPos, endPos)));
      const score = textSimilarity(sl, asrSlice);
      rawSegments.push({ text: lines[li], start: st, end: en, matched: true, score });
    }
    return rawSegments;
  }

  // ---- PASS 1 fallback: old per-line greedy windowed matcher ----
  function alignLinesToWordsWindowed(lines, whisperWords) {
    const words = whisperWords.map(w => stripWs(w.text));
    const N = words.length;
    let wp = 0;
    const rawSegments = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const target = stripWs(line);
      if (!target) continue;

      let best = null;
      // search forward using WORD_LOOKAHEAD, to force staying near the current audio position
      const searchLimit = Math.min(N, wp + WORD_LOOKAHEAD);

      for (let start = wp; start < searchLimit; start++) {
        let acc = '';
        const spanLimit = Math.min(N, start + WORD_MAX_SPAN);
        for (let end = start; end < spanLimit; end++) {
          acc += words[end];
          const rawScore = textSimilarity(target, acc);
          // Distance penalty: discourage matches far from the current pointer, to prevent skipping ahead
          const distancePenalty = (start - wp) * 0.03;
          const score = rawScore - distancePenalty;

          if (!best || score > best.score) {
            best = { start, end, score, rawScore };
          }
          if (acc.length >= target.length && rawScore > EARLY_BREAK_SCORE) break;
          if (acc.length > target.length * 1.5 + 4) break;
        }
      }

      // minimum similarity threshold
      if (best && best.rawScore >= MIN_MATCH_SCORE) {
        rawSegments.push({
          text: line,
          start: whisperWords[best.start].start,
          end: whisperWords[best.end].end, // real acoustic end time, no arbitrary buffer
          matched: true,
          score: best.rawScore
        });
        wp = best.end + 1; // advance pointer forward
      } else {
        // if no match found, nudge wp forward proportionally to line length to avoid getting stuck
        rawSegments.push({ text: line, start: null, end: null, matched: false, score: 0 });
        wp = Math.min(N, wp + Math.max(1, Math.round(target.length / 7)));
      }
    }
    return rawSegments;
  }

  // ---- PASS 2 + PASS 3: shared finishing pipeline for either path above ----
  function finishSegments(rawSegments, whisperWords) {
    // PASS 2: Block-based Continuous Interpolation (distribute time across unmatched blocks so nothing disappears)
    const totalAudioDuration = whisperWords.length > 0 ? whisperWords[whisperWords.length - 1].end : 30;
    let idx = 0;

    while (idx < rawSegments.length) {
      if (rawSegments[idx].matched) {
        idx++;
        continue;
      }

      // find the start/end of this unmatched block of lines
      const blockStart = idx;
      while (idx < rawSegments.length && !rawSegments[idx].matched) {
        idx++;
      }
      const blockEnd = idx; // exclusive

      // find the previous reference time
      let tPrev = 0;
      if (blockStart > 0 && rawSegments[blockStart - 1].end != null) {
        tPrev = rawSegments[blockStart - 1].end;
      }

      // find the next reference time
      let tNext = totalAudioDuration;
      if (blockEnd < rawSegments.length && rawSegments[blockEnd].start != null) {
        tNext = rawSegments[blockEnd].start;
      }

      // total character length of the unmatched block
      let totalChars = 0;
      for (let k = blockStart; k < blockEnd; k++) {
        totalChars += Math.max(1, stripWs(rawSegments[k].text).length);
      }

      const availableDuration = Math.max(0.4 * (blockEnd - blockStart), tNext - tPrev);
      let currentCursor = tPrev;

      // distribute time proportionally to actual character length, but only
      // fill 80% of each slot with active text — the remaining 20% is left
      // as a silence cushion so interpolated lines still get a visible gap
      // between them instead of touching edge-to-edge.
      for (let k = blockStart; k < blockEnd; k++) {
        const charLen = Math.max(1, stripWs(rawSegments[k].text).length);
        const slotDuration = (charLen / totalChars) * availableDuration;
        const activeDuration = Math.max(0.25, slotDuration * 0.80);
        rawSegments[k].start = currentCursor;
        rawSegments[k].end = currentCursor + activeDuration;
        currentCursor += slotDuration;
      }
    }

    // PASS 3: Acoustic lock + minimum display duration.
    // A subtitle appears when Whisper detected speech starting and, by
    // default, disappears when it detected that speech ending. The old
    // 20ms "draw-call safety" floor (end = start + 0.02) is gone: it let
    // short lines pop up for a single frame. Instead any line shorter than
    // MIN_DISPLAY_DURATION is stretched forward to that length, limited by
    // the next line's start so two subtitles can never overlap. When the
    // next line begins right away, this line's end meets that start exactly.

    // First work out every line's locked start (including the matched-line
    // bias nudge). It's computed back-to-front so each line can be clamped
    // against the *actual* start the next line will have in the output —
    // otherwise the +25ms nudge on the next line would leave a 25ms blank
    // frame between two lines of continuous speech.
    const lockedStarts = new Array(rawSegments.length);
    for (let i = rawSegments.length - 1; i >= 0; i--) {
      const cur = rawSegments[i];
      const nextLocked = i + 1 < rawSegments.length ? lockedStarts[i + 1] : null;
      let s = cur.start;
      if (cur.matched) {
        const nudged = cur.start + MATCHED_START_BIAS;
        // the nudge must never push the start past this line's own end
        // (very short line) or into the next line's locked start (overlap)
        if (nudged < cur.end && (nextLocked == null || nudged < nextLocked)) s = nudged;
      }
      lockedStarts[i] = s;
    }

    const finalSegments = [];
    let prevEnd = 0;

    for (let i = 0; i < rawSegments.length; i++) {
      const cur = rawSegments[i];
      const nextStart = i + 1 < rawSegments.length ? lockedStarts[i + 1] : null;

      let exactStart = lockedStarts[i];
      let exactEnd = cur.end; // real end of this line's speech

      if (nextStart != null) {
        // alignment noise can leave a line starting at/after the next line's
        // start; pull it back (not before the previous line's end) so it
        // still has room to show
        if (exactStart >= nextStart) {
          exactStart = Math.max(Math.min(prevEnd, nextStart), nextStart - MIN_DISPLAY_DURATION);
        }
        // never overlap the next line
        if (exactEnd > nextStart) exactEnd = nextStart;
      }

      // Minimum display duration: stretch forward, never past the next
      // line's start. A next line that starts inside the window simply
      // caps the end exactly at next.start (seamless handoff).
      if (exactEnd - exactStart < MIN_DISPLAY_DURATION) {
        const target = exactStart + MIN_DISPLAY_DURATION;
        exactEnd = nextStart != null ? Math.min(target, nextStart) : target;
      }

      prevEnd = exactEnd;

      finalSegments.push({
        text: cur.text,
        start: Number(exactStart.toFixed(2)),
        end: Number(exactEnd.toFixed(2)),
        // an interpolated (never-matched) block gets a hard 0 — it was
        // never anchored to real ASR text at all, so it always deserves
        // a review flag regardless of whatever score field it carried in
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

