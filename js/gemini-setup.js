/**
 * DeepGuard Pro v3 — Gemini 설정 & 상태 모듈
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'dg_gemini_key';

  /* ─── API 키 저장/복원 ─────────────────────────────────── */
  function getSavedKey() {
    try { return sessionStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
  }
  function saveKey(key) {
    try { sessionStorage.setItem(STORAGE_KEY, key); } catch {}
  }

  /* ─── 서버에 API 키 전달 ───────────────────────────────── */
  async function configureServer(apiKey) {
    const res = await fetch('/api/ai-detect/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    if (!res.ok) {
      const d = await res.json().catch(()=>({}));
      throw new Error(d.error || '설정 실패');
    }
    return res.json();
  }

  /* ─── 상태 체크 ────────────────────────────────────────── */
  async function checkStatus() {
    try {
      const d = await fetch('/api/ai-detect/status').then(r => r.json());
      updateStatusUI(d.geminiConfigured);
      return d;
    } catch {
      updateStatusUI(false);
      return null;
    }
  }

  function updateStatusUI(configured) {
    const dot  = document.getElementById('gemini-status-dot');
    const text = document.getElementById('gemini-status-text');
    if (!dot || !text) return;
    if (configured) {
      dot.style.background  = 'var(--clr-safe)';
      text.textContent = 'Gemini AI 연결됨';
    } else {
      dot.style.background  = 'var(--clr-warn)';
      text.textContent = 'Gemini 설정';
    }
  }

  /* ─── 설정 모달 ────────────────────────────────────────── */
  function openModal() {
    const saved = getSavedKey();
    const overlay = document.createElement('div');
    overlay.id = 'gemini-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
    overlay.innerHTML = `
      <div style="background:var(--clr-card);border:1px solid var(--clr-line);border-radius:16px;padding:32px;max-width:480px;width:100%;position:relative">
        <button onclick="document.getElementById('gemini-modal-overlay').remove()"
          style="position:absolute;top:16px;right:16px;background:none;border:none;color:rgba(255,255,255,.4);font-size:1.25rem;cursor:pointer;line-height:1">✕</button>

        <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
          <div style="width:36px;height:36px;border-radius:8px;background:rgba(0,229,160,.1);border:1px solid rgba(0,229,160,.25);display:flex;align-items:center;justify-content:center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--clr-accent)" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
          </div>
          <div>
            <h3 style="font-size:1.05rem;font-weight:700;margin:0">Gemini AI 연결 설정</h3>
            <p style="font-size:.8rem;color:rgba(255,255,255,.4);margin:2px 0 0">Google AI Studio 무료 API 키</p>
          </div>
        </div>

        <div style="background:rgba(0,229,160,.05);border:1px solid rgba(0,229,160,.15);border-radius:10px;padding:14px 16px;margin-bottom:20px">
          <p style="font-size:.825rem;color:rgba(255,255,255,.7);line-height:1.6;margin:0">
            <strong style="color:var(--clr-accent)">무료 사용 한도</strong><br>
            분당 15회 · 일 1,500회 · 월 100만 토큰<br>
            <a href="https://aistudio.google.com/apikey" target="_blank"
               style="color:var(--clr-accent);text-decoration:underline">
              aistudio.google.com/apikey
            </a> 에서 무료 키 발급
          </p>
        </div>

        <label style="font-size:.8rem;color:rgba(255,255,255,.5);display:block;margin-bottom:6px">API 키 입력</label>
        <input id="gemini-key-input" type="password" placeholder="AIzaSy..."
          value="${saved}"
          style="width:100%;background:rgba(255,255,255,.05);border:1px solid var(--clr-line);border-radius:8px;padding:10px 14px;color:#fff;font-size:.875rem;font-family:monospace;margin-bottom:16px">

        <div id="gemini-modal-msg" style="font-size:.8rem;margin-bottom:12px;min-height:18px"></div>

        <div style="display:flex;gap:10px">
          <button id="gemini-save-btn" onclick="DG.GeminiSetup.saveFromModal()"
            style="flex:1;background:var(--clr-accent);color:#000;border:none;border-radius:8px;padding:10px;font-size:.875rem;font-weight:700;cursor:pointer">
            저장 & 활성화
          </button>
          <button onclick="DG.GeminiSetup.clearKey()"
            style="background:rgba(255,59,92,.1);border:1px solid rgba(255,59,92,.25);color:var(--clr-danger);border-radius:8px;padding:10px 16px;font-size:.875rem;cursor:pointer">
            초기화
          </button>
        </div>

        <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--clr-line)">
          <p style="font-size:.75rem;color:rgba(255,255,255,.3);line-height:1.5;margin:0">
            ⚠️ API 키는 브라우저 세션에만 저장되며 서버 재시작 시 초기화됩니다.<br>
            영구 설정: <code style="background:rgba(255,255,255,.06);padding:1px 5px;border-radius:3px">GEMINI_API_KEY=AIza... node server.js</code>
          </p>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    setTimeout(() => document.getElementById('gemini-key-input')?.focus(), 50);
  }

  async function saveFromModal() {
    const key = document.getElementById('gemini-key-input')?.value.trim();
    const msg = document.getElementById('gemini-modal-msg');
    const btn = document.getElementById('gemini-save-btn');
    if (!key) { if(msg) { msg.style.color='var(--clr-danger)'; msg.textContent='API 키를 입력하세요'; } return; }
    if (!key.startsWith('AIza')) { if(msg) { msg.style.color='var(--clr-danger)'; msg.textContent='유효하지 않은 키 형식 (AIza로 시작)'; } return; }
    if (btn) btn.textContent = '설정 중...';
    try {
      await configureServer(key);
      saveKey(key);
      if (msg) { msg.style.color='var(--clr-safe)'; msg.textContent='✓ Gemini AI 연결 완료'; }
      updateStatusUI(true);
      setTimeout(() => document.getElementById('gemini-modal-overlay')?.remove(), 1200);
    } catch(e) {
      if (msg) { msg.style.color='var(--clr-danger)'; msg.textContent='오류: ' + e.message; }
      if (btn) btn.textContent = '저장 & 활성화';
    }
  }

  function clearKey() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
    const input = document.getElementById('gemini-key-input');
    if (input) input.value = '';
    const msg = document.getElementById('gemini-modal-msg');
    if (msg) { msg.style.color='rgba(255,255,255,.4)'; msg.textContent='키가 초기화되었습니다'; }
    fetch('/api/ai-detect/configure', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({apiKey:'invalid_clear'}) }).catch(()=>{});
    updateStatusUI(false);
  }

  /* ─── 저장된 키 자동 적용 ──────────────────────────────── */
  async function autoApplySavedKey() {
    const key = getSavedKey();
    if (key && key.startsWith('AIza')) {
      try {
        await configureServer(key);
        updateStatusUI(true);
      } catch { updateStatusUI(false); }
    } else {
      await checkStatus();
    }
  }

  // 초기화
  document.addEventListener('DOMContentLoaded', () => {
    autoApplySavedKey();
  });

  window.DG = window.DG || {};
  window.DG.GeminiSetup = { openModal, saveFromModal, clearKey, checkStatus };
})();
