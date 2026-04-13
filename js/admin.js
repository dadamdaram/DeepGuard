/**
 * DeepGuard Pro v9 — Admin & Community Module
 * 신고 알림 시스템 · 게시물 삭제 권한 · 딥페이크/AI 생성 구분 표시
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
    isAdmin() { const u = API.getUser(); return u && u.role === 'ADMIN'; },
  };

  /* ─── Admin login page ───────────────────────────────────── */
  function initLoginPage() {
    const form = document.getElementById('login-form');
    const err  = document.getElementById('login-error');
    const btn  = document.getElementById('login-btn');
    if (!form) return;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const user = document.getElementById('login-username').value.trim();
      const pass = document.getElementById('login-password').value;
      btn.disabled = true; btn.textContent = '로그인 중...'; err.classList.add('hidden');
      try {
        await Auth.login(user, pass);
        window.location.href = './admin.html';
      } catch {
        err.textContent = '잘못된 관리자 계정입니다';
        err.classList.remove('hidden');
      } finally { btn.disabled = false; btn.textContent = '로그인'; }
    });
  }

  /* ─── Notification Bell ──────────────────────────────────── */
  let _notifPollTimer = null;
  let _notifOpen = false;

  function initNotificationBell() {
    const bell = document.getElementById('notif-bell');
    if (!bell) return;
    bell.addEventListener('click', e => { e.stopPropagation(); toggleNotifDropdown(); });
    document.addEventListener('click', () => closeNotifDropdown());
    pollNotifications();
    _notifPollTimer = setInterval(pollNotifications, 30000);
  }

  async function pollNotifications() {
    if (!Auth.isAdmin()) return;
    try {
      const data = await API.get('/admin/notifications?unread=true', API.getToken());
      const count = data.unreadCount || 0;
      const badge = document.getElementById('notif-badge');
      if (badge) { badge.textContent = count > 9 ? '9+' : count; badge.style.display = count > 0 ? 'flex' : 'none'; }
      document.getElementById('notif-bell')?.classList.toggle('has-notif', count > 0);
    } catch {}
  }

  async function toggleNotifDropdown() {
    const dropdown = document.getElementById('notif-dropdown');
    if (!dropdown) return;
    _notifOpen = !_notifOpen;
    if (_notifOpen) { dropdown.classList.add('is-open'); await loadNotifDropdown(dropdown); }
    else dropdown.classList.remove('is-open');
  }

  function closeNotifDropdown() {
    document.getElementById('notif-dropdown')?.classList.remove('is-open');
    _notifOpen = false;
  }

  async function loadNotifDropdown(dropdown) {
    dropdown.innerHTML = `<div style="padding:20px;text-align:center;color:rgba(255,255,255,.3);font-size:.8125rem">불러오는 중...</div>`;
    try {
      const data = await API.get('/admin/notifications', API.getToken());
      const items = data.items || [];
      const unread = data.unreadCount || 0;
      if (!items.length) {
        dropdown.innerHTML = `
          <div style="padding:14px 20px;border-bottom:1px solid var(--clr-line)"><span style="font-weight:600;font-size:.875rem">알림</span></div>
          <div style="padding:32px 20px;text-align:center;color:rgba(255,255,255,.3);font-size:.8125rem">새 알림이 없습니다</div>`;
        return;
      }
      const reasonLabels = { false_result:'판별 부정확', privacy:'개인정보 침해', harmful:'유해 콘텐츠', spam:'스팸', other:'기타' };
      const notifHtml = items.slice(0, 15).map(n => {
        const isNew = !n.read;
        return `<div class="notif-item" onclick="DG.Admin.handleNotifClick('${n.id}','${n.postId}')" style="padding:12px 20px;border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer;display:flex;gap:12px;align-items:flex-start;transition:background .15s;${isNew ? 'background:rgba(255,170,0,.04);' : ''}">
          <div style="width:34px;height:34px;border-radius:50%;background:rgba(255,59,92,.12);border:1px solid rgba(255,59,92,.25);display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--clr-danger)" stroke-width="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
          </div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
              ${isNew ? '<span style="width:6px;height:6px;border-radius:50%;background:var(--clr-warn);flex-shrink:0"></span>' : ''}
              <span style="font-size:.8125rem;font-weight:600">신고: ${reasonLabels[n.reason] || '기타'}</span>
            </div>
            <p style="font-size:.75rem;color:rgba(255,255,255,.4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${n.postFileName || '알 수 없음'}</p>
            <div style="display:flex;gap:8px;margin-top:3px">
              <span style="font-size:.65rem;color:rgba(255,255,255,.25)">${getTimeAgo(n.createdAt)}</span>
              <span style="font-size:.65rem;color:var(--clr-warn)">🚩 ${n.flagCount}회</span>
              ${n.postDeleted ? '<span style="font-size:.65rem;color:rgba(255,255,255,.2)">[삭제됨]</span>' : ''}
            </div>
          </div>
        </div>`;
      }).join('');
      dropdown.innerHTML = `
        <div style="padding:14px 20px;border-bottom:1px solid var(--clr-line);display:flex;justify-content:space-between;align-items:center">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-weight:600;font-size:.875rem">알림</span>
            ${unread > 0 ? `<span style="background:var(--clr-danger);color:#fff;font-size:.6rem;font-weight:700;padding:1px 6px;border-radius:10px">${unread}</span>` : ''}
          </div>
          ${unread > 0 ? `<button onclick="event.stopPropagation();DG.Admin.markAllNotifRead()" style="font-size:.75rem;color:var(--clr-accent);background:none;border:none;cursor:pointer">모두 읽음</button>` : ''}
        </div>
        <div style="max-height:380px;overflow-y:auto">${notifHtml}</div>
        <div style="padding:10px 20px;border-top:1px solid var(--clr-line);text-align:center">
          <a href="#" onclick="event.preventDefault();event.stopPropagation();DG.Admin.switchSection('moderation',null)" style="font-size:.8125rem;color:var(--clr-accent)">신고 관리 바로가기 →</a>
        </div>`;
    } catch { dropdown.innerHTML = `<div style="padding:20px;color:var(--clr-danger);font-size:.8125rem">알림 로드 실패</div>`; }
  }

  async function handleNotifClick(notifId, postId) {
    try { await API.patch(`/admin/notifications/${notifId}/read`, {}, API.getToken()); } catch {}
    pollNotifications();
    closeNotifDropdown();
    switchSection('moderation', null);
    setTimeout(() => {
      const row = document.querySelector(`[data-post-id="${postId}"]`);
      if (row) { row.scrollIntoView({ behavior:'smooth', block:'center' }); row.style.outline = '2px solid var(--clr-warn)'; setTimeout(() => row.style.outline = '', 2500); }
    }, 500);
  }

  async function markAllNotifRead() {
    try {
      await API.post('/admin/notifications/read-all', {}, API.getToken());
      pollNotifications();
      const dd = document.getElementById('notif-dropdown');
      if (dd && _notifOpen) loadNotifDropdown(dd);
      Toast.success('모든 알림을 읽음 처리했습니다');
    } catch { Toast.error('처리 실패'); }
  }

  function getTimeAgo(d) {
    const m = Math.floor((Date.now() - new Date(d)) / 60000);
    if (m < 1) return '방금 전';
    if (m < 60) return m + '분 전';
    if (m < 1440) return Math.floor(m/60) + '시간 전';
    return Math.floor(m/1440) + '일 전';
  }

  /* ─── Admin dashboard ────────────────────────────────────── */
  function initAdminPage() {
    if (!Auth.isAdmin()) { window.location.href = './admin-login.html'; return; }
    document.getElementById('admin-username') && (document.getElementById('admin-username').textContent = 'admin');
    loadAdminStats();
    loadModeration();
    loadHashSearch();
    initNotificationBell();
    document.getElementById('admin-logout-btn')?.addEventListener('click', async () => {
      if (_notifPollTimer) clearInterval(_notifPollTimer);
      await Auth.logout();
      window.location.href = './admin-login.html';
    });
  }

  async function loadAdminStats() {
    try {
      const [flagged, stats, notifs] = await Promise.all([
        API.get('/admin/reports?status=FLAGGED&pageSize=1', API.getToken()),
        API.get('/admin/stats', API.getToken()),
        API.get('/admin/notifications?unread=true', API.getToken()),
      ]);
      [['admin-pending-count', flagged.total], ['admin-total-count', stats.totalAnalyses], ['admin-community-count', stats.communityPosts], ['admin-notif-count', notifs.unreadCount]].forEach(([id, v]) => {
        const el = document.getElementById(id); if (el) el.textContent = v ?? '—';
      });
      const badge = document.getElementById('pending-badge');
      if (badge) { badge.textContent = flagged.total || 0; badge.style.display = flagged.total > 0 ? 'inline-flex' : 'none'; }
    } catch {}
  }

  /* ─── switchSection ──────────────────────────────────────── */
  function switchSection(key, triggerEl) {
    document.querySelectorAll('.admin-section').forEach(s => s.classList.add('hidden'));
    document.getElementById(`section-${key}`)?.classList.remove('hidden');
    document.querySelectorAll('.admin-sidebar__item').forEach(b => b.classList.remove('active'));
    if (triggerEl) triggerEl.classList.add('active');
    else document.querySelector(`[data-section="${key}"]`)?.classList.add('active');
    if (key === 'moderation') loadModeration();
    if (key === 'hashes') loadHashSearch();
    if (key === 'notices') loadNotices();
  }
  window.switchSection = switchSection;

  /* ─── Moderation ─────────────────────────────────────────── */
  let _modStatus = 'FLAGGED';

  async function loadModeration(status, page = 1) {
    if (status !== undefined && status !== null) _modStatus = status;
    const tbody = document.getElementById('mod-tbody');
    const pager = document.getElementById('mod-pager');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:rgba(255,255,255,.3)">불러오는 중...</td></tr>`;
    try {
      const data = await API.get(`/admin/reports?status=${_modStatus}&page=${page}&pageSize=15`, API.getToken());
      renderModerationRows(data.items || data.data || []);
      if (pager) renderPagination(pager, { page, total: data.total, pageSize: 15, onPage: p => loadModeration(null, p) });
      document.querySelectorAll('[data-mod-status]').forEach(b => b.classList.toggle('active', b.dataset.modStatus === _modStatus));
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" style="color:var(--clr-danger);padding:24px;text-align:center">불러오기 실패</td></tr>`;
    }
  }

  function dtLabel(type) {
    return { DEEPFAKE_MANIPULATED:{label:'🎭 딥페이크',color:'var(--clr-danger)'}, AI_GENERATED:{label:'🤖 AI 생성',color:'#a78bfa'}, AI_MANIPULATED:{label:'⚠️ AI 편집',color:'var(--clr-warn)'} }[type] || null;
  }

  function renderModerationRows(reports) {
    const tbody = document.getElementById('mod-tbody');
    if (!tbody) return;
    if (!reports.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:48px;color:rgba(255,255,255,.2)">해당 상태의 신고가 없습니다</td></tr>`;
      return;
    }
    const statusMap = { ACTIVE:{cls:'badge--safe',lbl:'활성'}, FLAGGED:{cls:'badge--warn',lbl:'🚩 신고됨'}, DELETED:{cls:'badge--neutral',lbl:'삭제됨'}, PENDING:{cls:'badge--pending',lbl:'대기'}, APPROVED:{cls:'badge--safe',lbl:'승인'}, REJECTED:{cls:'badge--neutral',lbl:'반려'} };
    tbody.innerHTML = reports.map(r => {
      const vm = r.verdict ? verdictMeta(r.verdict) : null;
      const sc = statusMap[r.status] || { cls:'badge--neutral', lbl: r.status };
      const dt = dtLabel(r.detectionType);
      const isDeleted = r.status === 'DELETED';
      const title = r.fileName || (r.sourceUrl ? (() => { try { return new URL(r.sourceUrl).hostname; } catch { return r.sourceUrl.slice(0,28); } })() : r.memo?.slice(0,30) || '(알 수 없음)');
      const thumb = r.mediaData
        ? `<img src="${r.mediaData}" style="width:48px;height:36px;object-fit:cover;border-radius:5px;border:1px solid rgba(255,255,255,.1);flex-shrink:0"/>`
        : `<div style="width:48px;height:36px;border-radius:5px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:center;flex-shrink:0"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.2)" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="21 15 16 10 5 21"/></svg></div>`;
      return `<tr data-post-id="${r.id}" style="${isDeleted ? 'opacity:.4;' : ''}">
        <td><span class="badge ${sc.cls}" style="font-size:.65rem">${sc.lbl}</span>${r.flagCount > 0 ? `<br><span style="font-size:.65rem;color:var(--clr-warn);margin-top:3px;display:inline-block">🚩 ${r.flagCount}회</span>` : ''}</td>
        <td><div style="display:flex;align-items:center;gap:9px">${thumb}<div style="min-width:0"><div style="font-size:.8rem;font-weight:500;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(title)}</div><div style="font-family:var(--font-mono);font-size:.6rem;color:rgba(255,255,255,.25);margin-top:2px">${(r.hash||'').slice(0,12)}…</div></div></div></td>
        <td>
          <div style="display:flex;flex-direction:column;gap:5px;align-items:flex-start">
            ${vm ? `<span class="badge badge--${vm.cls}" style="font-size:.65rem;white-space:nowrap">${vm.label}</span>` : '<span style="color:rgba(255,255,255,.25);font-size:.75rem">—</span>'}
            ${dt ? `<span class="badge" style="font-size:.6rem;background:${dt.color}18;color:${dt.color};border:1px solid ${dt.color}40;white-space:nowrap">${dt.label}</span>` : ''}
          </div>
        </td>
        <td style="font-family:var(--font-mono);font-size:.8rem;color:${vm ? `var(--clr-${vm.cls})` : 'rgba(255,255,255,.4)'}">${r.avgConfidence != null ? (r.avgConfidence*100).toFixed(1)+'%' : '—'}</td>
        <td style="font-size:.75rem;color:rgba(255,255,255,.3)">${fmtDate(r.postedAt||r.createdAt)}</td>
        <td style="max-width:120px"><p style="font-size:.75rem;color:rgba(255,255,255,.4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.memo ? escHtml(r.memo) : '—'}</p></td>
        <td>${!isDeleted ? `<button class="btn btn--sm" style="background:rgba(255,59,92,.1);border:1px solid rgba(255,59,92,.25);color:var(--clr-danger);font-size:.75rem;padding:5px 10px;white-space:nowrap" onclick="DG.Admin.deletePost('${r.id}')"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:inline;margin-right:4px;vertical-align:middle"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>삭제</button>` : '<span style="font-size:.7rem;color:rgba(255,255,255,.2)">삭제됨</span>'}</td>
      </tr>`;
    }).join('');
  }

  async function deletePost(id) {
    Modal.open({
      title: '게시물 삭제',
      body: `<div style="background:rgba(255,59,92,.07);border:1px solid rgba(255,59,92,.2);border-radius:8px;padding:14px 18px">
        <p style="font-size:.875rem;color:var(--clr-danger);font-weight:600;margin-bottom:6px">⚠ 되돌릴 수 없는 작업입니다</p>
        <p style="font-size:.8125rem;color:rgba(255,255,255,.6)">해당 커뮤니티 게시물을 삭제합니다. 커뮤니티에서 즉시 숨겨집니다.</p>
      </div>`,
      confirmLabel: '삭제 확인', dangerous: true,
      onConfirm: async () => {
        try {
          await API.delete(`/admin/community/posts/${id}`, API.getToken());
          Toast.success('게시물이 삭제되었습니다');
          loadModeration(); loadAdminStats(); pollNotifications();
        } catch (e) { Toast.error('삭제 실패: ' + (e.message||'')); }
      },
    });
  }

  /* ─── Hash Search ────────────────────────────────────────── */
  async function loadHashSearch(page = 1) {
    const filters = Store.get('hashSearch')?.filters || {};
    const tbody = document.getElementById('hash-tbody');
    const pager = document.getElementById('hash-pager');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:32px;color:rgba(255,255,255,.3)">검색 중...</td></tr>`;
    const params = new URLSearchParams({ page, pageSize: 15 });
    if (filters.q)       params.append('q', filters.q);
    if (filters.verdict) params.append('verdict', filters.verdict);
    if (filters.dateFrom) params.append('dateFrom', filters.dateFrom);
    if (filters.dateTo)   params.append('dateTo', filters.dateTo);
    try {
      const data = await API.get(`/analysis/search?${params}`, API.getToken());
      renderHashRows(data.items || data.data || []);
      if (pager) renderPagination(pager, { page, total: data.total, pageSize: 15, onPage: loadHashSearch });
    } catch { tbody.innerHTML = `<tr><td colspan="7" style="color:var(--clr-danger);padding:24px;text-align:center">오류 발생</td></tr>`; }
  }

  function renderHashRows(items) {
    const tbody = document.getElementById('hash-tbody');
    if (!tbody) return;
    if (!items.length) { tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:rgba(255,255,255,.2)">결과 없음</td></tr>`; return; }
    const tcIcon = { video:'🎬', image:'🖼', url:'🔗' };
    tbody.innerHTML = items.map(r => {
      const vm = verdictMeta(r.verdict);
      const dt = dtLabel(r.detectionType);
      return `<tr>
        <td><span class="mono" style="font-size:.7rem;color:rgba(255,255,255,.4)">${r.hash?.slice(0,16)}…</span></td>
        <td style="font-size:.8rem;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${(tcIcon[r.inputType]||'📄')} ${escHtml(r.fileName||r.sourceUrl||'—')}</td>
        <td>
          <div style="display:flex;flex-direction:column;gap:5px;align-items:flex-start">
            <span class="badge badge--${vm.cls}" style="font-size:.65rem;white-space:nowrap">${vm.label}</span>
            ${dt ? `<span class="badge" style="font-size:.6rem;background:${dt.color}18;color:${dt.color};border:1px solid ${dt.color}40;white-space:nowrap">${dt.label}</span>` : ''}
          </div>
        </td>
        <td style="font-family:var(--font-mono);font-size:.8rem;color:var(--clr-${vm.cls})">${(r.avgConfidence*100).toFixed(1)}%</td>
        <td style="font-size:.75rem;color:rgba(255,255,255,.35)">${r.totalFrames ? r.totalFrames+' f' : '—'}</td>
        <td style="font-family:var(--font-mono);font-size:.7rem;color:rgba(255,255,255,.3)">${r.fileSize ? fmtBytes(r.fileSize) : '—'}</td>
        <td style="font-size:.75rem;color:rgba(255,255,255,.3)">${fmtDate(r.analyzedAt)}</td>
      </tr>`;
    }).join('');
  }

  function initHashSearchFilters() {
    document.getElementById('hash-search-btn')?.addEventListener('click', () => {
      Store.set('hashSearch', { filters: { q: document.getElementById('hash-q')?.value||'', verdict: document.getElementById('hash-verdict')?.value||'', dateFrom: document.getElementById('hash-date-from')?.value||'', dateTo: document.getElementById('hash-date-to')?.value||'' } });
      loadHashSearch(1);
    });
    document.getElementById('hash-q')?.addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('hash-search-btn')?.click(); });
  }

  function initModerationFilters() {
    document.querySelectorAll('[data-mod-status]').forEach(btn => {
      btn.addEventListener('click', () => loadModeration(btn.dataset.modStatus));
    });
  }

  /* ─── 공지사항 ───────────────────────────────────────────── */
  async function loadNotices() {
    const list = document.getElementById('notices-list');
    if (!list) return;
    list.innerHTML = '<p style="color:rgba(255,255,255,.3);padding:16px;text-align:center">불러오는 중...</p>';
    try {
      const data = await API.get('/notices');
      const items = data.items || [];
      if (!items.length) { list.innerHTML = '<p style="color:rgba(255,255,255,.25);padding:24px;text-align:center">등록된 공지가 없습니다</p>'; return; }
      list.innerHTML = items.map(n => `
        <div style="padding:16px 20px;background:var(--clr-surface-2);border:1px solid var(--clr-line);border-radius:10px;margin-bottom:10px">
          <div class="flex items-center gap-10" style="margin-bottom:8px">
            ${n.pinned ? '<span style="font-size:.65rem;background:rgba(0,229,160,.1);color:var(--clr-safe);padding:2px 8px;border-radius:20px;border:1px solid rgba(0,229,160,.2)">📌 고정</span>' : ''}
            <span style="font-weight:600;font-size:.9rem;flex:1">${escHtml(n.title)}</span>
            <span style="font-size:.7rem;color:rgba(255,255,255,.3)">${fmtDate(n.createdAt)}</span>
            <button class="btn btn--sm" style="background:rgba(255,59,92,.1);border:1px solid rgba(255,59,92,.2);color:var(--clr-danger);font-size:.7rem;padding:4px 10px" onclick="DG.Admin.deleteNotice('${n.id}')">삭제</button>
          </div>
          <p style="font-size:.85rem;color:rgba(255,255,255,.55);line-height:1.7;white-space:pre-wrap">${escHtml(n.content)}</p>
        </div>`).join('');
    } catch { list.innerHTML = '<p style="color:var(--clr-danger);padding:16px">불러오기 실패</p>'; }
  }

  async function submitNotice() {
    const title = document.getElementById('notice-title')?.value.trim();
    const content = document.getElementById('notice-content')?.value.trim();
    const pinned = document.getElementById('notice-pinned')?.checked;
    if (!title || !content) { Toast.warn('제목과 내용을 입력하세요'); return; }
    const btn = document.getElementById('notice-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = '등록 중...'; }
    try {
      await API.post('/admin/notices', { title, content, pinned }, API.getToken());
      Toast.success('공지가 등록되었습니다');
      ['notice-title','notice-content'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
      document.getElementById('notice-pinned') && (document.getElementById('notice-pinned').checked = false);
      loadNotices();
    } catch (e) { Toast.error('공지 등록 실패: '+(e.message||'')); }
    finally { if(btn) { btn.disabled=false; btn.textContent='공지 등록'; } }
  }

  async function deleteNotice(id) {
    Modal.open({ title:'공지 삭제', body:'<p style="font-size:.875rem;color:rgba(255,255,255,.6)">공지를 삭제합니다.</p>', confirmLabel:'삭제', dangerous:true,
      onConfirm: async () => {
        try { await API.delete(`/admin/notices/${id}`, API.getToken()); Toast.success('삭제됨'); loadNotices(); }
        catch { Toast.error('삭제 실패'); }
      }
    });
  }

  /* ─── Util ───────────────────────────────────────────────── */
  function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  /* ─── Init ───────────────────────────────────────────────── */
  function init() {
    initLoginPage();
    Store.set('hashSearch', { filters:{}, page:1 });
    if (document.getElementById('mod-tbody')) {
      initAdminPage();
      initModerationFilters();
      initHashSearchFilters();
      document.getElementById('notice-submit-btn')?.addEventListener('click', submitNotice);
    }
  }

  window.DG.Admin = { init, deletePost, loadModeration, loadHashSearch, loadNotices, submitNotice, deleteNotice, markAllNotifRead, handleNotifClick, switchSection };
  window.DG.Auth = Auth;
})();
