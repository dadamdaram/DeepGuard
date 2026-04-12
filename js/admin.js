/**
 * DeepGuard Pro — Admin & Community Module
 */
(function () {
  'use strict';
  const { Store, API, Toast, Modal, fmtDate, fmtBytes, verdictMeta, renderPagination } = window.DG;

  /* ─── Auth ───────────────────────────────────────────────── */
  const Auth = {
    async login(username, password) {
      const data = await API.post('/auth/login', { username, password });
      API.saveSession(data.token, data.role);
      return data;
    },
    async logout() {
      try { await API.post('/auth/logout', {}, API.getToken()); } catch {}
      API.clearSession();
    },
    isAdmin() {
      const u = API.getUser();
      return u && u.role === 'ADMIN';
    },
  };

  /* ─── Admin login page ───────────────────────────────────── */
  function initLoginPage() {
    const form = document.getElementById('login-form');
    const err = document.getElementById('login-error');
    const btn = document.getElementById('login-btn');
    if (!form) return;

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const user = document.getElementById('login-username').value.trim();
      const pass = document.getElementById('login-password').value;
      btn.disabled = true;
      btn.textContent = '로그인 중...';
      err.classList.add('hidden');
      try {
        await Auth.login(user, pass);
        window.location.href = './admin.html';
      } catch {
        err.textContent = '잘못된 관리자 계정입니다';
        err.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.textContent = '로그인';
      }
    });
  }

  /* ─── Admin dashboard ────────────────────────────────────── */
  function initAdminPage() {
    if (!Auth.isAdmin()) { window.location.href = './admin-login.html'; return; }
    updateAdminHeader();
    window.DG.initTabs('[data-tabs="admin"]');
    loadAdminStats();
    loadModeration();
    loadHashSearch();

    document.getElementById('admin-logout-btn')?.addEventListener('click', async () => {
      await Auth.logout();
      window.location.href = './admin-login.html';
      Toast.info('로그아웃되었습니다');
    });
  }

  function updateAdminHeader() {
    const el = document.getElementById('admin-username');
    if (el) el.textContent = 'admin';
  }

  async function loadAdminStats() {
    try {
      const [pending, total] = await Promise.all([
        API.get('/admin/reports?status=PENDING&pageSize=1', API.getToken()),
        API.get('/admin/reports?pageSize=1', API.getToken()),
      ]);
      const el = document.getElementById('admin-pending-count');
      if (el) el.textContent = pending.total || 0;
      const el2 = document.getElementById('admin-total-count');
      if (el2) el2.textContent = total.total || 0;
    } catch (e) { console.warn('Stats:', e); }
  }

  /* ─── Moderation ─────────────────────────────────────────── */
  async function loadModeration(status = 'PENDING', page = 1) {
    const tbody = document.getElementById('mod-tbody');
    const pager = document.getElementById('mod-pager');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:rgba(255,255,255,.3)">불러오는 중...</td></tr>`;

    try {
      const data = await API.get(`/admin/reports?status=${status}&page=${page}&pageSize=12`, API.getToken());
      renderModerationRows(data.items || data.data || []);
      if (pager) renderPagination(pager, { page, total: data.total, pageSize: 12, onPage: p => loadModeration(status, p) });
      Store.set('moderation', { reports: (data.items || data.data), total: data.total, page, statusFilter: status });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" style="color:var(--clr-danger);padding:24px;text-align:center">불러오기 실패</td></tr>`;
    }
  }

  function renderModerationRows(reports) {
    const tbody = document.getElementById('mod-tbody');
    if (!tbody) return;
    if (!reports.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:rgba(255,255,255,.25);font-size:.875rem">해당 상태의 신고가 없습니다</td></tr>`;
      return;
    }
    tbody.innerHTML = reports.map(r => {
      // community post 기반 신고 (verdict 필드 직접 존재)
      const verdict = r.verdict || r.analysisSnapshot?.verdict;
      const vm = verdict ? verdictMeta(verdict) : null;
      const avgConf = r.avgConfidence ?? r.analysisSnapshot?.avgConfidence;
      const confStr = avgConf != null ? (avgConf * 100).toFixed(1) + '%' : null;
      const statusBadge = { PENDING:'badge--pending', APPROVED:'badge--approved', REJECTED:'badge--rejected', FLAGGED:'badge--warn', ACTIVE:'badge--safe', DELETED:'badge--neutral' }[r.status] || 'badge--neutral';
      const title = r.title || r.fileName || r.sourceUrl || r.memo?.slice(0,40) || '(제목 없음)';
      const flagCount = r.flagCount != null ? `<span style="font-size:.7rem;color:var(--clr-warn);margin-left:4px">🚩${r.flagCount}</span>` : '';
      const mediaThumb = r.mediaData
        ? `<img src="${r.mediaData}" style="width:48px;height:36px;object-fit:cover;border-radius:4px;border:1px solid rgba(255,255,255,.1);flex-shrink:0" />`
        : '';
      return `
        <tr>
          <td><span class="badge ${statusBadge}">${r.status}</span>${flagCount}</td>
          <td>
            <div style="display:flex;align-items:center;gap:8px">
              ${mediaThumb}
              <div style="min-width:0">
                <div style="font-weight:500;font-size:.875rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</div>
                <div class="mono-sm" style="margin-top:3px">${(r.hash || '').slice(0, 16)}…</div>
              </div>
            </div>
          </td>
          <td>${vm ? `<span class="badge badge--${vm.cls}">${verdict}</span>` : '—'}</td>
          <td>${confStr ? `<span style="color:var(--clr-${vm?.cls||'safe'});font-family:var(--font-mono);font-size:.8125rem">${confStr}</span>` : '—'}</td>
          <td><span style="font-size:.8125rem;color:rgba(255,255,255,.4)">${fmtDate(r.createdAt || r.postedAt)}</span></td>
          <td>
            <div class="flex gap-8" style="flex-wrap:wrap">
              ${r.status === 'PENDING' ? `
                <button class="btn btn--sm btn--outline-accent" onclick="DG.Admin.approveReport('${r.id}')">승인</button>
                <button class="btn btn--sm btn--ghost" onclick="DG.Admin.rejectReport('${r.id}')">반려</button>
              ` : `<span style="font-size:.75rem;color:rgba(255,255,255,.25)">${r.moderatedBy || '—'}</span>`}
              <button class="btn btn--sm btn--danger" onclick="DG.Admin.deleteReport('${r.id}')" title="삭제">삭제</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  async function approveReport(id) {
    try {
      await API.patch(`/admin/reports/${id}`, { action: 'APPROVE' }, API.getToken());
      Toast.success('승인 처리되었습니다');
      loadModeration(Store.get('moderation').statusFilter, Store.get('moderation').page);
      loadAdminStats();
    } catch { Toast.error('처리 실패'); }
  }

  async function deleteReport(id) {
    Modal.open({
      title: '게시물 삭제',
      body: '<p style="font-size:.875rem;color:rgba(255,255,255,.6)">해당 신고/게시물을 완전히 삭제합니다. 이 작업은 되돌릴 수 없습니다.</p>',
      confirmLabel: '삭제',
      dangerous: true,
      onConfirm: async () => {
        try {
          await API.delete(`/admin/community/${id}`, API.getToken());
          Toast.success('삭제되었습니다');
          loadModeration(Store.get('moderation').statusFilter, Store.get('moderation').page);
          loadAdminStats();
        } catch { Toast.error('삭제 실패'); }
      },
    });
  }

  function rejectReport(id) {
    Modal.open({
      title: '신고 반려',
      body: `
        <div class="form-group">
          <label class="form-label">반려 사유 (선택)</label>
          <textarea class="form-textarea" id="reject-note" placeholder="반려 사유를 입력하세요..."></textarea>
        </div>
      `,
      confirmLabel: '반려 처리',
      dangerous: true,
      onConfirm: async () => {
        const note = document.getElementById('reject-note')?.value;
        try {
          await API.patch(`/admin/reports/${id}`, { action: 'REJECT', note }, API.getToken());
          Toast.success('반려 처리되었습니다');
          loadModeration(Store.get('moderation').statusFilter, Store.get('moderation').page);
        } catch { Toast.error('처리 실패'); }
      },
    });
  }

  /* ─── Hash Search ────────────────────────────────────────── */
  async function loadHashSearch(page = 1) {
    const filters = Store.get('hashSearch').filters;
    const tbody = document.getElementById('hash-tbody');
    const pager = document.getElementById('hash-pager');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:rgba(255,255,255,.3)">검색 중...</td></tr>`;

    const params = new URLSearchParams({ page, pageSize: 15 });
    if (filters.q) params.append('q', filters.q);
    if (filters.verdict) params.append('verdict', filters.verdict);
    if (filters.dateFrom) params.append('dateFrom', filters.dateFrom);
    if (filters.dateTo) params.append('dateTo', filters.dateTo);

    try {
      const data = await API.get(`/analysis/search?${params}`, API.getToken());
      renderHashRows(data.items || data.data || []);
      if (pager) renderPagination(pager, { page, total: data.total, pageSize: 15, onPage: loadHashSearch });
      Store.set('hashSearch', { results: (data.items || data.data), total: data.total, page });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" style="color:var(--clr-danger);padding:24px;text-align:center">오류 발생</td></tr>`;
    }
  }

  function renderHashRows(items) {
    const tbody = document.getElementById('hash-tbody');
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:rgba(255,255,255,.25);font-size:.875rem">검색 결과가 없습니다</td></tr>`;
      return;
    }
    tbody.innerHTML = items.map(r => {
      const vm = verdictMeta(r.verdict);
      return `
        <tr>
          <td><span class="mono" style="font-size:.75rem;color:rgba(255,255,255,.5)">${r.hash?.slice(0, 20)}…</span></td>
          <td style="font-size:.875rem;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.fileName || '—'}</td>
          <td><span class="badge badge--${vm.cls}">${r.verdict}</span></td>
          <td><span style="font-family:var(--font-mono);font-size:.8125rem;color:var(--clr-${vm.cls})">${(r.avgConfidence * 100).toFixed(1)}%</span></td>
          <td style="font-family:var(--font-mono);font-size:.75rem;color:rgba(255,255,255,.4)">${r.fileSize ? fmtBytes(r.fileSize) : '—'}</td>
          <td style="font-size:.8125rem;color:rgba(255,255,255,.4)">${fmtDate(r.analyzedAt)}</td>
        </tr>
      `;
    }).join('');
  }

  function initHashSearchFilters() {
    const applyBtn = document.getElementById('hash-search-btn');
    const qInput = document.getElementById('hash-q');
    const verdictSel = document.getElementById('hash-verdict');

    applyBtn?.addEventListener('click', () => {
      Store.set('hashSearch', {
        filters: {
          q: qInput?.value || '',
          verdict: verdictSel?.value || '',
          dateFrom: document.getElementById('hash-date-from')?.value || '',
          dateTo: document.getElementById('hash-date-to')?.value || '',
        },
        page: 1,
      });
      loadHashSearch(1);
    });

    qInput?.addEventListener('keydown', e => { if (e.key === 'Enter') applyBtn?.click(); });
  }

  function initModerationFilters() {
    document.querySelectorAll('[data-mod-status]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-mod-status]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadModeration(btn.dataset.modStatus);
      });
    });
  }

  /* ─── Community ──────────────────────────────────────────── */
  async function loadCommunity(page = 1) {
    const list = document.getElementById('community-list');
    const pager = document.getElementById('community-pager');
    if (!list) return;
    list.innerHTML = `<div style="text-align:center;padding:40px;color:rgba(255,255,255,.3)">불러오는 중...</div>`;

    try {
      const data = await API.get(`/reports/community?page=${page}&pageSize=10`);
      if (!(data.items || data.data)?.length) {
        list.innerHTML = `<div style="text-align:center;padding:60px;color:rgba(255,255,255,.25)">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="margin:0 auto 16px;opacity:.3;display:block"><path d="M9 17H7A5 5 0 017 7h2"/><path d="M15 7h2a5 5 0 010 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          <p>승인된 신고 사례가 없습니다</p>
        </div>`;
        return;
      }
      list.innerHTML = (data.items || data.data).map(r => {
        const vm = r.verdict ? verdictMeta(r.verdict) : null;
        const conf = r.confidence != null ? (r.confidence * 100).toFixed(1) + '%' : null;
        return `
          <div class="community-card">
            <div class="flex items-start justify-between gap-16">
              <div style="flex:1;min-width:0">
                ${vm ? `<div class="flex items-center gap-8 mb-10"><span class="badge badge--${vm.cls}">${r.verdict}</span>${conf ? `<span style="font-family:var(--font-mono);font-size:.75rem;color:rgba(255,255,255,.4)">신뢰도 ${conf}</span>` : ''}</div>` : ''}
                <h3 style="font-size:1rem;font-weight:600;margin-bottom:8px;line-height:1.4">${r.title}</h3>
                <p style="font-size:.875rem;color:rgba(255,255,255,.5);line-height:1.6">${r.description || ''}</p>
              </div>
              <div style="flex-shrink:0;text-align:right">
                <p style="font-family:var(--font-mono);font-size:.6875rem;color:rgba(255,255,255,.25)">${fmtDate(r.createdAt)}</p>
              </div>
            </div>
            ${r.hash ? `<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--clr-line)">
              <span style="font-family:var(--font-mono);font-size:.6875rem;color:rgba(255,255,255,.25)">해시: ${r.hash.slice(0,24)}…</span>
            </div>` : ''}
          </div>
        `;
      }).join('');
      if (pager) renderPagination(pager, { page, total: data.total, pageSize: 10, onPage: loadCommunity });
    } catch {
      list.innerHTML = `<div style="color:var(--clr-danger);padding:24px;text-align:center">불러오기 실패</div>`;
    }
  }

  /* ─── Report submission modal ────────────────────────────── */
  function initReportModal() {
    const overlay = document.getElementById('report-modal-overlay');
    const form = document.getElementById('report-form');
    const closeBtn = document.getElementById('report-modal-close');
    const cancelBtn = document.getElementById('report-cancel-btn');
    const submitBtn = document.getElementById('report-submit-btn');
    const openBtn = document.getElementById('open-report-modal-btn');

    if (!overlay) return;

    [closeBtn, cancelBtn].forEach(b => b?.addEventListener('click', () => overlay.classList.remove('is-open')));
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('is-open'); });
    openBtn?.addEventListener('click', () => overlay.classList.add('is-open'));

    submitBtn?.addEventListener('click', async () => {
      const a = Store.get('analysis');
      const title = document.getElementById('report-title')?.value.trim();
      const desc = document.getElementById('report-desc')?.value.trim();
      const contact = document.getElementById('report-contact')?.value.trim();
      const consent = document.getElementById('report-consent')?.checked;

      if (!title) { Toast.warn('제목을 입력하세요'); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = '접수 중...';
      try {
        await API.post('/reports', {
          hash: a.hash,
          title, description: desc,
          contactEmail: contact,
          victimConsent: consent,
        }, API.getToken());
        overlay.classList.remove('is-open');
        Toast.success('신고가 접수되었습니다. 관리자 검토 후 게시됩니다.');
      } catch (e) {
        Toast.error(e.status === 401 ? '로그인이 필요합니다' : '신고 접수 실패');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '신고 접수';
      }
    });
  }

  /* ─── 공지사항 관리 ──────────────────────────────────────── */
  async function loadNotices() {
    const list = document.getElementById('notices-list');
    if (!list) return;
    list.innerHTML = '<p style="color:rgba(255,255,255,.3);padding:16px">불러오는 중...</p>';
    try {
      const data = await API.get('/notices');
      const items = data.items || [];
      if (!items.length) {
        list.innerHTML = '<p style="color:rgba(255,255,255,.25);padding:16px;text-align:center">등록된 공지가 없습니다</p>';
        return;
      }
      list.innerHTML = items.map(n => `
        <div style="padding:16px;background:var(--clr-surface-2);border:1px solid var(--clr-line);border-radius:var(--radius-sm);margin-bottom:10px">
          <div class="flex items-center gap-10" style="margin-bottom:8px">
            ${n.pinned ? '<span style="font-size:.7rem;background:rgba(0,229,160,.15);color:var(--clr-safe);padding:2px 8px;border-radius:20px;border:1px solid rgba(0,229,160,.25)">📌 고정</span>' : ''}
            <span style="font-weight:600;font-size:.9375rem;flex:1">${n.title}</span>
            <span style="font-size:.75rem;color:rgba(255,255,255,.3);font-family:var(--font-mono)">${fmtDate(n.createdAt)}</span>
            <button class="btn btn--sm btn--danger" onclick="DG.Admin.deleteNotice('${n.id}')">삭제</button>
          </div>
          <p style="font-size:.875rem;color:rgba(255,255,255,.55);line-height:1.6;white-space:pre-wrap">${n.content}</p>
        </div>
      `).join('');
    } catch { list.innerHTML = '<p style="color:var(--clr-danger);padding:16px">불러오기 실패</p>'; }
  }

  async function submitNotice() {
    const title   = document.getElementById('notice-title')?.value.trim();
    const content = document.getElementById('notice-content')?.value.trim();
    const pinned  = document.getElementById('notice-pinned')?.checked;
    if (!title || !content) { Toast.warn('제목과 내용을 입력하세요'); return; }
    const btn = document.getElementById('notice-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = '등록 중...'; }
    try {
      await API.post('/admin/notices', { title, content, pinned }, API.getToken());
      Toast.success('공지가 등록되었습니다');
      if (document.getElementById('notice-title'))   document.getElementById('notice-title').value = '';
      if (document.getElementById('notice-content')) document.getElementById('notice-content').value = '';
      if (document.getElementById('notice-pinned'))  document.getElementById('notice-pinned').checked = false;
      loadNotices();
    } catch (e) { Toast.error('공지 등록 실패: ' + (e.message || '')); }
    finally { if (btn) { btn.disabled = false; btn.textContent = '공지 등록'; } }
  }

  async function deleteNotice(id) {
    Modal.open({
      title: '공지 삭제',
      body: '<p style="font-size:.875rem;color:rgba(255,255,255,.6)">해당 공지를 삭제합니다.</p>',
      confirmLabel: '삭제',
      dangerous: true,
      onConfirm: async () => {
        try {
          await API.delete(`/admin/notices/${id}`, API.getToken());
          Toast.success('삭제되었습니다');
          loadNotices();
        } catch { Toast.error('삭제 실패'); }
      },
    });
  }

  /* ─── Init ───────────────────────────────────────────────── */
  function init() {
    initLoginPage();
    if (document.getElementById('mod-tbody')) {
      initAdminPage();
      initModerationFilters();
      initHashSearchFilters();
    }
    if (document.getElementById('community-list')) loadCommunity();
    if (document.getElementById('notices-list'))   loadNotices();
    if (document.getElementById('notice-submit-btn')) {
      document.getElementById('notice-submit-btn').addEventListener('click', submitNotice);
    }
    initReportModal();
  }

  window.DG.Admin = { init, approveReport, rejectReport, deleteReport, loadModeration, loadCommunity, loadHashSearch, loadNotices, submitNotice, deleteNotice };
  window.DG.Auth = Auth;
})();
