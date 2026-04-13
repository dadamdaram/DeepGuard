# DeepGuard Pro

**딥페이크·AI 생성 이미지 실시간 판별 플랫폼**

파일은 서버로 전송되지 않고 브라우저에서 직접 처리됩니다.  
Google Gemini Vision AI와 로컬 픽셀 포렌식을 병렬 실행해 이중으로 판별합니다.

---

## 기술 스택

| 레이어          | 기술                                                              |
| --------------- | ----------------------------------------------------------------- |
| **Frontend**    | **HTML5** (Canvas, File, Drag & Drop, Video API), Vanilla JS ES6+ |
| **멀티스레딩**  | Web Worker API                                                    |
| **암호화**      | Web Crypto API (SHA-256)                                          |
| **Backend**     | Node.js 18+, Express 4                                            |
| **AI 판별**     | Google Gemini 2.0 Flash Vision (REST, 무료 분당 15회)             |
| **로컬 포렌식** | Canvas 픽셀 분석 (CFA·GAN·조명·기하학)                            |
| **상태 관리**   | 자체 구현 Observable Store                                        |
| **저장소**      | In-memory Map (서버 재시작 시 초기화)                             |

---

## 실행

```bash
npm install

# .env 생성
# GEMINI_API_KEY=AIza...
# ADMIN_PASSWORD=yourpw
# PORT=3001

node server.js
# → http://localhost:3001

후 api key를 로컬에 입력
```

---

## 파일 구조

```
deepguard/
├── index.html              # 메인 분석 페이지
├── history.html            # 분석 기록
├── community.html          # 커뮤니티 공유
├── share.html              # 공유 링크 뷰어
├── admin.html              # 관리자 대시보드
├── admin-login.html        # 관리자 로그인
├── env.js                  # 클라이언트 환경 변수
├── server.js               # Express 서버 (API + 정적 파일 서빙)
├── css/
│   └── main.css            # 디자인 토큰 기반 CSS
└── js/
    ├── core.js             # Store, API 클라이언트, Toast, Modal
    ├── analysis.js         # 분석 엔진 UI 컨트롤러
    ├── analyzer.worker.js  # Web Worker — 픽셀 포렌식 실행
    ├── admin.js            # 관리자 패널 로직
    └── gemini-setup.js     # Gemini API 키 설정 UI
```

---

## 전체 플로우

```
사용자 입력 (파일 / 이미지 / URL)
         │
         ▼
 ① 해시 생성 (SHA-256)
    └─ 서버에 캐시 여부 확인
       ├─ 캐시 히트 → 즉시 이전 결과 반환     ──────────────────────┐
       └─ 캐시 없음 → 분석 시작

         ▼
 ② createImageBitmap() — 픽셀 디코딩
    └─ 영상: requestVideoFrameCallback()으로 프레임 단위 추출
    └─ 이미지: File 객체 → ImageBitmap 변환
    └─ URL: 서버 프록시(/api/url-image-proxy)로 CORS 우회
         │
         ├────────────────────────────────────────┐
         ▼                                        ▼
 ③ Web Worker (별도 스레드)             ④ Gemini Vision API
    픽셀 포렌식                             (서버 경유)
    ├─ CFA 노이즈 매핑                   Chain-of-Thought 프롬프트
    ├─ 조명 비일관성                     → aiVerdict
    ├─ GAN 체커보드 아티팩트             → deepfakeVerdict
    ├─ 비네팅 분석                       → aiConfidence
    └─ 기하학 노이즈                     → deepfakeConfidence
         │                                        │
         └────────────────┬───────────────────────┘
                          ▼
                ⑤ 점수 결합
                   final = Gemini × 0.92 + Local × 0.08
                           │
                           ▼
                ⑥ 판정 & 서버 저장 ◄──────────────────────────── ┘
                   DEEPFAKE / SUSPICIOUS / AUTHENTIC
```

점수화 가중치?

