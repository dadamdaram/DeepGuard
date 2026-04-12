/**
 * DeepGuard Pro — Analysis Engine v4
 * Deepfake + AI-Generated Image Detection · Upload fix · PDF 개선
 */
(function () {
  'use strict';
  const { Store, API, Toast, Modal, computeSHA256, fmtBytes, fmtTime, fmtDate,
          confidenceColor, verdictMeta, renderPagination } = window.DG;

  /* ─── State ─────────────────────────────────────────────── */
  let worker = null;
  let videoEl = null;
  let rafId = null;
  let frameCount = 0;
  let frameBuf = [];
  let currentInputType = 'video';
  const SAMPLE_RATE = 6; // 프레임 샘플링 간격 증가 → 속도 개선
  const BATCH_SIZE  = 16; // 배치 축소 → 첫 결과 응답 빠름
  let chartCtx = null;
  const chartData = { labels: [], scores: [], dfScores: [], aiScores: [] };

  /* ─── Worker ─────────────────────────────────────────────── */
  function initWorker() {
    worker = new Worker('./js/analyzer.worker.js');
    worker.onmessage = handleWorkerMsg;
    worker.postMessage({ type: 'INIT' });
  }

  function handleWorkerMsg({ data: { type, payload } }) {
    const a = Store.get('analysis');
    switch (type) {
      case 'MODEL_READY':
        Store.set('analysis', { analysisStatus: 'ready' });
        updateUI();
        break;
      case 'MODEL_ERROR':
        Store.set('analysis', { analysisStatus: 'error' });
        stopCapture();
        document.getElementById('live-panel')?.classList.add('hidden');
        document.getElementById('start-btn')?.classList.remove('hidden');
        document.getElementById('stop-btn')?.classList.add('hidden');
        Toast.error('분석 중단: ' + payload);
        const section = document.getElementById('result-section');
        if (section) {
          section._rendered = true;
          section.innerHTML = `
            <div class="card p-28 fade-up" style="border-color:rgba(255,59,92,.5); background:rgba(255,59,92,.05)">
              <div class="flex items-center gap-16 mb-20">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--clr-danger)" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                <h2 style="font-size:1.5rem;font-weight:800;color:var(--clr-danger);margin:0">분석 실패 (오류 발생)</h2>
              </div>
              <p style="font-size:1rem;color:rgba(255,255,255,.8);line-height:1.6">AI 분석 통신 중 문제가 발생하여 신뢰할 수 없는 위조 분석을 방지하기 위해 프로세스를 차단했습니다.</p>
              <div style="background:rgba(0,0,0,.3);border-left:3px solid var(--clr-danger);padding:12px;margin-top:16px;border-radius:4px">
                <p style="font-size:.85rem;color:var(--clr-danger);font-family:var(--font-mono)">${payload}</p>
              </div>
              <p style="font-size:.85rem;color:rgba(255,255,255,.5);margin-top:16px">👉 API 키의 월간 한도(Quota)가 초과되었거나 서버 연결이 원활하지 않습니다. 좌측 메뉴에서 구글 계정을 변경하거나 API 키를 새로 발급받아 등록해 주세요.</p>
            </div>
          `;
          section.classList.remove('hidden');
        }
        break;
      case 'FRAME_RESULT': {
        const frames = [...(a.frameResults||[]), payload];
        Store.set('analysis', {
          frameResults: frames,
          liveConfidence: payload.smoothedConfidence,
          analysisProgress: payload.progress || 0,
          frameCount: frames.length,
        });
        pushChartPoint(payload.timestamp, payload.smoothedConfidence, payload.dfConfidence, payload.aiConfidence);
        updateLiveUI(payload);
        break;
      }
      case 'ANALYSIS_COMPLETE':
        Store.set('analysis', {
          overallResult: payload,
          analysisStatus: 'complete',
          analysisProgress: 1,
          liveConfidence: payload.avgConfidence,
        });
        stopCapture();
        try {
          renderResult(payload);
        } catch(renderErr) {
          console.error('[DeepGuard] renderResult 오류:', renderErr);
          Toast.error('결과 표시 오류: ' + renderErr.message);
        }
        saveAnalysis(payload);
        // 완료 배너는 renderResult 내에 포함
        break;
    }
  }

  /* ─── Frame capture ─────────────────────────────────────── */
  function onFrame(now, metadata) {
    if (!videoEl || videoEl.paused || videoEl.ended) return;
    frameCount++;
    if (frameCount % SAMPLE_RATE !== 0) { scheduleFrame(); return; }
    const ts = metadata?.mediaTime ?? videoEl.currentTime;
    createImageBitmap(videoEl, { resizeWidth:224, resizeHeight:224, resizeQuality:'medium' })
      .then(bmp => {
        frameBuf.push({ imageBitmap:bmp, frameIndex:frameCount, timestamp:ts });
        if (frameBuf.length >= BATCH_SIZE) flushBatch();
      });
    scheduleFrame();
  }
  function scheduleFrame() {
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype)
      rafId = videoEl.requestVideoFrameCallback(onFrame);
    else
      rafId = requestAnimationFrame(() => onFrame(performance.now(), null));
  }
  function flushBatch() {
    if (!frameBuf.length) return;
    const batch = frameBuf.splice(0, BATCH_SIZE);
    worker.postMessage({ type:'ANALYZE', payload:{ frames:batch } }, batch.map(f => f.imageBitmap));
  }
  function stopCapture() {
    if (videoEl && rafId) {
      if ('cancelVideoFrameCallback' in videoEl) videoEl.cancelVideoFrameCallback(rafId);
      else cancelAnimationFrame(rafId);
    }
    flushBatch();
  }

  /* ─── Image analysis ─────────────────────────────────────── */
  function analyzeImage() {
    const a = Store.get('analysis');
    if (a.analysisStatus === 'analyzing') return;

    const file = a.file;
    const imgEl = document.getElementById('image-preview');
    const bitmapSource = file && file.type?.startsWith('image/') ? file : imgEl;

    if (!bitmapSource || (bitmapSource === imgEl && (!imgEl.src || imgEl.src === location.href))) {
      Toast.warn('이미지를 먼저 업로드하세요'); return;
    }

    const doAnalyze = async () => {
      // hash가 없으면 직접 계산
      const cur = Store.get('analysis');
      if (!cur.hash && file) {
        try {
          const hash = await computeSHA256(file);
          Store.set('analysis', { hash });
        } catch(e) { console.warn('[DeepGuard] hash 계산 실패:', e); }
      }

      Store.set('analysis', { analysisStatus:'analyzing', analysisProgress:0, inputType:'image' });
      // 이전 결과 _rendered 플래그 초기화 — 재분석 시 결과가 표시되지 않는 버그 방지
      const rs = document.getElementById('result-section');
      if (rs) { rs._rendered = false; rs.classList.add('hidden'); rs.innerHTML = ''; }
      document.getElementById('url-text-section')?.classList.add('hidden');
      document.getElementById('live-panel')?.classList.remove('hidden');
      document.getElementById('start-btn')?.classList.add('hidden');
      document.getElementById('stop-btn')?.classList.remove('hidden');
      initChart(); // 과거 판정(차트) 찌꺼기 완벽하게 클리어!

      console.log('[DeepGuard] createImageBitmap 시작, source:', bitmapSource === file ? 'File' : 'ImgEl');

      // URL 이미지는 cross-origin tainted → canvas로 픽셀 복사해 origin-clean bitmap 생성
      const makeSafeBitmap = async (source) => {
        // File/Blob은 그대로 사용 가능
        if (source instanceof File || source instanceof Blob) {
          return createImageBitmap(source);
        }
        // <img> 엘리먼트: canvas를 통해 origin-clean 픽셀 복사
        const img = source;
        // cross-origin 이미지면 서버 프록시로 재시도
        if (img.src && !img.src.startsWith('blob:') && !img.src.startsWith('data:') && !img.src.startsWith(location.origin)) {
          try {
            const proxyRes = await fetch(`/api/url-image-proxy?url=${encodeURIComponent(img.src)}`);
            if (proxyRes.ok) {
              const { base64, mimeType } = await proxyRes.json();
              const byteStr = atob(base64);
              const bytes = new Uint8Array(byteStr.length);
              for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
              const blob = new Blob([bytes], { type: mimeType });
              return createImageBitmap(blob);
            }
          } catch (proxyErr) {
            console.warn('[DeepGuard] 프록시 실패, canvas 방식으로 시도:', proxyErr.message);
          }
        }
        // canvas 픽셀 복사 (same-origin / blob URL / data URL)
        const canvas = new OffscreenCanvas(img.naturalWidth || 512, img.naturalHeight || 512);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
        return createImageBitmap(blob);
      };

      makeSafeBitmap(bitmapSource)
        .then(bmp => {
          console.log('[DeepGuard] bitmap 생성 완료, worker로 전송');
          worker.postMessage(
            { type:'ANALYZE', payload:{ frames:[{ imageBitmap:bmp, frameIndex:1, timestamp:0 }] } },
            [bmp]
          );
          
          // 가짜 프로그레스 바 애니메이션 (길어진 API 호출 시간에 대한 UX 개선)
          if (window._dgFakeProgInt) clearInterval(window._dgFakeProgInt);
          let fakeProgress = 0;
          const progFill = document.getElementById('analysis-progress-fill');
          if (progFill) progFill.style.transition = 'width 0.5s ease-out';
          
          window._dgFakeProgInt = setInterval(() => {
            if (Store.get('analysis').analysisStatus !== 'analyzing') {
              clearInterval(window._dgFakeProgInt);
              if (progFill) progFill.style.width = '100%';
              return;
            }
            if (fakeProgress < 0.95) {
              fakeProgress += (0.95 - fakeProgress) * 0.05 + 0.01;
              if (progFill) progFill.style.width = (fakeProgress * 100) + '%';
            }
          }, 800);
        })
        .catch(e => {
          console.error('[DeepGuard] createImageBitmap 실패:', e);
          Toast.error('이미지 로드 실패: ' + e.message);
          Store.set('analysis', { analysisStatus:'ready' });
          document.getElementById('start-btn')?.classList.remove('hidden');
          document.getElementById('stop-btn')?.classList.add('hidden');
        });
    };

    if (!worker) { initWorker(); }

    // idle 포함 — worker는 TF.js 없으므로 즉시 ready
    const status = Store.get('analysis').analysisStatus;
    if (status === 'ready' || status === 'idle') {
      Store.set('analysis', { analysisStatus: 'ready' });
      doAnalyze();
    } else {
      
      document.getElementById('start-btn').disabled = true;
      const unsub = Store.on('analysis', state => {
        if (state.analysisStatus === 'ready') {
          unsub();
          doAnalyze();
        }
      });
    }
  }

  /* ─── Hash pipeline ──────────────────────────────────────── */
  async function processFile(file) {
    Store.set('analysis', {
      file, hash:null, hashStatus:'hashing', hashProgress:0,
      frameResults:[], overallResult:null, analysisProgress:0, analysisStatus:'idle',
    });
    updateHashUI({ status:'hashing', progress:0 });
    try {
      const hash = await computeSHA256(file, p => {
        Store.set('analysis', { hashProgress:p });
        updateHashUI({ status:'hashing', progress:p });
      });
      Store.set('analysis', { hash, hashStatus:'checking' });
      updateHashUI({ status:'checking', hash });
      let cached = null;
      try { cached = await API.get(`/analysis/hash/${hash}`); }
      catch (e) { if (e.status !== 404) console.warn('Cache:', e); }
      if (cached) {
        Store.set('analysis', { hashStatus:'cached' });
        updateHashUI({ status:'cached', hash });
        showCachedResult(cached); return;
      }
      Store.set('analysis', { hashStatus:'new' });
      updateHashUI({ status:'new', hash });
      enableStartBtn();
    } catch (err) {
      Store.set('analysis', { hashStatus:'error' });
      Toast.error('파일 처리 오류');
      console.error(err);
    }
  }

  /* ─── URL pipeline ───────────────────────────────────────── */
  async function processUrl(urlStr) {
    if (!urlStr || !urlStr.startsWith('http')) {
      Toast.warn('http:// 또는 https://로 시작하는 URL을 입력하세요'); return;
    }
    const statusEl = document.getElementById('url-status');
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--clr-accent)">미디어 추출 중...</span>';
    Store.set('analysis', {
      file:null, hash:null, hashStatus:'idle', sourceUrl:urlStr,
      inputType:'url', frameResults:[], overallResult:null,
      analysisProgress:0, analysisStatus:'idle',
    });
    try {
      const meta = await API.get(`/url-meta?url=${encodeURIComponent(urlStr)}`);
      if (!meta.mediaUrl) {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--clr-danger)">분석 가능한 미디어를 찾지 못했습니다</span>';
        Toast.warn('해당 링크에서 이미지 또는 영상을 추출하지 못했습니다'); return;
      }
      const typeLabel = meta.mediaType==='video' ? '영상' : meta.isArticleThumb ? '기사 썸네일 이미지' : '이미지';
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--clr-safe)">✓ ${typeLabel} 발견${meta.title?' — '+meta.title.slice(0,40):''}</span>`;
      const fileInfo = document.getElementById('file-info');
      const fileName = document.getElementById('file-name');
      if (fileInfo) fileInfo.classList.remove('hidden');
      if (fileName) fileName.textContent = meta.title || urlStr.slice(0,60);
      const fileSize = document.getElementById('file-size');
      if (fileSize) fileSize.textContent = new URL(urlStr).hostname + (meta.isArticleThumb ? ' · 기사 썸네일' : '');
      if (meta.mediaType==='video') {
        const vp = document.getElementById('video-preview');
        if (vp) { vp.src=meta.mediaUrl; videoEl=vp; document.getElementById('video-wrap')?.classList.remove('hidden'); }
      } else {
        const imgEl = document.getElementById('image-preview');
        if (imgEl) {
          // URL 이미지는 crossOrigin 속성 설정 후 로드 시도
          imgEl.crossOrigin = 'anonymous';
          imgEl.src=meta.mediaUrl;
          imgEl.style.display='block';
          document.getElementById('image-wrap')?.classList.remove('hidden');
          currentInputType='image';
          Store.set('analysis',{inputType:'image'});
          // 서버 프록시로 미디어 데이터 미리 확보 (공유/캡처용)
          if (window.DG_ENV?.URL_IMAGE_PROXY !== false) {
            fetch(`/api/url-image-proxy?url=${encodeURIComponent(meta.mediaUrl)}`)
              .then(r => r.ok ? r.json() : null)
              .then(d => {
                if (d && d.base64) {
                  const dataUrl = `data:${d.mimeType};base64,${d.base64}`;
                  Store.set('analysis', { proxyMediaData: dataUrl });
                }
              })
              .catch(() => {});
          }
        }
      }
      const encoded = new TextEncoder().encode('url|'+urlStr);
      const hbuf = await crypto.subtle.digest('SHA-256', encoded);
      const hash = Array.from(new Uint8Array(hbuf)).map(b=>b.toString(16).padStart(2,'0')).join('');
      Store.set('analysis', { hash, hashStatus:'new' });
      updateHashUI({ status:'new', hash });
      enableStartBtn();

      // URL 텍스트 분석 (링크 탭 전용: AI 작성 구간 + 요약)
      const textSec = document.getElementById('url-text-section');
      if (textSec) {
        textSec.classList.remove('hidden');
        textSec.innerHTML = `<div style="margin-top:16px;padding:16px 20px;background:var(--clr-surface-2);border:1px solid var(--clr-line);border-radius:var(--radius-md)"><p class="text-label" style="color:var(--clr-accent)">🔍 링크 본문 AI 분석 중...</p></div>`;
        fetch('/api/url-text-analyze', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ url: urlStr }),
        })
        .then(r => r.json())
        .then(data => renderUrlTextAnalysis(data, textSec))
        .catch(() => { textSec.innerHTML = ''; textSec.classList.add('hidden'); });
      }
    } catch(e) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--clr-danger)">URL 처리 오류</span>';
      Toast.error('URL 처리 실패: ' + e.message);
    }
  }

  /* ─── URL 텍스트 AI 분석 렌더 ───────────────────────────── */
  function renderUrlTextAnalysis(data, container) {
    if (!data || (!data.summary && !data.highlights?.length)) {
      container.classList.add('hidden'); return;
    }
    const { summary, highlights = [], aiWrittenRatio = 0, articleText = '', title = '' } = data;

    // 본문에 하이라이트 적용
    function applyHighlights(text, hls) {
      if (!hls.length || !text) return escHtml(text);
      let result = escHtml(text);
      // 각 하이라이트를 마크업으로 교체 (신뢰도 기반 색상)
      hls.forEach((h, idx) => {
        if (!h.text) return;
        const escaped = escHtml(h.text);
        const conf = h.confidence || 50;
        const color = conf >= 75 ? 'rgba(255,59,92,.85)' : conf >= 50 ? 'rgba(255,170,0,.85)' : 'rgba(167,139,250,.85)';
        const bg    = conf >= 75 ? 'rgba(255,59,92,.12)' : conf >= 50 ? 'rgba(255,170,0,.10)' : 'rgba(167,139,250,.10)';
        result = result.split(escaped).join(
          `<mark style="background:${bg};color:${color};border-radius:3px;padding:1px 3px;cursor:pointer;font-weight:600;border-bottom:1px solid ${color}33" title="${escAttr(h.reason)}">${escaped}</mark>`
        );
      });
      return result;
    }
    function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function escAttr(s) { return String(s||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

    const highlightedText = applyHighlights(articleText, highlights);
    const ratioCls = aiWrittenRatio >= 60 ? 'var(--clr-danger)' : aiWrittenRatio >= 30 ? 'var(--clr-warn)' : 'var(--clr-safe)';

    container.innerHTML = `
      <div style="margin-top:20px;border:1px solid rgba(0,200,255,.2);border-radius:var(--radius-md);overflow:hidden">
        <div style="background:rgba(0,200,255,.05);padding:16px 20px;border-bottom:1px solid rgba(0,200,255,.15)">
          <div class="flex items-center gap-10 mb-12">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(0,200,255,.9)" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
            <p style="font-size:.8rem;font-weight:700;color:rgba(0,200,255,.9);margin:0;text-transform:uppercase;letter-spacing:.06em">링크 본문 AI 작성 분석</p>
            <div style="margin-left:auto;display:flex;align-items:center;gap:8px">
              <span style="font-size:.7rem;color:rgba(255,255,255,.4)">AI 작성 추정</span>
              <span style="font-family:var(--font-mono);font-size:1.125rem;font-weight:800;color:${ratioCls}">${aiWrittenRatio}%</span>
            </div>
          </div>
          ${summary ? `<div style="background:rgba(0,0,0,.25);border-left:3px solid rgba(0,200,255,.5);padding:12px 16px;border-radius:0 6px 6px 0">
            <p style="font-size:.7rem;color:rgba(255,255,255,.35);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">본문 요약</p>
            <p style="font-size:.875rem;color:rgba(255,255,255,.75);line-height:1.75">${escHtml(summary)}</p>
          </div>` : ''}
        </div>
        ${highlights.length ? `
        <div style="padding:14px 20px;border-bottom:1px solid rgba(255,255,255,.06)">
          <p style="font-size:.7rem;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">AI 작성 의심 구간 (${highlights.length}개)</p>
          <div style="display:flex;flex-direction:column;gap:8px">
            ${highlights.map((h,i) => {
              const conf = h.confidence || 50;
              const c = conf >= 75 ? 'var(--clr-danger)' : conf >= 50 ? 'var(--clr-warn)' : '#a78bfa';
              return `<div style="background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-left:3px solid ${c};border-radius:0 6px 6px 0;padding:10px 14px">
                <div class="flex items-center gap-8 mb-6">
                  <span style="font-size:.65rem;font-family:var(--font-mono);color:rgba(255,255,255,.3)">#${i+1}</span>
                  <span style="font-size:.7rem;font-weight:700;color:${c}">${conf}% 확신</span>
                  ${h.reason ? `<span style="font-size:.7rem;color:rgba(255,255,255,.4);margin-left:6px">${escHtml(h.reason)}</span>` : ''}
                </div>
                <p style="font-size:.8125rem;color:rgba(255,255,255,.65);line-height:1.6;font-style:italic">"${escHtml(h.text)}"</p>
              </div>`;
            }).join('')}
          </div>
        </div>` : ''}
        ${articleText ? `
        <details style="padding:0">
          <summary style="cursor:pointer;padding:14px 20px;font-size:.8125rem;color:rgba(255,255,255,.45);display:flex;align-items:center;gap:8px;list-style:none;user-select:none;border-top:1px solid rgba(255,255,255,.05)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            원문 보기 (AI 하이라이트 포함)
            ${highlights.length ? `<span style="font-size:.7rem;background:rgba(255,59,92,.1);border:1px solid rgba(255,59,92,.2);color:var(--clr-danger);border-radius:4px;padding:1px 7px;margin-left:4px">🔴 위험 ■ 🟡 주의 ■ 🟣 낮음</span>` : ''}
          </summary>
          <div style="padding:16px 20px;border-top:1px solid rgba(255,255,255,.05);max-height:360px;overflow-y:auto">
            <div style="font-size:.8125rem;color:rgba(255,255,255,.65);line-height:1.85;white-space:pre-wrap">${highlightedText}</div>
          </div>
        </details>` : ''}
      </div>`;
  }

  /* ─── Save to server ─────────────────────────────────────── */
  async function saveAnalysis(result) {
    const a = Store.get('analysis');
    if (!a.hash || !result.verdict) {
      console.warn('[DeepGuard] saveAnalysis 스킵: hash=' + a.hash + ', verdict=' + result.verdict);
      return;
    }
    try {
      const rec = await API.post('/analyses', {
        hash:       a.hash,
        verdict:    result.verdict,
        detectionType: result.detectionType || null,
        maxConfidence: result.maxConfidence,
        avgConfidence: result.avgConfidence,
        dfAvgConfidence: result.dfAvgConfidence,
        aiAvgConfidence: result.aiAvgConfidence,
        totalFrames: result.totalFrames,
        suspiciousSegments: result.suspiciousSegments,
        scores:     result.scores,
        fileName:   a.file?.name || null,
        fileSize:   a.file?.size || null,
        inputType:  a.inputType || currentInputType || 'video',
        sourceUrl:  a.sourceUrl || null,
        aiResult:   result.geminiResult || null,
        mediaData:  captureMediaData() || null,
      });
      Store.set('analysis', { savedId: rec.id });
    } catch(e) { console.warn('Save:', e); }
  }

  /* ─── Chart ──────────────────────────────────────────────── */
  function initChart() {
    const canvas = document.getElementById('confidence-chart');
    if (!canvas) return;
    chartCtx = canvas.getContext('2d');
    chartData.labels = []; chartData.scores = []; chartData.dfScores = []; chartData.aiScores = [];
    drawChart();
  }

  function pushChartPoint(t, score, dfScore, aiScore) {
    chartData.labels.push(typeof t==='number' ? t.toFixed(1)+'s' : '');
    chartData.scores.push(score);
    chartData.dfScores.push(dfScore || score);
    chartData.aiScores.push(aiScore || score);
    if (chartData.scores.length > 120) {
      chartData.labels.shift(); chartData.scores.shift();
      chartData.dfScores.shift(); chartData.aiScores.shift();
    }
    drawChart();
  }

  function drawChart() {
    const canvas = document.getElementById('confidence-chart');
    if (!canvas || !chartCtx) return;
    const W = canvas.offsetWidth; const H = canvas.offsetHeight;
    canvas.width = W; canvas.height = H;
    const ctx = chartCtx;
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle = 'rgba(10,16,28,0.8)'; ctx.fillRect(0,0,W,H);
    // Grid
    [0.25,0.5,0.68,0.75,1.0].forEach(v => {
      const y = H - v*H;
      ctx.strokeStyle = v===0.68 ? 'rgba(255,59,92,0.3)' : 'rgba(255,255,255,0.05)';
      ctx.lineWidth = v===0.68 ? 1.5 : 0.5;
      ctx.setLineDash(v===0.68 ? [4,4] : []);
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.font = '9px monospace';
      ctx.fillText((v*100).toFixed(0)+'%', 4, y-3);
    });
    if (!chartData.scores.length) return;
    const n = chartData.scores.length;
    const xStep = W / Math.max(n-1,1);
    // Draw AI scores (blue)
    if (chartData.aiScores.length) {
      ctx.strokeStyle = 'rgba(0,200,255,0.5)'; ctx.lineWidth = 1; ctx.beginPath();
      chartData.aiScores.forEach((v,i) => { const x=i*xStep, y=H-v*H; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
      ctx.stroke();
    }
    // Draw DF scores (orange)
    if (chartData.dfScores.length) {
      ctx.strokeStyle = 'rgba(255,170,0,0.5)'; ctx.lineWidth = 1; ctx.beginPath();
      chartData.dfScores.forEach((v,i) => { const x=i*xStep, y=H-v*H; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
      ctx.stroke();
    }
    // Draw combined (main)
    const grad = ctx.createLinearGradient(0,0,0,H);
    grad.addColorStop(0,'rgba(255,59,92,0.9)'); grad.addColorStop(0.5,'rgba(255,170,0,0.7)'); grad.addColorStop(1,'rgba(0,229,160,0.6)');
    ctx.strokeStyle = grad; ctx.lineWidth = 2; ctx.beginPath();
    chartData.scores.forEach((v,i) => { const x=i*xStep, y=H-v*H; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
    ctx.stroke();
    // Fill under curve
    ctx.beginPath();
    chartData.scores.forEach((v,i) => { const x=i*xStep, y=H-v*H; i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
    ctx.lineTo((n-1)*xStep, H); ctx.lineTo(0, H); ctx.closePath();
    const fillGrad = ctx.createLinearGradient(0,0,0,H);
    fillGrad.addColorStop(0,'rgba(255,59,92,0.15)'); fillGrad.addColorStop(1,'rgba(0,229,160,0.02)');
    ctx.fillStyle = fillGrad; ctx.fill();
  }

  /* ─── Hash UI ────────────────────────────────────────────── */
  function updateHashUI({ status, hash, progress }) {
    const row = document.getElementById('hash-row');
    const label = document.getElementById('hash-status-label');
    const fill = document.getElementById('hash-progress-fill');
    const val = document.getElementById('hash-value');
    if (!row) return;
    row.classList.remove('hidden');
    const map = {
      hashing:  { text:'해싱 중...', cls:'text-accent' },
      checking: { text:'캐시 확인 중...', cls:'text-accent' },
      cached:   { text:'✓ 기존 분석 발견', cls:'text-safe' },
      new:      { text:'신규 파일', cls:'text-label' },
      error:    { text:'오류', cls:'text-danger' },
    };
    const m = map[status] || map.new;
    if (label) label.innerHTML = `<span class="${m.cls}" style="font-size:.75rem">${m.text}</span>`;
    if (fill) fill.style.width = status==='hashing'?`${(progress||0)*100}%`:status==='checking'?'80%':'100%';
    if (val && hash) val.textContent = hash;
  }

  function enableStartBtn() {
    const btn = document.getElementById('start-btn');
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove('hidden');
    document.getElementById('stop-btn')?.classList.add('hidden');
  }

  /* ─── Live UI update ─────────────────────────────────────── */
  function updateLiveUI(payload) {
    const pct = (payload.smoothedConfidence*100).toFixed(1)+'%';
    const confEl = document.getElementById('live-confidence-val');
    if (confEl) { confEl.textContent = pct; confEl.style.color = confidenceColor(payload.smoothedConfidence); }
    const fill = document.getElementById('live-conf-fill');
    if (fill) { fill.style.width=pct; fill.style.background=confidenceColor(payload.smoothedConfidence); }
    const prog = document.getElementById('analysis-progress-fill');
    if (prog) prog.style.width = ((payload.progress||0)*100)+'%';
    const fc = document.getElementById('frame-count');
    if (fc) fc.textContent = Store.get('analysis').frameCount + ' 프레임';
    // Sub-detector badges
    if (payload.dfConfidence != null) {
      const dEl = document.getElementById('live-df-val');
      if (dEl) dEl.textContent = (payload.dfConfidence*100).toFixed(1)+'%';
    }
    if (payload.aiConfidence != null) {
      const aEl = document.getElementById('live-ai-val');
      if (aEl) aEl.textContent = (payload.aiConfidence*100).toFixed(1)+'%';
    }
  }

  function updateUI() {
    const a = Store.get('analysis');
    if (a.analysisStatus === 'ready') {
      const sb = document.getElementById('start-btn');
      if (sb && (a.hashStatus === 'new' || a.hashStatus === 'cached')) {
        sb.disabled = false;
      }
    }
  }

  /* ─── Mini history ───────────────────────────────────────── */
  async function loadMiniHistory() {
    try {
      const size = (window.DG_ENV && window.DG_ENV.HISTORY_MINI_SIZE) || 5;
      const data = await API.get(`/analyses?pageSize=${size}`);
      const el = document.getElementById('history-mini');
      const rows = data.items || data.data || [];
      if (!el || !rows.length) return;
      el.innerHTML = `
        <div style="margin-top:48px;padding-top:32px;border-top:1px solid var(--clr-line)">
          <p class="text-label mb-16">최근 분석</p>
          <div style="display:flex;flex-direction:column;gap:8px">
            ${rows.map(r => {
              const vm = verdictMeta(r.verdict);
              const typeIcon = r.inputType==='image' ? '🖼' : r.inputType==='url' ? '🔗' : '🎬';
              const conf = r.avgConfidence != null ? Math.round(r.avgConfidence * 100) + '%' : '';
              const detTypeLabel = r.detectionType === 'AI_GENERATED' ? 'AI 생성' : r.detectionType === 'AI_MANIPULATED' ? 'AI 편집' : r.detectionType === 'DEEPFAKE_MANIPULATED' ? '딥페이크' : '';
              return `<div class="mini-hist-row flex items-center gap-12" style="padding:12px 14px;background:var(--clr-surface-2);border:1px solid var(--clr-line);border-radius:var(--radius-sm);cursor:pointer;transition:background 0.2s" onmouseover="this.style.background='var(--clr-surface-3)'" onmouseout="this.style.background='var(--clr-surface-2)'" onclick="DG.Analysis.loadAndShowHistory('${r.hash}')">
                <span style="font-size:1rem">${typeIcon}</span>
                <div style="flex:1;min-width:0">
                  <p style="font-size:.8125rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.fileName||r.sourceUrl||'알 수 없음'}</p>
                  <p class="text-label mt-2">${fmtDate(r.analyzedAt)}${detTypeLabel ? ' · '+detTypeLabel : ''}${conf ? ' · '+conf : ''}</p>
                </div>
                <span class="badge badge--${vm.cls}">${vm.label}</span>
              </div>`;
            }).join('')}
          </div>
        </div>`;
    } catch(e) { /* ignore */ }
  }

  /* ─── Result render ──────────────────────────────────────── */
  function detectionTypeLabel(type) {
    const map = {
      DEEPFAKE_MANIPULATED: { label:'딥페이크 합성', icon:'🎭', color:'var(--clr-danger)' },
      AI_GENERATED:         { label:'AI 생성 이미지', icon:'🤖', color:'#a78bfa' },
      AI_MANIPULATED:       { label:'AI 합성·편집', icon:'⚠️', color:'var(--clr-warn)' },
    };
    return map[type] || map.DEEPFAKE_MANIPULATED;
  }

  function renderResult(result) {
    const section = document.getElementById('result-section');
    if (!section) { console.error('[DeepGuard] result-section 엘리먼트 없음'); return; }

    // 이미 결과가 표시된 경우 중복 렌더 방지
    if (section._rendered) {
      console.log('[DeepGuard] renderResult 중복 호출 무시');
      return;
    }
    section._rendered = true;
    console.log('[DeepGuard] renderResult 호출:', result.verdict, result.avgConfidence);

    // undefined 방어
    result = {
      suspiciousSegments: [],
      geminiResult: null,
      detectionType: null,
      dfAvgConfidence: null,
      aiAvgConfidence: null,
      totalFrames: 0,
      maxConfidence: 0,
      avgConfidence: 0,
      verdict: 'SUSPICIOUS',
      ...result,
    };
    const a = Store.get('analysis');
    const vm = verdictMeta(result.verdict);
    const dt = result.detectionType ? detectionTypeLabel(result.detectionType) : null;
    section.innerHTML = `
      <div class="card p-28 fade-up" style="border-color:${vm.cls==='danger'?'rgba(255,59,92,.3)':vm.cls==='warn'?'rgba(255,170,0,.3)':'rgba(0,229,160,.3)'}">
        <div class="flex items-center gap-16 mb-24">
          <div class="verdict-block ${vm.blockCls}" style="flex:1">
            <p class="text-label mb-6">판별 결과</p>
            <div class="flex items-center gap-12 flex-wrap">
              <h2 style="font-size:2rem;font-weight:800;line-height:1">${vm.label}</h2>
              ${dt ? `<span style="background:rgba(0,0,0,.3);border:1px solid ${dt.color}44;color:${dt.color};border-radius:999px;padding:4px 10px;font-size:.75rem;font-weight:600">${dt.icon} ${dt.label}</span>` : ''}
            </div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            <p class="text-label mb-4">종합 신뢰도</p>
            <p style="font-size:2.5rem;font-weight:800;color:${confidenceColor(result.avgConfidence)};font-family:var(--font-display);line-height:1">${(result.avgConfidence*100).toFixed(1)}%</p>
          </div>
        </div>
        ${(result.dfAvgConfidence != null || result.aiAvgConfidence != null) ? `
        <div class="grid-2 mb-20" style="gap:10px">
          <div style="background:rgba(255,170,0,.06);border:1px solid rgba(255,170,0,.15);border-radius:var(--radius-sm);padding:12px 16px">
            <p style="font-size:.7rem;color:rgba(255,255,255,.4);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">딥페이크 탐지</p>
            <p style="font-size:1.375rem;font-weight:700;color:var(--clr-warn)">${((result.dfAvgConfidence||0)*100).toFixed(1)}%</p>
            <div style="height:3px;background:rgba(255,255,255,.06);border-radius:2px;margin-top:6px"><div style="height:100%;width:${(result.dfAvgConfidence||0)*100}%;background:var(--clr-warn);border-radius:2px"></div></div>
          </div>
          <div style="background:rgba(167,139,250,.06);border:1px solid rgba(167,139,250,.15);border-radius:var(--radius-sm);padding:12px 16px">
            <p style="font-size:.7rem;color:rgba(255,255,255,.4);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">AI 생성 탐지</p>
            <p style="font-size:1.375rem;font-weight:700;color:#a78bfa">${((result.aiAvgConfidence||0)*100).toFixed(1)}%</p>
            <div style="height:3px;background:rgba(255,255,255,.06);border-radius:2px;margin-top:6px"><div style="height:100%;width:${(result.aiAvgConfidence||0)*100}%;background:#a78bfa;border-radius:2px"></div></div>
          </div>
        </div>` : ''}
        <div class="grid-3 mt-8" style="gap:10px">
          ${[
            ['최대 신뢰도', (result.maxConfidence*100).toFixed(1)+'%'],
            ['분석 프레임', result.totalFrames+' frames'],
            ['의심 구간',   result.suspiciousSegments.length+'개'],
          ].map(([k,v])=>`<div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:var(--radius-sm);padding:14px">
            <p style="font-size:.7rem;color:rgba(255,255,255,.35);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">${k}</p>
            <p style="font-size:1.25rem;font-weight:700">${v}</p>
          </div>`).join('')}
        </div>
      </div>
      ${result.geminiResult ? `
      <div class="card p-20 mt-12 fade-up stagger-1" style="border-color:rgba(66,133,244,.25)">
        <div class="flex items-center gap-10 mb-16">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4285f4" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
          <p class="text-label" style="color:#4285f4;margin:0">Gemini AI 정밀 분석 결과</p>
          <span style="margin-left:auto;font-size:.7rem;background:rgba(66,133,244,.1);border:1px solid rgba(66,133,244,.25);color:#4285f4;border-radius:999px;padding:2px 8px">gemini-1.5-flash</span>
        </div>
        <div class="grid-2 mb-16" style="gap:10px">
          <div style="background:rgba(66,133,244,.05);border:1px solid rgba(66,133,244,.15);border-radius:var(--radius-sm);padding:12px 16px">
            <p style="font-size:.7rem;color:rgba(255,255,255,.4);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">AI 생성 판정</p>
            <p style="font-size:1.1rem;font-weight:700;color:${result.geminiResult.aiVerdict==='AI_GENERATED'||result.geminiResult.aiVerdict==='LIKELY_AI'?'var(--clr-danger)':result.geminiResult.aiVerdict==='AUTHENTIC'||result.geminiResult.aiVerdict==='LIKELY_REAL'?'var(--clr-safe)':'var(--clr-warn)'}">
              ${{AI_GENERATED:'AI 생성',LIKELY_AI:'AI 가능성 높음',UNCERTAIN:'불확실',LIKELY_REAL:'실제 가능성 높음',AUTHENTIC:'실제 콘텐츠'}[result.geminiResult.aiVerdict]||result.geminiResult.aiVerdict}
            </p>
            <p style="font-size:.75rem;color:rgba(255,255,255,.35);margin-top:4px">${result.geminiResult.aiCategory||''}</p>
          </div>
          <div style="background:rgba(66,133,244,.05);border:1px solid rgba(66,133,244,.15);border-radius:var(--radius-sm);padding:12px 16px">
            <p style="font-size:.7rem;color:rgba(255,255,255,.4);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">Gemini 신뢰도</p>
            <p style="font-size:1.375rem;font-weight:700;color:#4285f4">${result.geminiResult.aiConfidence}%</p>
            <div style="height:3px;background:rgba(255,255,255,.06);border-radius:2px;margin-top:6px"><div style="height:100%;width:${result.geminiResult.aiConfidence}%;background:#4285f4;border-radius:2px"></div></div>
          </div>
        </div>
        ${result.geminiResult.aiSignals?.length ? `
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
          ${result.geminiResult.aiSignals.map(s=>`<span style="background:rgba(66,133,244,.08);border:1px solid rgba(66,133,244,.2);color:rgba(255,255,255,.6);border-radius:999px;padding:3px 10px;font-size:.72rem">${s}</span>`).join('')}
        </div>` : ''}
        ${result.geminiResult.aiReasoning ? `
        <div style="background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:var(--radius-sm);padding:12px 16px">
          <p style="font-size:.75rem;color:rgba(255,255,255,.35);margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">분석 근거</p>
          <p style="font-size:.85rem;color:rgba(255,255,255,.65);line-height:1.7">${result.geminiResult.aiReasoning}</p>
        </div>` : ''}
      </div>` : `
      <div class="card p-16 mt-12 fade-up stagger-1" style="border-color:rgba(255,170,0,.2)">
        <div class="flex items-center gap-10">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--clr-warn)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <p style="font-size:.82rem;color:rgba(255,255,255,.5);margin:0">
            Gemini 정밀 분석 비활성 — 
            <span style="color:var(--clr-accent);cursor:pointer;text-decoration:underline" onclick="DG.GeminiSetup.openModal()">API 키 설정</span>으로 활성화
          </p>
        </div>
      </div>`}
      ${a.hash ? `<div class="card p-20 mt-12 fade-up stagger-1">
        <p class="text-label mb-6">식별 해시</p>
        <p class="mono" style="font-size:.75rem;color:var(--clr-accent);word-break:break-all;line-height:1.7">${a.hash}</p>
      </div>` : ''}
      ${result.suspiciousSegments.length ? `
      <div class="card p-20 mt-12 fade-up stagger-2">
        <p class="text-label mb-12">위조 의심 구간 (${result.suspiciousSegments.length}개)</p>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${result.suspiciousSegments.map((s,i)=>`
            <div class="segment-item">
              <span class="mono" style="font-size:.75rem;color:var(--clr-danger);min-width:24px">#${i+1}</span>
              <span class="segment-item__time">${fmtTime(s.startTime)} → ${fmtTime(s.endTime)}</span>
              <div class="segment-item__bar"><div class="segment-item__bar-fill" style="width:${s.avgConfidence*100}%"></div></div>
              <span class="segment-item__score">${(s.avgConfidence*100).toFixed(1)}%</span>
              <span class="badge badge--danger">FAKE</span>
            </div>`).join('')}
        </div>
      </div>` : ''}
      ${result.forensicReport ? `
      <div class="card p-20 mt-12 fade-up stagger-2" style="border-color:rgba(0,200,255,.2)">
        <div class="flex items-center gap-10 mb-16">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(0,200,255,.8)" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35M11 8v6M8 11h6"/></svg>
          <p style="font-size:.8rem;font-weight:700;color:rgba(0,200,255,.8);margin:0;text-transform:uppercase;letter-spacing:.06em">포렌식 모듈 상세 분석</p>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px">
          ${[
            ['🔬 CFA 노이즈 매핑', result.forensicReport.cfaScore, 'rgba(0,200,255,.7)', 'CFA 패턴 이상 (카메라 센서 위조 여부)'],
            ['💡 조명 메타데이터', result.forensicReport.lightingScore, 'rgba(255,210,0,.7)', '광원 불일치·그림자 방향 오류'],
            ['🤖 GAN 픽셀 검사', result.forensicReport.ganScore, 'rgba(255,100,150,.7)', '체커보드 아티팩트·픽셀 분포 편향'],
            ['📄 파일 데이터', result.forensicReport.fileScore, 'rgba(160,130,255,.7)', '비네팅·포아송 노이즈·렌즈 왜곡 흔적'],
            ['📐 기하학 노이즈', result.forensicReport.geoScore, 'rgba(80,220,140,.7)', '직선 불연속·원근 오류·기하 왜곡'],
          ].map(([label, score, color, desc]) => {
            const pct = ((score||0)*100).toFixed(1);
            const lvl = score > 0.6 ? '높음' : score > 0.35 ? '보통' : '낮음';
            const lvlC = score > 0.6 ? 'var(--clr-danger)' : score > 0.35 ? 'var(--clr-warn)' : 'var(--clr-safe)';
            return `<div style="background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:12px 14px">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                <p style="font-size:.72rem;color:rgba(255,255,255,.45);margin:0">${label}</p>
                <span style="font-size:.68rem;color:${lvlC};font-weight:700">${lvl}</span>
              </div>
              <p style="font-size:1.25rem;font-weight:800;color:${color};margin:0 0 4px">${pct}%</p>
              <div style="height:3px;background:rgba(255,255,255,.06);border-radius:2px;margin-bottom:6px">
                <div style="height:100%;width:${pct}%;background:${color};border-radius:2px;transition:width .6s"></div>
              </div>
              <p style="font-size:.65rem;color:rgba(255,255,255,.28);margin:0;line-height:1.4">${desc}</p>
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}
      <div id="analysis-complete-banner" class="fade-up" style="background:rgba(0,229,160,.07);border:1px solid rgba(0,229,160,.25);border-radius:var(--radius-md);padding:14px 20px;display:flex;align-items:center;gap:14px;margin-top:20px">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--clr-safe)" stroke-width="2" style="flex-shrink:0"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <div style="flex:1">
          <p style="font-size:.875rem;font-weight:600;color:var(--clr-safe);margin:0">분석이 완료되었습니다</p>
          <p style="font-size:.75rem;color:rgba(255,255,255,.45);margin:4px 0 0">아래에서 상세 결과를 확인하세요. 결과는 기록 페이지에 자동 저장됩니다.</p>
        </div>
      </div>
      <div class="flex gap-12 mt-16 fade-up stagger-3" style="flex-wrap:wrap">
        <button class="btn btn--outline-accent" onclick="DG.Analysis.openShareModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          커뮤니티 공유
        </button>
        <button class="btn btn--ghost" onclick="DG.Analysis.reset()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          새로 분석하기
        </button>
      </div>`;
    section.classList.remove('hidden');
    document.getElementById('legal-section')?.classList.remove('hidden');
    // 결과 섹션으로 부드럽게 스크롤
    setTimeout(() => section.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  }

  function showCachedResult(cached) {
    Toast.info('기존 분석 결과를 불러왔습니다');
    renderResult(cached);
  }

  /* ─── Community share modal ──────────────────────────────── */
  function captureMediaData() {
    try {
      const imgEl = document.getElementById('image-preview');
      const vp    = document.getElementById('video-preview');
      const MAX = (window.DG_ENV && window.DG_ENV.MEDIA_CAPTURE_MAX) || 600;
      // Image input
      if (imgEl && imgEl.src && !imgEl.src.endsWith(location.href) && imgEl.style.display !== 'none') {
        const canvas = document.createElement('canvas');
        const w = imgEl.naturalWidth || imgEl.width || MAX;
        const h = imgEl.naturalHeight || imgEl.height || MAX;
        const scale = Math.min(1, MAX / Math.max(w, h));
        canvas.width  = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        try {
          canvas.getContext('2d').drawImage(imgEl, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/jpeg', 0.82);
        } catch (taintErr) {
          // cross-origin tainted — 저장된 proxyBase64 사용
          const a = Store.get('analysis');
          if (a.proxyMediaData) return a.proxyMediaData;
          console.warn('[DeepGuard] captureMediaData tainted, proxyMediaData 없음');
          return null;
        }
      }
      // Video input — capture current frame
      if (vp && vp.src && vp.readyState >= 2) {
        const canvas = document.createElement('canvas');
        const w = vp.videoWidth  || MAX;
        const h = vp.videoHeight || MAX;
        const scale = Math.min(1, MAX / Math.max(w, h));
        canvas.width  = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        try {
          canvas.getContext('2d').drawImage(vp, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/jpeg', 0.82);
        } catch (e) { return null; }
      }
    } catch(e) { console.warn('[DeepGuard] captureMediaData 실패:', e); }
    return null;
  }

  function openShareModal() {
    const a = Store.get('analysis');
    const result = a.overallResult;
    if (!result) return;
    Modal.open({
      title: '커뮤니티에 공유',
      body: `
        <p style="font-size:.875rem;color:rgba(255,255,255,.5);margin-bottom:14px">판별 결과를 익명 커뮤니티에 공유합니다. 민감한 데이터나 원본 파일은 업로드되지 않습니다.</p>
        <div class="form-group">
          <label class="form-label">코멘트 (선택, 최대 280자)</label>
          <textarea class="form-textarea" id="share-memo" rows="3" placeholder="이 영상/이미지에 대해 한마디..."></textarea>
        </div>`,
      confirmLabel: '공유하기',
      onConfirm: async () => {
        const memo = document.getElementById('share-memo')?.value || '';
        const mediaData = captureMediaData();
        try {
          const post = await window.DG.API.post('/community/posts', {
            analysisId: a.savedId || null,
            verdict: result.verdict || 'AUTHENTIC',
            avgConfidence: result.avgConfidence || 0,
            maxConfidence: result.maxConfidence || 0,
            totalFrames: result.totalFrames || 1,
            suspiciousSegments: result.suspiciousSegments || [],
            scores: result.scores || [],
            fileName: a.file?.name || null,
            inputType: a.inputType || currentInputType || 'video',
            sourceUrl: a.sourceUrl || null,
            hash: a.hash || 'unknown',
            memo: memo.trim(),
            mediaData,
          });
          // Show share link
          const shareLink = `${location.origin}/share.html?token=${post.shareToken}`;
          setTimeout(() => {
            Modal.open({
              title: '공유 링크가 생성되었습니다',
              body: `
                <p style="font-size:.875rem;color:rgba(255,255,255,.5);margin-bottom:14px">아래 링크를 공유하면 판별된 미디어와 결과를 함께 볼 수 있습니다.</p>
                <div style="display:flex;gap:8px;align-items:center">
                  <input id="share-link-input" class="form-input" style="flex:1;font-size:.8125rem;font-family:var(--font-mono)" value="${shareLink}" readonly />
                  <button class="btn btn--primary btn--sm" onclick="navigator.clipboard.writeText(document.getElementById('share-link-input').value).then(()=>window.DG.Toast.success('링크가 복사되었습니다'))">복사</button>
                </div>
                <a href="${shareLink}" target="_blank" style="display:inline-block;margin-top:10px;font-size:.8125rem;color:var(--clr-accent)">링크 미리보기 →</a>`,
              confirmLabel: '확인',
              cancelLabel: null,
              onConfirm: () => {},
            });
          }, 100);
          Toast.success('커뮤니티에 성공적으로 공유되었습니다.');
        } catch (err) {
          console.error('[DeepGuard] Report Share Error:', err);
          Toast.error(err.message || '공유 중 오류가 발생했습니다.');
        }
      },
    });
  }

  /* ─── Reset ──────────────────────────────────────────────── */
  function reset() {
    stopCapture();
    frameCount=0; frameBuf=[];
    chartData.labels=[]; chartData.scores=[]; chartData.dfScores=[]; chartData.aiScores=[];
    Store.set('analysis', {
      file:null, hash:null, hashStatus:'idle', hashProgress:0,
      analysisStatus: worker?'ready':'idle', analysisProgress:0,
      frameResults:[], overallResult:null, liveConfidence:0, frameCount:0,
      inputType:null, sourceUrl:null, savedId:null,
    });
    currentInputType = 'video';
    ['hash-row','result-section','video-wrap','live-panel','file-info','image-wrap','url-text-section']
      .forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.classList.add('hidden'); el._rendered = false; }
      });
    document.getElementById('legal-section')?.classList.add('hidden');
    const imgEl = document.getElementById('image-preview');
    if (imgEl) { imgEl.src=''; imgEl.style.display='none'; }
    const vp = document.getElementById('video-preview');
    if (vp) vp.src='';
    const startBtn = document.getElementById('start-btn');
    if (startBtn) { startBtn.disabled=true; startBtn.classList.remove('hidden'); }
    document.getElementById('stop-btn')?.classList.add('hidden');
    document.getElementById('file-input').value='';
    document.getElementById('file-input-img') && (document.getElementById('file-input-img').value='');
    const urlInput = document.getElementById('url-input');
    if (urlInput) urlInput.value='';
    const urlStatus = document.getElementById('url-status');
    if (urlStatus) urlStatus.innerHTML='';
    document.querySelectorAll('[data-input-tab]').forEach(t => t.classList.toggle('active',t.dataset.inputTab==='video'));
    document.querySelectorAll('[data-input-panel]').forEach(p => p.classList.toggle('hidden',p.dataset.inputPanel!=='video'));
    initChart();
    
  }

  /* ─── File handler (unified) ─────────────────────────────── */
  function handleFileSelect(file) {
    if (!file) return;
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) { Toast.warn('지원하지 않는 파일 형식입니다'); return; }

    // 새 파일 선택 시 이전 결과 완전 초기화
    const resultSection = document.getElementById('result-section');
    if (resultSection) { resultSection.classList.add('hidden'); resultSection._rendered = false; resultSection.innerHTML = ''; }
    document.getElementById('legal-section')?.classList.add('hidden');
    document.getElementById('live-panel')?.classList.add('hidden');
    document.getElementById('url-text-section')?.classList.add('hidden');
    // 차트 초기화
    chartData.labels=[]; chartData.scores=[]; chartData.dfScores=[]; chartData.aiScores=[];
    initChart();

    Store.set('analysis', { inputType: isImage?'image':'video', overallResult: null, analysisStatus: worker?'ready':'idle', frameResults: [], analysisProgress: 0 });
    if (isImage) currentInputType='image';
    else currentInputType='video';

    const fileInfo=document.getElementById('file-info');
    const fileName=document.getElementById('file-name');
    const fileSize=document.getElementById('file-size');
    if (fileInfo) fileInfo.classList.remove('hidden');
    if (fileName) fileName.textContent=file.name;
    if (fileSize) fileSize.textContent=fmtBytes(file.size);

    const url = URL.createObjectURL(file);
    if (isVideo) {
      const vp=document.getElementById('video-preview');
      if (vp) { vp.src=url; videoEl=vp; }
      document.getElementById('video-wrap')?.classList.remove('hidden');
      document.getElementById('image-wrap')?.classList.add('hidden');
    } else {
      const imgEl=document.getElementById('image-preview');
      if (imgEl) { imgEl.src=url; imgEl.style.display='block'; }
      document.getElementById('image-wrap')?.classList.remove('hidden');
      document.getElementById('video-wrap')?.classList.add('hidden');
    }
    processFile(file);
  }

  /* ─── Input tabs ─────────────────────────────────────────── */
  function initInputTabs() {
    document.querySelectorAll('[data-input-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        if (tab.classList.contains('active')) return;
        reset(); // 탭 이동 시 폼 완전 초기화
        document.querySelectorAll('[data-input-tab]').forEach(t=>t.classList.remove('active'));
        tab.classList.add('active');
        currentInputType=tab.dataset.inputTab;
        document.querySelectorAll('[data-input-panel]').forEach(p=>{
          p.classList.toggle('hidden',p.dataset.inputPanel!==currentInputType);
        });
        Store.set('analysis',{hashStatus:'idle',inputType:currentInputType});
        document.getElementById('hash-row')?.classList.add('hidden');
        const sb=document.getElementById('start-btn');
        if (sb) sb.disabled=true;
      });
    });
  }

  /* ─── Init ───────────────────────────────────────────────── */
  function init() {
    initWorker();
    initChart();
    loadMiniHistory();
    initInputTabs();

    // Video file input
    const fileInput  = document.getElementById('file-input');
    const uploadZone = document.getElementById('upload-zone');
    const startBtn   = document.getElementById('start-btn');
    const stopBtn    = document.getElementById('stop-btn');

    if (fileInput) {
      fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFileSelect(e.target.files[0]); });
    }

    // Video upload zone drag-drop
    if (uploadZone) {
      uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('upload-zone--dragover'); });
      uploadZone.addEventListener('dragleave', ()=> uploadZone.classList.remove('upload-zone--dragover'));
      uploadZone.addEventListener('drop', e => {
        e.preventDefault(); uploadZone.classList.remove('upload-zone--dragover');
        const f=e.dataTransfer.files[0]; if(f) handleFileSelect(f);
      });
      uploadZone.addEventListener('click', e => {
        // Don't trigger if clicking a child interactive element
        if (e.target.tagName==='BUTTON') return;
        if (fileInput) { fileInput.accept='video/*'; fileInput.click(); }
      });
    }

    // Image upload zone — has its own input
    const imgUploadZone = document.getElementById('image-upload-zone');
    const fileInputImg  = document.getElementById('file-input-img');
    if (imgUploadZone) {
      imgUploadZone.addEventListener('dragover', e => { e.preventDefault(); imgUploadZone.classList.add('upload-zone--dragover'); });
      imgUploadZone.addEventListener('dragleave',()=> imgUploadZone.classList.remove('upload-zone--dragover'));
      imgUploadZone.addEventListener('drop', e => {
        e.preventDefault(); imgUploadZone.classList.remove('upload-zone--dragover');
        const f=e.dataTransfer.files[0]; if(f) handleFileSelect(f);
      });
      imgUploadZone.addEventListener('click', e => {
        if (e.target.tagName==='BUTTON') return;
        if (fileInputImg) { fileInputImg.click(); }
        else if (fileInput) { fileInput.accept='image/*'; fileInput.click(); }
      });
    }
    if (fileInputImg) {
      fileInputImg.addEventListener('change', e => { if(e.target.files[0]) handleFileSelect(e.target.files[0]); });
    }

    // URL button
    document.getElementById('url-submit-btn')?.addEventListener('click', () => {
      const v = document.getElementById('url-input')?.value.trim();
      if (v) processUrl(v);
    });
    document.getElementById('url-input')?.addEventListener('keydown', e => {
      if (e.key==='Enter') document.getElementById('url-submit-btn')?.click();
    });

    // Start button
    startBtn?.addEventListener('click', () => {
      const inp = currentInputType || Store.get('analysis').inputType || 'video';
      if (inp==='image') { analyzeImage(); return; }
      if (!videoEl) return;

      // 영상 종료 시 자동으로 분석 완료 처리
      videoEl.onended = () => {
        stopCapture();
        startBtn?.classList.remove('hidden');
        stopBtn?.classList.add('hidden');
        // flushBatch 후 worker가 ANALYSIS_COMPLETE를 보내도록 약간 대기
        // 만약 이미 결과가 있으면 즉시 렌더링
        setTimeout(() => {
          const cur = Store.get('analysis');
          if (cur.analysisStatus !== 'complete' && cur.frameResults.length > 0) {
            // Worker로부터 ANALYSIS_COMPLETE 미수신 시 직접 집계해서 렌더
            const frames = cur.frameResults;
            const scores = frames.map(f => f.confidence);
            const dfScores = frames.map(f => f.dfConfidence || f.confidence);
            const aiScores = frames.map(f => f.aiConfidence || f.confidence);
            const avgC = scores.reduce((a,b)=>a+b,0)/scores.length;
            const maxC = Math.max(...scores);
            const dfAvg = dfScores.reduce((a,b)=>a+b,0)/dfScores.length;
            const aiAvg = aiScores.reduce((a,b)=>a+b,0)/aiScores.length;
            const verdict = avgC > 0.70 ? 'FAKE' : avgC > 0.45 ? 'SUSPICIOUS' : 'AUTHENTIC';
            const syntheticResult = {
              verdict, detectionType: aiAvg > dfAvg*1.1 ? 'AI_GENERATED' : 'DEEPFAKE_MANIPULATED',
              maxConfidence: maxC, avgConfidence: avgC,
              dfAvgConfidence: dfAvg, aiAvgConfidence: aiAvg,
              totalFrames: frames.length, suspiciousSegments: [],
              scores, dfScores, aiScores, geminiResult: null,
            };
            Store.set('analysis', { overallResult: syntheticResult, analysisStatus:'complete' });
            renderResult(syntheticResult);
            saveAnalysis(syntheticResult);
            // 완료 배너는 renderResult 내에 포함
          }
        }, 1500);
      };

      videoEl.play();
      frameCount=0; frameBuf=[];
      Store.set('analysis',{analysisStatus:'analyzing',analysisProgress:0});
      document.getElementById('live-panel')?.classList.remove('hidden');
      startBtn.classList.add('hidden');
      stopBtn?.classList.remove('hidden');
      scheduleFrame();
    });

    stopBtn?.addEventListener('click', () => {
      stopCapture();
      if (videoEl) videoEl.onended = null;  // 수동 중단 시 자동 완료 핸들러 제거
      startBtn?.classList.remove('hidden');
      stopBtn?.classList.add('hidden');
      // 현재까지 수집된 프레임으로 즉시 결과 렌더링
      const cur = Store.get('analysis');
      if (cur.frameResults.length > 0 && cur.analysisStatus !== 'complete') {
        const frames = cur.frameResults;
        const scores = frames.map(f => f.confidence);
        const dfScores = frames.map(f => f.dfConfidence || f.confidence);
        const aiScores = frames.map(f => f.aiConfidence || f.confidence);
        const avgC = scores.reduce((a,b)=>a+b,0)/scores.length;
        const maxC = Math.max(...scores);
        const dfAvg = dfScores.reduce((a,b)=>a+b,0)/dfScores.length;
        const aiAvg = aiScores.reduce((a,b)=>a+b,0)/aiScores.length;
        const verdict = avgC > 0.70 ? 'FAKE' : avgC > 0.45 ? 'SUSPICIOUS' : 'AUTHENTIC';
        const syntheticResult = {
          verdict, detectionType: aiAvg > dfAvg*1.1 ? 'AI_GENERATED' : 'DEEPFAKE_MANIPULATED',
          maxConfidence: maxC, avgConfidence: avgC,
          dfAvgConfidence: dfAvg, aiAvgConfidence: aiAvg,
          totalFrames: frames.length, suspiciousSegments: [],
          scores, dfScores, aiScores, geminiResult: null,
        };
        Store.set('analysis', { overallResult: syntheticResult, analysisStatus:'complete' });
        renderResult(syntheticResult);
        saveAnalysis(syntheticResult);
        // 완료 배너는 renderResult 내에 포함
      }
    });

    window.addEventListener('resize', drawChart);
  }

  async function loadAndShowHistory(hash) {
    try {
      const cached = await API.get(`/analysis/hash/${hash}`);
      if (cached) {
        Store.set('analysis', { hashStatus: 'cached', hash });
        showCachedResult(cached);
        document.getElementById('result-section')?.scrollIntoView({ behavior: 'smooth' });
      }
    } catch(e) {
      Toast.error('기록을 불러올 수 없습니다.');
    }
  }

  window.DG.Analysis = { init, reset, openShareModal, loadAndShowHistory };
})();
