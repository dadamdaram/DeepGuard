/**
 * DeepGuard Pro — Client Environment Config
 * 이 파일을 수정해 클라이언트 설정을 바꾸세요.
 * 서버 비밀값(API 키)은 .env 파일로 관리하세요 (이 파일에 넣지 마세요).
 */
window.DG_ENV = {
  // 앱 이름 / 버전
  APP_NAME: 'DeepGuard Pro',
  APP_VERSION: 'v13',

  // 서버 API 베이스 경로 (기본: /api)
  API_BASE: '/api',

  // 커뮤니티 게시물당 기본 페이지 크기
  COMMUNITY_PAGE_SIZE: 12,

  // 최근 분석 표시 개수 (메인 페이지 미니 히스토리)
  HISTORY_MINI_SIZE: 5,

  // 이미지 캡처 최대 크기 (px) — 공유 시 첨부 썸네일
  MEDIA_CAPTURE_MAX: 600,

  // URL 이미지 로드 시 서버 프록시 사용 여부 (cross-origin 오류 방지)
  URL_IMAGE_PROXY: true,
};