```bash
“Gemini의 의미 기반 판단이 전체 정확도에 더 크게 기여한다고 판단해서
가중치를 높게 설정, 포렌식 분석은 노이즈가 있지만 중요한 보조 신호라
낮은 비율로 결합한 경험적(Heuristic) 가중치

#Gemini (0.92)
장점: 전체 맥락 이해(얼굴, 손, 배경), 딥페이크 특징 잘 잡음, 최신 생성 모델 패턴 반영
단점: 정확도 문제, 물리적 근거 부족

#Local 포렌식 (0.08)
장점: 물리적 특징, 확실한 증거(CFA/노이즈/조명)
단점: 노이즈 많음, 이미지 압축/리사이즈 취약, 단독 판단 불안정

🧠 Analysis Pipeline

Web Worker (Pixel Forensics):

브라우저의 메인 스레드와 분리된 Web Worker에서
이미지의 물리적·통계적 특성을 분석하여 AI 생성 여부를 판단

(1) CFA Noise Mapping (Color Filter Array Noise)
→ 카메라 센서 특유의 노이즈 패턴 존재 여부 분석 - 패턴 X or 불규칙?

(실제 카메라 센서는 RGB 필터 배열(Bayer Pattern)을 통해 이미지 생성.
이 과정에서 일정한 노이즈 패턴 발생)

(2) 조명 비일관성(Lighting Inconsistency)
→ 광원 방향, 그림자 등의 물리적 일관성 검증 - 빛의 방향 일관성 X?

(3) GAN Checkerboard Artifacts
→ 생성 모델에서 발생하는 격자 패턴 탐지 - 생성 모델 특유의 패턴 O?
(업샘플링 과정(ConvTranspose)에서 생기는 대표적 인공 흔적)

(4) Vignetting Analysis
→ 렌즈 가장자리 어두워짐의 자연스러움 평가 - 균일함 or 부자연스러움?

(5) Geometric Distortion
→ 객체 구조(얼굴, 손, 직선 등)의 형태, 비율 구조의 일관성 & 왜곡 여부 분석

Gemini Vision API (Semantic Analysis)

이미지의 맥락 및 자연스러움을 기반으로 종합 판단

Chain-of-Thought Prompting
→ 단계적 분석을 통해 결과 신뢰도 향상
(1) aiVerdict
→ AI 생성 여부 (AI_GENERATED / AUTHENTIC)

(2) deepfakeVerdict
→ 딥페이크 여부 (DEEPFAKE / REAL)

(3) aiConfidence
→ AI 생성 확률 (%)

(4) deepfakeConfidence
→ 딥페이크 확률 (%)
```

---

## 기술 상세 — 왜, 어떻게 구현했는가

---

### 1. HTML5 Canvas API — 픽셀에 직접 접근

**Canvas란?**
HTML5의 `<canvas>` 엘리먼트와 JavaScript API를 사용해 이미지를 픽셀 단위 배열로 읽고 쓸 수 있는 브라우저 내장 기능입니다.

**왜 필요한가?**
딥페이크 분석은 이미지의 RGB 픽셀 값을 수학적으로 계산해야 합니다. Canvas의 `getImageData()`가 브라우저에서 픽셀 데이터에 접근하는 유일한 방법입니다.

```js
// js/analysis.js
// createImageBitmap: 파일/영상 프레임을 GPU 메모리의 픽셀 객체로 디코딩
// resizeWidth/Height: 224×224로 정규화 (분석 속도 vs 정확도 균형점)
createImageBitmap(videoEl, {
  resizeWidth: 224,
  resizeHeight: 224,
  resizeQuality: "medium",
}).then((bmp) => {
  frameBuf.push({ imageBitmap: bmp, timestamp: ts });
});

// js/analyzer.worker.js
// OffscreenCanvas: 화면에 표시하지 않는 Canvas (Worker 내부에서 사용 가능)
const canvas = new OffscreenCanvas(sz, sz);
const ctx = canvas.getContext("2d");
ctx.drawImage(imageBitmap, 0, 0, sz, sz);

// ImageData.data = Uint8ClampedArray (0~255 범위로 자동 고정되는 정수 배열)
// 픽셀 (x, y)의 R값 인덱스 = (y * width + x) * 4
// [R, G, B, A, R, G, B, A, ...] 형태로 픽셀이 순서대로 나열됨
const { data } = ctx.getImageData(0, 0, sz, sz);
```

