/**
 * DeepGuard Pro v4 — Backend API Server
 * 무료 AI 판별: Google Gemini Flash (무료 티어 지원)
 * node server.js → http://localhost:3001
 */
import express from 'express';
import { createHash, randomBytes } from 'crypto';
import http  from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

/* ─── Gemini Free API ──────────────────────────────────────── */
let GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-flash-latest';

async function callGemini(parts) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 미설정');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ role: 'user', parts }],
      // responseMimeType 제거 — 모델 버전에 따라 지원 안 되면 500 발생
      generationConfig: { maxOutputTokens: 8192, temperature: 0.1 },
    });
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 60000,
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(`Gemini API 오류 [${json.error.code}]: ${json.error.message}`));
          let text = json.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
          // 마크다운 코드블록 제거
          text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/m, '').trim();
          resolve(JSON.parse(text));
        } catch(e) {
          reject(new Error('Gemini 응답 파싱 실패: ' + data.slice(0, 300)));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Gemini 타임아웃 (60s)')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ─── AI 판별 프롬프트 (Chain of Thought 고도화) ───────────────── */
const IMAGE_PROMPT = `당신은 최고 수준의 시각 포렌식 및 AI/딥페이크 탐지 전문 시스템입니다.
주어진 이미지를 분석하여 AI 생성/딥페이크 여부를 엄격하게 판별하세요.

[분석 지침 (Chain of Thought)]
결론을 내리기 전에, 아래 단계에 따라 시각적 단서를 꼼꼼히 역추적하세요:
1. 조명 및 반사: 눈동자의 인공적 하이라이트 비대칭성, 그림자의 방향이 광원과 일치하는지?
2. 해부학 및 인체 구조: 손가락 형태와 개수, 치아 크기/배열, 귀의 복잡한 구조가 자연스러운지?
3. 텍스처 및 결합: 피부가 플라스틱처럼 지나치게 매끈한지, 배경 피사체가 이상하게 융합되었는지?
4. 딥페이크 특화 신호: 얼굴 경계선(턱선, 헤어라인) 부근의 해상도 저하나 비정상적인 블러링 처리 유무.

반드시 아래 JSON 형식으로만 최종 응답해야 합니다 (마크다운이나 백틱 \`\`\` 표기 금지):
{
  "analysisSteps": [
    "광원 분석: ...",
    "해부학 분석: ...",
    "텍스처 및 딥페이크 흔적: ..."
  ],
  "aiVerdict": "AI_GENERATED" | "LIKELY_AI" | "UNCERTAIN" | "LIKELY_REAL" | "AUTHENTIC",
  "aiConfidence": 0~100,
  "aiCategory": "Diffusion 모델" | "GAN 생성" | "딥페이크 합성" | "실제 사진" | "편집된 사진" | "불분명",
  "aiSignals": ["구체적인 의심 신호 1 (예: 손가락 구조 왜곡)", "의심 신호 2"],
  "aiReasoning": "analysisSteps 바탕으로 한 최종 판단 근거 (한국어 150자 이내)",
  "deepfakeVerdict": "DEEPFAKE" | "LIKELY_DEEPFAKE" | "UNCERTAIN" | "AUTHENTIC",
  "deepfakeConfidence": 0~100
}

중요: 확신이 있으면 AI_GENERATED(85~100) 또는 AUTHENTIC(0~15)으로 명확히 판정하세요. 모호할 때만 UNCERTAIN을 사용하세요.`;

const VIDEO_FRAME_PROMPT = `당신은 최고 수준의 시각 포렌식 및 딥페이크 탐지 전문 시스템입니다.
이 영상 프레임이 딥페이크(얼굴 합성/교체)인지 상세히 분석하세요.

[딥페이크 분석 지침]
결론을 내리기 전 다음 요소를 점검하세요:
1. 안면 경계선: 합성된 얼굴과 본래 목/머리카락 경계의 색상 불일치나 블러 자국.
2. 이목구비: 어색한 눈 깜빡임, 입 모양과 치아의 부자연스러운 왜곡.
3. 노이즈 분포: 얼굴 영역과 배경 영역의 노이즈 밀도 차이.

반드시 아래 JSON 형식으로만 최종 응답 (마크다운/백틱 없이):
{
  "analysisSteps": [
    "경계선 분석: ...",
    "이목구비 분석: ...",
    "종합 검토: ..."
  ],
  "aiVerdict": "AI_GENERATED" | "LIKELY_AI" | "UNCERTAIN" | "LIKELY_REAL" | "AUTHENTIC",
  "aiConfidence": 0~100,
  "aiCategory": "딥페이크" | "GAN 합성" | "Diffusion 합성" | "실제 영상" | "불분명",
  "aiSignals": ["발견된 구체적 신호 1", "발견된 구체적 신호 2"],
  "aiReasoning": "분석 근거 (한국어, 100자 이내)",
  "deepfakeVerdict": "DEEPFAKE" | "LIKELY_DEEPFAKE" | "UNCERTAIN" | "AUTHENTIC",
  "deepfakeConfidence": 0~100
}`;

/* ─── AI 판별 엔드포인트 ───────────────────────────────────── */
app.post('/api/ai-detect/image', async (req, res) => {
  const { imageBase64, mimeType = 'image/jpeg', isFrame = false } = req.body;
  if (!imageBase64) return res.status(400).json({ error: '이미지 데이터 필요' });
  if (!GEMINI_API_KEY) {
    return res.json(generateStubResult());
  }
  try {
    const result = await callGemini([
      { inlineData: { mimeType, data: imageBase64 } },
      { text: isFrame ? VIDEO_FRAME_PROMPT : IMAGE_PROMPT },
    ]);
    res.json(sanitizeResult(result));
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/ai-detect/status', (req, res) => {
  res.json({
    geminiConfigured: !!GEMINI_API_KEY,
    model: GEMINI_MODEL,
    freeQuota: '분당 15회, 일 1500회 (무료)',
    keyLink: 'https://aistudio.google.com/apikey',
  });
});

app.post('/api/ai-detect/configure', (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey || !apiKey.startsWith('AIza')) {
    return res.status(400).json({ error: '유효하지 않은 Gemini API 키' });
  }
  GEMINI_API_KEY = apiKey;
  process.env.GEMINI_API_KEY = apiKey;
  res.json({ ok: true, message: 'API 키 설정 완료' });
});

function sanitizeResult(r) {
  return {
    aiVerdict:          r.aiVerdict          || 'UNCERTAIN',
    aiConfidence:       Math.min(100, Math.max(0, Number(r.aiConfidence) ?? 50)),
    aiCategory:         r.aiCategory         || '불분명',
    aiSignals:          Array.isArray(r.aiSignals) ? r.aiSignals.slice(0, 4) : [],
    aiReasoning:        r.aiReasoning        || '',
    deepfakeVerdict:    r.deepfakeVerdict    || 'UNCERTAIN',
    deepfakeConfidence: Math.min(100, Math.max(0, Number(r.deepfakeConfidence) ?? 50)),
  };
}

function generateStubResult() {
  const v = Math.random();
  const aiConf = Math.round(v * 60 + 20);
  return {
    aiVerdict: aiConf > 68 ? 'LIKELY_AI' : aiConf > 40 ? 'UNCERTAIN' : 'LIKELY_REAL',
    aiConfidence: aiConf,
    aiCategory: '스텁 모드 (API 키 미설정)',
    aiSignals: ['Gemini API 키를 설정하면 실제 분석이 가능합니다'],
    aiReasoning: 'GEMINI_API_KEY 환경변수 또는 설정 화면에서 무료 API 키를 입력하면 실제 AI 판별이 활성화됩니다.',
    deepfakeVerdict: 'UNCERTAIN',
    deepfakeConfidence: aiConf,
  };
}


/* ─── In-memory DB ─────────────────────────────────────────── */
function hashPW(pw) { return createHash('sha256').update(pw + ':dg_salt_v1').digest('hex'); }
function uid()      { return randomBytes(8).toString('hex'); }

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

const DB = {
  users:          new Map([['admin', { id: 'admin', role: 'ADMIN', hash: hashPW(ADMIN_PASSWORD) }]]),
  sessions:       new Map(),
  analyses:       new Map(),
  analysesList:   [],
  communityPosts: new Map(),
  shareTokens:    new Map(),
  reports:        new Map(),
  notices:        new Map(),
  noticesList:    [],
  notifications:  [],
  comments:       new Map(),
};

(function seedDemo() {
  const seeds = [
    { h:'a1b2c3d4'.padEnd(64,'a'), verdict:'DEEPFAKE',   maxC:0.93, avgC:0.87, frames:240, name:'suspect_video.mp4', sz:12400000, type:'video', segs:[{startTime:2.5,endTime:8.1,avgConfidence:0.91}] },
    { h:'deadbeef'.padEnd(64,'d'), verdict:'SUSPICIOUS', maxC:0.52, avgC:0.47, frames:180, name:'unknown_clip.mov',  sz:8900000,  type:'video', segs:[] },
    { h:'cafebabe'.padEnd(64,'c'), verdict:'AUTHENTIC',  maxC:0.08, avgC:0.06, frames:320, name:'original.mp4',     sz:22000000, type:'video', segs:[] },
    { h:'img00001'.padEnd(64,'1'), verdict:'DEEPFAKE',   maxC:0.89, avgC:0.89, frames:1,   name:'photo_face.jpg',   sz:540000,   type:'image', segs:[] },
    { h:'url00001'.padEnd(64,'0'), verdict:'SUSPICIOUS', maxC:0.61, avgC:0.61, frames:96,  name:null, sz:null, type:'url', segs:[], sourceUrl:'https://example.com/post/123' },
  ];
  seeds.forEach((s, i) => {
    const rec = { id:uid(), hash:s.h, verdict:s.verdict, detectionType: s.type==='image' ? 'AI_GENERATED' : 'DEEPFAKE_MANIPULATED', maxConfidence:s.maxC, avgConfidence:s.avgC, totalFrames:s.frames, suspiciousSegments:s.segs, analyzedAt: new Date(Date.now() - i * 7200000).toISOString(), fileName:s.name, fileSize:s.sz, inputType:s.type, sourceUrl:s.sourceUrl||null };
    DB.analyses.set(s.h, rec);
    DB.analysesList.push(rec);
  });
  // 공지 시드
  const notice = { id: uid(), title: 'DeepGuard Pro 서비스 안내', content: '딥페이크·AI 생성 미디어 판별 서비스입니다. 판별 결과는 참고용이며 법적 효력이 없습니다. 부적절한 게시물은 신고 기능을 이용해 주세요.', pinned: true, createdAt: new Date().toISOString() };
  DB.notices.set(notice.id, notice);
  DB.noticesList.push(notice);

  const memos = ['유명인 사칭 딥페이크 영상입니다.', '소셜미디어에서 발견한 의심 영상.', 'AI 합성 이미지로 추정됩니다.'];
  [0,1,3].forEach((si, i) => {
    const a = DB.analysesList[si]; const id = uid();
    DB.communityPosts.set(id, { id, analysisId:a.id, verdict:a.verdict, avgConfidence:a.avgConfidence, maxConfidence:a.maxConfidence, totalFrames:a.totalFrames, suspiciousSegments:a.suspiciousSegments, fileName:a.fileName, inputType:a.inputType, sourceUrl:a.sourceUrl, hash:a.hash, memo:memos[i], postedAt: new Date(Date.now() - i * 7200000).toISOString(), flagCount:0, status:'ACTIVE', likes:0, likedBy:[], commentCount:0 });
  });
})();

function requireAuth(req, res, next) {
  const token = (req.headers.authorization||'').replace('Bearer ','');
  const sess = DB.sessions.get(token);
  if (!sess) return res.status(401).json({ error: '인증 필요' });
  req.session = sess; next();
}

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = DB.users.get(username);
  if (!user || user.hash !== hashPW(password)) return res.status(401).json({ error: '로그인 실패' });
  const token = randomBytes(32).toString('hex');
  DB.sessions.set(token, { userId: user.id, role: user.role });
  res.json({ token, role: user.role });
});

