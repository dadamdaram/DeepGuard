/**
 * DeepGuard Pro — Core JS Runtime
 * State management, UI primitives, SPA router
 */

/* ─── State Store ─────────────────────────────────────────── */
const Store = (() => {
  const _state = {
    currentPage: 'analyze',
    analysis: {
      file: null,
      hash: null,
      hashStatus: 'idle',       // idle | hashing | checking | cached | new
      hashProgress: 0,
      analysisStatus: 'idle',   // idle | ready | analyzing | complete | error
      analysisProgress: 0,
      frameResults: [],
      overallResult: null,
      suspiciousScreenshots: [],
      liveConfidence: 0,
      frameCount: 0,
    },
    admin: {
      user: null,
      token: null,
      role: null,
    },
    community: {
      reports: [],
      total: 0,
      page: 1,
    },
    moderation: {
      reports: [],
      total: 0,
      statusFilter: 'PENDING',
      page: 1,
    },
    hashSearch: {
      results: [],
      total: 0,
      page: 1,
      filters: { q: '', verdict: '', dateFrom: '', dateTo: '' },
    },
  };

  const listeners = {};

  function get(key) { return key ? _state[key] : _state; }

  function set(key, patch) {
    if (typeof patch === 'object' && !Array.isArray(patch)) {
      Object.assign(_state[key], patch);
    } else {
      _state[key] = patch;
    }
    (listeners[key] || []).forEach(fn => fn(_state[key]));
    (listeners['*'] || []).forEach(fn => fn(_state));
  }

  function on(key, fn) {
    if (!listeners[key]) listeners[key] = [];
    listeners[key].push(fn);
    return () => { listeners[key] = listeners[key].filter(f => f !== fn); };
  }

  return { get, set, on };
})();

/* ─── API Client ──────────────────────────────────────────── */
const API_BASE = (window.DG_ENV && window.DG_ENV.API_BASE) || '/api';

const API = {
  async request(method, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, data });
    return data;
  },
  get:    (p, t) => API.request('GET', p, null, t),
  post:   (p, b, t) => API.request('POST', p, b, t),
  patch:  (p, b, t) => API.request('PATCH', p, b, t),
  delete: (p, b, t) => API.request('DELETE', p, b || null, t),

  getToken() { return sessionStorage.getItem('dg_token'); },
  getUser()  {
    const u = sessionStorage.getItem('dg_user');
    return u ? JSON.parse(u) : null;
  },
  saveSession(token, role) {
    sessionStorage.setItem('dg_token', token);
    sessionStorage.setItem('dg_user', JSON.stringify({ token, role }));
    Store.set('admin', { user: { role }, token, role });
  },
  clearSession() {
    sessionStorage.removeItem('dg_token');
    sessionStorage.removeItem('dg_user');
    Store.set('admin', { user: null, token: null, role: null });
  },
};

/* ─── Toast ───────────────────────────────────────────────── */
const Toast = (() => {
  let container;

  function init() {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const icons = {
    success: `<svg class="toast__icon" viewBox="0 0 20 20" fill="none"><path d="M16.667 5L7.5 14.167 3.333 10" stroke="#00e5a0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    error:   `<svg class="toast__icon" viewBox="0 0 20 20" fill="none"><path d="M10 6v4m0 4h.01M4.343 4.343a8 8 0 1011.314 11.314A8 8 0 004.343 4.343z" stroke="#ff3b5c" stroke-width="1.5"/></svg>`,
    info:    `<svg class="toast__icon" viewBox="0 0 20 20" fill="none"><path d="M10 6h.01M10 10v4m0 4a8 8 0 100-16 8 8 0 000 16z" stroke="#00c8ff" stroke-width="1.5"/></svg>`,
    warn:    `<svg class="toast__icon" viewBox="0 0 20 20" fill="none"><path d="M10 3L18 17H2L10 3z" stroke="#ffaa00" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 10v3m0 2h.01" stroke="#ffaa00" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  };

  function show(message, type = 'info', duration = 4000) {
    if (!container) init();
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.innerHTML = `${icons[type] || ''}<span>${message}</span>`;
    container.appendChild(el);
    const remove = () => {
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 300);
    };
    setTimeout(remove, duration);
    el.addEventListener('click', remove);
  }

  return {
    success: (m, d) => show(m, 'success', d),
    error:   (m, d) => show(m, 'error', d),
    info:    (m, d) => show(m, 'info', d),
    warn:    (m, d) => show(m, 'warn', d),
  };
})();

/* ─── Modal ───────────────────────────────────────────────── */
const Modal = (() => {
  let overlay, modal, _onConfirm;

  function init() {
    overlay = document.getElementById('modal-overlay');
    modal = document.getElementById('modal');
    if (!overlay) return;
    overlay.addEventListener('click', e => {
      if (e.target === overlay) close();
    });
    document.getElementById('modal-cancel-btn')?.addEventListener('click', close);
    document.getElementById('modal-confirm-btn')?.addEventListener('click', () => {
      if (_onConfirm) _onConfirm();
      close();
    });
  }

  function open({ title, body, confirmLabel = '확인', cancelLabel = '취소', onConfirm, dangerous = false }) {
    if (!overlay) init();
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = body;
    const confirmBtn = document.getElementById('modal-confirm-btn');
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className = `btn ${dangerous ? 'btn--danger' : 'btn--primary'} btn--sm`;
    const cancelBtn = document.getElementById('modal-cancel-btn');
    if (cancelLabel === null || cancelLabel === false) {
      cancelBtn.style.display = 'none';
    } else {
      cancelBtn.style.display = '';
      cancelBtn.textContent = cancelLabel;
    }
    _onConfirm = onConfirm;
    overlay.classList.add('is-open');
  }

  function close() { overlay?.classList.remove('is-open'); }

  return { open, close };
})();

/* ─── Tabs ────────────────────────────────────────────────── */
function initTabs(containerSelector) {
  const containers = document.querySelectorAll(containerSelector || '[data-tabs]');
  containers.forEach(container => {
    const buttons = container.querySelectorAll('.tab-btn');
    const panels = container.querySelectorAll('.tab-panel');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        buttons.forEach(b => b.classList.remove('active'));
        panels.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const target = btn.dataset.tab;
        const panel = container.querySelector(`[data-panel="${target}"]`);
        if (panel) panel.classList.add('active');
      });
    });
  });
}