---

### 2. HTML5 Video API + requestVideoFrameCallback — 정확한 프레임 추출

**requestVideoFrameCallback이란?**
브라우저가 영상의 새 프레임을 화면에 렌더링하기 직전에 콜백을 호출하는 HTML5 Video 확장 API입니다.

**왜 setInterval을 안 쓰는가?**
`setInterval(fn, 33)`은 33ms (= "frmae 간격" = 영상 속도) 마다 무조건 실행되지만 영상 재생 속도와 무관합니다. 같은 프레임을 여러 번 처리하거나 프레임을 건너뛸 수 있습니다. `requestVideoFrameCallback`은 새 프레임이 디코드된 직후 정확히 한 번만 호출됩니다.

(영상 = 1초에 약 30장의 사진이 지나감 (30FPS), 5장 중 1 장만 분석

(ex. 33ms = skip, 66ms = skip, 99 ms = skip, 132ms = skip, 165ms = "분석")
-> 5번째 마다 들어온 프레임(샘플링) 분석

대부분 영상 - 기본 프레임 속도 : 30 FPS 기준 → 1프레임 ≈ 33ms )

(ex. 1000 ms = 1초, 총 6장 사용)

```js
// js/analysis.js
const SAMPLE_RATE = 5; // "샘플링 비율" = 몇 개 건너뛸 지, 5프레임마다 1번만 분석 (초당 약 6프레임 처리)

function onFrame(now, metadata) {
  frameCount++;
  if (frameCount % SAMPLE_RATE !== 0) {
    scheduleFrame(); // 이 프레임은 건너뜀
    return;
  }
  // metadata.mediaTime: 영상 내 정확한 타임스탬프 (초 단위)
  // videoEl.currentTime: 폴백 — 덜 정확하지만 대부분의 브라우저에서 동작
  const ts = metadata?.mediaTime ?? videoEl.currentTime;
  createImageBitmap(videoEl, { resizeWidth: 224, resizeHeight: 224 }).then(
    (bmp) => frameBuf.push({ imageBitmap: bmp, timestamp: ts }),
  );
  scheduleFrame();
}

function scheduleFrame() {
  // 기능 감지(Feature Detection): 기능 존재 여부를 먼저 확인하는 패턴
  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype)
    rafId = videoEl.requestVideoFrameCallback(onFrame);
  else
    // 미지원 브라우저 폴백 (Safari 15.3 이하 등)
    rafId = requestAnimationFrame(() => onFrame(performance.now(), null));
}
```

---

### 3. Web Worker + Transferable — UI 블로킹 없는 병렬 연산

**Web Worker란?**
브라우저의 메인 스레드와 완전히 독립된 백그라운드 스레드입니다. Worker에서 무거운 연산을 실행해도 UI(버튼 클릭, 스크롤 등)가 멈추지 않습니다.

**Transferable 객체란?**
`postMessage()`는 기본적으로 데이터를 Deep Copy(전체 복사)합니다. `ImageBitmap`은 Transferable로 지정하면 복사 없이 소유권만 이전됩니다. 10MB 데이터를 복사하는 대신 포인터만 넘기는 것과 같습니다.