app.get('/api/analyses', (req, res) => {
  const { q='', verdict='', dateFrom='', dateTo='', page=1, pageSize=20 } = req.query;
  let list = [...DB.analysesList];
  if (q)        list = list.filter(r => r.fileName?.includes(q) || r.hash?.startsWith(q) || r.sourceUrl?.includes(q));
  if (verdict)  list = list.filter(r => r.verdict === verdict);
  if (dateFrom) list = list.filter(r => r.analyzedAt >= dateFrom);
  if (dateTo)   list = list.filter(r => r.analyzedAt <= dateTo + 'T23:59:59');
  const total = list.length, pg = Math.max(1, parseInt(page)), ps = Math.min(100, parseInt(pageSize));
  const items = list.slice((pg-1)*ps, pg*ps);
  res.json({ total, page: pg, pageSize: ps, items, data: items });
});

app.get('/api/analysis/hash/:hash', (req, res) => {
  const r = DB.analyses.get(req.params.hash);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

app.post('/api/analyses', (req, res) => {
  const { hash, verdict, detectionType, maxConfidence, avgConfidence, dfAvgConfidence, aiAvgConfidence, totalFrames, suspiciousSegments, scores, fileName, fileSize, inputType, sourceUrl, aiResult, mediaData } = req.body;
  if (!hash || !verdict) return res.status(400).json({ error: 'hash, verdict 필요' });
  const existing = DB.analyses.get(hash);
  if (existing) return res.json(existing);
  const rec = { id: uid(), hash, verdict, detectionType: detectionType||null, maxConfidence: maxConfidence||0, avgConfidence: avgConfidence||0, dfAvgConfidence: dfAvgConfidence||null, aiAvgConfidence: aiAvgConfidence||null, totalFrames: totalFrames||0, suspiciousSegments: suspiciousSegments||[], scores: scores||[], fileName: fileName||null, fileSize: fileSize||null, inputType: inputType||'video', sourceUrl: sourceUrl||null, aiResult: aiResult||null, mediaData: mediaData||null, analyzedAt: new Date().toISOString() };
  DB.analyses.set(hash, rec);
  DB.analysesList.unshift(rec);
  res.status(201).json(rec);
});

app.delete('/api/analyses/:id', requireAuth, (req, res) => {
  const rec = DB.analysesList.find(r => r.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  DB.analysesList = DB.analysesList.filter(r => r.id !== req.params.id);
  DB.analyses.delete(rec.hash);
  res.json({ ok: true });
});

/* 사용자 기록 삭제 (인증 불필요 — hash 기반, 본인이 hash 알면 삭제 가능) */
app.delete('/api/analyses/by-hash/:hash', (req, res) => {
  const rec = DB.analyses.get(req.params.hash);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  DB.analysesList = DB.analysesList.filter(r => r.hash !== req.params.hash);
  DB.analyses.delete(req.params.hash);
  res.json({ ok: true });
});

app.get('/api/community/posts', (req, res) => {
  const { page=1, pageSize=20, status='ACTIVE', verdict='' } = req.query;
  let list = [...DB.communityPosts.values()].filter(p => !status || p.status===status).filter(p => !verdict || p.verdict===verdict).sort((a,b)=>b.postedAt.localeCompare(a.postedAt));
  const total=list.length, pg=Math.max(1,parseInt(page)), ps=Math.min(50,parseInt(pageSize));
  res.json({ total, page:pg, pageSize:ps, items:list.slice((pg-1)*ps,pg*ps), data:list.slice((pg-1)*ps,pg*ps) });
});

app.post('/api/community/posts', (req, res) => {
  const { analysisId, verdict, avgConfidence, maxConfidence, totalFrames, suspiciousSegments, scores, fileName, inputType, sourceUrl, hash, memo, mediaData } = req.body;
  if (!verdict) return res.status(400).json({ error: 'verdict 필요' });
  const id = uid();
  const shareToken = randomBytes(16).toString('hex');
  const editToken  = randomBytes(20).toString('hex');
  const post = { id, analysisId, verdict, avgConfidence, maxConfidence, totalFrames, suspiciousSegments:suspiciousSegments||[], scores:scores||[], fileName, inputType, sourceUrl, hash, memo: (memo||'').slice(0,500), mediaData: mediaData||null, shareToken, editToken, postedAt: new Date().toISOString(), flagCount:0, status:'ACTIVE', likes:0, likedBy:[], commentCount:0 };
  DB.communityPosts.set(id, post);
  DB.shareTokens.set(shareToken, id);
  res.status(201).json(post);
});

/* ─── 좋아요 토글 ─────────────────────────────────────────── */
app.post('/api/community/posts/:id/like', (req, res) => {
  const p = DB.communityPosts.get(req.params.id);
  if (!p || p.status !== 'ACTIVE') return res.status(404).json({ error: 'Not found' });
  const { clientId } = req.body || {};
  if (!clientId) return res.status(400).json({ error: 'clientId 필요' });
  p.likedBy = p.likedBy || [];
  const idx = p.likedBy.indexOf(clientId);
  if (idx === -1) { p.likedBy.push(clientId); p.likes = (p.likes||0) + 1; }
  else            { p.likedBy.splice(idx, 1);  p.likes = Math.max(0, (p.likes||0) - 1); }
  res.json({ likes: p.likes, liked: idx === -1 });
});

/* ─── 댓글 ───────────────────────────────────────────────── */
app.get('/api/community/posts/:id/comments', (req, res) => {
  const all = [...DB.comments.values()].filter(c => c.postId === req.params.id && c.status === 'ACTIVE').sort((a,b) => a.createdAt.localeCompare(b.createdAt));
  res.json({ items: all, total: all.length });
});
app.post('/api/community/posts/:id/comments', (req, res) => {
  const p = DB.communityPosts.get(req.params.id);
  if (!p || p.status !== 'ACTIVE') return res.status(404).json({ error: 'Not found' });
  const { text, nickname, editToken: cToken } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: '댓글 내용 필요' });
  const id = uid();
  const editToken = cToken || randomBytes(16).toString('hex');
  const comment = { id, postId: req.params.id, text: text.trim().slice(0,300), nickname: (nickname||'익명').slice(0,20), editToken, createdAt: new Date().toISOString(), status: 'ACTIVE' };
  DB.comments.set(id, comment);
  p.commentCount = (p.commentCount||0) + 1;
  res.status(201).json(comment);
});
app.delete('/api/community/posts/:postId/comments/:id', (req, res) => {
  const c = DB.comments.get(req.params.id);
  if (!c || c.postId !== req.params.postId) return res.status(404).json({ error: 'Not found' });
  const { editToken } = req.body || {};
  if (c.editToken && c.editToken !== editToken) return res.status(403).json({ error: '삭제 권한 없음' });
  c.status = 'DELETED';
  const p = DB.communityPosts.get(req.params.postId);
  if (p) p.commentCount = Math.max(0, (p.commentCount||0) - 1);
  res.json({ ok: true });
});

/* ─── 본인 게시물 삭제 (editToken) ─────────────────────────── */
app.delete('/api/community/posts/:id', (req, res) => {
  const p = DB.communityPosts.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const auth = (req.headers.authorization||'').replace('Bearer ','');
  const isAdmin = DB.sessions.has(auth);
  const { editToken } = req.body || {};
  if (!isAdmin && p.editToken && p.editToken !== editToken) return res.status(403).json({ error: '삭제 권한 없음' });
  p.status = 'DELETED';
  res.json({ ok: true });
});

app.get('/api/share/:token', (req, res) => {
  const postId = DB.shareTokens.get(req.params.token);
  if (!postId) return res.status(404).json({ error: '유효하지 않은 공유 링크입니다' });
  const post = DB.communityPosts.get(postId);
  if (!post || post.status === 'DELETED') return res.status(404).json({ error: '삭제된 게시물입니다' });
  res.json(post);
});

app.post('/api/community/posts/:id/flag', (req, res) => {
  const p = DB.communityPosts.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const { reason = 'other', detail = '' } = req.body || {};
  p.flagCount = (p.flagCount || 0) + 1;
  if (p.flagCount >= 5) p.status = 'FLAGGED';

  // 관리자 알림 생성
  const notif = {
    id: uid(),
    type: 'FLAG',
    postId: p.id,
    postVerdict: p.verdict,
    postFileName: p.fileName || p.sourceUrl || '알 수 없음',
    reason,
    detail: detail.slice(0, 200),
    flagCount: p.flagCount,
    createdAt: new Date().toISOString(),
    read: false,
  };
  DB.notifications.unshift(notif);
  if (DB.notifications.length > 200) DB.notifications.pop(); // 최대 200개 유지

  res.json({ ok: true, flagCount: p.flagCount });
});

/* ─── 관리자 알림 API ──────────────────────────────────────── */
app.get('/api/admin/notifications', requireAuth, (req, res) => {
  const unreadOnly = req.query.unread === 'true';
  const list = unreadOnly ? DB.notifications.filter(n => !n.read) : DB.notifications;
  res.json({ total: list.length, unreadCount: DB.notifications.filter(n=>!n.read).length, items: list.slice(0, 50) });
});

app.patch('/api/admin/notifications/:id/read', requireAuth, (req, res) => {
  const n = DB.notifications.find(n => n.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'Not found' });
  n.read = true;
  res.json({ ok: true });
});