/* ─── SPA Router ──────────────────────────────────────────── */
const Router = (() => {
  const routes = {};

  function define(path, handler) { routes[path] = handler; }

  function navigate(path, state) {
    window.history.pushState(state || {}, '', path);
    dispatch(path, state);
  }

  function dispatch(path, state) {
    const handler = routes[path] || routes['*'];
    if (handler) handler(state || {});
  }

  function init() {
    window.addEventListener('popstate', (e) => {
      dispatch(window.location.pathname, e.state);
    });
    document.addEventListener('click', e => {
      const a = e.target.closest('[data-link]');
      if (a) {
        e.preventDefault();
        navigate(a.dataset.link, a.dataset.state ? JSON.parse(a.dataset.state) : undefined);
      }
    });
    dispatch(window.location.pathname, window.history.state);
  }

  return { define, navigate, dispatch, init };
})();

/* ─── File Fingerprint (캐시 조회용 식별자) ───────────────── */
// 파일 전체를 읽지 않고 name + size + lastModified 문자열을
// crypto.subtle로 해싱. 메모리/스택 문제 없음.
// 동일 파일은 항상 동일 해시 → 서버 캐시 히트 정상 동작.
async function computeSHA256(file, onProgress) {
  const fingerprint = `${file.name}|${file.size}|${file.lastModified}`;
  const encoded     = new TextEncoder().encode(fingerprint);
  const hashBuf     = await crypto.subtle.digest('SHA-256', encoded);
  onProgress?.(0.55);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ─── Format helpers ──────────────────────────────────────── */
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2);
  return m > 0 ? `${m}:${sec.padStart(5, '0')}` : `${sec}s`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function confidenceColor(v) {
  if (v >= 0.7) return 'var(--clr-danger)';
  if (v >= 0.4) return 'var(--clr-warn)';
  return 'var(--clr-safe)';
}

function verdictMeta(verdict) {
  const map = {
    FAKE:       { label: '위조 판정',     cls: 'danger', badgeCls: 'badge--danger', blockCls: 'verdict-block--deepfake' },
    DEEPFAKE:   { label: '딥페이크 의심', cls: 'danger', badgeCls: 'badge--danger', blockCls: 'verdict-block--deepfake' },
    SUSPICIOUS: { label: '주의 필요',     cls: 'warn',   badgeCls: 'badge--warn',   blockCls: 'verdict-block--suspicious' },
    AUTHENTIC:  { label: '정상 판정',     cls: 'safe',   badgeCls: 'badge--safe',   blockCls: 'verdict-block--authentic' },
  };
  return map[verdict] || map.SUSPICIOUS;
}

/* ─── Pagination ──────────────────────────────────────────── */
function renderPagination(container, { page, total, pageSize, onPage }) {
  const totalPages = Math.ceil(total / pageSize);
  container.innerHTML = `
    <button class="btn btn--ghost btn--sm" ${page <= 1 ? 'disabled' : ''} data-pg="${page - 1}">← 이전</button>
    <span style="font-family:var(--font-mono);font-size:.75rem;color:rgba(255,255,255,.4);padding:0 12px;">${page} / ${totalPages || 1}</span>
    <button class="btn btn--ghost btn--sm" ${page >= totalPages ? 'disabled' : ''} data-pg="${page + 1}">다음 →</button>
  `;
  container.querySelectorAll('[data-pg]').forEach(btn => {
    btn.addEventListener('click', () => onPage(Number(btn.dataset.pg)));
  });
}

/* ─── Expose globals ──────────────────────────────────────── */
// Auth stub so admin-login.html can call DG.Auth.isAdmin() before admin.js sets the real impl
const _AuthStub = {
  isAdmin() {
    const u = API.getUser();
    return u && u.role === 'ADMIN';
  },
};
window.DG = { Store, API, Toast, Modal, Router, computeSHA256, fmtBytes, fmtTime, fmtDate, confidenceColor, verdictMeta, renderPagination, initTabs, Auth: _AuthStub };