```js
// js/analysis.js — 메인 스레드
const worker = new Worker("./js/analyzer.worker.js");

function flushBatch() {
  const batch = frameBuf.splice(0, BATCH_SIZE);

  // 두 번째 인자 = Transferable 목록 → 소유권 이전, 복사 없음
  // 이후 메인 스레드에서 batch[i].imageBitmap 접근 시 에러 (소유권 없음)
  worker.postMessage(
    { type: "ANALYZE", payload: { frames: batch } },
    batch.map((f) => f.imageBitmap),
  );
}

// Worker로부터 결과 수신
worker.onmessage = ({ data }) => {
  if (data.type === "FRAME_RESULT") updateLiveUI(data.payload);
  if (data.type === "BATCH_DONE") finalizeResult(data.payload);
};

// js/analyzer.worker.js — Worker 스레드
self.onmessage = async ({ data }) => {
  if (data.type === "ANALYZE") {
    for (const frame of data.payload.frames) {
      const result = await analyzeFrame(frame.imageBitmap);
      self.postMessage({ type: "FRAME_RESULT", payload: result });

      // 분석 후 즉시 해제: 명시적으로 close() 안 하면 GC가 수거하지 않음
      frame.imageBitmap.close();
    }
    self.postMessage({ type: "BATCH_DONE", payload: aggregateResults() });
  }
};
```

---

### 4. 로컬 픽셀 포렌식 5대 모듈 (`js/analyzer.worker.js`)

#### 4-1. CFA 노이즈 매핑

**CFA(Color Filter Array)란?**
실제 카메라 센서는 한 픽셀에 하나의 색만 감지합니다. RGGB 배열(Bayer Pattern)로 빛을 기록하고 나머지 색은 주변 픽셀에서 보간합니다. 이 과정에서 인접 픽셀 간 통계적 상관관계가 생깁니다.

AI 이미지에는 이 패턴이 없습니다. GAN/Diffusion 모델은 픽셀을 처음부터 직접 생성하므로 Bayer Pattern의 흔적이 없거나 비정상적입니다.

```js
// js/analyzer.worker.js
function analyzeCFANoise(d, sz) {
  const halfSz = Math.floor(sz / 2);
  let rgCross = 0,
    bayerResidual = 0;

  // 이미지를 2×2 Bayer 블록 단위로 순회
  for (let y = 0; y < halfSz - 1; y++) {
    for (let x = 0; x < halfSz - 1; x++) {
      // 2×2 블록의 RGGB 4픽셀 인덱스 계산
      const coords = [
        [y * 2, x * 2],
        [y * 2, x * 2 + 1],
        [y * 2 + 1, x * 2],
        [y * 2 + 1, x * 2 + 1],
      ];
      const rv = coords.map(([py, px]) => d[(py * sz + px) * 4]); // Red 채널
      const gv = coords.map(([py, px]) => d[(py * sz + px) * 4 + 1]); // Green 채널

      const rMean = rv.reduce((a, b) => a + b, 0) / 4;
      const gMean = gv.reduce((a, b) => a + b, 0) / 4;
      const rDev = rv.map((v) => v - rMean);
      const gDev = gv.map((v) => v - gMean);

      // 교차 상관(cross-correlation): R 편차와 G 편차의 내적
      // 실제 카메라 → 낮음 (채널 간 독립적 노이즈)
      // AI 생성 → 높음 (채널들이 동시에 같은 방향으로 변동)
      rgCross += rDev.reduce((a, v, i) => a + v * gDev[i], 0) / 4;

      // Bayer 잔차: 대각 G픽셀 쌍의 합 차이
      // 실제 카메라 → 거의 0 (Bayer interpolation 후 연속성 보장)
      const g00 = d[(y * 2 * sz + x * 2) * 4 + 1];
      const g11 = d[((y * 2 + 1) * sz + x * 2 + 1) * 4 + 1];
      const g01 = d[(y * 2 * sz + x * 2 + 1) * 4 + 1];
      const g10 = d[((y * 2 + 1) * sz + x * 2) * 4 + 1];
      bayerResidual += Math.abs(g00 + g11 - (g01 + g10));
    }
  }
  // cfaScore: 0(실제 카메라에 가까움) ~ 1(AI 생성에 가까움)
}
```