app.post('/api/admin/notifications/read-all', requireAuth, (req, res) => {
  DB.notifications.forEach(n => { n.read = true; });
  res.json({ ok: true });
});

app.get('/api/admin/reports', requireAuth, (req, res) => {
  const { status='PENDING', page=1, pageSize=20 } = req.query;
  const list = [...DB.communityPosts.values()]
    .filter(p => status==='ALL' || p.status===status)
    .sort((a,b)=>b.postedAt.localeCompare(a.postedAt));
  const pg=Math.max(1,parseInt(page)), ps=Math.min(50,parseInt(pageSize));
  const items = list.slice((pg-1)*ps, pg*ps).map(p => ({ ...p, createdAt: p.createdAt || p.postedAt }));
  res.json({ total:list.length, page:pg, pageSize:ps, items, data: items });
});

app.patch('/api/admin/reports/:id', requireAuth, (req, res) => {
  const p = DB.communityPosts.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (req.body.status) p.status = req.body.status;
  res.json(p);
});

/* 관리자 게시물 강제 삭제 */
app.delete('/api/admin/community/posts/:id', requireAuth, (req, res) => {
  const p = DB.communityPosts.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.status = 'DELETED';
  // 관련 알림 정리
  DB.notifications.filter(n => n.postId === req.params.id).forEach(n => { n.postDeleted = true; });
  res.json({ ok: true });
});

