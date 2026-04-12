# DeepGuard Pro

**딥페이크·AI 생성 이미지 실시간 판별 플랫폼**

영상·이미지·URL을 브라우저에서 직접 분석해 딥페이크 합성 및 AI 생성 여부를 이중 판별합니다.  
파일은 서버로 전송되지 않으며, Google Gemini API와 로컬 픽셀 포렌식을 병렬로 실행합니다.

---

## 기술 스택

| 레이어      | 기술                                                      |
| ----------- | --------------------------------------------------------- |
| Frontend    | Vanilla JS (ES6+), Web Workers, Canvas API, CSS Variables |
| Backend     | Node.js 18+, Express 4                                    |
| AI 판별     | Google Gemini 1.5 Flash (Vision REST)                     |
| 로컬 포렌식 | Web Worker 내 Canvas 픽셀 분석 (CFA·GAN·조명·기하학)      |
| 상태 관리   | 자체 구현 Observable Store (Observer 패턴)                |
| 저장소      | In-memory Map (서버 재시작 시 초기화; 파일 DB 전환 가능)  |
| 배포        | `node server.js` — 단일 프로세스, 정적 파일 서빙 포함     |

---

## 주요 기능 및 구현 상세

### 1. 하이브리드 이중 판별 엔진

**핵심 설계:** 로컬 휴리스틱 포렌식과 Gemini Vision API 분석을 병렬로 실행하고, 두 결과를 가중 평균으로 결합합니다.

```
[브라우저]
  ├─ Canvas → ImageData → Web Worker (js/analyzer.worker.js)
  │     ├─ CFA 노이즈 매핑          analyzeCFANoise()
  │     ├─ 조명 비일관성 분석        analyzeLighting()
  │     ├─ GAN 픽셀 패턴 검사       analyzeGANPixels()
  │     ├─ 이진 파일 데이터 분석     analyzeFileDataProxy()
  │     └─ 기하학 노이즈 매핑        analyzeGeometricNoise()
  │
  └─ Base64 프레임 → POST /api/ai-detect/image
        └─ Gemini 1.5 Flash (Vision)
              Chain-of-Thought 프롬프트
              → { aiVerdict, deepfakeVerdict, aiConfidence, deepfakeConfidence, aiSignals }
```

**결과 결합 공식 (`analyzer.worker.js: blend`):**

```js
// Gemini 결과가 있으면 92% 반영, 로컬 분석은 8% 보정용으로 유지
return {
  df:
    Math.min(0.97, gemini.deepfakeConfidence / 100) * 0.92 +
    heuristic.df * 0.08,
  ai: Math.min(0.97, gemini.aiConfidence / 100) * 0.92 + heuristic.ai * 0.08,
};
```

**문제 & 해결 — Gemini 쿼터 소진:**
영상 분석 시 프레임 단위로 Gemini를 직렬 호출하면 무료 한도(분당 15회)가 즉시 소진됩니다.  
→ `SAMPLE_RATE = 6`으로 6프레임당 1회만 캡처하고, 배치 내 대표 프레임 최대 2개에만 API 호출.  
로컬 Worker 결과로 실시간 UI를 먼저 갱신하고 Gemini는 비동기로 보정합니다.

---

### 2. Web Worker 기반 비차단 포렌식

**문제:** CFA·GAN 노이즈 계산은 CPU-bound 작업입니다. 메인 스레드에서 실행 시 Canvas 조작과 UI 갱신이 동시에 블록됩니다.

**해결:** `analyzer.worker.js`를 별도 스레드로 분리. ImageBitmap을 Transferable로 전달해 복사 비용을 제거합니다.

```js
// js/analysis.js — 배치 전송 (zero-copy)
worker.postMessage(
  { type: 'ANALYZE', payload: { frames: batch } },
  batch.map(f => f.imageBitmap)   // Transfer ownership
);

// Worker → 메인스레드 실시간 결과 스트리밍
postMessage({ type: 'FRAME_RESULT', payload: {
  confidence, dfConfidence, aiConfidence, smoothedConfidence, progress, ...
}});
```

**5개 포렌식 모듈 (192×192px 처리):**

| 모듈             | 탐지 원리                                                        |
| ---------------- | ---------------------------------------------------------------- |
| CFA 노이즈 매핑  | Bayer 패턴 잔차, R·G·B 채널 간 교차 상관 분석                    |
| 조명 메타데이터  | 16분할 밝기 히트맵으로 광원 방향 불일치 및 하이라이트 위치 검사  |
| GAN 픽셀 검사    | Even/Odd 픽셀 분포 편향, 체커보드 아티팩트, 방사형 밝기 엔트로피 |
| 파일 데이터 분석 | 비네팅 비율, 포아송 노이즈 분포, 코너-중앙 분산비                |
| 기하학 노이즈    | 에지 방향 엔트로피, 수평선 연속성, 블록 평활도                   |