#### 4-2. GAN 체커보드 아티팩트 탐지

**체커보드 아티팩트란?**
GAN은 저해상도 특성 맵(Feature Map)을 업샘플링할 때 Transposed Convolution을 사용합니다. 이 연산은 인접 픽셀이 서로 다른 횟수로 커널과 겹치는 현상을 일으켜, 체스판처럼 2×2 격자로 밝기가 교대로 높고 낮아지는 패턴이 생깁니다.

```js
// js/analyzer.worker.js
function analyzeGANPixels(d, sz) {
  let checkerScore = 0,
    total = 0;

  for (let y = 0; y < sz - 1; y += 2) {
    for (let x = 0; x < sz - 1; x += 2) {
      // 2×2 블록의 대각 픽셀 밝기 계산
      // 밝기(Luminance) = 0.299*R + 0.587*G + 0.114*B (사람 눈의 색 감도 반영)
      const i00 = (y * sz + x) * 4;
      const i11 = ((y + 1) * sz + (x + 1)) * 4;
      const lum00 = 0.299 * d[i00] + 0.587 * d[i00 + 1] + 0.114 * d[i00 + 2];
      const lum11 = 0.299 * d[i11] + 0.587 * d[i11 + 1] + 0.114 * d[i11 + 2];

      // 체커보드가 있으면 대각 픽셀 간 밝기 차이가 일정하게 큼
      checkerScore += Math.abs(lum00 - lum11);
      total++;
    }
  }
  return checkerScore / (total * 30); // 최대값 30으로 0~1 정규화
}
```

#### 4-3. 조명 비일관성 분석

이미지를 4×4 = 16개 구역으로 분할해 각 구역의 평균 밝기를 계산합니다. 가장 밝은 구역(하이라이트)과 인접 구역 사이에 물리적으로 불가능한 밝기 낙차가 있으면 조작 신호로 판단합니다.

#### 4-4. 비네팅(Vignetting) 분석

**비네팅이란?**
실제 카메라 렌즈는 광학적 특성으로 인해 이미지 중앙보다 코너가 자연스럽게 어둡습니다. AI 생성 이미지는 이 어두워짐이 없거나 비정상적으로 균등합니다.

```js
// 코너 4구역 평균 밝기 vs 중앙 구역 밝기 비율로 판단
const vigRatio = cornerBrightness / centerBrightness;
// 실제 카메라: vigRatio ≈ 0.7~0.9
// AI 생성:    vigRatio ≈ 0.95~1.0 (코너가 중앙만큼 밝음)
```

#### 4-5. 기하학 노이즈 매핑

실제 광학 렌즈는 미세한 왜곡과 색수차(Chromatic Aberration, RGB 채널 간 미세 위치 차이)를 남깁니다. 수평·수직 직선의 연속성과 RGB 채널 간 정렬 오차를 분석합니다.

---

### 5. 이중 엔진 결합

```js
// js/analysis.js
function combineScores(geminiScore, localScore) {
  // Gemini: 수백억 파라미터 멀티모달 모델 → 신뢰도 높음
  // 로컬 포렌식: 수학적 휴리스틱 → 오탐 가능하지만 오프라인에서도 동작
  return geminiScore * 0.92 + localScore * 0.08;
}
```

| 최종 신뢰도 | 판정          |
| ----------- | ------------- |
| 70%+        | 🔴 DEEPFAKE   |
| 45~70%      | 🟡 SUSPICIOUS |
| 0~45%       | 🟢 AUTHENTIC  |

---

### 6. Web Crypto API — 파일 식별 해시

**SHA-256이란?**
어떤 입력이든 256비트(64자리 16진수) 고정 길이 해시로 변환하는 단방향 함수입니다. 입력이 조금이라도 다르면 완전히 다른 해시가 나옵니다. 역방향 계산(원래 입력 복원)이 불가능합니다.