app.delete('/api/admin/reports/:id', requireAuth, (req, res) => {
  if (!DB.communityPosts.has(req.params.id)) return res.status(404).json({ error: 'Not found' });
  DB.communityPosts.delete(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/stats', requireAuth, (req, res) => {
  const analyses = DB.analysesList;
  res.json({ totalAnalyses: analyses.length, fakeCount: analyses.filter(r=>r.verdict==='FAKE'||r.verdict==='DEEPFAKE').length, suspiciousCount: analyses.filter(r=>r.verdict==='SUSPICIOUS').length, authenticCount: analyses.filter(r=>r.verdict==='AUTHENTIC').length, communityPosts: DB.communityPosts.size, geminiConfigured: !!GEMINI_API_KEY });
});

app.get('/api/analysis/search', requireAuth, (req, res) => {
  const { q='', verdict='', dateFrom='', dateTo='', page=1, pageSize=15 } = req.query;
  let list = [...DB.analysesList];
  if (q)        list = list.filter(r => r.fileName?.includes(q) || r.hash?.startsWith(q) || r.sourceUrl?.includes(q));
  if (verdict)  list = list.filter(r => r.verdict === verdict);
  if (dateFrom) list = list.filter(r => r.analyzedAt >= dateFrom);
  if (dateTo)   list = list.filter(r => r.analyzedAt <= dateTo + 'T23:59:59');
  const total = list.length, pg = Math.max(1, parseInt(page)), ps = Math.min(100, parseInt(pageSize));
  const items = list.slice((pg-1)*ps, pg*ps);
  res.json({ total, page: pg, pageSize: ps, items, data: items });
});

app.get('/api/reports/community', (req, res) => {
  const { page=1, pageSize=10 } = req.query;
  let list = [...DB.communityPosts.values()].filter(p => p.status === 'ACTIVE').sort((a,b) => b.postedAt.localeCompare(a.postedAt));
  const total = list.length, pg = Math.max(1, parseInt(page)), ps = Math.min(50, parseInt(pageSize));
  const items = list.slice((pg-1)*ps, pg*ps).map(p => ({ ...p, title: p.fileName || p.sourceUrl || '익명 신고', description: p.memo || '', confidence: p.avgConfidence, createdAt: p.postedAt }));
  res.json({ total, page: pg, pageSize: ps, items, data: items });
});

app.post('/api/reports', (req, res) => {
  const { hash, title, description, contactEmail, victimConsent } = req.body;
  const id = uid();
  const rec = DB.analyses.get(hash);
  const report = { id, hash: hash||null, title: title||'신고', description: description||'', contactEmail: contactEmail||null, victimConsent: !!victimConsent, status: 'PENDING', verdict: rec?.verdict||null, avgConfidence: rec?.avgConfidence||null, fileName: rec?.fileName||null, inputType: rec?.inputType||null, createdAt: new Date().toISOString() };
  DB.reports.set(id, report);
  res.status(201).json(report);
});

/* ─── URL 이미지 프록시 (cross-origin ImageBitmap 오류 방지) ─── */
app.get('/api/url-image-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url 필요' });
  try {
    new URL(url); // validate
  } catch { return res.status(400).json({ error: '유효하지 않은 URL' }); }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DeepGuardBot/1.0)' },
    });
    clearTimeout(timer);
    const ct = resp.headers.get('content-type') || 'image/jpeg';
    if (!ct.startsWith('image/')) return res.status(415).json({ error: '이미지가 아닙니다' });
    const buf = Buffer.from(await resp.arrayBuffer());
    const b64 = buf.toString('base64');
    res.json({ base64: b64, mimeType: ct.split(';')[0].trim() });
  } catch (e) {
    res.status(502).json({ error: '이미지 fetch 실패: ' + e.message });
  }
});