---

### 3. SHA-256 중복 탐지 & 캐싱

동일 파일을 재업로드하면 API 호출 없이 캐시된 결과를 즉시 반환합니다.

```js
// js/core.js — computeSHA256
// 파일 전체를 읽지 않고 name|size|lastModified 문자열 해싱 (메모리 효율적)
const fingerprint = `${file.name}|${file.size}|${file.lastModified}`;
const hashBuf = await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(fingerprint),
);
```

```js
// server.js
// GET /api/analysis/hash/:hash — 캐시 히트 시 즉시 반환
const existing = DB.analyses.get(hash);
if (existing) return res.json(existing);

// POST /api/analyses — 중복 저장 방지
if (DB.analyses.get(hash)) return res.json(existing);
```

---

### 4. Gemini Chain-of-Thought 프롬프트

단순 Yes/No 판정 대신 4단계 추론을 강제해 근거 기반 판별을 수행합니다.

```
STEP 1 — 조명 및 반사 분석
  눈동자 하이라이트 비대칭, 그림자 방향, 피부 반사 불일치

STEP 2 — 해부학적 구조 검사
  손가락 개수·형태, 치아 배열, 귀 구조 이상

STEP 3 — 텍스처·경계 융합 이상
  플라스틱성 피부 질감, 배경-피사체 경계 블러

STEP 4 — 딥페이크 특화 신호
  턱선·헤어라인 블러, 해상도 저하 구간, GAN 아티팩트

→ JSON 응답: { aiVerdict, aiConfidence, aiCategory, aiSignals[], aiReasoning,
               deepfakeVerdict, deepfakeConfidence }
```

**문제 & 해결 — JSON 파싱 오류:**
`responseMimeType: 'application/json'` 파라미터 사용 시 일부 Gemini 모델 버전에서 500 오류 발생.  
→ 파라미터 제거 후 응답 텍스트에서 마크다운 코드블록을 strip하고 파싱합니다.

````js
// server.js: callGemini()
text = text
  .replace(/^```(?:json)?\s*/i, "")
  .replace(/\s*```$/m, "")
  .trim();
return JSON.parse(text);
````

---

### 5. URL 분석 — og:image 자동 추출

직접 미디어 URL 외에 뉴스 기사·SNS 게시물 URL을 입력하면 서버가 HTML을 페치해  
`og:image` / `og:video` / `twitter:image` 메타태그에서 미디어를 추출합니다.

```js
// server.js: GET /api/url-meta
const getMeta = (prop) =>
  html.match(
    new RegExp(
      `<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`,
      "i",
    ),
  )?.[1];

const ogVideo = getMeta("og:video") || getMeta("og:video:url");
const ogImage = getMeta("og:image") || getMeta("twitter:image");

if (ogVideo) return res.json({ mediaUrl: ogVideo, mediaType: "video", title });
if (ogImage)
  return res.json({
    mediaUrl: ogImage,
    mediaType: "image",
    title,
    isArticleThumb: true,
  });
```

**지원 입력 유형:**

- 직접 미디어 파일 URL (`.mp4`, `.jpg` 등)
- 뉴스 기사·블로그 URL → og:image 추출 후 판별 ("기사 썸네일 이미지"로 표시)
- SNS 게시물 URL → og:video / og:image 추출

---

### 6. 분석 결과 저장 & 공유 (미디어 첨부)

분석 완료 시 `captureMediaData()`로 분석 대상 미디어를 Canvas에서 JPEG base64로 캡처해 레코드에 포함합니다. 공유 링크에서 이미지·판별 결과·의심 구간을 모두 확인할 수 있습니다.

```js
// js/analysis.js — captureMediaData()
const canvas = document.createElement("canvas");
const scale = Math.min(1, 480 / Math.max(w, h)); // 최대 480px로 리사이즈
canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
return canvas.toDataURL("image/jpeg", 0.82);
```

**저장·공유 흐름:**

```
분석 완료
  └─ saveAnalysis()          → POST /api/analyses { verdict, scores, mediaData, ... }
  └─ openShareModal()
       └─ captureMediaData()
       └─ POST /api/community/posts { mediaData, memo, ... }
            └─ shareToken 발급 → /share.html?token=xxxx
                 판별 미디어 + 결과 + 의심 구간 렌더링
```

---

### 7. 관리자 대시보드

- 랜덤 32바이트 토큰 세션, `requireAuth` 미들웨어로 보호된 엔드포인트
- 5회 이상 신고된 게시물 자동 `FLAGGED` 상태 전환
- `/api/admin/stats`: 총 분석 수, 딥페이크 비율, Gemini 연결 상태 실시간 조회
- 분석 기록 삭제 / 커뮤니티 게시물 승인·거부 CRUD