**왜 파일 전체를 해시하지 않는가?**
100MB 영상을 전부 읽으면 수 초가 걸립니다. `파일명|크기|수정일` 조합은 동일 파일을 실용적으로 식별하기에 충분합니다.

```js
// js/analysis.js
async function getFileFingerprint(file) {
  // 파일 전체를 읽지 않고 메타데이터만으로 식별 문자열 생성
  const fingerprint = `${file.name}|${file.size}|${file.lastModified}`;

  // Web Crypto API — 브라우저 내장, 외부 라이브러리 불필요
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(fingerprint), // 문자열 → Uint8Array(바이트 배열)
  );

  // ArrayBuffer(이진 데이터) → 16진수 문자열 변환
  // b.toString(16): 10진수 정수를 16진수로
  // padStart(2, '0'): 한 자리 16진수 앞에 0 추가 (예: 'a' → '0a')
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // 예: "a1b2c3d4e5f6..."
}
```

**캐시 동작 흐름:**

```
동일 파일 재분석 요청
      ↓
해시 생성 → GET /api/analyses?hash=a1b2c3...
      ↓
캐시 있음 → 이전 결과 즉시 반환  (Gemini API 호출 0회)
캐시 없음 → 전체 분석 실행
```

---

### 7. Observable Store — 자체 구현 상태 관리

**Observer 패턴이란?**
상태가 바뀌면 그 상태를 구독하고 있는 모든 함수에게 자동으로 알리는 패턴입니다. React의 `useState`와 유사하지만 빌드 도구 없이 Vanilla JS로 구현했습니다.

**왜 Redux/Zustand 같은 라이브러리를 쓰지 않았는가?**
이 프로젝트는 `node server.js` 하나로 실행됩니다. Webpack/Vite 같은 번들러가 없으므로 npm 패키지를 프론트엔드에서 직접 import할 수 없습니다.

```js
// js/core.js
const Store = (() => {
  const _state = {
    analysis: {
      analysisStatus: "idle", // idle | ready | analyzing | complete | error
      liveConfidence: 0,
      frameCount: 0,
      overallResult: null,
    },
    // ... 기타 슬라이스
  };
  const listeners = {};

  return {
    get(key) {
      return _state[key];
    },

    set(key, patch) {
      // patch가 객체면 기존 상태에 얕은 병합(shallow merge)
      // → 전체를 덮어쓰지 않고 바뀐 필드만 업데이트
      if (typeof patch === "object" && !Array.isArray(patch))
        Object.assign(_state[key], patch);
      else _state[key] = patch;

      // 이 키를 구독하는 모든 콜백에게 새 상태 전달
      (listeners[key] || []).forEach((fn) => fn(_state[key]));
    },

    // 구독 등록 — 반환된 함수를 호출하면 구독 해제 (메모리 누수 방지)
    on(key, fn) {
      if (!listeners[key]) listeners[key] = [];
      listeners[key].push(fn);
      return () => {
        listeners[key] = listeners[key].filter((f) => f !== fn);
      };
    },
  };
})();

// 사용 예: Worker에서 FRAME_RESULT 수신 시 신뢰도 바 자동 갱신
Store.on("analysis", (state) => {
  document.getElementById("live-confidence").style.width =
    state.liveConfidence * 100 + "%";
});

Store.set("analysis", { liveConfidence: 0.72, frameCount: 45 });
// → 위 콜백이 자동 실행되어 UI 즉시 반영
```

---

### 8. Express 서버 + CORS 프록시