app.get('/api/url-meta', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url 필요' });
  try {
    const u = new URL(url);
    const ext = u.pathname.split('.').pop().toLowerCase();
    const videoExts = ['mp4','webm','mov','avi','mkv'];
    const imageExts = ['jpg','jpeg','png','gif','webp','bmp'];
    if (videoExts.includes(ext)) return res.json({ mediaUrl: url, mediaType: 'video', title: u.pathname.split('/').pop() });
    if (imageExts.includes(ext)) return res.json({ mediaUrl: url, mediaType: 'image', title: u.pathname.split('/').pop() });

    // Try fetching HTML to extract og:image / og:video / twitter:image
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DeepGuardBot/1.0)' }
      });
      clearTimeout(timer);
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('video/')) return res.json({ mediaUrl: url, mediaType: 'video', title: u.hostname });
      if (ct.includes('image/')) return res.json({ mediaUrl: url, mediaType: 'image', title: u.hostname });

      const html = await resp.text();
      const getMeta = (prop) => {
        const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
                || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
        return m ? m[1] : null;
      };
      const title = getMeta('og:title') || getMeta('twitter:title') || (html.match(/<title[^>]*>([^<]+)/i)||[])[1] || u.hostname;
      const ogVideo = getMeta('og:video') || getMeta('og:video:url');
      const ogImage = getMeta('og:image') || getMeta('twitter:image') || getMeta('og:image:url');

      if (ogVideo) return res.json({ mediaUrl: ogVideo, mediaType: 'video', title: title.trim() });
      if (ogImage) return res.json({ mediaUrl: ogImage, mediaType: 'image', title: title.trim(), isArticleThumb: true });
      return res.json({ mediaUrl: null, mediaType: null, title: title?.trim() || null, articleUrl: url });
    } catch(fetchErr) {
      return res.json({ mediaUrl: null, mediaType: null, title: u.hostname });
    }
  } catch(e) { res.status(400).json({ error: '유효하지 않은 URL' }); }
});