---

### 8. 환경변수 기반 비밀값 관리

**문제:** 초기 버전에서 관리자 비밀번호와 Gemini API 키가 소스코드에 하드코딩되어 있었습니다.  
**해결:** 모든 비밀값을 `process.env`로 이관하고 `.env.example`을 제공합니다.  
런타임 설정 UI도 병행 제공 — Gemini 설정 모달에서 입력한 키가 `POST /api/ai-detect/configure`로 서버 메모리에 즉시 반영됩니다.

```js
// server.js
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";
```

---

## 파일 구조

```
deepguard-pro/
├── index.html            # 메인 분석 페이지 (영상·이미지·URL 입력)
├── history.html          # 분석 기록 목록 + 필터·검색·페이지네이션
├── community.html        # 커뮤니티 공유 피드 (판별 미디어 썸네일 포함)
├── share.html            # 공유 링크 페이지 (미디어 + 판별 결과 + 의심 구간)
├── admin-login.html      # 관리자 로그인
├── admin.html            # 관리자 대시보드 (통계, 모더레이션)
├── server.js             # Express 백엔드 + Gemini 프록시 + URL 메타 추출
├── package.json
├── .env.example          # 환경변수 템플릿
├── .gitignore
├── css/
│   └── main.css          # 디자인 시스템 (CSS Variables, Forensic Intelligence 테마)
└── js/
    ├── core.js           # Observable Store, API 클라이언트, Toast, Modal, SHA-256
    ├── analyzer.worker.js # Web Worker: 5개 픽셀 포렌식 모듈 (CFA·GAN·조명·기하학)
    ├── analysis.js       # 분석 UI 컨트롤러 (프레임 캡처, 결과 렌더링, 공유)
    ├── admin.js          # 관리자 UI 컨트롤러
    └── gemini-setup.js   # Gemini API 키 설정 모달
```

<!-- # 2. 환경변수 설정
cp .env.example .env -->

## <!-- # .env 파일에서 GEMINI_API_KEY, ADMIN_PASSWORD 입력 -->

## 빠른 시작

```bash
# 1. 의존성 설치
npm install

# 2. 실행
npm start        # http://localhost:3001
npm run dev      # --watch 모드 (파일 변경 시 자동 재시작)
```

Gemini API 키 없이 실행 시 스텁 모드(랜덤 결과)로 동작합니다.  
무료 키 발급: https://aistudio.google.com/apikey 발급 key 등록 후 테스트 (local)

---

## API 엔드포인트

| 메서드 | 경로                            | 인증 | 설명                               |
| ------ | ------------------------------- | ---- | ---------------------------------- |
| GET    | `/api/ai-detect/status`         | —    | Gemini 연결 상태                   |
| POST   | `/api/ai-detect/configure`      | —    | API 키 런타임 설정                 |
| POST   | `/api/ai-detect/image`          | —    | 이미지/프레임 AI 판별              |
| GET    | `/api/url-meta?url=…`           | —    | URL에서 미디어/og:image 추출       |
| GET    | `/api/analyses`                 | —    | 분석 기록 목록 (페이지네이션·필터) |
| GET    | `/api/analysis/hash/:hash`      | —    | 해시로 캐시 조회                   |
| POST   | `/api/analyses`                 | —    | 분석 결과 저장 (mediaData 포함)    |
| DELETE | `/api/analyses/:id`             | ✅   | 분석 기록 삭제                     |
| GET    | `/api/community/posts`          | —    | 커뮤니티 게시물 목록               |
| POST   | `/api/community/posts`          | —    | 게시물 작성 (판별 미디어 첨부)     |
| POST   | `/api/community/posts/:id/flag` | —    | 게시물 신고                        |
| GET    | `/api/share/:token`             | —    | 공유 링크 조회                     |
| GET    | `/api/admin/reports`            | ✅   | 신고 목록                          |
| PATCH  | `/api/admin/reports/:id`        | ✅   | 신고 상태 변경                     |
| DELETE | `/api/admin/reports/:id`        | ✅   | 신고 삭제                          |
| GET    | `/api/admin/stats`              | ✅   | 대시보드 통계                      |
| POST   | `/api/auth/login`               | —    | 관리자 로그인                      |

✅ = `Authorization: Bearer <token>` 헤더 필요

---

## Gemini 무료 한도

| 항목      | 한도       |
| --------- | ---------- |
| 분당 요청 | 15회       |
| 일일 요청 | 1,500회    |
| 월간 토큰 | 100만 토큰 |
| 비용      | 무료       |

---

## 관리자 계정

- **ID:** `admin`
- **PW:** `.env`의 `ADMIN_PASSWORD` (미설정 시 기본값 `admin1234`)

> 운영 배포 시 반드시 강력한 비밀번호로 교체하세요.