```js
// server.js
app.use(express.static(".")); // HTML/CSS/JS 정적 파일 서빙

// Gemini API 키를 서버에만 보관 — 브라우저 소스코드에 노출 안 됨
app.post("/api/analyze", async (req, res) => {
  const { imageBase64, mimeType } = req.body;
  const response = await fetch(
    "https://generativelanguage.googleapis.com/...",
    {
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        /* Chain-of-Thought 프롬프트 + 이미지 */
      }),
    },
  );
  res.json(await response.json());
});

// CORS 프록시: 외부 URL 이미지를 Canvas로 읽을 수 없는 문제 해결
// 브라우저 → 우리 서버 → 외부 URL → 브라우저 (서버는 CORS 제약 없음)
app.get("/api/url-image-proxy", async (req, res) => {
  const response = await fetch(req.query.url);
  const buffer = await response.arrayBuffer();
  res.json({
    base64: Buffer.from(buffer).toString("base64"),
    mimeType: response.headers.get("content-type"),
  });
});
```

---

### 9. Gemini Chain-of-Thought 프롬프트

**Chain-of-Thought란?**
"이게 가짜냐?"라고 단순히 묻는 대신, 단계별 추론을 요구하는 프롬프트 기법입니다. AI가 중간 분석 과정을 거치면 최종 판단의 정확도와 일관성이 높아집니다.

모델이 단계적으로 이미지를 분석하도록 프롬프트를 구조화하여 구성

{
"steps": [
"조명 및 그림자 일관성 분석",
"텍스처 및 디테일 자연스러움 검토",
"객체 구조 및 해부학적 정확성 확인",
"AI 생성/딥페이크 신호 종합 판단"
]
}

→ 단순 결과가 아니라 분석 과정 기반 판단 유도

````js
// server.js
const prompt = `You are a forensic AI expert. Analyze step by step:

STEP 1 - Lighting & reflections:
  Check: eye highlight positions, shadow direction consistency across the face
STEP 2 - Anatomy:
  Check: finger count/joints, teeth regularity, ear structure detail
STEP 3 - Texture & boundaries:
  Check: skin smoothness anomalies, background blending artifacts
STEP 4 - Deepfake signals:
  Check: face boundary blur, hairline resolution drop vs background

Respond ONLY with valid JSON (no markdown fences):
{
  "aiVerdict":          "authentic" | "ai_generated",
  "deepfakeVerdict":    "authentic" | "deepfake" | "uncertain",
  "aiConfidence":       0.0 ~ 1.0,
  "deepfakeConfidence": 0.0 ~ 1.0,
  "reasoning":          "brief explanation"
}`;

// Gemini 응답 후처리: 마크다운 코드블록 제거
let text = response.candidates[0].content.parts[0].text;
text = text
  .replace(/^```(?:json)?\s*/i, "")
  .replace(/\s*```$/m, "")
  .trim();
const parsed = JSON.parse(text);
````

✔ aiVerdict / deepfakeVerdict

모델 출력 형식을 고정된 JSON 스키마로 강제

{
"aiVerdict": "AI_GENERATED | AUTHENTIC",
"deepfakeVerdict": "DEEPFAKE | REAL"
}

→ 문자열 분기 처리로 프론트에서 바로 사용 가능

✔ aiConfidence / deepfakeConfidence

모델이 판단한 결과를 수치화된 확률 값으로 반환

{
"aiConfidence": 0-100,
"deepfakeConfidence": 0-100
}

→ 내부적으로는

각 분석 단계 결과를 종합
최종 판단에 대한 신뢰도 점수로 출력
🔧 전체 출력 구조
{
"aiVerdict": "AI_GENERATED",
"deepfakeVerdict": "DEEPFAKE",
"aiConfidence": 87,
"deepfakeConfidence": 91
}

---

## 주요 문제 & 해결 기록

---

### 문제 1: Gemini 응답 JSON 파싱 실패

**원인:** Gemini가 JSON 앞뒤에 마크다운 코드블록(` ```json ... ``` `)을 붙여 반환합니다.

````js
// 실제 응답 예시:
// "```json\n{\"aiVerdict\": \"authentic\"...}\n```"
// JSON.parse() 호출 시 SyntaxError 발생