/* ─── 공지사항 API ──────────────────────────────────────────── */
app.get('/api/notices', (req, res) => {
  const list = [...DB.noticesList].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
  res.json({ items: list, total: list.length });
});

app.post('/api/admin/notices', requireAuth, (req, res) => {
  const { title, content, pinned = false } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title, content 필요' });
  const notice = { id: uid(), title: title.slice(0, 100), content: content.slice(0, 2000), pinned: !!pinned, createdAt: new Date().toISOString() };
  DB.notices.set(notice.id, notice);
  DB.noticesList.unshift(notice);
  res.status(201).json(notice);
});

app.patch('/api/admin/notices/:id', requireAuth, (req, res) => {
  const n = DB.notices.get(req.params.id);
  if (!n) return res.status(404).json({ error: 'Not found' });
  if (req.body.title   !== undefined) n.title   = req.body.title.slice(0, 100);
  if (req.body.content !== undefined) n.content = req.body.content.slice(0, 2000);
  if (req.body.pinned  !== undefined) n.pinned  = !!req.body.pinned;
  res.json(n);
});

app.delete('/api/admin/notices/:id', requireAuth, (req, res) => {
  if (!DB.notices.has(req.params.id)) return res.status(404).json({ error: 'Not found' });
  DB.notices.delete(req.params.id);
  DB.noticesList = DB.noticesList.filter(n => n.id !== req.params.id);
  res.json({ ok: true });
});

