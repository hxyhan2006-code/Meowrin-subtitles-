import { alignLinesToWords, refineSegmentBoundariesWithEnergy } from './aligner.js';

// ===== PWA: service worker registration (moved from inline <script> in index.html) =====
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .then((reg) => {
          console.log('[PWA] Service Worker registered:', reg.scope);
        })
        .catch((err) => {
          console.warn('[PWA] Service Worker registration failed:', err);
        });
    });
  } else {
    console.warn('[PWA] Service Worker not supported in this browser — app will still work, just without installability.');
  }

  // ---------- constants ----------
  const CANVAS_W = 1080, CANVAS_H = 1080;
  let FONT_PX = 74;   // user-adjustable via the style card (was a fixed const)
  const FONT_FAMILY = "Kanit";
  let STROKE_PX = 10; // user-adjustable via the style card (was a fixed const)
  let SYNC_OFFSET_MS = 0; // user-adjustable manual correction for sub-vs-audio timing drift
  const BOTTOM_MARGIN_RATIO = 0.10;
  const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
  const GROQ_MODEL = "whisper-large-v3";
  const GEMINI_MODEL = "gemini-3.8-flash"; // NOTE: Google renames/retires Gemini models often — if this
                                                  // starts 404-ing again, the error message itself usually names
                                                  // the replacement model to put here (e.g. "gemini-3.6-flash").
  const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const PAUSE_MARK_THRESHOLD_SEC = 0.25; // gap between two whisper words above this is marked [PAUSE] for Gemini

  // ---------- elements ----------
  const apiKeyGroqInput = document.getElementById('apiKeyGroq');
  const apiKeyGeminiInput = document.getElementById('apiKeyGemini');
  const rawScriptInput = document.getElementById('rawScript');
  const autoSplitBtn = document.getElementById('autoSplitBtn');
  const autoSplitStatusRow = document.getElementById('autoSplitStatusRow');
  const autoSplitStatusText = document.getElementById('autoSplitStatusText');
  const autoSplitStatsEl = document.getElementById('autoSplitStats');
  const autoSplitErrorBox = document.getElementById('autoSplitErrorBox');
  const whisperHintTermsInput = document.getElementById('whisperHintTerms');
  const scriptModeHint = document.getElementById('scriptModeHint');
  const wordRangeCustomInput = document.getElementById('wordRangeCustom');
  const fileDrop = document.getElementById('fileDrop');
  const audioFileInput = document.getElementById('audioFile');
  const fileInfo = document.getElementById('fileInfo');
  const audioEl = document.getElementById('audioEl');
  const editedScript = document.getElementById('editedScript');
  const fontSizeVal = document.getElementById('fontSizeVal');
  const strokeWidthVal = document.getElementById('strokeWidthVal');
  const stylePreviewCanvas = document.getElementById('stylePreviewCanvas');
  const startBtn = document.getElementById('startBtn');
  const statusRow = document.getElementById('statusRow');
  const statusText = document.getElementById('statusText');
  const errorBox = document.getElementById('errorBox');
  const resultCard = document.getElementById('resultCard');
  const previewVideo = document.getElementById('previewVideo');
  const dlVideo = document.getElementById('dlVideo');
  const dlSrt = document.getElementById('dlSrt');
  const canvas = document.getElementById('renderCanvas');
  const ctx = canvas.getContext('2d');
  const step1 = document.getElementById('step1');
  const step2 = document.getElementById('step2');
  const step3 = document.getElementById('step3');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsModalBackdrop = document.getElementById('settingsModalBackdrop');
  const settingsSaveBtn = document.getElementById('settingsSaveBtn');
  const pasteBtn = document.getElementById('pasteBtn');
  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const progressPct = document.getElementById('progressPct');
  const trimCard = document.getElementById('trimCard');
  const clearScriptBtn = document.getElementById('clearScriptBtn');
  const scriptErrorBox = document.getElementById('scriptErrorBox');
  const pasteRawBtn = document.getElementById('pasteRawBtn');
  const clearRawBtn = document.getElementById('clearRawBtn');
  const rawErrorBox = document.getElementById('rawErrorBox');
  const scriptLineCount = document.getElementById('scriptLineCount');

  // unified 1:1 stage (tab 3): style preview canvas <-> result video
  const stage = document.getElementById('stage');
  const stageSwitch = document.getElementById('stageSwitch');
  const stageSwitchBtns = Array.from(stageSwitch.querySelectorAll('button'));
  let hasResult = false;
  function setStageView(view){
    stage.dataset.view = view;
    stageSwitchBtns.forEach(b => b.classList.toggle('active', b.dataset.view === view));
    if (view !== 'video') previewVideo.pause();
  }
  stageSwitchBtns.forEach(b => b.addEventListener('click', () => setStageView(b.dataset.view)));

  const waveformScroll = document.getElementById('waveformScroll');
  const waveformWrap = document.getElementById('waveformWrap');
  const waveformCanvas = document.getElementById('waveformCanvas');
  const wfPlayhead = document.getElementById('wfPlayhead');
  const wfPlayBtn = document.getElementById('wfPlayBtn');
  const wfTime = document.getElementById('wfTime');
  const wfSplitBtn = document.getElementById('wfSplitBtn');
  const wfPlaySelBtn = document.getElementById('wfPlaySelBtn');
  const wfCutSelBtn = document.getElementById('wfCutSelBtn');
  const wfZoomOutBtn = document.getElementById('wfZoomOut');
  const wfZoomInBtn = document.getElementById('wfZoomIn');
  const wfZoomFitBtn = document.getElementById('wfZoomFitBtn');
  const wfZoomLabel = document.getElementById('wfZoomLabel');
  const cutListEl = document.getElementById('cutList');
  const wfUndoBtn = document.getElementById('wfUndoBtn');
  const wfRedoBtn = document.getElementById('wfRedoBtn');

  let selectedFile = null;
  let audioBuffer = null;      // decoded original audio, used to draw the waveform + build the trimmed version
  let waveformPeaks = null;    // Float32Array of [min,max] pairs per pixel-bucket
  let cutRegions = [];         // [{start,end}] in ORIGINAL-audio seconds — sorted, non-overlapping (committed deletions)
  let splitPoints = [];        // [seconds] in ORIGINAL-audio time — manual split markers inside surviving audio
  let selectedSeg = null;      // {start,end} in ORIGINAL-audio seconds — the currently tapped/highlighted piece, ready to delete
  let loopSelection = false;   // true while previewing the selected piece on a loop
  let wfRafId = null;
  let zoom = 1;                 // 1 = fit-to-width, up to ZOOM_MAX
  const ZOOM_MIN = 1, ZOOM_MAX = 60;
  let basePxPerSecond = 1;      // px/sec at zoom=1 (fills the visible width) — recomputed on load/resize
  function pxPerSecond(){ return basePxPerSecond * zoom; }

  // ---------- undo/redo for split/delete actions on the waveform ----------
  let undoStack = [];   // [{cutRegions, splitPoints}] — snapshot taken BEFORE each mutating action
  let redoStack = [];
  function snapshotTrimState(){
    return {
      cutRegions: cutRegions.map(r => ({ start: r.start, end: r.end })),
      splitPoints: [...splitPoints]
    };
  }
  function pushHistory(){
    undoStack.push(snapshotTrimState());
    if (undoStack.length > 50) undoStack.shift();
    redoStack = [];
    updateHistoryButtons();
  }
  function applyTrimState(s){
    cutRegions = s.cutRegions.map(r => ({ start: r.start, end: r.end }));
    splitPoints = [...s.splitPoints];
    selectedSeg = null;
    recomputeBasePxPerSecond();
    layoutWaveform();
    drawWaveform();
    renderCutList();
    refreshSelUI();
    renderPlayheadOnly();
    updateHistoryButtons();
  }
  function updateHistoryButtons(){
    wfUndoBtn.disabled = undoStack.length === 0;
    wfRedoBtn.disabled = redoStack.length === 0;
  }
  wfUndoBtn.addEventListener('click', () => {
    if (undoStack.length === 0) return;
    redoStack.push(snapshotTrimState());
    applyTrimState(undoStack.pop());
  });
  wfRedoBtn.addEventListener('click', () => {
    if (redoStack.length === 0) return;
    undoStack.push(snapshotTrimState());
    applyTrimState(redoStack.pop());
  });

  // ---------- edge auto-scroll: dragging the playhead near either edge of
  // the visible (zoomed-in) waveform pans the view for you — no more
  // needing a second finger just to move forward/back while zoomed ----------
  const EDGE_ZONE_PX = 34;
  const EDGE_MAX_SPEED_PX = 14;
  let edgeScrollPointerX = null;
  let edgeScrollRafId = null;
  function edgeScrollLoop(){
    if (dragMode !== 'scrub' || edgeScrollPointerX == null){ edgeScrollRafId = null; return; }
    const scrollRect = waveformScroll.getBoundingClientRect();
    const maxScroll = Math.max(0, waveformWrap.offsetWidth - waveformScroll.clientWidth);
    let dx = 0;
    if (edgeScrollPointerX < scrollRect.left + EDGE_ZONE_PX){
      const depth = (scrollRect.left + EDGE_ZONE_PX - edgeScrollPointerX) / EDGE_ZONE_PX;
      dx = -EDGE_MAX_SPEED_PX * Math.min(1, depth);
    } else if (edgeScrollPointerX > scrollRect.right - EDGE_ZONE_PX){
      const depth = (edgeScrollPointerX - (scrollRect.right - EDGE_ZONE_PX)) / EDGE_ZONE_PX;
      dx = EDGE_MAX_SPEED_PX * Math.min(1, depth);
    }
    if (dx !== 0 && maxScroll > 0){
      waveformScroll.scrollLeft = Math.max(0, Math.min(maxScroll, waveformScroll.scrollLeft + dx));
      audioEl.currentTime = clientXToOrigTime(edgeScrollPointerX);
      renderPlayheadOnly();
    }
    edgeScrollRafId = requestAnimationFrame(edgeScrollLoop);
  }
  function startEdgeScroll(){
    if (edgeScrollRafId == null) edgeScrollRafId = requestAnimationFrame(edgeScrollLoop);
  }
  function stopEdgeScroll(){
    edgeScrollPointerX = null;
    if (edgeScrollRafId != null){ cancelAnimationFrame(edgeScrollRafId); edgeScrollRafId = null; }
  }

  // ---------- persist API key ----------
  const savedGroq = localStorage.getItem('groq_api_key');
  if (savedGroq) apiKeyGroqInput.value = savedGroq;
  apiKeyGroqInput.addEventListener('input', () => {
    localStorage.setItem('groq_api_key', apiKeyGroqInput.value.trim());
  });
  const savedGemini = localStorage.getItem('gemini_api_key');
  if (savedGemini) apiKeyGeminiInput.value = savedGemini;
  apiKeyGeminiInput.addEventListener('input', () => {
    localStorage.setItem('gemini_api_key', apiKeyGeminiInput.value.trim());
  });

  // ---------- scripts are never persisted: every launch starts with empty boxes.
  // (only the API keys above are remembered) — purge any leftover from older versions ----------
  localStorage.removeItem('gs_raw_script');

  // ---------- word-range preset chips + custom input (target line length for
  // AI split — a guideline passed into the Gemini prompt, not a hard cap; the
  // prompt itself tells Gemini it may exceed either edge when context calls
  // for it) ----------
  let WORD_RANGE_MIN = 2, WORD_RANGE_MAX = 3; // default matches the tool's original fixed target
  const wordRangeChips = document.querySelectorAll('#wordRangeChips .chip-btn');
  function setWordRangeActive(min, max, persist){
    WORD_RANGE_MIN = min; WORD_RANGE_MAX = max;
    wordRangeChips.forEach(btn => {
      const isActive = Number(btn.dataset.min) === min && Number(btn.dataset.max) === max;
      btn.classList.toggle('active', isActive);
    });
    if (persist) localStorage.setItem('gs_word_range', `${min}-${max}`);
  }
  (function initWordRange(){
    const saved = localStorage.getItem('gs_word_range');
    const m = saved && saved.match(/^(\d+)-(\d+)$/);
    if (m){
      const mn = Number(m[1]), mx = Number(m[2]);
      const matchesPreset = Array.from(wordRangeChips).some(btn => Number(btn.dataset.min) === mn && Number(btn.dataset.max) === mx);
      if (matchesPreset){ setWordRangeActive(mn, mx, false); }
      else { WORD_RANGE_MIN = mn; WORD_RANGE_MAX = mx; wordRangeCustomInput.value = `${mn}-${mx}`; }
    } else {
      setWordRangeActive(2, 3, false);
    }
  })();
  wordRangeChips.forEach(btn => {
    btn.addEventListener('click', () => {
      wordRangeCustomInput.value = '';
      setWordRangeActive(Number(btn.dataset.min), Number(btn.dataset.max), true);
    });
  });
  wordRangeCustomInput.addEventListener('input', () => {
    const m = wordRangeCustomInput.value.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) return;
    const mn = Number(m[1]), mx = Number(m[2]);
    if (mn < 1 || mx < mn) return;
    WORD_RANGE_MIN = mn; WORD_RANGE_MAX = mx;
    wordRangeChips.forEach(btn => btn.classList.remove('active'));
    localStorage.setItem('gs_word_range', `${mn}-${mx}`);
  });

  // ---------- script-reference mode: strict (use only the user's own script
  // text, silently skip audio the script doesn't cover) vs fill (use Whisper's
  // transcript to cover gaps the script doesn't have text for, or the whole
  // clip if the raw script is empty) — default is strict, the safer option ----------
  let SCRIPT_FILL_MODE = false;
  const scriptModeChips = document.querySelectorAll('#scriptModeChips .chip-btn');
  const SCRIPT_MODE_STRICT_HINT = 'ใช้เฉพาะคำที่คุณเขียนมาเป๊ะๆ ช่วงเสียงที่สคริปต์ไม่ครอบคลุมจะถูกข้ามไปเงียบๆ ไม่แต่งเติมเอง (ปลอดภัยกว่า แนะนำถ้าเขียนสคริปต์มาครบแล้ว)';
  const SCRIPT_MODE_FILL_HINT = 'ช่วงที่สคริปต์ไม่ครอบคลุม จะดึงคำจาก Whisper มาเติมแทน และขึ้นต้นบรรทัดนั้นด้วย [AI] ให้สังเกตง่าย (ถ้าเว้นสคริปต์ว่างทั้งหมด ทุกบรรทัดจะขึ้น [AI]) Whisper อาจฟังผิดคำได้ — ตรวจทานก่อนใช้จริงเสมอ';
  function setScriptMode(mode, persist){
    SCRIPT_FILL_MODE = mode === 'fill';
    scriptModeChips.forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
    scriptModeHint.textContent = SCRIPT_FILL_MODE ? SCRIPT_MODE_FILL_HINT : SCRIPT_MODE_STRICT_HINT;
    if (persist) localStorage.setItem('gs_script_mode', mode);
  }
  (function initScriptMode(){
    const saved = localStorage.getItem('gs_script_mode');
    setScriptMode(saved === 'fill' ? 'fill' : 'strict', false);
  })();
  scriptModeChips.forEach(btn => btn.addEventListener('click', () => setScriptMode(btn.dataset.mode, true)));

  // ---------- settings modal (API Key) ----------
  function openSettingsModal(){
    settingsModalBackdrop.classList.add('show');
  }
  function closeSettingsModal(){
    settingsModalBackdrop.classList.remove('show');
  }
  settingsBtn.addEventListener('click', openSettingsModal);
  settingsSaveBtn.addEventListener('click', () => {
    localStorage.setItem('groq_api_key', apiKeyGroqInput.value.trim());
    localStorage.setItem('gemini_api_key', apiKeyGeminiInput.value.trim());
    closeSettingsModal();
  });
  settingsModalBackdrop.addEventListener('click', (e) => {
    if (e.target === settingsModalBackdrop) closeSettingsModal();
  });

  // ---------- custom fine-step slider (drag the round thumb only; tapping
  // the bar itself does nothing — that's the point) ----------
  function setupFineSlider({ trackWrapId, thumbId, fillId, minusBtnId, plusBtnId, min, max, step, initial, valueLabelEl, onChange }){
    const trackWrap = document.getElementById(trackWrapId);
    const thumb = document.getElementById(thumbId);
    const fill = document.getElementById(fillId);
    const minusBtn = document.getElementById(minusBtnId);
    const plusBtn = document.getElementById(plusBtnId);
    let value = initial;

    function clamp(v){ return Math.min(max, Math.max(min, v)); }
    function pctFor(v){ return ((v - min) / (max - min)) * 100; }

    function render(){
      const pct = pctFor(value);
      thumb.style.left = pct + '%';
      fill.style.width = pct + '%';
      if (valueLabelEl) valueLabelEl.textContent = String(value);
    }

    function setValue(raw, fire){
      const stepped = Math.round(raw / step) * step;
      const v = clamp(stepped);
      const changed = v !== value;
      value = v;
      render();
      if (fire && changed) onChange(value);
    }

    // Dragging starts ONLY from a pointerdown on the thumb itself — tapping
    // anywhere else on the track is intentionally inert.
    let dragging = false;
    thumb.addEventListener('pointerdown', (e) => {
      dragging = true;
      thumb.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    thumb.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = trackWrap.getBoundingClientRect();
      const ratio = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
      setValue(min + ratio * (max - min), true);
    });
    function endDrag(e){
      if (!dragging) return;
      dragging = false;
      try { thumb.releasePointerCapture(e.pointerId); } catch (_){}
    }
    thumb.addEventListener('pointerup', endDrag);
    thumb.addEventListener('pointercancel', endDrag);

    minusBtn.addEventListener('click', () => setValue(value - step, true));
    plusBtn.addEventListener('click', () => setValue(value + step, true));

    render();
    return { get: () => value };
  }

  // ---------- text style controls (font size / stroke width) ----------
  const PREVIEW_SCALE = stylePreviewCanvas.width / CANVAS_W; // keep preview proportional to the real 1080px-wide render
  const PREVIEW_SAMPLE_TEXT = 'ตัวอย่างข้อความซับ';

  function drawStylePreview(){
    const pctx = stylePreviewCanvas.getContext('2d');
    const w = stylePreviewCanvas.width, h = stylePreviewCanvas.height;
    pctx.clearRect(0, 0, w, h);
    pctx.fillStyle = '#00FF00';
    pctx.fillRect(0, 0, w, h);
    const fpx = Math.max(6, FONT_PX * PREVIEW_SCALE);
    const spx = Math.max(0, STROKE_PX * PREVIEW_SCALE);
    pctx.font = `700 ${fpx}px "${FONT_FAMILY}"`;
    pctx.textAlign = 'center';
    pctx.textBaseline = 'alphabetic';
    pctx.lineJoin = 'round';
    pctx.miterLimit = 2;
    pctx.lineWidth = spx;
    pctx.strokeStyle = '#000000';
    pctx.fillStyle = '#FFFFFF';
    const py = h - h * BOTTOM_MARGIN_RATIO; // same baseline rule as drawFrame()
    if (spx > 0) pctx.strokeText(PREVIEW_SAMPLE_TEXT, w / 2, py);
    pctx.fillText(PREVIEW_SAMPLE_TEXT, w / 2, py);
  }

  const savedFontPxRaw = localStorage.getItem('gs_font_px');
  const initialFontPx = savedFontPxRaw != null && !Number.isNaN(Number(savedFontPxRaw)) ? Number(savedFontPxRaw) : FONT_PX;
  const savedStrokePxRaw = localStorage.getItem('gs_stroke_px');
  const initialStrokePx = savedStrokePxRaw != null && !Number.isNaN(Number(savedStrokePxRaw)) ? Number(savedStrokePxRaw) : STROKE_PX;

  setupFineSlider({
    trackWrapId: 'fontSizeTrackWrap', thumbId: 'fontSizeThumb', fillId: 'fontSizeFill',
    minusBtnId: 'fontSizeMinus', plusBtnId: 'fontSizePlus',
    min: 40, max: 130, step: 1, initial: initialFontPx, valueLabelEl: fontSizeVal,
    onChange: (v) => {
      FONT_PX = v;
      localStorage.setItem('gs_font_px', String(v));
      if (hasResult) setStageView('style');
      drawStylePreview();
    }
  });
  FONT_PX = initialFontPx;

  setupFineSlider({
    trackWrapId: 'strokeWidthTrackWrap', thumbId: 'strokeWidthThumb', fillId: 'strokeWidthFill',
    minusBtnId: 'strokeWidthMinus', plusBtnId: 'strokeWidthPlus',
    min: 0, max: 24, step: 1, initial: initialStrokePx, valueLabelEl: strokeWidthVal,
    onChange: (v) => {
      STROKE_PX = v;
      localStorage.setItem('gs_stroke_px', String(v));
      if (hasResult) setStageView('style');
      drawStylePreview();
    }
  });
  STROKE_PX = initialStrokePx;

  const savedSyncOffsetRaw = localStorage.getItem('gs_sync_offset_ms');
  const initialSyncOffsetMs = savedSyncOffsetRaw != null && !Number.isNaN(Number(savedSyncOffsetRaw)) ? Number(savedSyncOffsetRaw) : 0;
  const syncOffsetValEl = document.getElementById('syncOffsetVal');
  setupFineSlider({
    trackWrapId: 'syncOffsetTrackWrap', thumbId: 'syncOffsetThumb', fillId: 'syncOffsetFill',
    minusBtnId: 'syncOffsetMinus', plusBtnId: 'syncOffsetPlus',
    min: -300, max: 300, step: 10, initial: initialSyncOffsetMs, valueLabelEl: syncOffsetValEl,
    onChange: (v) => {
      SYNC_OFFSET_MS = v;
      localStorage.setItem('gs_sync_offset_ms', String(v));
    }
  });
  SYNC_OFFSET_MS = initialSyncOffsetMs;

  drawStylePreview();
  document.fonts.ready.then(drawStylePreview).catch(() => {});

  // the style controls live in a collapsed accordion — redraw the preview canvas whenever it opens
  // so it never shows up stale or blank
  document.getElementById('styleAccordion').addEventListener('toggle', (e) => {
    if (e.currentTarget.open){
      drawStylePreview();
      requestAnimationFrame(drawStylePreview);
    }
  });

  // ---------- paste / clear — one pair of buttons per box ----------
  function updateLineCount(){
    const n = editedScript.value.split('\n').filter(l => l.trim()).length;
    scriptLineCount.textContent = n ? `· ${n} บรรทัด` : '';
  }
  editedScript.addEventListener('input', updateLineCount);

  function bindPasteClear(pasteEl, clearEl, textarea, errBox){
    pasteEl.addEventListener('click', async () => {
      hideError(errBox);
      try {
        const text = await navigator.clipboard.readText();
        if (!text){ showError('คลิปบอร์ดว่างเปล่า — คัดลอกข้อความมาก่อนแล้วค่อยกดวาง', errBox); return; }
        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (err){
        showError('วางอัตโนมัติไม่ได้ (เบราว์เซอร์ไม่อนุญาต clipboard) — ลองกดค้างในช่องแล้วเลือก "วาง" เอง', errBox);
      }
    });
    clearEl.addEventListener('click', () => {
      textarea.value = '';
      hideError(errBox);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  bindPasteClear(pasteRawBtn, clearRawBtn, rawScriptInput, rawErrorBox);
  bindPasteClear(pasteBtn, clearScriptBtn, editedScript, scriptErrorBox);
  clearScriptBtn.addEventListener('click', hideAutoSplitStats); // stats describe the box that was just emptied

  // ---------- 3-step tab wizard (top tabs + sticky footer back/next) ----------
  const tabBtns = Array.from(document.querySelectorAll('.tab'));
  const tabPanels = Array.from(document.querySelectorAll('.panel'));
  const backBtn = document.getElementById('backBtn');
  const nextBtn = document.getElementById('nextBtn');
  let currentTab = 0;
  function goTab(i){
    i = Math.max(0, Math.min(tabPanels.length - 1, i));
    if (i !== 0 && !audioEl.paused) audioEl.pause();
    currentTab = i;
    tabBtns.forEach((b, k) => {
      b.classList.toggle('active', k === i);
      b.setAttribute('aria-selected', String(k === i));
    });
    tabPanels.forEach((p, k) => p.classList.toggle('active', k === i));
    backBtn.disabled = i === 0;
    nextBtn.hidden = i === tabPanels.length - 1;
    window.scrollTo(0, 0);
    // the waveform can't be measured while its tab is display:none — redo layout when it's visible again
    if (i === 0 && audioBuffer){
      requestAnimationFrame(() => {
        recomputeBasePxPerSecond(); layoutWaveform(); drawWaveform(); renderPlayheadOnly();
      });
    }
    if (i === 2) drawStylePreview();
  }
  tabBtns.forEach((b, k) => b.addEventListener('click', () => goTab(k)));
  backBtn.addEventListener('click', () => goTab(currentTab - 1));
  nextBtn.addEventListener('click', () => goTab(currentTab + 1));
  goTab(0);
  // ---------- file selection ----------
  fileDrop.addEventListener('click', () => audioFileInput.click());
  audioFileInput.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;

    // reset trim state for the newly selected file up front
    cutRegions = [];
    splitPoints = [];
    selectedSeg = null;
    audioBuffer = null;
    waveformPeaks = null;
    zoom = 1;
    undoStack = [];
    redoStack = [];
    updateHistoryButtons();
    wfSplitBtn.disabled = true;
    refreshSelUI();
    trimCard.style.display = 'none';
    fileInfo.classList.remove('show');

    // If the selection is a video file, pull its audio track out first via
    // Mediabunny (the same library already used for muxing the final
    // render) and continue with a plain audio File from that point on —
    // everything downstream (Whisper, waveform, render) only ever sees an
    // audio file, exactly as before, so none of the existing pipeline
    // needs to know a video was ever involved.
    let fileForPipeline = f;
    let extractedBuffer = null;
    if (isVideoFile(f)){
      fileInfo.innerHTML = 'กำลังดึงเสียงออกจากไฟล์วิดีโอ...';
      fileInfo.classList.add('show');
      try {
        extractedBuffer = await extractAudioFromVideo(f);
        const wavBlob = audioBufferToWavBlob(extractedBuffer);
        const baseName = f.name.replace(/\.[^.]+$/, '') || 'video';
        fileForPipeline = new File([wavBlob], `${baseName}_audio.wav`, { type: 'audio/wav' });
      } catch (err){
        console.error(err);
        fileInfo.innerHTML = `ดึงเสียงจากวิดีโอไม่สำเร็จ: ${escapeHtml(err.message || String(err))}`;
        fileInfo.classList.add('show');
        return;
      }
    }

    selectedFile = fileForPipeline;
    audioEl.src = URL.createObjectURL(fileForPipeline);
    await new Promise(res => {
      audioEl.addEventListener('loadedmetadata', res, { once: true });
    });
    const durationSec = await getReliableDuration(audioEl);
    const mins = Math.floor(durationSec / 60);
    const secs = Math.round(durationSec % 60).toString().padStart(2, '0');
    fileInfo.innerHTML = `<b>${escapeHtml(f.name)}</b> · ${mins}:${secs}${extractedBuffer ? ' <span class="badge">ดึงเสียงจากวิดีโอแล้ว</span>' : ''}`;
    fileInfo.classList.add('show');

    // decode for the waveform. If decoding fails (unsupported format on this
    // browser), the app still works normally — trimming is just unavailable.
    // (video files already have their AudioBuffer from the extraction step above)
    try {
      audioBuffer = extractedBuffer || await decodeAudioFile(fileForPipeline);
      waveformPeaks = computePeaks(audioBuffer, 2000);
      trimCard.style.display = 'block';
      wfSplitBtn.disabled = false;
      renderCutList();
      requestAnimationFrame(() => { recomputeBasePxPerSecond(); layoutWaveform(); drawWaveform(); });
      updatePlayheadAndTime();
    } catch (err){
      console.warn('waveform decode failed, trimming UI unavailable for this file', err);
    }
  });

  // =========================================================
  // WAVEFORM TRIM — let the user see, hear, and cut out parts of the
  // audio (silence, coughs, mistakes) before it's sent to Whisper.
  // =========================================================
  async function decodeAudioFile(file){
    const arrayBuf = await file.arrayBuffer();
    const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      return await tmpCtx.decodeAudioData(arrayBuf);
    } finally {
      tmpCtx.close();
    }
  }

  function isVideoFile(file){
    return (file.type && file.type.startsWith('video/')) || /\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name || '');
  }

  // Demux + decode a video file's audio track into a single AudioBuffer,
  // using Mediabunny (already a dependency of this file for muxing the
  // rendered output). Runs entirely client-side, no upload/transcoding
  // service involved.
  async function extractAudioFromVideo(file){
    const { Input, ALL_FORMATS, BlobSource, AudioBufferSink } = await loadMediabunny();
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) throw new Error('ไม่พบแทร็กเสียงในไฟล์วิดีโอนี้');
    const canDecode = await audioTrack.canDecode();
    if (!canDecode) throw new Error('เบราว์เซอร์นี้ถอดรหัสแทร็กเสียงของไฟล์วิดีโอนี้ไม่ได้');

    const sampleRate = await audioTrack.getSampleRate();
    const numberOfChannels = await audioTrack.getNumberOfChannels();
    const totalDuration = await input.computeDuration();
    const totalSamples = Math.max(1, Math.ceil(totalDuration * sampleRate));

    const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
    let merged;
    try {
      merged = tmpCtx.createBuffer(numberOfChannels, totalSamples, sampleRate);
    } finally {
      tmpCtx.close();
    }

    const sink = new AudioBufferSink(audioTrack);
    for await (const wrapped of sink.buffers()){
      // some encoders write a few audio chunks with a negative presentation
      // timestamp (priming/encoder-delay samples meant to be discarded before
      // t=0) — only some source videos have this, which is why extraction
      // worked for some clips and threw "offset is out of bounds" for others.
      // Clip off the portion of the chunk that lands before time zero instead
      // of writing at a negative index.
      let offset = Math.round(wrapped.timestamp * sampleRate);
      let srcStart = 0;
      if (offset < 0){
        srcStart = -offset;
        offset = 0;
      }
      if (offset >= totalSamples) continue;
      for (let c = 0; c < numberOfChannels; c++){
        const full = wrapped.buffer.numberOfChannels > c ? wrapped.buffer.getChannelData(c) : wrapped.buffer.getChannelData(0);
        if (srcStart >= full.length) continue;
        const src = srcStart > 0 ? full.subarray(srcStart) : full;
        const dest = merged.getChannelData(c);
        const room = totalSamples - offset;
        dest.set(room >= src.length ? src : src.subarray(0, room), offset);
      }
    }
    return merged;
  }

  function computePeaks(buffer, numBuckets){
    const channelCount = buffer.numberOfChannels;
    const length = buffer.length;
    const channelData = [];
    for (let c = 0; c < channelCount; c++) channelData.push(buffer.getChannelData(c));
    const samplesPerBucket = Math.max(1, Math.floor(length / numBuckets));
    const peaks = new Float32Array(numBuckets * 2);
    for (let i = 0; i < numBuckets; i++){
      const start = i * samplesPerBucket;
      const end = Math.min(length, start + samplesPerBucket);
      let min = 0, max = 0;
      for (let j = start; j < end; j++){
        let v = 0;
        for (let c = 0; c < channelCount; c++) v += channelData[c][j];
        v /= channelCount;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      peaks[i*2] = min;
      peaks[i*2+1] = max;
    }
    return peaks;
  }

  function fmtTime(t){
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t/60);
    const s = Math.floor(t%60).toString().padStart(2,'0');
    return `${m}:${s}`;
  }

  // ---------- ripple model: cutRegions are physically gone from the timeline.
  // "virtual" time = position on the (collapsed) timeline the user sees/taps.
  // "orig" time = position in the actual decoded audioBuffer. ----------
  function keptSegments(){
    if (!audioBuffer) return [];
    const dur = audioBuffer.duration;
    const cuts = [...cutRegions].sort((a, b) => a.start - b.start);
    const kept = [];
    let cursor = 0;
    cuts.forEach(c => {
      if (c.start > cursor) kept.push({ start: cursor, end: c.start });
      cursor = Math.max(cursor, c.end);
    });
    if (cursor < dur) kept.push({ start: cursor, end: dur });
    return kept;
  }
  function virtualDuration(){
    return keptSegments().reduce((s, k) => s + (k.end - k.start), 0);
  }
  function isInCutRegion(t){
    return cutRegions.some(r => t >= r.start && t < r.end);
  }
  function origToVirtual(t){
    let acc = 0;
    for (const k of keptSegments()){
      if (t <= k.start) break;
      if (t <= k.end){ acc += (t - k.start); break; }
      acc += (k.end - k.start);
    }
    return acc;
  }
  function virtualToOrig(v){
    let acc = 0;
    const segs = keptSegments();
    for (const k of segs){
      const len = k.end - k.start;
      if (v <= acc + len) return k.start + (v - acc);
      acc += len;
    }
    return segs.length ? segs[segs.length - 1].end : 0;
  }
  // the pieces the user can tap-select: each surviving (kept) region, further
  // cut into pieces at any manual split points inside it
  function selectableSegments(){
    const result = [];
    keptSegments().forEach(k => {
      const pts = splitPoints.filter(p => p > k.start + 0.001 && p < k.end - 0.001).sort((a, b) => a - b);
      let prev = k.start;
      pts.forEach(p => { result.push({ start: prev, end: p }); prev = p; });
      result.push({ start: prev, end: k.end });
    });
    return result;
  }
  function snapOutOfCutRegion(t, forward){
    for (const r of cutRegions){
      if (t >= r.start && t < r.end) return forward ? r.end : r.start;
    }
    return t;
  }

  function totalWidthPx(){
    return Math.max(1, virtualDuration() * pxPerSecond());
  }
  function recomputeBasePxPerSecond(){
    if (!audioBuffer) return;
    const visibleW = waveformScroll.clientWidth || 300;
    basePxPerSecond = visibleW / Math.max(0.001, virtualDuration());
  }
  function maxZoomAllowed(){
    const visibleW = waveformScroll.clientWidth || 300;
    return Math.max(4, Math.min(ZOOM_MAX, 16000 / visibleW));
  }
  function clampZoom(z){
    return Math.max(ZOOM_MIN, Math.min(maxZoomAllowed(), z));
  }
  function updateZoomLabel(){
    wfZoomLabel.textContent = zoom <= 1.02 ? 'พอดีจอ' : Math.round(zoom * 100) + '%';
  }
  function layoutWaveform(){
    if (!audioBuffer) return;
    waveformWrap.style.width = totalWidthPx() + 'px';
    updateZoomLabel();
  }
  function timeToX(t){ return t * pxPerSecond(); }
  function xToTime(x){ return audioBuffer ? Math.max(0, Math.min(virtualDuration(), x / pxPerSecond())) : 0; }
  function clientXToTime(clientX){
    const rect = waveformWrap.getBoundingClientRect();
    return xToTime(clientX - rect.left);
  }
  // client X on the (collapsed) waveform -> real position in the original file
  function clientXToOrigTime(clientX){
    return virtualToOrig(clientXToTime(clientX));
  }
  function clampToDuration(t){
    if (!audioBuffer) return 0;
    return Math.max(0, Math.min(audioBuffer.duration, t));
  }
  function fmtTimePrecise(t){
    return `${fmtTime(t)}.${Math.floor((t % 1) * 10)}`;
  }

  function drawWaveform(){
    if (!waveformPeaks || !audioBuffer) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = waveformCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(110 * dpr));
    if (waveformCanvas.width !== w || waveformCanvas.height !== h){
      waveformCanvas.width = w;
      waveformCanvas.height = h;
    }
    const wctx = waveformCanvas.getContext('2d');
    wctx.clearRect(0, 0, w, h);
    const midY = h / 2;

    wctx.strokeStyle = 'rgba(255,255,255,0.08)';
    wctx.beginPath(); wctx.moveTo(0, midY); wctx.lineTo(w, midY); wctx.stroke();

    const vDur = Math.max(0.001, virtualDuration());
    const totalDur = audioBuffer.duration;
    const numBuckets = waveformPeaks.length / 2;

    // ripple-drawn waveform: every pixel column maps back to a spot in the
    // ORIGINAL file, walking past whatever has already been cut out — so
    // deleted parts simply never appear, and the remaining audio reads as
    // one continuous clip (like CapCut after a delete).
    wctx.strokeStyle = '#39d98a';
    wctx.lineWidth = Math.max(1, dpr);
    wctx.beginPath();
    for (let x = 0; x < w; x++){
      const vTime = (x / w) * vDur;
      const origTime = virtualToOrig(vTime);
      let bi = Math.floor((origTime / totalDur) * numBuckets);
      if (bi < 0) bi = 0; if (bi >= numBuckets) bi = numBuckets - 1;
      const min = waveformPeaks[bi*2], max = waveformPeaks[bi*2+1];
      wctx.moveTo(x, midY - max * midY * 0.92);
      wctx.lineTo(x, midY - min * midY * 0.92);
    }
    wctx.stroke();

    // manual split markers — thin white divider at each split point still standing
    wctx.strokeStyle = 'rgba(255,255,255,0.55)';
    wctx.lineWidth = Math.max(1, dpr);
    splitPoints.forEach(p => {
      if (isInCutRegion(p)) return;
      const dx = (origToVirtual(p) / vDur) * w;
      wctx.beginPath(); wctx.moveTo(dx, 0); wctx.lineTo(dx, h); wctx.stroke();
    });

    // the currently selected piece — highlighted box, ready to delete
    if (selectedSeg){
      const dx1 = (origToVirtual(selectedSeg.start) / vDur) * w;
      const dx2 = (origToVirtual(selectedSeg.end) / vDur) * w;
      wctx.fillStyle = 'rgba(255,255,255,0.14)';
      wctx.fillRect(dx1, 0, Math.max(1, dx2 - dx1), h);
      wctx.strokeStyle = '#ffffff';
      wctx.lineWidth = Math.max(2, dpr * 2);
      wctx.strokeRect(dx1 + 1, 1, Math.max(1, dx2 - dx1 - 2), h - 2);
    }
  }
  window.addEventListener('resize', () => {
    if (!audioBuffer) return;
    recomputeBasePxPerSecond();
    layoutWaveform();
    drawWaveform();
    refreshSelUI();
  });

  // ---------- selection (tap-to-select a whole piece, CapCut style) ----------
  function selectSegmentAt(origTime){
    const segs = selectableSegments();
    let found = segs.find(s => origTime >= s.start - 0.001 && origTime <= s.end + 0.001);
    if (!found && segs.length){
      let best = null, bestD = Infinity;
      segs.forEach(s => {
        const d = Math.min(Math.abs(origTime - s.start), Math.abs(origTime - s.end));
        if (d < bestD){ bestD = d; best = s; }
      });
      found = best;
    }
    selectedSeg = found || null;
    refreshSelUI();
    drawWaveform();
  }

  function refreshSelUI(){
    const has = !!(selectedSeg && audioBuffer);
    wfPlaySelBtn.disabled = !has;
    wfCutSelBtn.disabled = !has;
  }

  function renderPlayheadOnly(){
    if (!audioBuffer) return;
    const vDur = virtualDuration() || 1;
    const vTime = origToVirtual(audioEl.currentTime);
    wfPlayhead.style.left = timeToX(vTime) + 'px';
    wfTime.textContent = `${fmtTime(vTime)} / ${fmtTime(vDur)}`;
  }

  // like autoScrollToPlayhead, but scrolls even at zoom<=1.02 is skipped
  // there anyway (nothing to scroll); kept as its own name so the seek
  // slider's intent (always try to keep the view following) is explicit
  function autoScrollToPlayheadForced(){ autoScrollToPlayhead(); }
  function autoScrollToPlayhead(){
    if (zoom <= 1.02) return; // whole clip already fits — nothing to scroll
    const scrollRect = waveformScroll.getBoundingClientRect();
    const playheadX = timeToX(origToVirtual(audioEl.currentTime));
    const viewLeft = waveformScroll.scrollLeft;
    const viewRight = viewLeft + scrollRect.width;
    if (playheadX < viewLeft + 24 || playheadX > viewRight - 24){
      waveformScroll.scrollLeft = Math.max(0, playheadX - scrollRect.width / 2);
    }
  }

  // 1-finger tap or drag on the waveform moves the playhead (scrub) and, on
  // release, selects whichever piece it landed on — a single tap is all it
  // takes to pick a clip to delete, no painting/dragging a range required.
  // 2-finger gestures pinch-zoom and pan the timeline.
  const activePointers = new Map();
  let dragMode = null;          // 'scrub' | null
  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  let pinchAnchorTime = 0;
  let scrubStartX = 0, scrubStartY = 0;   // to tell a tap (select) from a drag (just scan, no select)
  const TAP_MOVE_THRESHOLD = 8;           // px — below this, pointerup still counts as a tap

  function pointerDist(pts){ return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y); }
  function pointerMid(pts){ return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }; }

  waveformWrap.addEventListener('pointerdown', (e) => {
    if (!audioBuffer) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { waveformWrap.setPointerCapture(e.pointerId); } catch (_){}
    e.preventDefault();

    if (activePointers.size >= 2){
      dragMode = null;
      const pts = Array.from(activePointers.values()).slice(0, 2);
      const scrollRect = waveformScroll.getBoundingClientRect();
      const mid = pointerMid(pts);
      pinchAnchorTime = xToTime(waveformScroll.scrollLeft + (mid.x - scrollRect.left));
      pinchStartDist = Math.max(1, pointerDist(pts));
      pinchStartZoom = zoom;
      return;
    }

    dragMode = 'scrub';
    scrubStartX = e.clientX;
    scrubStartY = e.clientY;
    loopSelection = false;
    audioEl.pause();
    audioEl.currentTime = clientXToOrigTime(e.clientX);
    renderPlayheadOnly();
  });

  waveformWrap.addEventListener('pointermove', (e) => {
    if (!audioBuffer || !activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size >= 2){
      stopEdgeScroll();
      selectedSeg = null; // clear any lingering selection box before re-scaling the view
      refreshSelUI();
      const pts = Array.from(activePointers.values()).slice(0, 2);
      const dist = Math.max(1, pointerDist(pts));
      const mid = pointerMid(pts);
      zoom = clampZoom(pinchStartZoom * (dist / pinchStartDist));
      layoutWaveform();
      const scrollRect = waveformScroll.getBoundingClientRect();
      waveformScroll.scrollLeft = Math.max(0, timeToX(pinchAnchorTime) - (mid.x - scrollRect.left));
      drawWaveform();
      renderPlayheadOnly();
      return;
    }

    if (dragMode === 'scrub'){
      audioEl.currentTime = clientXToOrigTime(e.clientX);
      renderPlayheadOnly();
      edgeScrollPointerX = e.clientX;
      startEdgeScroll();
    }
  });

  function endWfPointer(e){
    activePointers.delete(e.pointerId);
    try { waveformWrap.releasePointerCapture(e.pointerId); } catch (_){}
    if (activePointers.size === 0){
      if (dragMode === 'scrub'){
        // only a genuine tap (barely any movement) selects a piece to
        // delete — a drag used purely to scan the audio no longer leaves
        // a surprise white highlight box behind it
        const moved = Math.hypot(e.clientX - scrubStartX, e.clientY - scrubStartY);
        if (moved < TAP_MOVE_THRESHOLD){
          selectSegmentAt(audioEl.currentTime);
        }
      }
      dragMode = null;
      pinchStartDist = 0;
      stopEdgeScroll();
    }
  }
  waveformWrap.addEventListener('pointerup', endWfPointer);
  waveformWrap.addEventListener('pointercancel', endWfPointer);

  // ---------- zoom controls (buttons; pinch is handled above) ----------
  function zoomBy(factor){
    if (!audioBuffer) return;
    selectedSeg = null; // never carry a highlight box into a new zoom level
    refreshSelUI();
    const anchorVirtual = origToVirtual(audioEl.currentTime);
    const scrollRect = waveformScroll.getBoundingClientRect();
    zoom = clampZoom(zoom * factor);
    layoutWaveform();
    waveformScroll.scrollLeft = Math.max(0, timeToX(anchorVirtual) - scrollRect.width / 2);
    drawWaveform();
    renderPlayheadOnly();
  }
  wfZoomInBtn.addEventListener('click', () => zoomBy(1.6));
  wfZoomOutBtn.addEventListener('click', () => zoomBy(1 / 1.6));
  wfZoomFitBtn.addEventListener('click', () => {
    if (!audioBuffer) return;
    selectedSeg = null;
    refreshSelUI();
    zoom = ZOOM_MIN;
    layoutWaveform();
    waveformScroll.scrollLeft = 0;
    drawWaveform();
    renderPlayheadOnly();
  });

  // ---------- split: drop a divider at the playhead, splitting whichever piece it's in ----------
  const MIN_SEG = 0.12; // seconds — don't allow a split that leaves a sliver this thin
  wfSplitBtn.addEventListener('click', () => {
    if (!audioBuffer) return;
    const t = audioEl.currentTime;
    if (isInCutRegion(t)) return;
    const seg = selectableSegments().find(s => t > s.start + 0.001 && t < s.end - 0.001);
    if (!seg) return; // playhead is already sitting exactly on a boundary — nothing to split
    if (t - seg.start < MIN_SEG || seg.end - t < MIN_SEG) return;
    pushHistory();
    splitPoints.push(t);
    splitPoints.sort((a, b) => a - b);
    // auto-select the piece just carved out to the left of the playhead, CapCut-style
    selectedSeg = { start: seg.start, end: t };
    refreshSelUI();
    drawWaveform();
  });

  // ---------- listen to just the selected piece before deleting it ----------
  wfPlaySelBtn.addEventListener('click', () => {
    if (!selectedSeg || !audioBuffer) return;
    loopSelection = true;
    audioEl.currentTime = clampToDuration(selectedSeg.start);
    audioEl.play();
  });

  // ---------- delete the selected piece — it's gone, remaining audio ripples together ----------
  wfCutSelBtn.addEventListener('click', () => {
    if (!selectedSeg || !audioBuffer) return;
    const { start: a, end: b } = selectedSeg;
    audioEl.pause();
    loopSelection = false;
    pushHistory();
    addCutRegion(a, b);
    splitPoints = splitPoints.filter(p => !isInCutRegion(p));
    selectedSeg = null;
    refreshSelUI();
    drawWaveform();
    renderCutList();
    layoutWaveform();
    renderPlayheadOnly();
  });

  function addCutRegion(start, end){
    let merged = { start, end };
    const remaining = [];
    cutRegions.forEach(r => {
      if (r.end < merged.start || r.start > merged.end){
        remaining.push(r);
      } else {
        merged = { start: Math.min(merged.start, r.start), end: Math.max(merged.end, r.end) };
      }
    });
    remaining.push(merged);
    remaining.sort((x, y) => x.start - y.start);
    cutRegions = remaining;
  }

  function removeCutRegion(idx){
    pushHistory();
    cutRegions.splice(idx, 1);
    layoutWaveform();
    drawWaveform();
    renderCutList();
    renderPlayheadOnly();
  }

  function renderCutList(){
    if (cutRegions.length === 0){
      cutListEl.innerHTML = '<p class="wf-hint" style="margin-top:0;">ยังไม่มีท่อนที่ลบ — ทั้งคลิปจะถูกส่งเข้า Whisper ตามปกติ</p>';
      return;
    }
    cutListEl.innerHTML = cutRegions.map((r, i) =>
      `<div class="cut-item"><span class="cut-range">${fmtTime(r.start)}–${fmtTime(r.end)} (ตัดออก ${fmtTime(r.end - r.start)})</span><button type="button" data-idx="${i}" aria-label="ลบช่วงตัดนี้">ยกเลิก</button></div>`
    ).join('');
    cutListEl.querySelectorAll('button[data-idx]').forEach(btn => {
      btn.addEventListener('click', () => removeCutRegion(Number(btn.dataset.idx)));
    });
  }

  wfPlayBtn.addEventListener('click', () => {
    if (!audioBuffer) return;
    loopSelection = false; // the main ▶ button always plays the whole clip forward
    if (audioEl.paused) audioEl.play(); else audioEl.pause();
  });
  audioEl.addEventListener('play', () => { wfPlayBtn.textContent = '❚❚'; startWfRaf(); });
  audioEl.addEventListener('pause', () => { wfPlayBtn.textContent = '▶'; stopWfRaf(); });
  audioEl.addEventListener('ended', () => { wfPlayBtn.textContent = '▶'; loopSelection = false; stopWfRaf(); updatePlayheadAndTime(); });

  function startWfRaf(){
    stopWfRaf();
    function loop(){
      updatePlayheadAndTime();
      wfRafId = requestAnimationFrame(loop);
    }
    wfRafId = requestAnimationFrame(loop);
  }
  function stopWfRaf(){
    if (wfRafId) cancelAnimationFrame(wfRafId);
    wfRafId = null;
  }
  // Used while actually playing: also loops the "listen to selection" preview
  // and keeps the playhead in view when zoomed in — pointer-drag scrubbing
  // uses the lighter renderPlayheadOnly() instead so it never fights the user's
  // finger by yanking the scroll position mid-drag.
  function updatePlayheadAndTime(){
    if (!audioBuffer) return;
    if (loopSelection && selectedSeg){
      if (audioEl.currentTime >= selectedSeg.end - 0.015){
        audioEl.currentTime = clampToDuration(selectedSeg.start);
      }
    } else if (!audioEl.paused){
      // normal forward playback ripples straight over any deleted piece,
      // exactly like CapCut's preview does
      for (const r of cutRegions){
        if (audioEl.currentTime >= r.start - 0.01 && audioEl.currentTime < r.end){
          audioEl.currentTime = r.end;
          break;
        }
      }
    }
    renderPlayheadOnly();
    autoScrollToPlayhead();
  }

  // ---------- build the final audio actually sent to Whisper + used in the render ----------
  function buildTrimmedAudioBuffer(buffer, regions){
    const sampleRate = buffer.sampleRate;
    const numChannels = buffer.numberOfChannels;
    const totalSamples = buffer.length;
    const cuts = regions
      .map(r => ({
        start: Math.max(0, Math.min(totalSamples, Math.round(r.start * sampleRate))),
        end: Math.max(0, Math.min(totalSamples, Math.round(r.end * sampleRate)))
      }))
      .filter(r => r.end > r.start)
      .sort((a, b) => a.start - b.start);

    const kept = [];
    let cursor = 0;
    cuts.forEach(c => {
      if (c.start > cursor) kept.push({ start: cursor, end: c.start });
      cursor = Math.max(cursor, c.end);
    });
    if (cursor < totalSamples) kept.push({ start: cursor, end: totalSamples });

    const newLength = Math.max(1, kept.reduce((sum, k) => sum + (k.end - k.start), 0));
    const outBuffer = new AudioContext().createBuffer(numChannels, newLength, sampleRate);
    for (let c = 0; c < numChannels; c++){
      const srcData = buffer.getChannelData(c);
      const dstData = outBuffer.getChannelData(c);
      let writeOffset = 0;
      kept.forEach(k => {
        dstData.set(srcData.subarray(k.start, k.end), writeOffset);
        writeOffset += (k.end - k.start);
      });
    }
    return outBuffer;
  }

  function audioBufferToWavBlob(buffer){
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const numFrames = buffer.length;
    const blockAlign = numChannels * 2;
    const dataSize = numFrames * blockAlign;
    const arrBuf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrBuf);
    function writeString(offset, str){
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    const channelData = [];
    for (let c = 0; c < numChannels; c++) channelData.push(buffer.getChannelData(c));
    let offset = 44;
    for (let i = 0; i < numFrames; i++){
      for (let c = 0; c < numChannels; c++){
        const sample = Math.max(-1, Math.min(1, channelData[c][i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        offset += 2;
      }
    }
    return new Blob([arrBuf], { type: 'audio/wav' });
  }

  // Returns the File that should actually be sent to Whisper and used for
  // rendering: the original file untouched if no cuts were made, or a
  // freshly-built WAV with the cut regions physically removed.
  function getFileForProcessing(){
    if (!audioBuffer || cutRegions.length === 0) return selectedFile;
    const trimmedBuffer = buildTrimmedAudioBuffer(audioBuffer, cutRegions);
    const wavBlob = audioBufferToWavBlob(trimmedBuffer);
    return new File([wavBlob], 'trimmed_audio.wav', { type: 'audio/wav' });
  }

  function escapeHtml(s){
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // Chrome/Android sometimes reports duration=Infinity for blob-URL media
  // until the element is seeked once. Force a real duration value.
  function getReliableDuration(mediaEl){
    return new Promise((resolve) => {
      if (isFinite(mediaEl.duration) && mediaEl.duration > 0){
        resolve(mediaEl.duration);
        return;
      }
      const onTimeUpdate = () => {
        mediaEl.removeEventListener('timeupdate', onTimeUpdate);
        mediaEl.currentTime = 0;
        resolve(isFinite(mediaEl.duration) ? mediaEl.duration : 0);
      };
      mediaEl.addEventListener('timeupdate', onTimeUpdate);
      mediaEl.currentTime = 1e10;
    });
  }

  // ---------- helpers ----------
  function fileToBase64(file){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function guessMimeType(file){
    const name = file.name.toLowerCase();
    if (file.type) return file.type;
    if (name.endsWith('.wav')) return 'audio/wav';
    if (name.endsWith('.m4a')) return 'audio/mp4';
    return 'audio/mp3';
  }

  function stripWs(s){
    return s.replace(/\s+/g, '');
  }

  function setStep(el, state){ el.className = state; }
  function showStatus(msg, row = statusRow, textEl = statusText){ row.classList.add('show'); if (textEl) textEl.textContent = msg; }
  function hideStatus(row = statusRow){ row.classList.remove('show'); }
  function showProgress(){ progressWrap.classList.add('show'); setProgress(0); }
  function hideProgress(){ progressWrap.classList.remove('show'); }
  function setProgress(pct){
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    progressFill.style.width = clamped + '%';
    progressPct.textContent = clamped + '%';
  }
  function showError(msg, box = errorBox){ box.textContent = msg; box.classList.add('show'); }
  function hideError(box = errorBox){ box.classList.remove('show'); }

  function srtTime(t){
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.round((t - Math.floor(t)) * 1000);
    const pad = (n, len) => String(n).padStart(len, '0');
    return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)},${pad(ms,3)}`;
  }

  function buildSrt(segments){
    return segments.map((seg, i) =>
      `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(seg.end)}\n${seg.text}\n`
    ).join('\n');
  }

  // =========================================================
  // STEP A — Groq Whisper: real acoustic word timing
  // =========================================================
  async function callGroqWhisper(apiKey, audioFile, promptHint){
    const form = new FormData();
    form.append('file', audioFile);
    form.append('model', GROQ_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('language', 'th');
    // temperature 0 = greedy decoding: ล็อกให้ Whisper ถอดเสียง/Timestamp เดิมทุกครั้งที่กดรัน (ไม่สุ่ม)
    form.append('temperature', '0');
    // optional: user-supplied specialized terms/character names, passed as
    // Whisper's own "prompt" hint so it's more likely to get unusual words
    // right on the first pass instead of mishearing them.
    if (promptHint && promptHint.trim()) form.append('prompt', promptHint.trim());

    const res = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form
    });

    if (!res.ok){
      const errText = await res.text().catch(() => '');
      throw new Error(`Groq Whisper API error (${res.status}): ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const words = data.words || [];
    if (!Array.isArray(words) || words.length === 0){
      throw new Error('Groq Whisper ไม่ส่งข้อมูล word-level timestamp กลับมา (ตรวจว่าเปิด timestamp_granularities[]=word)');
    }
    return words.map(w => ({
      text: String(w.word || ''),
      start: Number(w.start) || 0,
      end: Number(w.end) || 0
    }));
  }

  // =========================================================
  // STEP A.5 — Gemini-assisted script line splitting (OPTIONAL, INDEPENDENT)
  // Runs its own Groq Whisper call (separate from the one inside the main
  // "start" flow below) so this feature can never alter timing/alignment
  // for the actual render — it only ever writes plain text into
  // `editedScript`, which the user can still review/edit before pressing
  // "สร้างคลิป" as always. Nothing in STEP B/C or the render pipeline is
  // touched by this section.
  //
  // Why Whisper runs FIRST and Gemini never hears the raw audio: a
  // general multimodal model asked to listen to audio and place text at
  // the right moment is estimating acoustic position from scratch — that
  // is precisely the failure mode where a word from one sentence gets
  // placed mid-way through another. A dedicated ASR model (Whisper) is
  // built for exactly that job and already produces real word-level
  // timestamps elsewhere in this file. So instead of asking Gemini to
  // guess word position from raw sound, we hand it Whisper's already-
  // measured word sequence (with real pause gaps marked inline) and only
  // ask it to do the part it's actually good at: deciding readable
  // line-break points given real pacing information. Gemini never invents
  // wording — rule 4 in the prompt forces it to reproduce the user's own
  // clean script text, using the transcript purely as a pacing reference.
  // =========================================================

  // Turn Whisper's word list into a plain-text pacing reference: words in
  // spoken order, with a [PAUSE] marker inserted wherever the gap to the
  // next word exceeds PAUSE_MARK_THRESHOLD_SEC. This is intentionally
  // plain text (not JSON) — Gemini just needs to see rhythm, not compute
  // over structured indices we'd otherwise have to trust it not to miscount.
  function buildTranscriptForGemini(whisperWords){
    let out = '';
    for (let i = 0; i < whisperWords.length; i++){
      out += whisperWords[i].text;
      if (i < whisperWords.length - 1){
        const gap = whisperWords[i + 1].start - whisperWords[i].end;
        out += gap > PAUSE_MARK_THRESHOLD_SEC ? ' [PAUSE] ' : ' ';
      }
    }
    return out.trim();
  }

  function buildGeminiSplitPrompt(rawScript, transcriptText, fillMode){
    const rules = [
      'กติกา:',
      `1. เป้าหมายความยาวบรรทัด: ${WORD_RANGE_MIN}-${WORD_RANGE_MAX} คำต่อบรรทัด — บรรทัดส่วนใหญ่ (อย่างน้อย 90%) ต้องอยู่ในช่วงนี้จริงๆ ห้ามเกินเพดานบนหรือต่ำกว่าเพดานล่างเป็นประจำ อนุญาตให้ยืดหยุ่นได้เฉพาะกรณีจำเป็นจริงๆ เท่านั้น เช่น ชื่อเฉพาะที่แยกคำไม่ได้ หรือวลีติดกันแน่นจนแยกแล้วความหมายเสีย — ไม่ใช่ทุกครั้งที่รู้สึกว่า "น่าจะรวมกันดูดีกว่า"`,
      '2. ห้ามปล่อยคำเชื่อม (เช่น เพราะ, และ, แล้ว, แต่, โผล่) ลอยเดี่ยวๆ บนบรรทัดของตัวเอง',
      '3. ใช้ตำแหน่ง [PAUSE] ในทรานสคริปต์เป็นเบาะแสหลักของจุดตัด แต่ยังต้องพิจารณาเป้าหมายความยาวในข้อ 1 ประกอบด้วย — ถ้าช่วงยาวไม่มี [PAUSE] เลย ให้ใช้เป้าหมายความยาวเป็นตัวช่วยตัดสินใจแทน'
    ];

    if (fillMode){
      rules.push(
        '4. เทียบลำดับคำใน "สคริปต์ต้นฉบับ" กับ "ทรานสคริปต์เสียงจริง" ไปทีละช่วง — ช่วงไหนที่สคริปต์ต้นฉบับมีข้อความรองรับอยู่แล้ว ให้คงคำจากสคริปต์ต้นฉบับเป๊ะ 100% ห้ามเปลี่ยนแม้สะกดจะต่างจากทรานสคริปต์',
        '5. ช่วงไหนที่ทรานสคริปต์เสียงจริงมีคำพูดอยู่ แต่สคริปต์ต้นฉบับไม่มีข้อความรองรับเลย (ช่องว่าง/ไม่ครอบคลุม) ให้ดึงคำจากทรานสคริปต์เสียงจริงมาใช้แทนสำหรับช่วงนั้น และขึ้นต้นทุกบรรทัดที่เนื้อหามาจากทรานสคริปต์ (ไม่ใช่จากสคริปต์ต้นฉบับ) ด้วยข้อความ "[AI] " ที่จุดเริ่มบรรทัด (ห้ามใช้สัญลักษณ์อีโมจิ ใช้ตัวอักษรธรรมดา "[AI] " เท่านั้น) เพื่อให้แยกออกจากบรรทัดที่มาจากสคริปต์ต้นฉบับได้ง่าย',
        '6. ถ้าสคริปต์ต้นฉบับว่างเปล่าทั้งหมด ให้ใช้ทรานสคริปต์เสียงจริงทั้งหมดเป็นฐานในการตัดบรรทัด และขึ้นต้นทุกบรรทัดด้วย "[AI] "',
        '7. ประมวลผลครั้งเดียวจากต้นจนจบ ห้ามวนซ้ำ ห้ามพิมพ์ซ้ำ ห้ามหยุดก่อนถึงคำสุดท้ายของทรานสคริปต์เสียงจริง'
      );
    } else {
      rules.push(
        '4. ห้ามเพิ่ม/ตัด/เรียงคำใหม่ ต้องคงคำและลำดับจาก "สคริปต์ต้นฉบับ" เป๊ะ 100% — ทรานสคริปต์เสียงจริงมีไว้ดูจังหวะเท่านั้น ห้ามเอาคำจากทรานสคริปต์มาแทนคำในสคริปต์ต้นฉบับแม้จะสะกดต่างกัน',
        '5. ถ้ามีบางช่วงของทรานสคริปต์เสียงจริงที่ไม่มีข้อความในสคริปต์ต้นฉบับรองรับเลย ให้ข้ามช่วงนั้นไปเงียบๆ ห้ามแต่งข้อความเติมเอง และห้ามพยายามยัดคำจากสคริปต์ต้นฉบับไปเติมช่วงที่ไม่ตรงกันจริงๆ',
        '6. ประมวลผลครั้งเดียวจากต้นจนจบ ห้ามวนซ้ำ ห้ามพิมพ์ซ้ำ ห้ามหยุดก่อนสคริปต์ต้นฉบับหมด'
      );
    }

    return [
      'คุณคือ Thai Subtitle Pacing Engine',
      '',
      'หน้าที่: แบ่ง "สคริปต์ต้นฉบับ" ด้านล่างออกเป็นบรรทัดย่อยสำหรับซับไตเติ้ล โดยใช้ "ทรานสคริปต์เสียงจริงพร้อมจุดหยุด" เป็นตัวช่วยตัดสินใจว่าจะตัดจังหวะตรงไหน',
      '',
      ...rules,
      '',
      'รูปแบบผลลัพธ์: พิมพ์เฉพาะบรรทัดที่ตัดวรรคแล้ว ห้ามมีคำนำ ห้ามมีคำอธิบาย ห้ามมี code block',
      '',
      '--- สคริปต์ต้นฉบับ ---',
      rawScript ? rawScript : '(ไม่มี — ไม่มีสคริปต์ต้นฉบับให้เลย ใช้ทรานสคริปต์เสียงจริงทั้งหมดแทนตามกติกาข้อที่เกี่ยวข้องด้านบน)',
      '',
      `--- ทรานสคริปต์เสียงจริงพร้อมจุดหยุด (ใช้ดูจังหวะเสมอ${fillMode ? ' และใช้เป็นแหล่งคำสำหรับช่วงที่สคริปต์ไม่ครอบคลุม' : ' ห้ามคัดลอกคำจากส่วนนี้เว้นแต่กติกาด้านบนอนุญาต'}) ---`,
      transcriptText
    ].join('\n');
  }

  async function callGeminiSplit(apiKey, rawScript, transcriptText, fillMode){
    const prompt = buildGeminiSplitPrompt(rawScript, transcriptText, fillMode);
    const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 }
      })
    });

    if (!res.ok){
      const errText = await res.text().catch(() => '');
      throw new Error(`Gemini API error (${res.status}): ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    const text = Array.isArray(parts) ? parts.map(p => p.text || '').join('') : '';
    const cleaned = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
    if (!cleaned) throw new Error('Gemini ไม่ส่งข้อความบรรทัดที่แยกแล้วกลับมา ลองใหม่อีกครั้ง');
    return cleaned;
  }

  // ---------- AI split progress bar: staged milestones (15 -> 45 -> 85 -> 100) with a gentle
  // creep toward each milestone so the bar keeps moving and never looks frozen ----------
  const autoSplitProgressWrap = document.getElementById('autoSplitProgressWrap');
  const autoSplitProgressFill = document.getElementById('autoSplitProgressFill');
  const autoSplitProgressPct = document.getElementById('autoSplitProgressPct');
  let asProgress = 0, asTarget = 0, asCreepId = null, asHideTimer = null, asRemoveTimer = null;
  function renderAutoSplitProgress(){
    const p = Math.max(0, Math.min(100, Math.round(asProgress)));
    autoSplitProgressFill.style.width = p + '%';
    autoSplitProgressPct.textContent = p + '%';
  }
  function stopAutoSplitCreep(){ if (asCreepId){ clearInterval(asCreepId); asCreepId = null; } }
  function clearAutoSplitTimers(){
    stopAutoSplitCreep();
    if (asHideTimer){ clearTimeout(asHideTimer); asHideTimer = null; }
    if (asRemoveTimer){ clearTimeout(asRemoveTimer); asRemoveTimer = null; }
  }
  function beginAutoSplitProgress(){
    clearAutoSplitTimers();
    asProgress = 15; asTarget = 15;
    autoSplitProgressWrap.classList.remove('fading');
    autoSplitProgressWrap.classList.add('show');
    renderAutoSplitProgress();
    showAutoSplitStatus('กำลังเตรียมไฟล์เสียง...');
  }
  // move toward a milestone: snap forward quickly, then keep creeping so it never looks stuck
  function autoSplitProgressTo(target){
    asTarget = target;
    stopAutoSplitCreep();
    asCreepId = setInterval(() => {
      const gap = asTarget - asProgress;
      asProgress = gap < 0.4 ? asTarget : asProgress + gap * 0.1;
      renderAutoSplitProgress();
      if (asProgress >= asTarget) stopAutoSplitCreep();
    }, 300);
  }
  function finishAutoSplitProgress(){
    stopAutoSplitCreep();
    asProgress = 100; renderAutoSplitProgress();
    showAutoSplitStatus('เสร็จแล้ว');
    asHideTimer = setTimeout(() => {
      autoSplitProgressWrap.classList.add('fading');
      hideAutoSplitStatus();
      asRemoveTimer = setTimeout(() => {
        autoSplitProgressWrap.classList.remove('show', 'fading');
      }, 500);
    }, 900);
  }
  function failAutoSplitProgress(){
    clearAutoSplitTimers();
    autoSplitProgressWrap.classList.remove('show', 'fading');
    hideAutoSplitStatus();
  }

  function showAutoSplitStatus(msg){ autoSplitStatusRow.classList.add('show'); autoSplitStatusText.textContent = msg; }
  function hideAutoSplitStatus(){ autoSplitStatusRow.classList.remove('show'); }
  function showAutoSplitError(msg){ autoSplitErrorBox.textContent = msg; autoSplitErrorBox.classList.add('show'); }
  function hideAutoSplitError(){ autoSplitErrorBox.classList.remove('show'); }
  function hideAutoSplitStats(){ autoSplitStatsEl.style.display = 'none'; }
  function showAutoSplitStats(splitLines){
    const lines = splitLines.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0){ hideAutoSplitStats(); return; }
    // Thai is normally written with no spaces between words, so a space-split
    // "word count" on the AI's own output would be meaningless here — character
    // count (stripped of whitespace) is the only length measure that's actually
    // comparable to the ${WORD_RANGE_MIN}-${WORD_RANGE_MAX} guideline in a
    // consistent way, so that's what's reported back to the user.
    const lens = lines.map(l => stripWs(l).length);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    const max = Math.max(...lens);
    const flagged = lines.filter(l => l.startsWith('[AI]')).length;
    let msg = `ได้ ${lines.length} บรรทัด · เฉลี่ย ${avg.toFixed(1)} ตัวอักษร/บรรทัด (ยาวสุด ${max})`;
    if (flagged > 0) msg += ` · ${flagged} บรรทัดมาจากเสียงล้วนๆ (ไม่มีในสคริปต์ต้นฉบับ) ควรตรวจก่อนใช้จริง`;
    autoSplitStatsEl.textContent = msg;
    autoSplitStatsEl.style.display = 'block';
  }

  autoSplitBtn.addEventListener('click', async () => {
    hideAutoSplitError();
    hideAutoSplitStats();
    const geminiKey = apiKeyGeminiInput.value.trim();
    const groqKey = apiKeyGroqInput.value.trim();
    const raw = rawScriptInput.value.trim();

    if (!groqKey){ showAutoSplitError('กรอก Groq API Key ก่อน (ปุ่ม API Keys)'); return; }
    if (!geminiKey){ showAutoSplitError('กรอก Gemini API Key ก่อน (ปุ่ม API Keys)'); return; }
    if (!selectedFile){ showAutoSplitError('เลือกไฟล์เสียงหรือวิดีโอก่อน (แท็บ "เสียง & ตัดต่อ")'); return; }
    if (!SCRIPT_FILL_MODE && !raw){ showAutoSplitError('วางสคริปต์ดิบในกล่อง 1 ก่อน (หรือเปิด "ตั้งค่า AI เพิ่มเติม" แล้วสลับเป็นโหมด "เติมจากเสียงด้วย" ถ้าไม่มีสคริปต์)'); return; }

    autoSplitBtn.disabled = true;
    beginAutoSplitProgress(); // 15%
    try {
      if (!audioEl.paused) audioEl.pause();
      if (cutRegions.length > 0) showAutoSplitStatus('กำลังตัดส่วนที่เลือกออกจากไฟล์เสียง...');
      const processedFile = getFileForProcessing();

      autoSplitProgressTo(45); // Whisper phase
      showAutoSplitStatus('กำลังจับเวลาเสียงจริง (Whisper)...');
      const whisperWords = await callGroqWhisper(groqKey, processedFile, whisperHintTermsInput.value);

      asProgress = Math.max(asProgress, 45); renderAutoSplitProgress();
      autoSplitProgressTo(85); // Gemini phase
      showAutoSplitStatus('กำลังแยกบรรทัดด้วย Gemini ตามจังหวะเสียงจริง...');
      const transcriptText = buildTranscriptForGemini(whisperWords);
      const splitLines = await callGeminiSplit(geminiKey, raw, transcriptText, SCRIPT_FILL_MODE);

      editedScript.value = splitLines;
      updateLineCount();
      showAutoSplitStats(splitLines);
      finishAutoSplitProgress(); // 100% then fade out
      editedScript.scrollIntoView({ behavior: 'smooth', block: 'center' }); // bring the result into view
    } catch (err){
      console.error(err);
      failAutoSplitProgress();
      showAutoSplitError(err.message || 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง');
    } finally {
      autoSplitBtn.disabled = false;
    }
  });

  // ---------- canvas drawing ----------
  function drawFrame(text){
    ctx.fillStyle = '#00FF00';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    if (!text) return;

    ctx.font = `700 ${FONT_PX}px "${FONT_FAMILY}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = STROKE_PX;
    ctx.strokeStyle = '#000000';
    ctx.fillStyle = '#FFFFFF';

    const x = CANVAS_W / 2;
    const y = CANVAS_H - (CANVAS_H * BOTTOM_MARGIN_RATIO);

    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }

  function findActiveText(segments, t){
    for (const seg of segments){
      if (t >= seg.start && t < seg.end) return seg.text;
    }
    return '';
  }

  // =========================================================
  // RENDER — deterministic, offline (WebCodecs via Mediabunny)
  // The old approach recorded canvas + audio in real time through
  // MediaRecorder while the audio actually played back — so the result
  // depended on the phone keeping up at that exact moment. Any hiccup
  // (thermal throttling, another app stealing CPU) dropped or delayed
  // frames and baked a slightly-wrong clip that only showed up after the
  // fact, which is why some renders needed 2-3 tries. This version never
  // "plays" anything: audio is decoded once into raw samples, video frames
  // are drawn and encoded one at a time on a fixed timeline, and both are
  // muxed into an mp4. A slow device just takes longer — the output timing
  // is identical no matter how the render actually went, every time.
  // =========================================================
  const MEDIABUNNY_CDN = 'https://cdn.jsdelivr.net/npm/mediabunny@1.54.0/+esm';
  let mediabunnyModulePromise = null;
  function loadMediabunny(){
    if (!mediabunnyModulePromise) mediabunnyModulePromise = import(MEDIABUNNY_CDN);
    return mediabunnyModulePromise;
  }

  async function renderVideo(segments, audioBuffer, onProgress){
    await document.fonts.load(`700 ${FONT_PX}px "${FONT_FAMILY}"`);
    await document.fonts.ready;

    const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, QUALITY_HIGH } = await loadMediabunny();

    const output = new Output({
      format: new Mp4OutputFormat(),
      target: new BufferTarget(),
    });

    const videoSource = new CanvasSource(canvas, { codec: 'avc', quality: QUALITY_HIGH });
    output.addVideoTrack(videoSource);

    const audioSource = new AudioBufferSource({ codec: 'aac', quality: QUALITY_HIGH });
    output.addAudioTrack(audioSource);

    await output.start();

    const FPS = 30;
    const frameDur = 1 / FPS;
    const durationSec = audioBuffer.duration;
    const totalFrames = Math.max(1, Math.ceil(durationSec * FPS));

    for (let i = 0; i < totalFrames; i++){
      const t = i * frameDur;
      const dur = Math.min(frameDur, durationSec - t);
      drawFrame(findActiveText(segments, t));
      await videoSource.add(t, dur);
      if (typeof onProgress === 'function'){
        onProgress(Math.min(97, (t / durationSec) * 100));
      }
    }

    if (typeof onProgress === 'function') onProgress(98);
    await audioSource.add(audioBuffer);

    await output.finalize();
    if (typeof onProgress === 'function') onProgress(100);

    const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
    return { blob, durationSeconds: durationSec };
  }

  // ---------- STEP — confirm lines, run Whisper + matching + acoustic
  // refinement, then render straight away. No manual per-line review step:
  // Whisper's global alignment plus the energy-refinement pass above
  // handle the common cases automatically; if a specific clip still comes
  // out wrong, nudge the whole-clip offset slider above or edit the script
  // and re-run. ----------
  startBtn.addEventListener('click', async () => {
    // หยุดและรีเซ็ตคลิปตัวอย่างเก่าทันที กันเสียงคลิปเก่าแอบดังแทรกตอนเรนเดอร์คลิปใหม่
    previewVideo.pause(); previewVideo.currentTime = 0;
    hideError();
    resultCard.classList.remove('show');

    const groqKey = apiKeyGroqInput.value.trim();
    // strip the "[AI]" auto-fill marker (added by the auto-split feature above to
    // flag lines it pulled from audio rather than the user's own script) —
    // it's a review aid for the textarea only and must never end up as
    // literal burned-in subtitle text.
    const lines = editedScript.value.split('\n').map(l => l.trim().replace(/^\[AI\]\s*/, '')).filter(l => l.length > 0);

    if (!groqKey){ showError('กรอก Groq API Key ก่อน (กดปุ่ม API Keys ด้านบน)'); return; }
    if (!selectedFile){ showError('เลือกไฟล์เสียงพากย์ก่อน (แท็บ "เสียง & ตัดต่อ")'); return; }
    if (lines.length === 0){ showError('ใส่สคริปต์ก่อน (แท็บ "สคริปต์" อย่างน้อย 1 บรรทัด)'); return; }

    if (!audioEl.paused) audioEl.pause();

    // stage: show the progress overlay on top of the style preview while rendering
    hasResult = false;
    stageSwitch.classList.remove('show');
    setStageView('style');
    stage.classList.add('is-rendering');

    startBtn.disabled = true;
    setStep(step1, 'active'); setStep(step2, 'pending'); setStep(step3, 'pending');

    try {
      if (cutRegions.length > 0){
        showStatus('กำลังตัดส่วนที่เลือกออกจากไฟล์เสียง...');
      }
      const processedFile = getFileForProcessing();

      showStatus('กำลังถอดรหัสไฟล์เสียง...');
      const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
      const renderAudioBuffer = await decodeCtx.decodeAudioData(await processedFile.arrayBuffer());
      await decodeCtx.close();

      showStatus('กำลังจับเวลาเสียงจริง (Whisper)...');
      const whisperWords = await callGroqWhisper(groqKey, processedFile, whisperHintTermsInput.value);
      setStep(step1, 'done'); setStep(step2, 'active');
      showStatus('กำลังจับคู่บรรทัดกับเสียง...');

      let segments = alignLinesToWords(lines, whisperWords);
      // uniform correction, only for a whole-clip bias (see slider hint)
      if (SYNC_OFFSET_MS !== 0){
        const off = SYNC_OFFSET_MS / 1000;
        segments = segments.map(s => ({
          ...s,
          start: Math.max(0, s.start + off),
          end: Math.max(0.02, s.end + off)
        }));
        for (let i = 0; i < segments.length - 1; i++){
          if (segments[i].end > segments[i + 1].start) segments[i].end = segments[i + 1].start;
        }
      }

      showStatus('กำลังปรับจุดตัดให้ตรงคลื่นเสียงจริง...');
      segments = refineSegmentBoundariesWithEnergy(segments, renderAudioBuffer);
      setStep(step2, 'done'); setStep(step3, 'active');

      showStatus('กำลังเรนเดอร์คลิปจอเขียว...');
      showProgress();

      const { blob: videoBlob, durationSeconds } = await renderVideo(segments, renderAudioBuffer, setProgress);
      setStep(step3, 'done');
      hideProgress();

      const videoUrl = URL.createObjectURL(videoBlob);
      previewVideo.src = videoUrl;
      dlVideo.href = videoUrl;

      const srtBlob = new Blob([buildSrt(segments)], { type: 'text/plain' });
      dlSrt.href = URL.createObjectURL(srtBlob);

      resultCard.classList.add('show');
      hasResult = true;
      stageSwitch.classList.add('show');
      stage.classList.remove('is-rendering');
      setStageView('video');          // swap the stage to the finished clip
      previewVideo.currentTime = 0;
      previewVideo.play().catch(() => {}); // autoplay may be blocked on some browsers — controls are visible
      hideStatus();
    } catch (err){
      console.error(err);
      hideStatus();
      hideProgress();
      showError(err.message || 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง');
    } finally {
      stage.classList.remove('is-rendering');
      startBtn.disabled = false;
    }
  });