// 해결: 정규식으로 코드블록 펜스 제거 후 파싱
let text = response.candidates[0].content.parts[0].text;
text = text
  .replace(/^```(?:json)?\s*/i, "")
  .replace(/\s*```$/m, "")
  .trim();
const parsed = JSON.parse(text);
````

---

### 문제 2: Web Worker ImageBitmap 전달 시 복사 성능 저하

**원인:** `postMessage()`의 기본 동작은 구조적 복제(Deep Copy)입니다. 224×224 × 4바이트 × 배치 8개 ≈ 1.4MB를 매 배치마다 복사합니다.

```js
// 문제: 기본 전달 → 전체 데이터 복사 발생
worker.postMessage({ frames: batch });

// 해결: 두 번째 인자에 Transferable 목록 전달 → 소유권 이전, 복사 없음
worker.postMessage(
  { type: "ANALYZE", payload: { frames: batch } },
  batch.map((f) => f.imageBitmap),
);
```

---

### 문제 3: Worker 사용 후 메모리 누수

**원인:** Transferable로 이전된 `ImageBitmap`은 Worker가 소유합니다. 분석 후 명시적으로 해제하지 않으면 GC(Garbage Collector)가 수거하지 않습니다.

```js
// js/analyzer.worker.js
for (const frame of data.payload.frames) {
  await analyzeFrame(frame.imageBitmap);
  frame.imageBitmap.close(); // GPU 메모리 즉시 해제
}
```

---

### 문제 4: 외부 URL 이미지 Canvas 접근 차단 (CORS/Tainted Canvas)

**원인:** 브라우저 보안 정책(Same-Origin Policy)으로 외부 도메인 이미지를 Canvas에 그리면 `getImageData()` 호출 시 `SecurityError`가 발생합니다.

```
브라우저 → Canvas.drawImage(외부이미지) → getImageData()
→ SecurityError: The canvas has been tainted by cross-origin data
```

**해결:** 서버가 중간에서 이미지를 가져와 Base64로 변환해 반환합니다.

```js
// server.js — 서버는 CORS 제약 없음
app.get("/api/url-image-proxy", async (req, res) => {
  const response = await fetch(req.query.url);
  const buffer = await response.arrayBuffer();
  res.json({
    base64: Buffer.from(buffer).toString("base64"),
    mimeType: response.headers.get("content-type"),
  });
});

// 브라우저에서는 Base64 Data URL로 변환해 Canvas에 그림 → CORS 문제 없음
const dataUrl = `data:${d.mimeType};base64,${d.base64}`;
```

---

### 문제 5: requestVideoFrameCallback 미지원 브라우저

**원인:** Safari 15.3 이하 등 구버전에서 `requestVideoFrameCallback`이 없습니다.

```js
// 기능 감지(Feature Detection) 패턴: 런타임에 기능 존재 여부 확인
if ("requestVideoFrameCallback" in HTMLVideoElement.prototype)
  rafId = videoEl.requestVideoFrameCallback(onFrame); // 정확한 프레임 타이밍
else rafId = requestAnimationFrame(() => onFrame(performance.now(), null)); // 폴백
```

---

## 관리자 기능

| 기능                | 설명                                                     |
| ------------------- | -------------------------------------------------------- |
| 신고 모더레이션     | 신고 상태(신고됨·활성·삭제됨)별 필터링, 게시물 강제 삭제 |
| 해시 판별 이력 검색 | SHA-256·파일명·판별결과·날짜로 분석 기록 검색            |
| 실시간 신고 알림    | 30초 폴링으로 신규 신고 발생 시 벨 알림                  |
| 공지사항            | 커뮤니티 공지 등록·고정·삭제                             |

---

## 면책 조항

본 소프트웨어는 교육·연구·보안 목적으로 제공됩니다.  
AI 기반 판별 결과는 참고용이며 법적 효력을 갖지 않습니다.  
실제 법적 판단을 위해서는 반드시 공인 디지털 포렌식 전문가의 검토가 필요합니다.