/* ─── URL 텍스트 분석: AI 작성 구간 하이라이트 + 요약 ─────────── */
app.post('/api/url-text-analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url 필요' });

  if (!GEMINI_API_KEY) {
    return res.json({
      summary: '(Gemini API 키 미설정 — 스텁 모드) 이 텍스트는 AI 분석 없이 반환됩니다.',
      highlights: [],
      aiWrittenRatio: 0,
      articleText: '',
      title: '',
    });
  }

  try {
    // 페이지 HTML 가져오기
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DeepGuardBot/1.0)' },
    });
    clearTimeout(timer);
    const html = await resp.text();

    // 제목 추출
    const titleMatch = html.match(/<title[^>]*>([^<]+)/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    // 본문 텍스트 추출 (p 태그 기반 간이 추출)
    const paragraphs = [];
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = pRegex.exec(html)) !== null) {
      const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (text.length > 40) paragraphs.push(text);
    }
    const articleText = paragraphs.slice(0, 60).join('\n\n');

    if (!articleText || articleText.length < 100) {
      return res.json({ summary: '본문 텍스트를 추출하지 못했습니다.', highlights: [], aiWrittenRatio: 0, articleText: '', title });
    }

    // Gemini로 AI 작성 구간 분석 + 요약
    const prompt = `다음은 웹 페이지에서 추출한 본문입니다.

[본문]
${articleText.slice(0, 6000)}

다음 두 가지를 JSON으로만 응답하세요 (다른 텍스트 없이 JSON만):
{
  "summary": "본문의 핵심 내용을 3~5문장으로 한국어 요약",
  "aiWrittenRatio": 0~100 사이 숫자 (AI가 작성했을 가능성 % 전체 글 기준),
  "highlights": [
    {
      "text": "AI가 작성했다고 의심되는 정확한 문장 또는 구절 (원문 그대로)",
      "reason": "AI 작성 의심 이유 (간략히 한국어로)",
      "confidence": 0~100
    }
  ]
}

highlights는 AI 특유의 패턴(지나치게 매끄러운 문체, 중립적 나열, 과도한 접속사, 반복 구조 등)이 보이는 구절만 최대 8개 선정하세요. 없으면 빈 배열로 하세요.`;

    const gemResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 2048 } }),
    });

    const gemData = await gemResp.json();
    const rawText = gemData?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const clean = rawText.replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(clean); } catch { parsed = { summary: rawText.slice(0, 300), highlights: [], aiWrittenRatio: 0 }; }

    res.json({
      summary: parsed.summary || '',
      highlights: (parsed.highlights || []).slice(0, 8),
      aiWrittenRatio: parsed.aiWrittenRatio ?? 0,
      articleText: articleText.slice(0, 8000),
      title,
    });
  } catch (e) {
    res.status(500).json({ error: 'URL 텍스트 분석 실패: ' + e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🛡  DeepGuard Pro v4 — http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) console.log(`⚠️  GEMINI_API_KEY 미설정 → 스텁 모드\n`);
});
