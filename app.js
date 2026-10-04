// ── Config ──
const DROPBOX_CLIENT_ID = '0kfnwj8hluxzpun';
// PKCE(공개 클라이언트) 방식이므로 app secret은 코드에 두지 않는다 (공개 저장소 노출 방지)
const DROPBOX_FILE = '/project-papers/memos.json';
// 동기화 규칙 버전. 옛 앱이 새 규칙의 데이터를 망가뜨릴 수 있게 바뀔 때만 올린다.
// 파일의 dataVersion이 이 값보다 크면 이 앱은 올리지 않고 새로고침을 안내한다.
// 3: 글 버전을 시각이 아니라 내용 지문(ver)·계보(anc)로 가린다 — 시각만 보는 옛 앱이 되돌리지 못하게
const DATA_VERSION = 3;
let outdatedClient = false;
function markOutdated() {
  if (outdatedClient) return;
  outdatedClient = true;
  showToast('새 버전이 나와 이 화면에서는 저장을 올리지 않습니다. 새로고침해 주세요');
  // 한 세션에 한 번만 자동 새로고침 (새 코드를 받아 오게)
  if (!sessionStorage.getItem('outdated_reloaded')) {
    sessionStorage.setItem('outdated_reloaded', '1');
    setTimeout(() => location.reload(), 1500);
  }
}
const BACKUP_DIR = '/project-papers/backups';
const BACKUP_MAX = 30;
const REDIRECT_URI = location.origin + location.pathname;

// ── State ──
let memos = [];
let folders = [];
let trash = []; // 휴지통: { type: 'memo'|'folder', data: {...}, deletedAt: timestamp }
let deletedIds = []; // 영구 삭제된 항목: { id, at } (동기화 시 복귀 차단, 30일 후 자동 정리)
let currentId = null;
let currentFolder = null; // null = all
let accessToken = localStorage.getItem('dbx_token') || null;
let refreshToken = localStorage.getItem('dbx_refresh') || null;
let isOnline = !!accessToken;
let viewerMode = false;
let favFilterActive = false;
let selectMode = false;
let folderListCollapsed = false;
let selectedMemos = new Set();
let selectedFolders = new Set();
let lastCheckedMemoIndex = -1;
let lastCheckedFolderIndex = -1;
let touchSelectActive = false; // 모바일 롱프레스 범위 선택 활성 여부
let memoSortKey = 'updatedAt';
let saveTimer = null;
// 못 보낸 변경이 있는지(pending_sync), Dropbox 파일 버전(rev), 지난 동기화 때의 각 글 시각(sync_base)
let lastPullAt = 0;
let localSaveTimer = null;
const getRev = () => localStorage.getItem('dbx_rev') || null;
const getSyncBase = () => { try { return JSON.parse(localStorage.getItem('sync_base') || '{}'); } catch { return {}; } };
const isDirty = () => localStorage.getItem('pending_sync') === '1';
let changeSeq = 0;   // 이 기기에서 고칠 때마다 1씩 — 올리는 동안 또 고쳤는지 가린다
let reloadingForUpdate = false;
function setRev(rev) {
  if (rev) localStorage.setItem('dbx_rev', rev); else localStorage.removeItem('dbx_rev');
}

// 동기화 작업은 한 번에 하나씩 — 받기·올리기가 겹치면 같은 버전으로 두 번 올리다 충돌한다
let syncQueue = Promise.resolve();
function queueSync(fn) {
  const run = syncQueue.then(fn, fn);
  syncQueue = run.catch(() => {});
  return run;
}
const unlockedFolders = new Set(); // 현재 세션에서 잠금 해제된 폴더
let masterPasswordHash = null;
let masterPasswordAt = 0;   // Master를 마지막으로 바꾼(설정·해제) 시각 — 기기 사이에서 늦게 바꾼 쪽을 따른다
let templates = [];
let undoStack = [];
let redoStack = [];
const UNDO_MAX = 50;

// ── DOM ──
const $ = (s) => document.querySelector(s);
const loginScreen = $('#login-screen');
const app = $('#app');
const memoList = $('#memo-list');
const folderList = $('#folder-list');
const editor = $('#editor');
const titleInput = $('#memo-title-input');
const searchBox = $('#search-box');
const syncStatus = $('#sync-status');
const toast = $('#toast');
const editorToolbar = $('#editor-toolbar');
const editorContainer = $('#editor-container');
const emptyState = $('#empty-state');

// ── Init ──
document.addEventListener('DOMContentLoaded', init);

// 저장소 자동 삭제(브라우저의 유휴 정리) 방지 요청 — 안드로이드/PC 크롬 등에서
// 오래 안 써도 로그인·데이터가 지워지지 않도록 '영구 저장소'를 요청한다.
async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (!(await navigator.storage.persisted())) {
        await navigator.storage.persist();
      }
    }
  } catch (e) {}
}

async function init() {
  // 모바일 세로 모드 고정
  try {
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('portrait').catch(() => {});
    }
  } catch (e) {}

  requestPersistentStorage(); // 저장소 유지 요청 (로그인이 오래 유지되도록)

  await handleOAuthCallback();
  loadLocalData();
  cleanupEmptyMemo();

  // URL 파라미터로 특정 메모 열기 (새 창)
  const urlParams = new URLSearchParams(location.search);
  const openMemoId = urlParams.get('memo');

  // 새 창 모드는 URL 감지 즉시 적용 (햄버거 깜빡임·메모 미발견 시 노출 방지)
  if (openMemoId) {
    document.body.classList.add('popup-mode');
  }

  if (accessToken) {
    showApp();
    syncFromDropbox().then(() => checkAutoBackup());
  } else {
    // 오프라인 모드: 백업 필요 플래그만 저장
    markAutoBackupPending();
  }

  // 네트워크 복구 시 자동 동기화 + 보류된 자동 백업 실행
  window.addEventListener('online', () => {
    if (accessToken) {
      syncFromDropbox().then(() => checkAutoBackupPending());
    }
  });

  // 앱을 닫거나(beforeunload/pagehide), 다른 앱·화면으로 가려질 때(visibilitychange) 즉시 저장 + 동기화
  // 특히 휴대폰에서 홈으로 나가거나 앱을 전환할 때 beforeunload는 잘 안 불리므로 visibilitychange가 핵심
  window.addEventListener('beforeunload', flushSave);
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { flushSave(); return; }
    // 돌아왔을 때: 새 버전이 나왔는지 보고(나왔으면 새 코드로 다시 연다),
    // 못 보낸 변경을 올리고 다른 기기에서 고친 것을 받아 온다
    // (매번 받지는 않는다 — 파일이 커서 탭을 오갈 때마다 받으면 느리다)
    checkForUpdate();
    if (accessToken && (isDirty() || Date.now() - lastPullAt > 30000)) syncFromDropbox();
  });

  // 같은 기기의 다른 창에서 저장하면(localStorage 변경) 이 창에 즉시 반영
  window.addEventListener('storage', onExternalStorageChange);

  // 드롭다운 바깥 클릭 시 닫기
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#template-wrap')) {
      $('#template-dropdown').style.display = 'none';
    }
    if (!e.target.closest('#folder-select-wrap')) {
      $('#folder-select-dropdown').style.display = 'none';
    }
  });

  $('#btn-login').addEventListener('click', loginDropbox);
  $('#btn-offline').addEventListener('click', (e) => {
    e.preventDefault();
    isOnline = false;
    showApp();
  });
  $('#toolbar-reveal').addEventListener('click', () => {
    document.body.classList.remove('toolbar-hidden');
    lastEditorScrollTop = editor.scrollTop;
  });
  $('#btn-new').addEventListener('click', createMemo);
  $('#btn-backup').addEventListener('click', createBackup);
  $('#btn-folder-toggle').addEventListener('click', toggleFolderDropdown);
  $('#btn-fav-filter').addEventListener('click', toggleFavFilter);
  $('#btn-folder-add').addEventListener('click', showFolderDialog);
  $('#btn-folder-manage').addEventListener('click', () => openFolderManager());
  $('#btn-sync').addEventListener('click', () => {
    if (!accessToken) { loginDropbox(); return; }
    syncFromDropbox();
  });
  $('#btn-logout').addEventListener('click', confirmLogout);
  $('#btn-master-pw').addEventListener('click', showMasterPasswordDialog);
  $('#btn-master-unlock').addEventListener('click', showMasterUnlockPrompt);
  $('#btn-trash').addEventListener('click', showTrashView);
  $('#btn-fav').addEventListener('click', toggleFavorite);
  $('#btn-undo').addEventListener('click', performUndo);
  $('#btn-redo').addEventListener('click', performRedo);
  $('#btn-toolbar-more').addEventListener('click', toggleToolbarMore);
  $('#btn-template').addEventListener('click', toggleTemplateDropdown);
  $('#btn-template-save').addEventListener('click', saveAsTemplate);
  $('#btn-find').addEventListener('click', toggleFindReplace);
  $('#btn-copy').addEventListener('click', copyMemoToClipboard);
  $('#btn-share').addEventListener('click', shareMemo);
  $('#btn-viewer').addEventListener('click', toggleViewer);
  $('#btn-help').addEventListener('click', showHelpDialog);
  $('#btn-delete').addEventListener('click', confirmDelete);
  $('#memo-sort').addEventListener('change', (e) => { memoSortKey = e.target.value; renderMemoList(); });
  $('#btn-select-mode').addEventListener('click', toggleSelectMode);
  $('#btn-bulk-delete').addEventListener('click', bulkDelete);
  $('#btn-bulk-move').addEventListener('click', bulkMoveUnified);
  $('#btn-bulk-cancel').addEventListener('click', () => toggleSelectMode());
  $('#find-input').addEventListener('input', findCountOnly);
  $('#find-btn').addEventListener('click', findAndGo);
  $('#find-all-btn').addEventListener('click', findAllAndGo);
  $('#find-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findAndGo(); } });
  $('#find-next').addEventListener('click', () => findNavigate(1));
  $('#find-prev').addEventListener('click', () => findNavigate(-1));
  $('#replace-one').addEventListener('click', replaceAction);

  // 키보드 단축키
  document.addEventListener('keydown', (e) => {
    // Alt+Shift+D → 하이픈(------) 구분선, Alt+Shift+E → 등호(======) 구분선 (에디터 포커스 시)
    // Ctrl 게이트보다 위에서 처리(Alt는 Ctrl이 아니므로). 글자는 레이아웃 영향 적은 e.code로 판별
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && document.activeElement === editor) {
      if (e.code === 'KeyD') { e.preventDefault(); insertDivider('-'); return; }
      if (e.code === 'KeyE') { e.preventDefault(); insertDivider('='); return; }
    }
    // Alt+; → 현재 날짜, Alt+Shift+; → 날짜+시간 (본문/제목 포커스 시)
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'Semicolon' &&
        (document.activeElement === editor || document.activeElement === titleInput)) {
      e.preventDefault();
      insertTextAtCursor(formatDateStamp(e.shiftKey));
      return;
    }
    // Alt+H → 선택 영역 형광펜(하이라이트) 켜기/끄기 (본문 포커스 시). 앱 안에서만 보이는 표시.
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyH' && document.activeElement === editor) {
      e.preventDefault();
      toggleHighlight();
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    // Ctrl+↓ → 다음 문단(엔터로 구분된 줄) 맨 앞으로 커서 이동 (기본 동작이 애매해서 직접 처리)
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'ArrowDown' && document.activeElement === editor) {
      e.preventDefault();
      const target = nextParagraphStart(editor.value, editor.selectionEnd);
      editor.setSelectionRange(target, target);
      return;
    }
    // Ctrl+↑ → 이전 문단 맨 앞으로 커서 이동
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'ArrowUp' && document.activeElement === editor) {
      e.preventDefault();
      const target = prevParagraphStart(editor.value, editor.selectionStart);
      editor.setSelectionRange(target, target);
      return;
    }
    // Ctrl+Z → 어절 단위 되돌리기 (에디터 포커스 시에만 가로채 브라우저 기본 동작 대체)
    if (k === 'z' && !e.shiftKey && document.activeElement === editor) {
      e.preventDefault();
      performUndo();
      return;
    }
    // Ctrl+Shift+Z 또는 Ctrl+Y → 되살리기
    if (((k === 'z' && e.shiftKey) || k === 'y') && document.activeElement === editor) {
      e.preventDefault();
      performRedo();
      return;
    }
    // Ctrl+F → 앱 찾기/바꾸기
    if (k === 'f') {
      if (!currentId) return;
      e.preventDefault();
      toggleFindReplace();
    }
    // Ctrl+S → 저장 및 동기화
    if (k === 's') {
      e.preventDefault();
      saveLocalData();
      if (accessToken) {
        syncToDropbox().then(() => showToast('저장 및 동기화 완료')).catch(() => showToast('동기화 실패'));
      } else {
        showToast('로컬에 저장됨');
      }
    }
  });

  $('#menu-toggle').addEventListener('click', () => {
    $('#sidebar').classList.toggle('open');
  });

  // 에디터 영역 클릭: 사이드바 열려있으면 닫기만, 아니면 빈 화면에서 새 글
  $('#editor-area').addEventListener('click', (e) => {
    const sidebar = $('#sidebar');
    if (sidebar.classList.contains('open')) {
      sidebar.classList.remove('open');
      e.stopPropagation();
      return;
    }
    if (emptyState.style.display !== 'none' && emptyState.contains(e.target)) {
      createMemo();
    }
  });

  editor.addEventListener('input', onEditorInput);
  editor.addEventListener('scroll', () => {
    $('#editor-highlight').scrollTop = editor.scrollTop;
    handleEditorScroll();
  });
  titleInput.addEventListener('input', onTitleInput);
  titleInput.addEventListener('keydown', (e) => {
    // 제목에서 Enter → 본문 맨앞으로 커서 이동
    if (e.key === 'Enter') { e.preventDefault(); editor.focus(); editor.setSelectionRange(0, 0); editor.scrollTop = 0; }
  });
  $('#btn-folder-select').addEventListener('click', toggleFolderSelectDropdown);
  $('#folder-select-list').addEventListener('click', onFolderSelectItemClick);
  searchBox.addEventListener('input', renderMemoList);

  document.addEventListener('keydown', (e) => {
    // (Ctrl+S는 위 단축키 처리에서 저장·동기화까지 한다 — 여기서 또 처리하지 않는다)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      createMemo();
    }
  });

  // 새 창으로 열린 경우 해당 메모 바로 표시 (popup-mode 클래스는 init 초반에 이미 적용됨)
  if (openMemoId) {
    const memo = memos.find((m) => m.id === openMemoId);
    if (memo) {
      if (!accessToken) { isOnline = false; showApp(); }
      loadMemoInEditor(memo);
    }
  } else {
    // 새 버전으로 다시 열린 경우 쓰던 글을 다시 연다
    const reopenId = sessionStorage.getItem('reopen_memo');
    sessionStorage.removeItem('reopen_memo');
    const memo = reopenId && memos.find((m) => m.id === reopenId);
    if (memo && accessToken) loadMemoInEditor(memo);
  }
}

// ── OAuth (PKCE) ──
function generateCodeVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateCodeChallenge(verifier) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function loginDropbox() {
  const state = crypto.randomUUID();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  sessionStorage.setItem('oauth_state', state);
  sessionStorage.setItem('code_verifier', codeVerifier);
  const params = new URLSearchParams({
    client_id: DROPBOX_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
    scope: 'files.content.read files.content.write files.metadata.read files.metadata.write',
    state,
  });
  location.href = 'https://www.dropbox.com/oauth2/authorize?' + params;
}

async function handleOAuthCallback() {
  // PKCE code flow: code comes in query string
  const urlParams = new URLSearchParams(location.search);
  const code = urlParams.get('code');
  const state = urlParams.get('state');
  if (!code || state !== sessionStorage.getItem('oauth_state')) {
    // Fallback: legacy implicit flow (hash-based token)
    const hash = location.hash.substring(1);
    if (!hash) return;
    const hashParams = new URLSearchParams(hash);
    const token = hashParams.get('access_token');
    const hState = hashParams.get('state');
    if (token && hState === sessionStorage.getItem('oauth_state')) {
      accessToken = token;
      isOnline = true;
      localStorage.setItem('dbx_token', token);
      sessionStorage.removeItem('oauth_state');
      history.replaceState(null, '', location.pathname);
    }
    return;
  }

  // Exchange code for tokens
  const codeVerifier = sessionStorage.getItem('code_verifier');
  try {
    const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: DROPBOX_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier, // PKCE: secret 대신 code_verifier로 검증
      }),
    });
    if (!res.ok) throw new Error('token exchange failed: ' + res.status);
    const data = await res.json();
    accessToken = data.access_token;
    refreshToken = data.refresh_token || null;
    isOnline = true;
    localStorage.setItem('dbx_token', accessToken);
    if (refreshToken) localStorage.setItem('dbx_refresh', refreshToken);
    sessionStorage.removeItem('oauth_state');
    sessionStorage.removeItem('code_verifier');
    history.replaceState(null, '', location.pathname);
  } catch (e) {
    console.error('Token exchange error:', e);
    showToast('로그인 실패. 다시 시도해주세요.');
  }
}

async function refreshAccessToken() {
  if (!refreshToken) return false;
  try {
    const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: DROPBOX_CLIENT_ID, // PKCE 공개 클라이언트: secret 불필요
      }),
    });
    // 400·401 = 갱신 토큰 자체가 무효(진짜 로그아웃 사유). 그 밖의 실패는 일시적인 것으로 보고 다음에 다시 시도한다.
    if (res.status === 400 || res.status === 401) {
      console.error('Token refresh rejected:', res.status);
      return false;
    }
    if (!res.ok) throw new Error('token refresh failed: ' + res.status);
    const data = await res.json();
    accessToken = data.access_token;
    localStorage.setItem('dbx_token', accessToken);
    return true;
  } catch (e) {
    // 통신이 잠깐 끊긴 것 — 로그아웃하지 않는다(예전엔 지하철 등에서 로그아웃되고 '(Offline Work)' 사본이 생겼다)
    console.error('Token refresh error:', e);
    throw e;
  }
}

function logout() {
  accessToken = null;
  refreshToken = null;
  isOnline = false;
  localStorage.removeItem('dbx_token');
  localStorage.removeItem('dbx_refresh');
  location.reload();
}

function confirmLogout() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <p>로그아웃 하시겠습니까?</p>
      <div>
        <button class="btn btn-secondary" id="logout-cancel">취소</button>
        <button class="btn btn-primary" id="logout-ok">로그아웃</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#logout-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#logout-ok').onclick = () => { overlay.remove(); logout(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ── Dropbox API ──
// 동시 쓰기 충돌(409 too_many_write_operations)·요청 과다(429) 시 잠깐 기다렸다 재시도.
// 두 창에서 같은 파일에 동시에 저장할 때 한쪽이 거절당하던 문제를 자동으로 넘기기 위함.
const DBX_MAX_RETRY = 3;
const dbxSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function dbxRetryDelay(res, attempt) {
  const ra = parseInt((res && res.headers.get('Retry-After')) || '0', 10);
  if (ra > 0) return Math.min(ra * 1000, 10000); // 서버가 알려준 Retry-After(초) 존중, 최대 10초
  return Math.min(2000, 400 * Math.pow(2, attempt)); // 0.4s → 0.8s → 1.6s
}

async function dbxUpload(content, retried, attempt = 0) {
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: DROPBOX_FILE,
        // 내가 마지막으로 받아 본 버전 위에만 덮어쓴다 — 그사이 다른 기기가 올렸으면 409로 막힌다
        mode: getRev() ? { '.tag': 'update', update: getRev() } : 'overwrite',
        mute: true,
      }),
    },
    body: content,
  });
  if (res.status === 401) {
    if (!retried && await refreshAccessToken()) {
      return dbxUpload(content, true, attempt);
    }
    showToast('Dropbox 인증 만료. 다시 로그인해주세요.');
    logout();
    throw new Error('auth expired');
  }
  // 동시 쓰기 충돌(409)·요청 과다(429) → 잠깐 대기 후 재시도 (다른 창과 동시 저장 시)
  if (res.status === 409 && getRev()) {
    // 다른 기기가 먼저 올렸다 — 받아서 합친 뒤 다시 올려야 한다
    const err = new Error('rev conflict');
    err.revConflict = true;
    throw err;
  }
  if ((res.status === 429 || res.status === 409) && attempt < DBX_MAX_RETRY) {
    await dbxSleep(dbxRetryDelay(res, attempt));
    return dbxUpload(content, retried, attempt + 1);
  }
  if (!res.ok) throw new Error('upload failed: ' + res.status);
  const meta = await res.json();
  if (meta && meta.rev) setRev(meta.rev);
  return meta;
}

async function dbxDownload(retried, attempt = 0) {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Dropbox-API-Arg': JSON.stringify({ path: DROPBOX_FILE }),
    },
  });
  if (res.status === 409 || res.status === 404) { setRev(null); return null; } // 아직 파일 없음
  if (res.status === 401) {
    if (!retried && await refreshAccessToken()) {
      return dbxDownload(true, attempt);
    }
    showToast('Dropbox 인증 만료. 다시 로그인해주세요.');
    logout();
    throw new Error('auth expired');
  }
  if (res.status === 429 && attempt < DBX_MAX_RETRY) {
    await dbxSleep(dbxRetryDelay(res, attempt));
    return dbxDownload(retried, attempt + 1);
  }
  if (!res.ok) throw new Error('download failed: ' + res.status);
  const info = res.headers.get('dropbox-api-result');
  if (info) { try { const meta = JSON.parse(info); if (meta.rev) setRev(meta.rev); } catch { /* 헤더가 없으면 그냥 둔다 */ } }
  return res.json();
}

// ── Backup ──
// 백업 파일 내용 — 동기화 파일과 같은 항목을 모두 담는다(예전엔 글·폴더만 담아 템플릿·휴지통이 빠졌다)
function backupPayload() {
  const obj = { memos, folders, trash, deletedIds, templates, masterPasswordAt, dataVersion: DATA_VERSION };
  if (masterPasswordHash) obj.masterPassword = masterPasswordHash;
  return obj;
}
async function createBackup() {
  if (!accessToken) {
    showToast('Dropbox에 로그인 후 이용하세요');
    return;
  }
  const btn = $('#btn-backup');
  btn.disabled = true;
  showToast('백업 중...');

  try {
    // 백업 파일명: 날짜시간
    const now = new Date();
    const ts = now.getFullYear()
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + '_' + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0')
      + String(now.getSeconds()).padStart(2, '0');
    const backupPath = BACKUP_DIR + '/backup_' + ts + '.json';
    const obj = backupPayload();
    const data = JSON.stringify(obj, null, 2);

    // 백업 파일 업로드
    await dbxUploadTo(backupPath, data);

    // 기존 백업 파일 목록 조회 후 오래된 것 삭제
    await pruneBackups();

    showToast('백업 완료!');
  } catch (e) {
    console.error('Backup error:', e);
    showToast('백업 실패');
  } finally {
    btn.disabled = false;
  }
}

async function dbxUploadTo(path, content, retried, attempt = 0) {
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', mute: true }),
    },
    body: content,
  });
  if (res.status === 401) {
    if (!retried && await refreshAccessToken()) return dbxUploadTo(path, content, true, attempt);
    logout(); throw new Error('auth expired');
  }
  if ((res.status === 429 || res.status === 409) && attempt < DBX_MAX_RETRY) {
    await dbxSleep(dbxRetryDelay(res, attempt));
    return dbxUploadTo(path, content, retried, attempt + 1);
  }
  if (!res.ok) throw new Error('upload failed: ' + res.status);
  return res.json();
}

async function dbxListFolder(path, retried, attempt = 0) {
  const res = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path, recursive: false }),
  });
  if (res.status === 409 || res.status === 404) return [];
  if (res.status === 401) {
    if (!retried && await refreshAccessToken()) return dbxListFolder(path, true, attempt);
    logout(); throw new Error('auth expired');
  }
  if (res.status === 429 && attempt < DBX_MAX_RETRY) {
    await dbxSleep(dbxRetryDelay(res, attempt));
    return dbxListFolder(path, retried, attempt + 1);
  }
  if (!res.ok) throw new Error('list failed: ' + res.status);
  const data = await res.json();
  return data.entries || [];
}

async function dbxDelete(path, retried, attempt = 0) {
  const res = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path }),
  });
  if (res.status === 401) {
    if (!retried && await refreshAccessToken()) return dbxDelete(path, true, attempt);
    logout(); throw new Error('auth expired');
  }
  if (res.status === 429 && attempt < DBX_MAX_RETRY) {
    await dbxSleep(dbxRetryDelay(res, attempt));
    return dbxDelete(path, retried, attempt + 1);
  }
  if (!res.ok) throw new Error('delete failed: ' + res.status);
}

async function pruneBackups() {
  const entries = await dbxListFolder(BACKUP_DIR);
  const backups = entries
    .filter((e) => e['.tag'] === 'file' && e.name.startsWith('backup_'))
    .sort((a, b) => a.name.localeCompare(b.name));

  // 30개 초과 시 오래된 것부터 삭제
  while (backups.length > BACKUP_MAX) {
    const old = backups.shift();
    await dbxDelete(old.path_lower);
  }
}

// ── Auto Backup ──
function getTodayKST() {
  const now = new Date();
  // KST = UTC+9
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function markAutoBackupPending() {
  const today = getTodayKST();
  const lastDate = localStorage.getItem('auto_backup_date');
  if (lastDate !== today) {
    localStorage.setItem('auto_backup_pending', 'true');
  }
}

async function checkAutoBackup() {
  if (!accessToken) return;
  const today = getTodayKST();
  const lastDate = localStorage.getItem('auto_backup_date');
  if (lastDate === today) return; // 오늘 이미 백업함

  // Dropbox에 오늘 날짜 자동 백업 파일이 있는지 확인
  try {
    const entries = await dbxListFolder(BACKUP_DIR);
    const todayTag = today.replace(/-/g, '');
    const alreadyExists = entries.some((e) =>
      e['.tag'] === 'file' && e.name.includes(todayTag) && e.name.includes('(auto backup)')
    );
    if (alreadyExists) {
      localStorage.setItem('auto_backup_date', today);
      return;
    }
    await performAutoBackup(today);
  } catch (e) {
    console.error('Auto backup check error:', e);
  }
}

async function checkAutoBackupPending() {
  if (!accessToken) return;
  const pending = localStorage.getItem('auto_backup_pending');
  if (pending !== 'true') return;
  localStorage.removeItem('auto_backup_pending');
  await checkAutoBackup();
}

async function performAutoBackup(today) {
  try {
    const now = new Date();
    const ts = now.getFullYear()
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + '_' + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0')
      + String(now.getSeconds()).padStart(2, '0');
    const backupPath = BACKUP_DIR + '/backup_' + ts + ' (auto backup).json';
    const obj = backupPayload();
    const data = JSON.stringify(obj, null, 2);

    await dbxUploadTo(backupPath, data);
    await pruneBackups();
    localStorage.setItem('auto_backup_date', today);
    showToast('자동 백업 완료');
  } catch (e) {
    console.error('Auto backup error:', e);
  }
}

// ── Sync ──
// 합친 결과가 받은 원격과 같은가 (같으면 올릴 필요가 없다)
function sameAsRemote(remote) {
  if (!remote || Array.isArray(remote)) return false;
  const key = (arr, f) => JSON.stringify((arr || []).map(f).sort());
  const mk = (m) => m.id + ':' + m.updatedAt + ':' + (m.metaAt || 0);
  const fk = (f) => [f.id, f.name, f.parentId || '', f.sortOrder, f.updatedAt || 0, f.password || '', f.dormant ? 1 : 0].join('|');
  const tk = (t) => t.type + ':' + (t.data && t.data.id);
  const dk = (d) => d.id || d;
  return key(syncableMemos(), mk) === key(remote.memos, mk)
    && key(folders, fk) === key(remote.folders, fk)
    && key(templates, mk) === key(remote.templates, mk)
    && key(trash, tk) === key(remote.trash, tk)
    && key(deletedIds, dk) === key(remote.deletedIds, dk)
    && (masterPasswordHash || null) === (remote.masterPassword || null)
    && (masterPasswordAt || 0) === (remote.masterPasswordAt || 0);
}

// 올릴 글 = 빈 글(제목·본문 없고 폴더도 없음)을 뺀 나머지
function syncableMemos() {
  return memos.filter((m) => !isBlankMemo(m));
}

// 같은 글·폴더가 휴지통과 목록에 함께 있으면 늦게 일어난 일을 따른다.
// 지운 시각이 마지막 수정보다 늦으면 휴지통, 복원(또는 그 뒤 수정)이 더 늦으면 목록.
// 예전엔 휴지통을 기기끼리 합치기만 해서, 한 기기에서 복원해도 다른 기기 휴지통 때문에 다시 휴지통으로 갔다.
function reconcileTrash() {
  const liveMemo = new Map(memos.map((m) => [m.id, m]));
  const liveFolder = new Map(folders.map((f) => [f.id, f]));
  const dropMemo = new Set(), dropFolder = new Set();
  trash = trash.filter((t) => {
    const id = t.data && t.data.id;
    const live = t.type === 'folder' ? liveFolder.get(id) : liveMemo.get(id);
    if (!live) return true;
    if ((live.updatedAt || 0) > (t.deletedAt || 0)) return false;   // 복원이 더 늦다 → 휴지통 항목을 버린다
    (t.type === 'folder' ? dropFolder : dropMemo).add(id);          // 삭제가 더 늦다 → 목록에서 뺀다
    return true;
  });
  if (dropMemo.size) memos = memos.filter((m) => !dropMemo.has(m.id));
  if (dropFolder.size) folders = folders.filter((f) => !dropFolder.has(f.id));
}

// ── 글 버전 가리기 ──
// 시각(updatedAt)은 '안 고친 옛 내용'에도 찍힐 수 있다(옛 앱, 편집기에 남은 옛 내용 등).
// 그래서 어느 쪽이 새 버전인지는 내용 지문으로 가린다.
//   ver = 이 글을 마지막으로 올릴 때 내용의 지문, anc = 그 전에 거쳐 온 지문들(최근 것부터)
// 한쪽의 지금 내용이 다른 쪽이 이미 지나온 지문이면, 시각이 아무리 늦어도 뒤처진 사본이다.

// 글자열 지문(53비트). 같은 내용이면 어느 기기에서나 같은 값
function textHash(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const hashCache = new WeakMap();
// 글 지문 = 제목+본문. 폴더·형광펜·즐겨찾기는 넣지 않는다
function memoHash(m) {
  const c = hashCache.get(m);
  if (c && c.t === m.title && c.c === m.content) return c.h;
  const h = textHash((m.title || '') + '\u0000' + (m.content || ''));
  hashCache.set(m, { t: m.title, c: m.content, h });
  return h;
}

const ANC_MAX = 100;
// 올리기 직전, 내용이 바뀐 글에 새 지문을 새기고 이전 지문을 계보 맨 앞에 넣는다. 바뀐 게 있으면 true
function stampLineage(list) {
  const base = getSyncBase();
  let changed = false;
  for (const m of list) {
    const h = memoHash(m);
    if (m.ver === h) continue;
    // 처음 새길 때는 지난 동기화 때 지문을 이전 버전으로 삼는다
    const prev = m.ver || baseOf(base, m.id).h;
    if (prev && prev !== h) m.anc = [prev].concat((m.anc || []).filter((x) => x !== prev && x !== h)).slice(0, ANC_MAX);
    m.ver = h;
    changed = true;
  }
  return changed;
}

// 이 글이 거쳐 온 버전들의 지문 — 지금 내용이 맨 앞, 옛것일수록 뒤
function lineageOf(m) {
  const h = memoHash(m);
  const list = [h];
  if (m.ver && m.ver !== h) list.push(m.ver);   // 올린 뒤 이 기기에서 더 고쳤다
  for (const x of m.anc || []) if (x !== h) list.push(x);
  return list;
}

// a의 지금 내용이 b가 예전에 거쳐 온 버전이고, a는 그 뒤의 b 버전을 본 적이 없다 → a는 뒤처진 사본
function isBehind(a, b) {
  const la = lineageOf(a), lb = lineageOf(b);
  const i = lb.indexOf(la[0]);
  if (i < 1) return false;
  const newer = new Set(lb.slice(0, i));
  return !la.some((x, k) => k > 0 && newer.has(x));
}

// 기준점(sync_base) 한 칸 읽기. 글은 { t: 시각, h: 지문 }, 예전 형식(시각 숫자)도 읽는다
function baseOf(base, key) {
  const b = base[key];
  if (b == null) return { t: null, h: null };
  if (typeof b === 'number') return { t: b, h: null };
  return { t: b.t, h: b.h || null };
}

// 지난 동기화 이후 이 기기에서 안 바뀌었나 — 지문이 있으면 내용으로, 없으면 시각으로
function sameAsBase(m, b) {
  if (b.h) return memoHash(m) === b.h;
  return b.t != null && (m.updatedAt || 0) <= b.t;
}

// 같은 글의 두 버전 중 무엇을 남길지. 시각은 마지막에만 본다.
function pickVersion(l, r, b) {
  const later = (l.updatedAt || 0) >= (r.updatedAt || 0) ? l : r;
  if (memoHash(l) === memoHash(r)) return { winner: later };
  if (isBehind(r, l)) return { winner: l };   // 원격은 이 기기가 이미 지나온 옛 버전
  if (isBehind(l, r)) return { winner: r };   // 이 기기가 뒤처졌다
  // 지난 동기화 때 버전과 비교 — 한쪽만 바뀌었으면 바뀐 쪽
  const ls = sameAsBase(l, b), rs = sameAsBase(r, b);
  if (ls && !rs) return { winner: r };
  if (rs && !ls) return { winner: l };
  // 양쪽이 각자 고쳤거나 가릴 근거가 없다 → 늦은 쪽을 본문으로, 다른 쪽은 충돌본으로 남긴다
  return { winner: later, conflict: true };
}

// 지금 상태를 다음 합치기의 기준점으로 (글은 시각+지문, 폴더는 시각)
function baseSnapshot(list) {
  const base = {};
  for (const m of list) base[m.id] = { t: m.updatedAt, h: memoHash(m) };
  for (const f of folders) base['f:' + f.id] = f.updatedAt || 0;
  return base;
}

// 이 기기가 지난번 동기화 때 갖고 있던(= 원격에도 있던) 그대로인가.
// 기준점(sync_base)이 있으면 그것으로, 없으면 마지막 동기화 시각으로 판단한다.
function syncedAndUnchanged(item, key, base) {
  const b = baseOf(base || getSyncBase(), key);
  if (b.t != null || b.h) return sameAsBase(item, b);
  const last = Number(localStorage.getItem('last_synced_at')) || 0;
  return last > 0 && (item.updatedAt || 0) > 0 && (item.updatedAt || 0) <= last;
}

// 원격에서 사라진 글·폴더 처리. 지난번 동기화 때 함께 있었고 이 기기에서 그 뒤 손대지 않았다면
// 다른 기기에서 지운 것이다 → 다시 올리지 않고 휴지통으로 옮긴다(되살리지 않되, 혹시 몰라 복원은 가능).
// 오래(30일 넘게) 쉰 기기가 옛 글을 '새 글'로 착각해 DB를 되돌리던 문제를 막는다.
function retireGoneItems(remote) {
  const now = Date.now();
  if (Array.isArray(remote.memos)) {
    const ids = new Set(remote.memos.map((m) => m.id));
    const base = getSyncBase();
    const gone = memos.filter((m) => !ids.has(m.id) && !isBlankMemo(m) && syncedAndUnchanged(m, m.id, base));
    if (gone.length) {
      for (const m of gone) trash.push({ type: 'memo', data: { ...m }, deletedAt: now });
      const g = new Set(gone.map((m) => m.id));
      memos = memos.filter((m) => !g.has(m.id));
    }
  }
  if (Array.isArray(remote.folders)) {
    const ids = new Set(remote.folders.map((f) => f.id));
    const base = getSyncBase();
    const gone = folders.filter((f) => !ids.has(f.id) && base['f:' + f.id] != null && (f.updatedAt || 0) <= base['f:' + f.id]);
    if (gone.length) {
      for (const f of gone) trash.push({ type: 'folder', data: { ...f }, deletedAt: now });
      const g = new Set(gone.map((f) => f.id));
      folders = folders.filter((f) => !g.has(f.id));
    }
  }
}

// 원격 파일을 받아 이 기기 내용과 합친다 (올리지는 않는다). 파일이 없으면 true를 돌려준다.
// 합친 결과가 원격과 다르면 '보낼 것 있음'으로, 같으면 '동기화됨'으로 표시한다.
async function pullAndMerge() {
  lastPullAt = Date.now();
  const remote = await dbxDownload();
  if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
    // 이 앱보다 새 규칙으로 쓰인 파일이면 올리지 않는다(옛 화면이 새 데이터를 망가뜨리지 않게)
    if ((remote.dataVersion || 0) > DATA_VERSION) markOutdated();
    retireGoneItems(remote);
    if (Array.isArray(remote.deletedIds)) deletedIds = mergeDeletedIds(deletedIds, remote.deletedIds);
    if (Array.isArray(remote.trash)) trash = mergeTrash(trash, remote.trash);
    if (Array.isArray(remote.memos)) memos = mergeMemos(memos, remote.memos);
    if (Array.isArray(remote.folders)) folders = mergeFolders(folders, remote.folders);
    if (Array.isArray(remote.templates)) templates = mergeTemplates(templates, remote.templates);
    const rAt = remote.masterPasswordAt || 0;
    if (rAt > masterPasswordAt || (rAt === masterPasswordAt && !masterPasswordHash && remote.masterPassword)) {
      masterPasswordHash = remote.masterPassword || null;
      masterPasswordAt = rAt;
    }
  } else if (remote && Array.isArray(remote)) {
    memos = mergeMemos(memos, remote);
  }
  reconcileTrash();
  saveLocalData(false);
  if (sameAsRemote(remote)) markSynced();
  else localStorage.setItem('pending_sync', '1');
  // 합친 즉시 편집기에도 반영한다 — 글은 바뀌었는데 편집기에 옛 내용이 남아 있으면,
  // 그 위에 한 글자만 쳐도 옛 내용이 '방금 고친 최신'으로 올라간다(예전엔 올리기가 끝난 뒤에야 반영했다)
  refreshOpenMemo();
  return remote === null;
}

// 동기화로 지금 열린 글이 바뀌었으면 편집기에 반영한다 (커서 위치는 최대한 유지)
function refreshOpenMemo() {
  if (!currentId) return;
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) { currentId = null; hideEditor(); return; }
  if (editor.value !== memo.content) {
    const pos = Math.min(editor.selectionStart, memo.content.length);
    editor.value = memo.content;
    try { editor.setSelectionRange(pos, pos); } catch { /* 포커스 없으면 무시 */ }
    updateCharCount();
    repaintOverlay();
  }
  if (titleInput.value !== memo.title) titleInput.value = memo.title;
  updateMemoDates(memo);
}

function syncFromDropbox() {
  if (!accessToken) return Promise.resolve();
  setSyncStatus('syncing', '동기화 중...');
  return queueSync(async () => {
    try {
      const remoteMissing = await pullAndMerge();
      // Dropbox 에 파일이 없는데 이 기기도 비어 있으면, 빈 파일을 만들지 않고 멈춘다.
      // (저장 경로가 어긋났을 때 빈 파일이 생겨 노트가 사라진 것처럼 보이는 사고 방지)
      if (remoteMissing && isLocalEmpty()) {
        setSyncStatus('error', '저장 파일 없음');
        showToast('Dropbox에서 저장 파일을 찾지 못했습니다. 빈 내용을 올리지 않았습니다.');
        renderAll();
        return;
      }
      // 이 기기에만 있는 변경이 있을 때만 올린다 (매번 900KB를 올리지 않게)
      if (remoteMissing || isDirty()) await uploadNow();
      setSyncStatus('synced', '동기화 완료');
      renderAll();
      refreshOpenMemo();
    } catch (e) {
      console.error('Sync error:', e);
      setSyncStatus('error', '동기화 실패');
    }
  });
}

// 이 기기에 내용이 하나도 없는 상태인가(글·폴더·템플릿·휴지통 모두 빔)
function isLocalEmpty() {
  return syncableMemos().length === 0 && folders.length === 0 && templates.length === 0 && trash.length === 0;
}

// force=true 는 사용자가 직접 전부 지운 경우처럼 빈 상태를 일부러 올릴 때만
function syncToDropbox(force) {
  if (!accessToken) return Promise.resolve();
  return queueSync(() => uploadNow(force));
}

async function uploadNow(force, retriedConflict) {
  if (!accessToken || outdatedClient) return;
  // 안전장치: 빈 내용으로 Dropbox 파일을 덮어쓰지 않는다.
  // (경로가 어긋나거나 로그인 직후 아직 못 받아온 상태에서 올리면 원격 노트가 날아간다)
  if (!force && isLocalEmpty()) {
    console.warn('빈 상태라 업로드를 건너뜀');
    return;
  }
  // 아직 아무것도 안 쓴 빈 글은 올리지 않는다 — 기기마다 지웠다 되살렸다 하며 전송만 늘었다
  const list = syncableMemos();
  // 내용이 바뀐 글에 새 지문·계보를 새긴다(다른 기기가 뒤처진 사본을 가려내는 근거)
  if (stampLineage(list) || localSaveTimer) saveLocalData(false);
  const obj = { memos: list, folders, trash, deletedIds, templates, masterPasswordAt, dataVersion: DATA_VERSION };
  if (masterPasswordHash) obj.masterPassword = masterPasswordHash;
  const body = JSON.stringify(obj);   // 들여쓰기 없이 — 올리는 양이 줄어 휴대폰에서 끊길 일이 적다
  // 기준점은 '올린 그 순간'의 상태로 — 올리는 동안 고친 것까지 '동기화됨'으로 적으면 그 수정이 다음 합치기에서 진다
  const base = baseSnapshot(list);
  const seq = changeSeq;
  try {
    await dbxUpload(body);
  } catch (e) {
    // 그사이 다른 기기가 올렸으면: 그것을 받아 합친 뒤 합친 내용으로 다시 올린다
    if (e && e.revConflict && !retriedConflict) {
      await pullAndMerge();
      renderAll();
      return uploadNow(force, true);
    }
    throw e;
  }
  markSynced(base, seq === changeSeq && !localSaveTimer);
}

// 같은 글을 두 기기가 각자 고쳤을 때 늦게 고친 쪽을 본문으로 두고,
// 진 쪽은 '충돌본'이라는 새 글로 남긴다. 그래야 한쪽 글이 소리 없이 사라지지 않는다.
function conflictCopy(m) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  const copy = {
    ...m,
    id: crypto.randomUUID(),
    title: (m.title || '제목 없음') + ` (충돌본 ${stamp})`,
    conflictOf: m.id,
    conflictFrom: m.updatedAt,   // 어느 버전의 사본인지 — 사본을 고쳐도 같은 사본을 또 만들지 않게
    updatedAt: Date.now(),
  };
  delete copy.ver; delete copy.anc;   // 계보는 원본 글의 것 — 사본은 새 글로 시작
  return copy;
}

function mergeMemos(local, remote) {
  const localById = new Map(local.map((m) => [m.id, m]));
  const map = new Map();
  const extras = [];
  const syncBase = getSyncBase();
  // 다른 기기가 이미 만든 같은 충돌본이 있으면 또 만들지 않는다
  const copied = new Set(local.concat(remote).filter((m) => m.conflictOf).map((m) => m.conflictOf + '|' + m.conflictFrom));
  for (const r of remote) {
    const l = localById.get(r.id);
    if (!l) { map.set(r.id, r); continue; }
    const pick = pickVersion(l, r, baseOf(syncBase, r.id));
    let winner = pick.winner;
    const loser = winner === l ? r : l;
    // 뒤처진 쪽에 더 늦은 시각이 찍혀 있었으면 남길 쪽 시각을 그 바로 뒤로 —
    // 시각만 보는 옛 앱도 같은 버전을 고르고, 목록 순서도 맞는다
    if ((loser.updatedAt || 0) > (winner.updatedAt || 0)) winner = { ...winner, updatedAt: loser.updatedAt + 1 };
    // 즐겨찾기·보기모드는 글 내용과 따로 — 그쪽을 늦게 바꾼 기기의 값을 따른다
    if ((loser.metaAt || 0) > (winner.metaAt || 0)) {
      winner = { ...winner, favorite: loser.favorite, favoritedAt: loser.favoritedAt, viewerMode: loser.viewerMode, metaAt: loser.metaAt };
    }
    map.set(r.id, winner);
    if (pick.conflict && !copied.has(loser.id + '|' + loser.updatedAt)) {
      extras.push(conflictCopy(loser));
      copied.add(loser.id + '|' + loser.updatedAt);
    }
  }
  for (const m of local) if (!map.has(m.id)) map.set(m.id, m);
  const permDelIds = new Set(deletedIds.map((d) => d.id || d));
  return Array.from(map.values()).concat(extras)
    .filter((m) => !m.deleted && !permDelIds.has(m.id))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function mergeFolders(local, remote) {
  const permDelIds = new Set(deletedIds.map((d) => d.id || d));
  const map = new Map();
  for (const f of remote) { if (!permDelIds.has(f.id)) map.set(f.id, f); }
  for (const f of local) {
    if (permDelIds.has(f.id)) continue;
    const r = map.get(f.id);
    // 늦게 고친 쪽이 이긴다 (예전엔 원격이 늘 이겨, 이 기기에서 바꾼 이름·순서가 되돌아갔다)
    if (!r || (f.updatedAt || 0) > (r.updatedAt || 0)) map.set(f.id, f);
  }
  const result = Array.from(map.values());
  result.forEach((f, i) => { if (f.sortOrder === undefined) f.sortOrder = i; });
  return result.sort(sortBySortOrder);
}

function mergeTrash(local, remote) {
  const permDelIds = new Set(deletedIds.map((d) => d.id || d));
  const map = new Map();
  for (const t of remote) {
    if (!permDelIds.has(t.data.id)) map.set(t.data.id + '_' + t.type, t);
  }
  for (const t of local) {
    const key = t.data.id + '_' + t.type;
    if (!map.has(key) && !permDelIds.has(t.data.id)) map.set(key, t);
  }
  return Array.from(map.values()).sort((a, b) => b.deletedAt - a.deletedAt);
}

// 영구 삭제 기록은 지우지 않는다. 예전엔 30일 뒤 지웠더니, 30일 넘게 안 켠 기기가 자기에게 남은 글을
// '새 글'로 보고 다시 올려 지운 글이 되살아났다. 한 건에 수십 바이트라 계속 쌓여도 부담이 없다.
function mergeDeletedIds(local, remote) {
  const map = new Map();
  for (const d of remote.concat(local)) {
    const item = typeof d === 'string' ? { id: d, at: 0 } : d;
    if (!map.has(item.id)) map.set(item.id, item);
  }
  return Array.from(map.values());
}

// ── Local Storage ──
// 최근 저장/동기화 시각을 연월일시분초로 표시 (햄버거 옆 영역)
function fmtFullTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function updateSaveSyncTimes() {
  const savedEl = $('#last-saved-time');
  const syncedEl = $('#last-synced-time');
  if (savedEl) savedEl.textContent = '최근 저장 ' + fmtFullTime(localStorage.getItem('last_saved_at'));
  if (syncedEl) syncedEl.textContent = '최근 동기화 ' + fmtFullTime(localStorage.getItem('last_synced_at'));
}

// base: 원격과 같아진 상태(올린 그 순간의 상태). 없으면 지금 상태. clean=false면 그 뒤 고친 게 있어 '보낼 것'을 남긴다
function markSynced(base, clean = true) {
  localStorage.setItem('last_synced_at', String(Date.now()));
  localStorage.setItem('pending_sync', clean ? '0' : '1');
  // 원격과 같아진 내용을 다음 합치기의 기준점으로 삼는다
  localStorage.setItem('sync_base', JSON.stringify(base || baseSnapshot(syncableMemos())));
  updateSaveSyncTimes();
}

function saveLocalData(changed = true) {
  clearTimeout(localSaveTimer);
  localSaveTimer = null;
  localStorage.setItem('memos', JSON.stringify(memos));
  localStorage.setItem('folders', JSON.stringify(folders));
  localStorage.setItem('trash', JSON.stringify(trash));
  localStorage.setItem('deletedIds', JSON.stringify(deletedIds));
  localStorage.setItem('templates', JSON.stringify(templates));
  if (masterPasswordHash) localStorage.setItem('master_pw', masterPasswordHash);
  else localStorage.removeItem('master_pw');
  localStorage.setItem('master_pw_at', String(masterPasswordAt || 0));
  localStorage.setItem('last_saved_at', String(Date.now()));
  if (changed) { localStorage.setItem('pending_sync', '1'); changeSeq++; }   // 아직 클라우드로 못 보낸 변경이 있다
  updateSaveSyncTimes();
}

function loadLocalData() {
  try {
    const md = localStorage.getItem('memos');
    if (md) memos = JSON.parse(md);
    const fd = localStorage.getItem('folders');
    if (fd) folders = JSON.parse(fd);
    const td = localStorage.getItem('trash');
    if (td) trash = JSON.parse(td);
    const dd = localStorage.getItem('deletedIds');
    if (dd) deletedIds = JSON.parse(dd);
    const tp = localStorage.getItem('templates');
    if (tp) templates = JSON.parse(tp);
    masterPasswordHash = localStorage.getItem('master_pw') || null;
    masterPasswordAt = Number(localStorage.getItem('master_pw_at')) || 0;
    // 마이그레이션: sortOrder 없는 폴더에 순번 부여
    folders.forEach((f, i) => { if (f.sortOrder === undefined) f.sortOrder = i; });
  } catch {}
}

function sortBySortOrder(a, b) { return (a.sortOrder ?? 999) - (b.sortOrder ?? 999); }

function getChildFolders(parentId) {
  return folders.filter((f) => f.parentId === parentId).sort(sortBySortOrder);
}

function nextSortOrder(parentId) {
  const siblings = folders.filter((f) => (f.parentId || null) === (parentId || null));
  return siblings.length === 0 ? 0 : Math.max(...siblings.map((f) => f.sortOrder ?? 0)) + 1;
}

function isVisibleMemo(m) {
  return m.title.trim() || m.content.trim();
}

function getFolderMemoCount(folderId) {
  const childIds = getChildFolders(folderId).map((f) => f.id);
  return memos.filter((m) => (m.folder === folderId || childIds.includes(m.folder)) && isVisibleMemo(m)).length;
}

function getDormantFolderIds() {
  const ids = new Set();
  for (const f of folders) {
    if (f.dormant) {
      ids.add(f.id);
      getChildFolders(f.id).forEach((c) => ids.add(c.id));
    }
    // 부모가 휴면이면 자식도 휴면
    if (f.parentId) {
      const parent = folders.find((p) => p.id === f.parentId);
      if (parent && parent.dormant) ids.add(f.id);
    }
  }
  return ids;
}

function toggleDormant(folderId) {
  const f = folders.find((x) => x.id === folderId);
  if (!f) return;
  f.dormant = !f.dormant;
  f.updatedAt = Date.now();
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
  showToast(f.dormant ? '휴면 처리되었습니다' : '휴면이 해제되었습니다');
}

// ── Folder Password ──
async function hashPassword(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isFolderLocked(folderId) {
  const f = folders.find((f) => f.id === folderId);
  if (!f) return false;
  if (f.password && !unlockedFolders.has(folderId)) return true;
  if (f.parentId) return isFolderLocked(f.parentId);
  return false;
}

function getLockedFolderIds() {
  return folders.filter((f) => isFolderLocked(f.id)).map((f) => f.id);
}

function showPasswordPrompt(folderId, onSuccess) {
  const f = folders.find((f) => f.id === folderId);
  if (!f) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <p>🔒 "${escapeHtml(f.name)}" 폴더 비밀번호</p>
      <input type="password" id="pw-input" placeholder="비밀번호 입력" autofocus>
      <div>
        <button class="btn btn-secondary" id="pw-cancel">취소</button>
        <button class="btn btn-primary" id="pw-ok">확인</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#pw-input');
  input.focus();

  const check = async () => {
    const hash = await hashPassword(input.value);
    if (hash === f.password || (masterPasswordHash && hash === masterPasswordHash)) {
      unlockedFolders.add(folderId);
      overlay.remove();
      if (onSuccess) onSuccess();
    } else {
      input.value = '';
      input.placeholder = '비밀번호가 틀렸습니다';
      input.classList.add('error');
    }
  };

  overlay.querySelector('#pw-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#pw-ok').onclick = check;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') check(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function showSetPasswordDialog(folderId) {
  const f = folders.find((f) => f.id === folderId);
  if (!f) return;
  const hasPassword = !!f.password;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <p>${hasPassword ? '🔒 비밀번호 변경/해제' : '🔓 비밀번호 설정'} — "${escapeHtml(f.name)}"</p>
      ${hasPassword ? '<input type="password" id="pw-old" placeholder="현재 비밀번호" autofocus><br>' : ''}
      <input type="password" id="pw-new" placeholder="새 비밀번호 (해제하려면 비워두세요)" ${hasPassword ? '' : 'autofocus'}>
      <input type="password" id="pw-confirm" placeholder="새 비밀번호 확인">
      <div>
        <button class="btn btn-secondary" id="pw-cancel">취소</button>
        <button class="btn btn-primary" id="pw-ok">${hasPassword ? '변경' : '설정'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  (overlay.querySelector('#pw-old') || overlay.querySelector('#pw-new')).focus();

  const apply = async () => {
    // 기존 비밀번호 확인 (Master도 허용)
    if (hasPassword) {
      const oldInput = overlay.querySelector('#pw-old');
      const oldHash = await hashPassword(oldInput.value);
      if (oldHash !== f.password && !(masterPasswordHash && oldHash === masterPasswordHash)) {
        oldInput.value = '';
        oldInput.placeholder = '현재 비밀번호가 틀렸습니다';
        oldInput.classList.add('error');
        return;
      }
    }
    const newPw = overlay.querySelector('#pw-new').value;
    const confirmPw = overlay.querySelector('#pw-confirm').value;
    if (newPw === '' && confirmPw === '') {
      // 비밀번호 해제
      f.password = null;
      f.updatedAt = Date.now();
      unlockedFolders.delete(folderId);
      showToast('비밀번호가 해제되었습니다');
    } else if (newPw !== confirmPw) {
      overlay.querySelector('#pw-confirm').value = '';
      overlay.querySelector('#pw-confirm').placeholder = '비밀번호가 일치하지 않습니다';
      overlay.querySelector('#pw-confirm').classList.add('error');
      return;
    } else {
      f.password = await hashPassword(newPw);
      f.updatedAt = Date.now();
      unlockedFolders.add(folderId);
      showToast('비밀번호가 설정되었습니다');
    }
    saveLocalData();
    renderAll();
    scheduleSyncToDropbox();
    overlay.remove();
  };

  overlay.querySelector('#pw-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#pw-ok').onclick = apply;
  overlay.querySelector('#pw-confirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ── Master Password ──
function showMasterPasswordDialog() {
  const hasMaster = !!masterPasswordHash;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <p>${hasMaster ? '🔐 Master 변경/해제' : '🔐 Master 설정'}</p>
      ${hasMaster ? '<input type="password" id="mp-old" placeholder="현재 Master" autofocus>' : ''}
      <input type="password" id="mp-new" placeholder="새 Master (해제하려면 비워두세요)" ${hasMaster ? '' : 'autofocus'}>
      <input type="password" id="mp-confirm" placeholder="새 Master 확인">
      <div>
        <button class="btn btn-secondary" id="mp-cancel">취소</button>
        <button class="btn btn-primary" id="mp-ok">${hasMaster ? '변경' : '설정'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  (overlay.querySelector('#mp-old') || overlay.querySelector('#mp-new')).focus();

  const apply = async () => {
    if (hasMaster) {
      const oldInput = overlay.querySelector('#mp-old');
      const oldHash = await hashPassword(oldInput.value);
      if (oldHash !== masterPasswordHash) {
        oldInput.value = '';
        oldInput.placeholder = '현재 비밀번호가 틀렸습니다';
        oldInput.classList.add('error');
        return;
      }
    }
    const newPw = overlay.querySelector('#mp-new').value;
    const confirmPw = overlay.querySelector('#mp-confirm').value;
    if (newPw === '' && confirmPw === '') {
      masterPasswordHash = null;
      masterPasswordAt = Date.now();
      showToast('Master가 해제되었습니다');
    } else if (newPw !== confirmPw) {
      overlay.querySelector('#mp-confirm').value = '';
      overlay.querySelector('#mp-confirm').placeholder = '비밀번호가 일치하지 않습니다';
      overlay.querySelector('#mp-confirm').classList.add('error');
      return;
    } else {
      masterPasswordHash = await hashPassword(newPw);
      masterPasswordAt = Date.now();
      showToast('Master가 설정되었습니다');
    }
    saveLocalData();
    scheduleSyncToDropbox();
    overlay.remove();
  };

  overlay.querySelector('#mp-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#mp-ok').onclick = apply;
  overlay.querySelector('#mp-confirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function showMasterUnlockPrompt() {
  if (!masterPasswordHash) {
    showToast('Master가 설정되지 않았습니다');
    return;
  }
  const lockedIds = getLockedFolderIds();
  if (lockedIds.length === 0) {
    showToast('잠긴 폴더가 없습니다');
    return;
  }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <p>🔐 Master로 전체 잠금 해제</p>
      <input type="password" id="mu-input" placeholder="Master" autofocus>
      <div>
        <button class="btn btn-secondary" id="mu-cancel">취소</button>
        <button class="btn btn-primary" id="mu-ok">해제</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#mu-input');
  input.focus();

  const check = async () => {
    const hash = await hashPassword(input.value);
    if (hash === masterPasswordHash) {
      lockedIds.forEach((id) => unlockedFolders.add(id));
      overlay.remove();
      renderAll();
      showToast('모든 폴더 잠금이 해제되었습니다');
    } else {
      input.value = '';
      input.placeholder = '비밀번호가 틀렸습니다';
      input.classList.add('error');
    }
  };

  overlay.querySelector('#mu-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#mu-ok').onclick = check;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') check(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ── Folder CRUD ──
function showFolderDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <p>새 폴더 이름</p>
      <input type="text" id="folder-name-input" placeholder="폴더 이름" autofocus>
      <div>
        <button class="btn btn-secondary" id="folder-cancel">취소</button>
        <button class="btn btn-primary" id="folder-ok">만들기</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#folder-name-input');
  input.focus();

  const create = () => {
    const name = input.value.trim();
    if (name) {
      // 현재 폴더가 최상위 폴더이면 하위 폴더로 생성, 아니면 최상위로
      let parentId = null;
      if (currentFolder && currentFolder !== '__none__') {
        const cur = folders.find((f) => f.id === currentFolder);
        if (cur && !cur.parentId) parentId = cur.id; // 최상위 폴더 아래에만 하위 생성
      }
      folders.push({ id: crypto.randomUUID(), name, parentId, sortOrder: nextSortOrder(parentId), updatedAt: Date.now() });
      saveLocalData();
      renderAll();
      scheduleSyncToDropbox();
    }
    overlay.remove();
  };

  overlay.querySelector('#folder-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#folder-ok').onclick = create;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function showMoveFolderDialog(id) {
  const folder = folders.find((f) => f.id === id);
  if (!folder) return;
  // 이동 가능한 대상: 최상위로 + 자기 자신과 자기 하위 폴더를 제외한 최상위 폴더
  const childIds = getChildFolders(id).map((f) => f.id);
  // 하위 폴더를 가진 폴더를 다른 폴더 아래로 넣으면 3단계가 되어 목록에서 보이지 않는다 → 최상위로만
  const topFolders = childIds.length ? [] : folders.filter((f) => !f.parentId && f.id !== id && !childIds.includes(f.id)).sort(sortBySortOrder);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  let optionsHtml = `<option value="">-- 최상위 --</option>`;
  for (const f of topFolders) {
    const selected = folder.parentId === f.id ? ' selected' : '';
    optionsHtml += `<option value="${f.id}"${selected}>${escapeHtml(f.name)}</option>`;
  }
  overlay.innerHTML = `
    <div class="modal-box">
      <p>"${escapeHtml(folder.name)}" 폴더를 이동</p>
      <select id="move-folder-select" style="width:100%;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:0.9rem;outline:none;margin-bottom:16px;">
        ${optionsHtml}
      </select>
      <button class="btn btn-secondary" id="movef-cancel">취소</button>
      <button class="btn btn-primary" id="movef-ok">이동</button>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#movef-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#movef-ok').onclick = () => {
    const newParent = overlay.querySelector('#move-folder-select').value || null;
    overlay.remove();
    if (newParent === (folder.parentId || null)) return;   // 그대로 두기를 골랐으면 순서도 건드리지 않는다
    // 하위로 들어가면 휴면이 풀린다(부모를 따른다). 최상위로 나오면 지금 칸(사용 중/휴면) 맨 끝으로
    const plan = planFolderMove(id, { parentId: newParent, dormant: !newParent && !!folder.dormant });
    if (!plan) return;
    applyFolderMove(plan);
    showToast('폴더가 이동되었습니다');
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

function confirmDeleteFolder(id) {
  confirmDeleteFolders([id]);
}

// 여러 폴더를 한꺼번에 지운다(2번 확인). 부모와 하위를 같이 골랐으면 하위는 부모와 함께 지워지므로 따로 세지 않는다
function confirmDeleteFolders(ids, onDone) {
  const picked = ids.map((id) => folders.find((f) => f.id === id)).filter(Boolean);
  const pickedIds = new Set(picked.map((f) => f.id));
  const roots = picked.filter((f) => !(f.parentId && pickedIds.has(f.parentId)));
  if (!roots.length) return;
  const allIds = new Set();
  roots.forEach((f) => { allIds.add(f.id); getChildFolders(f.id).forEach((c) => allIds.add(c.id)); });
  const childCount = allIds.size - roots.length;
  const memoCount = memos.filter((m) => allIds.has(m.folder)).length;
  const label = roots.length === 1 ? `"${escapeHtml(roots[0].name)}" 폴더` : `${roots.length}개 폴더`;
  const childNote = childCount > 0 ? '하위 폴더 ' + childCount + '개, ' : '';
  const detailNote = (memoCount > 0 || childCount > 0) ? '<br><span style="font-size:0.85rem;color:var(--text2)">' + childNote + '메모 ' + memoCount + '개도 휴지통으로 이동합니다.</span>' : '';

  // 1차 확인
  const o1 = document.createElement('div');
  o1.className = 'modal-overlay';
  o1.innerHTML = `<div class="modal-box"><p>${label}를 삭제할까요?${detailNote}</p><button class="btn btn-secondary" id="fdel-cancel">취소</button> <button class="btn btn-primary" id="fdel-ok">삭제</button></div>`;
  document.body.appendChild(o1);
  o1.querySelector('#fdel-cancel').onclick = () => o1.remove();
  o1.addEventListener('click', (e) => { if (e.target === o1) o1.remove(); });
  o1.querySelector('#fdel-ok').onclick = () => {
    o1.remove();
    // 2차 확인
    const o2 = document.createElement('div');
    o2.className = 'modal-overlay';
    o2.innerHTML = `<div class="modal-box"><p>${label}를 정말 삭제할까요?</p><button class="btn btn-secondary" id="fdel-cancel2">취소</button> <button class="btn btn-primary" id="fdel-ok2">삭제</button></div>`;
    document.body.appendChild(o2);
    o2.querySelector('#fdel-cancel2').onclick = () => o2.remove();
    o2.addEventListener('click', (e) => { if (e.target === o2) o2.remove(); });
    o2.querySelector('#fdel-ok2').onclick = () => {
      o2.remove();
      roots.forEach((f) => deleteFolder(f.id));
      if (roots.length > 1) showToast(roots.length + '개 폴더가 휴지통으로 이동되었습니다');
      if (onDone) onDone();
    };
  };
}

// 여러 최상위 폴더를 한꺼번에 휴면 처리/해제 (하위 폴더는 부모를 따르므로 건너뛴다)
function setFoldersDormant(ids, on) {
  const now = Date.now();
  let n = 0;
  for (const id of ids) {
    const f = folders.find((x) => x.id === id);
    if (!f || f.parentId || !!f.dormant === on) continue;
    f.dormant = on;
    f.updatedAt = now;
    n++;
  }
  if (!n) return;
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
  showToast(n + '개 폴더' + (on ? '가 휴면 처리되었습니다' : '의 휴면이 해제되었습니다'));
}

function deleteFolder(id) {
  const folder = folders.find((f) => f.id === id);
  const childFolders = getChildFolders(id);
  const allIds = [id, ...childFolders.map((f) => f.id)];
  // 폴더 + 하위 폴더 내 메모들을 휴지통으로 이동
  const folderMemos = memos.filter((m) => allIds.includes(m.folder));
  for (const m of folderMemos) {
    trash.push({ type: 'memo', data: { ...m }, deletedAt: Date.now() });
  }
  memos = memos.filter((m) => !allIds.includes(m.folder));
  // 하위 폴더 휴지통으로
  for (const cf of childFolders) {
    trash.push({ type: 'folder', data: { ...cf }, deletedAt: Date.now() });
  }
  // 폴더 자체도 휴지통으로
  if (folder) {
    trash.push({ type: 'folder', data: { ...folder }, deletedAt: Date.now() });
  }
  folders = folders.filter((f) => !allIds.includes(f.id));
  if (allIds.includes(currentFolder)) currentFolder = null;
  if (currentId && folderMemos.some((m) => m.id === currentId)) {
    currentId = null;
    hideEditor();
  }
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
  showToast('폴더가 휴지통으로 이동되었습니다');
}

// ── 폴더 옮기기 (순서·상위 폴더·휴면 칸) ──
// target = { parentId, dormant, beforeId } — beforeId 앞에 넣는다(없으면 그 칸 맨 끝).
// 최상위는 [사용 중 …, 휴면 …]을 한 줄로 보고 번호를 다시 매긴다. 실제로 자리가 바뀌는지(moved)도 함께 돌려준다.
function planFolderMove(id, { parentId = null, dormant = false, beforeId = null } = {}) {
  const f = folders.find((x) => x.id === id);
  if (!f || parentId === id) return null;
  if (parentId) {
    const p = folders.find((x) => x.id === parentId);
    if (!p || p.parentId) return null;                      // 2단계까지만
    if (folders.some((c) => c.parentId === id)) return null; // 하위 폴더가 있는 폴더는 최상위로만
    dormant = false;                                         // 하위 폴더는 부모의 휴면을 따른다
  }
  dormant = !!dormant;
  const group = folders.filter((x) => (x.parentId || null) === parentId);
  const before = parentId
    ? group.sort(sortBySortOrder)
    : [...group.filter((x) => !x.dormant).sort(sortBySortOrder), ...group.filter((x) => x.dormant).sort(sortBySortOrder)];
  // 자기 자신 앞 = 지금 자리 그대로(바로 다음 폴더 앞)
  if (beforeId === id) { const i = before.findIndex((x) => x.id === id); beforeId = before[i + 1] ? before[i + 1].id : null; }
  const list = before.filter((x) => x.id !== id);
  let idx = beforeId ? list.findIndex((x) => x.id === beforeId) : -1;
  if (idx < 0) idx = (parentId || dormant) ? list.length : list.filter((x) => !x.dormant).length;
  list.splice(idx, 0, f);
  const moved = (f.parentId || null) !== parentId || !!f.dormant !== dormant ||
    before.map((x) => x.id).join() !== list.map((x) => x.id).join();
  return { f, parentId, dormant, list, moved };
}

function applyFolderMove(plan) {
  const { f, parentId, dormant, list } = plan;
  const now = Date.now();
  if ((f.parentId || null) !== parentId) f.parentId = parentId;
  if (!!f.dormant !== dormant) f.dormant = dormant;
  f.updatedAt = now;
  list.forEach((x, i) => { if (x.sortOrder !== i) { x.sortOrder = i; x.updatedAt = now; } });
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
}

// ── 폴더 관리 화면 (크롬 북마크 관리자처럼 한 화면에서) ──
// 사이드바 폴더를 우클릭(휴대폰은 길게 누르기)하거나 폴더 목록 아래 '폴더 관리'로 연다.
// 줄 끝 ⋮ 하나에 모든 기능: 열기·이름 바꾸기·하위 폴더·옮기기·비밀번호·휴면(최상위만)·삭제.
// 왼쪽 손잡이를 끌어 순서를 바꾸고, 다른 폴더 위에 놓으면 그 하위로, 휴면 칸에 놓으면 휴면이 된다.
let fm = null;   // 열려 있을 때 { el, body, editing, creating, menu, drag, openedAt, selected(체크한 id), lastCheck }

function openFolderManager(focusId) {
  if (fm) { renderFolderManager(true); flashFolderRow(focusId); return; }
  const el = document.createElement('div');
  el.id = 'folder-manager';
  el.innerHTML = `
    <div class="fm-page" role="dialog" aria-label="폴더 관리">
      <div class="fm-header">
        <button class="fm-icon-btn" id="fm-close" title="닫기">${ico('close')}</button>
        <h2>폴더 관리</h2>
        <button class="fm-info" id="fm-info" type="button" title="사용법">ⓘ</button>
        <button class="btn btn-primary" id="fm-add">+ 새 폴더</button>
      </div>
      <div class="fm-selbar" id="fm-selbar" hidden></div>
      <div class="fm-tip" id="fm-tip" hidden>
        왼쪽 손잡이(${ico('grip')})를 끌어 순서 바꾸기 · 다른 폴더 위에 놓으면 그 하위로 · 휴면 칸에 놓으면 휴면<br>
        체크박스로 여러 폴더를 골라 한꺼번에 휴면·삭제 · PC는 Shift+클릭으로 범위 선택<br>
        이름은 두 번 클릭해 바로 고칠 수 있어요 · 휴면 폴더의 글은 '전체'에서 숨겨집니다
      </div>
      <div class="fm-body" id="fm-body"></div>
    </div>`;
  document.body.appendChild(el);
  fm = { el, body: el.querySelector('#fm-body'), editing: null, creating: null, menu: null, drag: null, openedAt: Date.now(), selected: new Set(), lastCheck: null };

  el.querySelector('#fm-close').onclick = () => closeFolderManager();
  el.querySelector('#fm-info').onclick = () => { const t = el.querySelector('#fm-tip'); t.hidden = !t.hidden; };
  el.querySelector('#fm-add').onclick = () => startFmCreate(null);
  el.querySelector('#fm-selbar').addEventListener('click', onFmSelbarClick);
  // 바깥(어두운 부분) 누르면 닫기 — PC 에서만 보인다
  el.addEventListener('click', (e) => {
    if (fm && fm.menu && !e.target.closest('.fm-menu') && !e.target.closest('[data-act="menu"]')) closeFmMenu();
    if (e.target === el) closeFolderManager();
  });
  fm.body.addEventListener('click', onFmBodyClick);
  fm.body.addEventListener('dblclick', (e) => {
    const name = e.target.closest('.fm-name-text');
    if (name) startFmRename(name.closest('.fm-row').dataset.id);
  });
  fm.body.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.fm-grip');
    const row = grip && grip.closest('.fm-row[data-id]');
    if (row) startFmDrag(e, row);
  });
  fm.body.addEventListener('scroll', () => closeFmMenu());
  document.addEventListener('keydown', onFmKeydown);

  // 휴대폰 뒤로가기 제스처가 앱·글 대신 이 화면을 먼저 닫도록 기록 한 칸을 쌓는다
  history.pushState({ folderMgr: true }, '');
  renderFolderManager(true);
  flashFolderRow(focusId);
}

function closeFolderManager(fromPopstate) {
  if (!fm) return;
  if (fm.drag) endFmDrag(false);
  closeFmMenu();
  document.removeEventListener('keydown', onFmKeydown);
  fm.el.remove();
  fm = null;
  if (!fromPopstate && history.state && history.state.folderMgr) { skipNextPopstate = true; history.back(); }
}

function onFmKeydown(e) {
  if (!fm || e.key !== 'Escape') return;
  if (document.querySelector('.modal-overlay, .delete-confirm')) return;   // 위에 뜬 대화상자 몫
  e.preventDefault();
  if (fm.drag) { endFmDrag(false); return; }
  if (fm.menu) { closeFmMenu(); return; }
  if (fm.selected.size) { fm.selected.clear(); updateFmSelection(); return; }
  closeFolderManager();
}

// 화면 순서: 칸(사용 중/휴면)마다 최상위 → 그 하위. 어디에도 안 걸리는 폴더(부모가 사라졌거나 3단계)는
// 사이드바엔 안 보이므로 사용 중 칸 끝에 꺼내 둔다 — 끌어 옮기면 바로잡힌다.
function fmSections() {
  const placed = new Set();
  const sec = (dormant) => folders.filter((f) => !f.parentId && !!f.dormant === dormant).sort(sortBySortOrder).map((top) => {
    const children = getChildFolders(top.id);
    placed.add(top.id);
    children.forEach((c) => placed.add(c.id));
    return { top, children };
  });
  const active = sec(false);
  const dormant = sec(true);
  const stray = folders.filter((f) => !placed.has(f.id)).sort(sortBySortOrder);
  return { active, dormant, stray };
}

function fmRowHtml(f, kind) {
  // kind: 'top' | 'child' | 'stray'
  const count = kind === 'top' ? getFolderMemoCount(f.id) : memos.filter((m) => m.folder === f.id && isVisibleMemo(m)).length;
  const name = fm.editing === f.id
    ? `<input class="fm-input" value="${escapeHtml(f.name)}" maxlength="60" aria-label="폴더 이름">`
    : `<span class="fm-name-text">${escapeHtml(f.name)}</span>${f.password ? `<span class="fm-lock" title="비밀번호 걸림">${ico('lock')}</span>` : ''}`;
  const sel = fm.selected.has(f.id);
  return `<div class="fm-row${kind === 'child' ? ' fm-child' : ''}${sel ? ' selected' : ''}" data-id="${f.id}" data-parent="${kind === 'child' ? f.parentId : ''}"${kind === 'stray' ? ' data-stray="1"' : ''}>
    <label class="fm-check" title="선택"><input type="checkbox" data-check="${f.id}"${sel ? ' checked' : ''}></label>
    <span class="fm-grip" title="끌어서 옮기기">${ico('grip')}</span>
    <span class="fm-name">${ico('folder')}${name}</span>
    <span class="fm-count">${count}</span>
    <button class="fm-more" data-act="menu" type="button" title="더보기">${ico('more')}</button>
  </div>`;
}

function fmNewRowHtml(isChild) {
  return `<div class="fm-row fm-new${isChild ? ' fm-child' : ''}">
    <span class="fm-check"></span>
    <span class="fm-grip"></span>
    <span class="fm-name">${ico('folder')}<input class="fm-input" placeholder="새 폴더 이름" maxlength="60" aria-label="새 폴더 이름"></span>
  </div>`;
}

// force: 이 화면 안에서 고친 직후. 아니면(동기화 등 바깥에서 바뀜) 끄는 중·입력 중엔 미뤄 둔다
function renderFolderManager(force) {
  if (!fm) return;
  // 고치던 폴더가 (다른 기기에서 지워져) 사라졌으면 입력을 접는다
  if (fm.editing && !folders.some((f) => f.id === fm.editing)) fm.editing = null;
  if (fm.creating && fm.creating.parentId && !folders.some((f) => f.id === fm.creating.parentId)) fm.creating = null;
  if (!force && (fm.drag || fm.editing || fm.creating)) { fm.pendingRender = true; return; }
  fm.pendingRender = false;
  closeFmMenu();
  const oldInput = fm.body.querySelector('.fm-input');
  if (oldInput) oldInput._done = true;   // 지워지는 입력칸의 blur 가 새 입력칸 값으로 저장하지 않게
  const { active, dormant, stray } = fmSections();
  const creating = fm.creating;
  const blocks = (list) => list.map(({ top, children }) =>
    fmRowHtml(top, 'top') +
    children.map((c) => fmRowHtml(c, 'child')).join('') +
    (creating && creating.parentId === top.id ? fmNewRowHtml(true) : '')
  ).join('');
  const activeHtml = blocks(active) + stray.map((f) => fmRowHtml(f, 'stray')).join('') +
    (creating && !creating.parentId ? fmNewRowHtml(false) : '');
  const dormantHtml = blocks(dormant);
  const nActive = active.length + active.reduce((n, b) => n + b.children.length, 0) + stray.length;
  const nDormant = dormant.length + dormant.reduce((n, b) => n + b.children.length, 0);
  const scroll = fm.body.scrollTop;
  fm.body.innerHTML = `
    <div class="fm-section" data-section="active">
      <div class="fm-section-head">${ico('folder')} 폴더 <span class="fm-section-n">${nActive}</span></div>
      ${activeHtml || '<div class="fm-empty">비어 있음</div>'}
    </div>
    <div class="fm-section" data-section="dormant">
      <div class="fm-section-head">${ico('moon')} 휴면 <span class="fm-section-n">${nDormant}</span></div>
      ${dormantHtml || '<div class="fm-empty">비어 있음</div>'}
    </div>`;
  fm.body.scrollTop = scroll;
  updateFmSelection();

  const input = fm.body.querySelector('.fm-input');
  if (input) {
    const commit = () => { if (!input._done) { input._done = true; commitFmEdit(input.value); } };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input._done = true; cancelFmEdit(); }
    });
    input.addEventListener('blur', commit);
    input.scrollIntoView({ block: 'nearest' });
    input.focus();
    if (fm.editing) input.select();
  }
}

function flashFolderRow(id) {
  if (!fm || !id) return;
  const row = fm.body.querySelector(`.fm-row[data-id="${id}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'nearest' });
  row.classList.remove('fm-flash');
  void row.offsetWidth;   // 같은 줄을 다시 깜박일 수 있게
  row.classList.add('fm-flash');
}

function onFmBodyClick(e) {
  const cb = e.target.closest('input[data-check]');
  // 길게 눌러 연 직후 손을 뗄 때 생기는 클릭이 그 자리 버튼을 누르지 않게
  if (Date.now() - fm.openedAt < 400) { if (cb) e.preventDefault(); return; }
  if (cb) { toggleFmSelect(cb.dataset.check, cb.checked, e.shiftKey); return; }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.fm-row').dataset.id;
  if (btn.dataset.act === 'menu') {
    if (fm.menu && fm.menu.id === id) closeFmMenu(); else openFmMenu(id, btn);
  }
}

// 체크 켜기/끄기. Shift 를 누르고 고르면 지난번 고른 줄부터 여기까지(화면 순서) 같은 상태로
function toggleFmSelect(id, on, shift) {
  const ids = [...fm.body.querySelectorAll('.fm-row[data-id]')].map((r) => r.dataset.id);
  let range = [id];
  if (shift && fm.lastCheck && ids.includes(fm.lastCheck)) {
    const a = ids.indexOf(fm.lastCheck), b = ids.indexOf(id);
    range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
  }
  range.forEach((x) => { if (on) fm.selected.add(x); else fm.selected.delete(x); });
  fm.lastCheck = id;
  updateFmSelection();
}

// 줄 표시·체크 상태와 위쪽 선택 막대(N개 선택 · 휴면 처리 · 휴면 해제 · 삭제)를 맞춘다
function updateFmSelection() {
  if (!fm) return;
  for (const id of fm.selected) if (!folders.some((f) => f.id === id)) fm.selected.delete(id);
  fm.body.querySelectorAll('.fm-row[data-id]').forEach((r) => {
    const on = fm.selected.has(r.dataset.id);
    r.classList.toggle('selected', on);
    const cb = r.querySelector('input[data-check]');
    if (cb) cb.checked = on;
  });
  const bar = fm.el.querySelector('#fm-selbar');
  const header = fm.el.querySelector('.fm-header');
  const n = fm.selected.size;
  header.hidden = n > 0;
  bar.hidden = n === 0;
  if (!n) return;
  const picked = folders.filter((f) => fm.selected.has(f.id));
  const canSleep = picked.some((f) => !f.parentId && !f.dormant);
  const canWake = picked.some((f) => !f.parentId && f.dormant);
  bar.innerHTML = `
    <button class="fm-icon-btn" data-sel="clear" type="button" title="선택 해제">${ico('close')}</button>
    <span class="fm-sel-n">${n}개 선택</span>
    ${canSleep ? `<button class="fm-sel-btn" data-sel="sleep" type="button">${ico('moon')}<span>휴면 처리</span></button>` : ''}
    ${canWake ? `<button class="fm-sel-btn" data-sel="wake" type="button">${ico('sun')}<span>휴면 해제</span></button>` : ''}
    <button class="fm-sel-btn danger" data-sel="delete" type="button">${ico('trash')}<span>삭제</span></button>`;
}

function onFmSelbarClick(e) {
  const b = e.target.closest('[data-sel]');
  if (!b || !fm) return;
  const ids = [...fm.selected];
  const done = () => { if (fm) { fm.selected.clear(); updateFmSelection(); } };
  if (b.dataset.sel === 'clear') done();
  else if (b.dataset.sel === 'sleep') { setFoldersDormant(ids, true); done(); }
  else if (b.dataset.sel === 'wake') { setFoldersDormant(ids, false); done(); }
  else if (b.dataset.sel === 'delete') confirmDeleteFolders(ids, done);
}

function openFmMenu(id, anchor) {
  closeFmMenu();
  const f = folders.find((x) => x.id === id);
  if (!f) return;
  const row = anchor.closest('.fm-row');
  const isTop = !row.dataset.parent && !row.dataset.stray;
  const items = [
    ['open', 'folder', '열기'],
    ['rename', 'edit', '이름 바꾸기'],
    isTop ? ['child', 'folder-plus', '하위 폴더 만들기'] : null,
    ['move', 'folder-move', '다른 폴더로 옮기기'],
    ['password', f.password ? 'lock' : 'key', f.password ? '비밀번호 바꾸기·풀기' : '비밀번호 걸기'],
    isTop ? ['dormant', f.dormant ? 'sun' : 'moon', f.dormant ? '휴면 해제' : '휴면 처리'] : null,
    ['delete', 'trash', '삭제'],
  ].filter(Boolean);
  const menu = document.createElement('div');
  menu.className = 'fm-menu';
  menu.innerHTML = items.map(([act, icon, label]) =>
    `<button type="button" data-mact="${act}"${act === 'delete' ? ' class="danger"' : ''}>${ico(icon)}<span>${label}</span></button>`).join('');
  fm.el.appendChild(menu);
  // 단추 아래 오른쪽 끝에 맞춘다. 아래 자리가 모자라면 위로
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let top = r.bottom + 4;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.top = top + 'px';
  menu.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + 'px';
  row.classList.add('menu-open');
  fm.menu = { el: menu, id, row };
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mact]');
    if (!b) return;
    closeFmMenu();
    runFmAction(b.dataset.mact, id);
  });
}

function closeFmMenu() {
  if (!fm || !fm.menu) return;
  fm.menu.el.remove();
  fm.menu.row.classList.remove('menu-open');
  fm.menu = null;
}

function runFmAction(act, id) {
  if (act === 'open') openFolderFromManager(id);
  else if (act === 'rename') startFmRename(id);
  else if (act === 'child') startFmCreate(id);
  else if (act === 'move') showMoveFolderDialog(id);
  else if (act === 'password') showSetPasswordDialog(id);
  else if (act === 'dormant') toggleDormant(id);
  else if (act === 'delete') confirmDeleteFolder(id);
}

function openFolderFromManager(id) {
  closeFolderManager();
  const go = () => {
    currentFolder = id;
    renderAll();
    if (!selectMode) $('#folder-dropdown').style.display = 'none';
    if (window.innerWidth <= 768) $('#sidebar').classList.add('open');
  };
  if (isFolderLocked(id)) showPasswordPrompt(id, go); else go();
}

function startFmRename(id) {
  if (!fm || fm.drag) return;
  fm.creating = null;
  fm.editing = id;
  renderFolderManager(true);
}

function startFmCreate(parentId) {
  if (!fm || fm.drag) return;
  fm.editing = null;
  fm.creating = { parentId };
  renderFolderManager(true);
}

function cancelFmEdit() {
  if (!fm) return;
  fm.editing = null;
  fm.creating = null;
  renderFolderManager(true);
}

function commitFmEdit(value) {
  if (!fm) return;
  const name = value.trim();
  let flashId = null;
  if (fm.editing) {
    const f = folders.find((x) => x.id === fm.editing);
    fm.editing = null;
    if (f && name && name !== f.name) {
      f.name = name;
      f.updatedAt = Date.now();
      saveLocalData();
      renderAll();
      scheduleSyncToDropbox();
    }
  } else if (fm.creating) {
    const parentId = fm.creating.parentId;
    fm.creating = null;
    if (name && (!parentId || folders.some((p) => p.id === parentId))) {
      const nf = { id: crypto.randomUUID(), name, parentId, sortOrder: nextSortOrder(parentId), updatedAt: Date.now() };
      folders.push(nf);
      flashId = nf.id;
      saveLocalData();
      renderAll();
      scheduleSyncToDropbox();
    }
  }
  renderFolderManager(true);
  flashFolderRow(flashId);
}

// ── 폴더 관리: 끌어서 옮기기 (마우스·손가락 공통 pointer 이벤트) ──
function startFmDrag(e, row) {
  if (e.button > 0 || fm.drag) return;
  if (fm.editing || fm.creating) return;
  e.preventDefault();
  closeFmMenu();
  const id = row.dataset.id;
  const f = folders.find((x) => x.id === id);
  if (!f) return;
  const blockIds = new Set([id, ...folders.filter((c) => c.parentId === id).map((c) => c.id)]);
  fm.body.querySelectorAll('.fm-row[data-id]').forEach((r) => { if (blockIds.has(r.dataset.id)) r.classList.add('fm-dragging'); });
  const ghost = document.createElement('div');
  ghost.className = 'fm-ghost';
  ghost.innerHTML = ico('folder') + '<span>' + escapeHtml(f.name) + '</span>';
  fm.el.appendChild(ghost);
  const line = document.createElement('div');
  line.className = 'fm-drop-line';
  fm.body.appendChild(line);
  const onMove = (ev) => { if (ev.pointerId !== d.pointerId) return; d.x = ev.clientX; d.y = ev.clientY; updateFmDrag(); };
  const onUp = (ev) => { if (ev.pointerId === d.pointerId) endFmDrag(true); };
  const onCancel = (ev) => { if (ev.pointerId === d.pointerId) endFmDrag(false); };
  const d = fm.drag = {
    id, hasKids: blockIds.size > 1, ghost, line, x: e.clientX, y: e.clientY, target: null, raf: 0, pointerId: e.pointerId,
    off: () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    },
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  document.body.classList.add('fm-drag-on');
  updateFmDrag();
  // 목록 위·아래 끝에 가까이 대면 저절로 굴린다
  const tick = () => {
    if (!fm || fm.drag !== d) return;
    const br = fm.body.getBoundingClientRect();
    const edge = 48;
    let dy = 0;
    if (d.y < br.top + edge) dy = -Math.ceil((br.top + edge - d.y) / 4);
    else if (d.y > br.bottom - edge) dy = Math.ceil((d.y - (br.bottom - edge)) / 4);
    if (dy) { fm.body.scrollTop += dy; updateFmDrag(); }
    d.raf = requestAnimationFrame(tick);
  };
  d.raf = requestAnimationFrame(tick);
}

// 손가락·마우스 위치 → 놓을 자리. { into: 폴더id } 또는 { parentId, dormant, beforeId, lineEl, section }
function fmDropTarget(x, y) {
  const d = fm.drag;
  const br = fm.body.getBoundingClientRect();
  const hx = Math.min(Math.max(x, br.left + 24), br.right - 24);
  const hy = Math.min(Math.max(y, br.top + 1), br.bottom - 1);
  const el = document.elementFromPoint(hx, hy);
  if (!el || !fm.body.contains(el)) return null;
  let section = el.closest('.fm-section');
  let outside = 0;   // 칸 사이·아래 여백이면 가장 가까운 칸의 맨 앞(-1)·맨 끝(1)
  if (!section) {
    let best = Infinity;
    fm.body.querySelectorAll('.fm-section').forEach((s) => {
      const sr = s.getBoundingClientRect();
      const dist = hy < sr.top ? sr.top - hy : hy > sr.bottom ? hy - sr.bottom : 0;
      if (dist < best) { best = dist; section = s; outside = hy < sr.top ? -1 : 1; }
    });
    if (!section) return null;
  }
  const dormant = section.dataset.section === 'dormant';
  const rows = [...section.querySelectorAll('.fm-row[data-id]')];
  // beforeEl 앞(없으면 칸 맨 끝)에 넣기. 하위 줄 앞이면 그 부모의 하위로 들어간다
  const gap = (beforeEl) => {
    if (beforeEl && beforeEl.dataset.parent) {
      if (!d.hasKids) return { parentId: beforeEl.dataset.parent, dormant: false, beforeId: beforeEl.dataset.id, lineEl: beforeEl, section };
      // 하위 폴더가 있는 폴더는 최상위로만 → 그 부모 묶음 바로 뒤
      let i = rows.indexOf(beforeEl);
      while (rows[i] && rows[i].dataset.parent) i++;
      beforeEl = rows[i] || null;
    }
    return { parentId: null, dormant, beforeId: beforeEl ? beforeEl.dataset.id : null, lineEl: beforeEl, section };
  };
  const rowEl = outside ? null : el.closest('.fm-row[data-id]');
  if (!rowEl) return gap(outside < 0 || el.closest('.fm-section-head') ? (rows[0] || null) : null);
  const r = rowEl.getBoundingClientRect();
  const rel = (hy - r.top) / r.height;
  const canInto = !rowEl.dataset.parent && !rowEl.dataset.stray && rowEl.dataset.id !== d.id && !d.hasKids;
  if (canInto && rel > 0.25 && rel < 0.75) return { into: rowEl.dataset.id };
  if (rel < 0.5) return gap(rowEl);
  return gap(rows[rows.indexOf(rowEl) + 1] || null);
}

function fmTargetPlan(t) {
  if (!t) return null;
  const plan = t.into
    ? planFolderMove(fm.drag.id, { parentId: t.into })
    : planFolderMove(fm.drag.id, { parentId: t.parentId, dormant: t.dormant, beforeId: t.beforeId });
  return plan && plan.moved ? plan : null;
}

function updateFmDrag() {
  const d = fm && fm.drag;
  if (!d) return;
  d.ghost.style.transform = `translate(${d.x + 14}px, ${d.y - 16}px)`;
  const t = fmDropTarget(d.x, d.y);
  d.target = fmTargetPlan(t) ? t : null;
  fm.body.querySelectorAll('.fm-drop-into, .fm-drop-here').forEach((x) => x.classList.remove('fm-drop-into', 'fm-drop-here'));
  d.line.style.display = 'none';
  if (!d.target) return;
  if (t.into) { fm.body.querySelector(`.fm-row[data-id="${t.into}"]`).classList.add('fm-drop-into'); return; }
  // 줄을 그을 높이: 넣을 줄의 윗선, 칸 맨 끝이면 그 칸 마지막 줄의 아랫선(비었으면 '비어 있음' 상자)
  let top;
  if (t.lineEl) top = t.lineEl.offsetTop;
  else {
    const last = [...t.section.querySelectorAll('.fm-row')].pop();
    if (!last) { const empty = t.section.querySelector('.fm-empty'); if (empty) empty.classList.add('fm-drop-here'); return; }
    top = last.offsetTop + last.offsetHeight;
  }
  d.line.style.top = (top - 1) + 'px';
  // 하위로 들어가는 자리는 하위 줄 손잡이 위치부터 들여 긋는다
  d.line.style.left = (t.parentId && t.lineEl ? t.lineEl.querySelector('.fm-grip').offsetLeft : 10) + 'px';
  d.line.style.display = 'block';
}

function endFmDrag(commit) {
  const d = fm && fm.drag;
  if (!d) return;
  d.off();
  cancelAnimationFrame(d.raf);
  d.ghost.remove();
  d.line.remove();
  document.body.classList.remove('fm-drag-on');
  const plan = commit ? fmTargetPlan(d.target) : null;
  const wasDormant = plan && !!plan.f.dormant;
  fm.drag = null;
  if (plan) {
    applyFolderMove(plan);   // renderAll → 이 화면도 다시 그린다
    if (wasDormant !== plan.dormant) showToast(plan.dormant ? '휴면 처리되었습니다' : '휴면이 해제되었습니다');
  }
  renderFolderManager(true);
  if (plan) flashFolderRow(d.id);
}

// ── Memo CRUD ──
function createMemo() {
  // 새 글이 들어갈 폴더 결정 (cleanupEmptyMemo가 currentId를 비우기 전에 캡처)
  // 1) 특정 폴더를 연 상태면 그 폴더
  // 2) 전체/미분류 보기지만 지금 보고 있는 글이 어떤 폴더에 속하면 그 폴더
  // 3) 둘 다 아니면 폴더 없음
  let targetFolder = (currentFolder && currentFolder !== '__none__') ? currentFolder : null;
  if (!targetFolder && currentId) {
    const cur = memos.find((m) => m.id === currentId);
    if (cur && cur.folder) targetFolder = cur.folder;
  }
  cleanupEmptyMemo();
  const memo = {
    id: crypto.randomUUID(),
    title: '',
    content: '',
    folder: targetFolder,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  memos.unshift(memo);
  currentId = memo.id;
  saveLocalData();
  renderAll();
  showEditor(memo);
  titleInput.focus();
  $('#sidebar').classList.remove('open');
  scheduleSyncToDropbox();
}

function deleteMemo(id) {
  const memo = memos.find((m) => m.id === id);
  if (memo) {
    trash.push({ type: 'memo', data: { ...memo }, deletedAt: Date.now() });
  }
  memos = memos.filter((m) => m.id !== id);
  if (currentId === id) {
    currentId = null;
    hideEditor();
  }
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
  showToast('메모가 휴지통으로 이동되었습니다');
}

function confirmDelete() {
  if (!currentId) return;
  const memo = memos.find((m) => m.id === currentId);
  const title = escapeHtml(memo?.title || '제목 없음');

  // 1차 확인
  const o1 = document.createElement('div');
  o1.className = 'delete-confirm';
  o1.innerHTML = `<div class="delete-confirm-box"><p>"${title}" 메모를 삭제할까요?</p><button class="btn btn-secondary" id="del-cancel">취소</button> <button class="btn btn-primary" id="del-ok">삭제</button></div>`;
  document.body.appendChild(o1);
  o1.querySelector('#del-cancel').onclick = () => o1.remove();
  o1.addEventListener('click', (e) => { if (e.target === o1) o1.remove(); });
  o1.querySelector('#del-ok').onclick = () => {
    o1.remove();
    // 2차 확인
    const o2 = document.createElement('div');
    o2.className = 'delete-confirm';
    o2.innerHTML = `<div class="delete-confirm-box"><p>"${title}" 메모를 정말 삭제할까요?</p><button class="btn btn-secondary" id="del-cancel2">취소</button> <button class="btn btn-primary" id="del-ok2">삭제</button></div>`;
    document.body.appendChild(o2);
    o2.querySelector('#del-cancel2').onclick = () => o2.remove();
    o2.addEventListener('click', (e) => { if (e.target === o2) o2.remove(); });
    o2.querySelector('#del-ok2').onclick = () => {
      o2.remove();
      deleteMemo(currentId);
    };
  };
}

// ── Trash ──
function showTrashView() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  function renderTrashList() {
    if (trash.length === 0) {
      return '<p style="color:var(--text2);font-size:0.9rem;">휴지통이 비어 있습니다.</p>';
    }
    return trash.map((item, i) => {
      const icon = item.type === 'folder' ? '📁' : '📝';
      const name = item.type === 'folder' ? item.data.name : (item.data.title || formatCreatedAt(item.data.createdAt) + ' 새 글');
      const date = formatDate(item.deletedAt);
      const preview = item.type === 'memo' ? escapeHtml((item.data.content || '').substring(0, 200)) : '';
      return `<div class="trash-item" style="border-bottom:1px solid var(--border);font-size:0.85rem;">
        <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;" data-preview="${i}">
          <span>${icon}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(name)}</span>
          <span style="font-size:0.7rem;color:var(--text2);flex-shrink:0;">${date}</span>
          <button class="btn btn-secondary" style="padding:3px 8px;font-size:0.75rem;" data-restore="${i}">복원</button>
          <button class="btn btn-primary" style="padding:3px 8px;font-size:0.75rem;" data-permadel="${i}">삭제</button>
        </div>
        ${item.type === 'memo' ? '<div class="trash-preview" id="trash-preview-' + i + '" style="display:none;padding:6px 10px 10px 36px;font-size:0.8rem;color:var(--text2);white-space:pre-wrap;word-break:break-word;max-height:150px;overflow-y:auto;background:var(--bg);">' + (preview || '<i>내용 없음</i>') + '</div>' : ''}
      </div>`;
    }).join('');
  }

  function render() {
    overlay.innerHTML = `
      <div class="modal-box" style="max-width:480px;max-height:70vh;display:flex;flex-direction:column;text-align:left;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="font-size:1rem;">🗑 휴지통</h3>
          ${trash.length > 0 ? '<button class="btn btn-primary" id="trash-empty" style="padding:4px 10px;font-size:0.75rem;">비우기</button>' : ''}
        </div>
        <div style="overflow-y:auto;flex:1;">${renderTrashList()}</div>
        <div style="text-align:center;margin-top:12px;">
          <button class="btn btn-secondary" id="trash-close">닫기</button>
        </div>
      </div>
    `;

    overlay.querySelector('#trash-close').onclick = () => overlay.remove();

    const emptyBtn = overlay.querySelector('#trash-empty');
    if (emptyBtn) {
      emptyBtn.onclick = () => {
        if (confirm('휴지통을 비우시겠습니까? 영구적으로 삭제됩니다.')) {
          for (const t of trash) deletedIds.push({ id: t.data.id, at: Date.now() });
          trash = [];
          saveLocalData();
          syncToDropbox().catch(() => {});
          render();
          showToast('휴지통을 비웠습니다');
        }
      };
    }

    overlay.querySelectorAll('[data-preview]').forEach((row) => {
      row.onclick = (e) => {
        if (e.target.closest('[data-restore]') || e.target.closest('[data-permadel]')) return;
        const idx = row.dataset.preview;
        const prev = overlay.querySelector('#trash-preview-' + idx);
        if (prev) prev.style.display = prev.style.display === 'none' ? 'block' : 'none';
      };
    });

    overlay.querySelectorAll('[data-restore]').forEach((btn) => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.restore);
        restoreFromTrash(idx);
        render();
      };
    });

    overlay.querySelectorAll('[data-permadel]').forEach((btn) => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.permadel);
        const item = trash[idx];
        const name = item.type === 'folder' ? item.data.name : (item.data.title || '제목 없음');
        if (confirm(`"${name}"을(를) 영구 삭제하시겠습니까?`)) {
          deletedIds.push({ id: item.data.id, at: Date.now() });
          trash.splice(idx, 1);
          saveLocalData();
          syncToDropbox().catch(() => {});
          render();
          showToast('영구 삭제되었습니다');
        }
      };
    });

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  document.body.appendChild(overlay);
  render();
}

function restoreFromTrash(index) {
  const item = trash[index];
  if (!item) return;
  if (item.type === 'memo') {
    // 원래 폴더가 아직 존재하면 그 폴더로, 없으면 미분류로 복원
    if (item.data.folder && !folders.some((f) => f.id === item.data.folder)) {
      item.data.folder = null;
    }
    item.data.updatedAt = Date.now();
    memos.unshift(item.data);
  } else if (item.type === 'folder') {
    // 같은 이름의 폴더가 이미 있으면 이름 뒤에 (복원) 추가
    const exists = folders.some((f) => f.name === item.data.name);
    if (exists) item.data.name += ' (복원)';
    // 부모 폴더가 없으면 최상위로 복원
    if (item.data.parentId && !folders.some((f) => f.id === item.data.parentId)) {
      item.data.parentId = null;
    }
    item.data.sortOrder = nextSortOrder(item.data.parentId || null);
    item.data.updatedAt = Date.now();
    folders.push(item.data);
  }
  trash.splice(index, 1);
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
  showToast('복원되었습니다');
}

// ── Favorite ──
function toggleFavorite() {
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  memo.favorite = !memo.favorite;
  memo.favoritedAt = memo.favorite ? Date.now() : null;
  memo.metaAt = Date.now();   // 다른 기기로 전달되게 (글 수정 시각은 그대로 — 목록 순서가 바뀌지 않게)
  updateFavButton(memo);
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
  showToast(memo.favorite ? '즐겨찾기에 추가됨' : '즐겨찾기 해제됨');
}

// 선 아이콘 한 개(index.html 맨 위 아이콘 모음의 id="i-이름")
function ico(name) {
  return `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function updateFavButton(memo) {
  // 별 모양은 그대로, 켜짐(★)은 CSS .fav-active 가 속을 채운다
  $('#btn-fav').classList.toggle('fav-active', !!(memo && memo.favorite));
}

// 다른 창(같은 기기)에서 localStorage가 바뀌면 호출 → 이 창을 최신 상태로 갱신
// (A창에서 수정 → B창이 즉시 반영. 단, 이 창에서 직접 입력 중이면 본문은 건드리지 않음)
function onExternalStorageChange(e) {
  if (e.key === 'last_saved_at' || e.key === 'last_synced_at') { updateSaveSyncTimes(); return; }
  if (e.key !== 'memos') return; // saveLocalData는 항상 memos를 함께 저장하므로 이 키만 보면 됨
  loadLocalData();
  renderAll();
  updateSaveSyncTimes();
  if (!currentId) return;
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) { currentId = null; hideEditor(); return; } // 다른 창에서 이 글이 삭제됨
  // 이 창에서 직접 입력 중(창이 활성 + 입력칸 포커스)이면 본문을 덮어쓰지 않음(편집 손실 방지)
  const busyHere = document.hasFocus() && (document.activeElement === editor || document.activeElement === titleInput);
  if (!busyHere) {
    if (editor.value !== memo.content) editor.value = memo.content;
    if (titleInput.value !== memo.title) titleInput.value = memo.title;
    updateCharCount();
    updateFavButton(memo);
    repaintOverlay(); // 다른 창에서 바뀐 형광펜 반영
  }
  updateMemoDates(memo);
}

// ── Editor ──
function showEditor(memo) {
  editorToolbar.style.display = 'flex';
  editorContainer.style.display = 'flex';
  $('#char-count').style.display = 'block';
  emptyState.style.display = 'none';
  titleInput.value = memo.title;
  editor.value = memo.content;
  undoStack = [];
  redoStack = [];
  undoGroupOpen = false;
  updateFolderSelect(memo.folder);
  updateFavButton(memo);
  updateMemoDates(memo);
  updateCharCount();
  applyViewerMode(!!memo.viewerMode);
  // 찾기/바꾸기 패널·더보기 닫기
  $('#find-replace-bar').style.display = 'none';
  document.querySelectorAll('.toolbar-extra').forEach((el) => el.classList.remove('toolbar-show'));
  $('#btn-toolbar-more').classList.remove('active');
  $('#toolbar-right').classList.remove('expanded');
  $('#toolbar-buttons').classList.remove('expanded');
  // 이전 글에서 쓰던 찾기 표시 초기화 후, 이 글의 형광펜을 오버레이에 그림
  searchKeyword = ''; searchCurrentPos = -1; findMatches = []; findIndex = -1; findAllMode = false;
  repaintOverlay();
  // 뒤로가기(모바일 제스처)가 앱을 끄지 않고 글을 먼저 닫도록 기록 한 칸을 쌓아 둔다(글을 바꿔 열 때는 더 쌓지 않음)
  if (!(history.state && history.state.memoOpen)) history.pushState({ memoOpen: true }, '');
}

// 뒤로가기 → 열린 글을 닫고 빈 화면(There you are)으로. 빈 화면에서 한 번 더 뒤로가기 → 앱 종료
let skipNextPopstate = false;
window.addEventListener('popstate', () => {
  if (skipNextPopstate) { skipNextPopstate = false; return; }
  if (fm) { closeFolderManager(true); return; }   // 폴더 관리 화면이 떠 있으면 그것만 닫는다
  $('#sidebar').classList.remove('open');
  if (editorContainer.style.display === 'none') return;
  hideEditor();
  currentId = null;
  renderMemoList();
});

function hideEditor() {
  // 삭제 등 다른 이유로 글이 닫히면 쌓아 둔 기록 칸도 거둬, 다음 뒤로가기가 헛돌지 않게 한다
  if (history.state && history.state.memoOpen) { skipNextPopstate = true; history.back(); }
  cleanupEmptyMemo();
  editorToolbar.style.display = 'none';
  editorContainer.style.display = 'none';
  $('#char-count').style.display = 'none';
  $('#find-replace-bar').style.display = 'none';
  $('#memo-dates').style.display = 'none';
  emptyState.style.display = 'flex';
}

// 제목·본문이 모두 비어 있고 특정 폴더에도 속하지 않은 메모만 '빈 메모'로 본다.
// 폴더를 지정했다면(미분류가 아닌 특정 폴더) 빈 메모여도 보존한다.
function isBlankMemo(m) {
  return !m.title.trim() && !m.content.trim() && !m.folder;
}

function cleanupEmptyMemo() {
  // 빈 메모를 모두 정리한다. 한 번도 올린 적 없는 빈 글은 그냥 지우고,
  // 예전에 내용이 있어 올렸던 글을 비운 것이면 휴지통에 넣는다(다른 기기에서도 지워지고, 복원도 된다).
  const blanks = memos.filter(isBlankMemo);
  if (!blanks.length) return;
  const base = getSyncBase();
  for (const m of blanks) {
    if (base[m.id] != null) trash.push({ type: 'memo', data: { ...m }, deletedAt: Date.now() });
  }
  const ids = new Set(blanks.map((m) => m.id));
  memos = memos.filter((m) => !ids.has(m.id));
  if (currentId && ids.has(currentId)) currentId = null;
  saveLocalData();
}

async function loadMemoInEditor(memo) {
  // 빈 메모 정리를 동기화보다 먼저 실행
  cleanupEmptyMemo();
  // 글 전환 시 못 보낸 변경이 있으면 바로 보낸다
  if (localSaveTimer) saveLocalData();
  if (syncTimer || isDirty()) {
    clearTimeout(syncTimer);
    syncTimer = null;
    syncToDropbox().catch(() => {});
  }
  // 온라인이면 최신 데이터를 먼저 받아온 뒤 열기 (방금 받았으면 건너뜀 — 글마다 900KB를 받지 않게)
  syncFailedForCurrentMemo = false;
  if (accessToken && Date.now() - lastPullAt > 30000) {
    try {
      setSyncStatus('syncing', '동기화 중...');
      await queueSync(() => pullAndMerge());
      if (isDirty()) scheduleSyncToDropbox();
      setSyncStatus('synced', '동기화 완료');
      // 동기화 후 최신 memo 객체 다시 조회
      memo = memos.find((m) => m.id === memo.id);
      if (!memo) { showToast('해당 메모가 삭제되었습니다'); renderAll(); return; }
    } catch {
      setSyncStatus('error', '동기화 실패');
      syncFailedForCurrentMemo = true;
    }
  }
  offlineCopyId = null;
  currentId = memo.id;
  // 폴더에 속한 노트를 열면 사이드바 폴더 선택도 그 폴더로 동기화 (잠긴 폴더는 제외)
  if (memo.folder && folders.some((f) => f.id === memo.folder) && !isFolderLocked(memo.folder)) {
    currentFolder = memo.folder;
  }
  showEditor(memo);
  renderMemoList();
  renderFolderList();
  // 새 메모 열 때 툴바·제목 다시 표시
  document.body.classList.remove('toolbar-hidden');
  lastEditorScrollTop = 0;
}

let offlineCopyId = null; // 오프라인 복사본 추적
let syncFailedForCurrentMemo = false; // 현재 메모 열기 시 동기화 실패 여부

function updateFolderSelect(selectedFolder) {
  // 버튼 title에 현재 폴더 이름 표시
  const folder = selectedFolder ? folders.find((f) => f.id === selectedFolder) : null;
  const folderName = folder ? folder.name : '폴더 없음';
  const btn = $('#btn-folder-select');
  if (btn) btn.title = `폴더: ${folderName}`;

  // 드롭다운 리스트 생성
  let html = `<div class="folder-select-item ${!selectedFolder ? 'active' : ''}" data-folder="">-- 폴더 없음 --</div>`;
  const topFolders = folders.filter((f) => !f.parentId).sort(sortBySortOrder);
  for (const f of topFolders) {
    html += `<div class="folder-select-item ${f.id === selectedFolder ? 'active' : ''}" data-folder="${f.id}">${escapeHtml(f.name)}</div>`;
    const children = getChildFolders(f.id);
    for (const c of children) {
      html += `<div class="folder-select-item folder-select-item--child ${c.id === selectedFolder ? 'active' : ''}" data-folder="${c.id}">└ ${escapeHtml(c.name)}</div>`;
    }
  }
  const list = $('#folder-select-list');
  if (list) list.innerHTML = html;
}

function toggleFolderSelectDropdown() {
  const dd = $('#folder-select-dropdown');
  if (dd.style.display !== 'none') {
    dd.style.display = 'none';
    return;
  }
  // 버튼 위치 기준으로 fixed 좌표 계산 (overflow 탈출 + 화면 우측 잘림 방지)
  positionDropdown(dd, $('#btn-folder-select'));
  dd.style.display = 'block';
}

function positionDropdown(dd, btn) {
  const rect = btn.getBoundingClientRect();
  dd.style.top = rect.bottom + 'px';
  // 우측 잘림 방지: min-width 200px 기준
  const ddWidth = Math.max(200, dd.offsetWidth || 200);
  let left = rect.left;
  if (left + ddWidth > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - ddWidth - 8);
  }
  dd.style.left = left + 'px';
}

function onFolderSelectItemClick(e) {
  const item = e.target.closest('.folder-select-item');
  if (!item) return;
  const folderId = item.dataset.folder || null;
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  memo.folder = folderId;
  // 폴더 지정도 '수정'이므로 updatedAt을 갱신한다.
  // (갱신하지 않으면 동기화 병합 시 폴더 없던 원격본과 시간이 같아 폴더 지정이 되돌려지고,
  //  빈 메모로 간주돼 자동 삭제될 수 있다.)
  memo.updatedAt = Date.now();
  $('#folder-select-dropdown').style.display = 'none';
  updateFolderSelect(folderId);
  scheduleAutoSave();
}

function createOfflineCopy(memo) {
  if (offlineCopyId) return memos.find((m) => m.id === offlineCopyId);
  const title = (memo.title || formatCreatedAt(memo.createdAt) + ' 새 글') + ' (Offline Work)';
  const copy = {
    id: crypto.randomUUID(),
    title,
    content: memo.content,
    folder: memo.folder,
    highlights: memo.highlights ? memo.highlights.map((h) => ({ start: h.start, end: h.end })) : undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  memos.unshift(copy);
  currentId = copy.id;
  offlineCopyId = copy.id;
  titleInput.value = copy.title;
  saveLocalData();
  renderMemoList();
  return copy;
}

function onEditorInput() {
  let memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  // 글자가 실제로 안 바뀐 입력 신호(휴대폰 자판이 낱말을 다시 잡을 때 등)에는 '고친 시각'을 찍지 않는다
  if (editor.value === memo.content) return;
  // 오프라인 상태에서 편집 시 복사본 생성
  if (!accessToken && !offlineCopyId) {
    memo = createOfflineCopy(memo);
  }
  scheduleUndoSnapshot(memo);
  // 편집으로 글자 위치가 밀리면 형광펜 위치도 함께 보정
  if (memo.highlights && memo.highlights.length) {
    memo.highlights = adjustHighlights(memo.content, editor.value, memo.highlights);
  }
  memo.content = editor.value;
  memo.updatedAt = Date.now();
  updateCharCount();
  // 찾기 창이 열려 있으면 바뀐 본문으로 다시 센다(예전 위치를 칠하거나 바꾸지 않게)
  if ($('#find-replace-bar').style.display !== 'none' && $('#find-input').value) { findCountOnly(); searchCurrentPos = -1; }
  repaintOverlay();
  scheduleLocalSave(); // 기기 저장은 0.4초 모아서 — 앱을 벗어날 때는 flushSave가 즉시 저장
  scheduleRenderAndSync();
}

function onTitleInput() {
  let memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  if (titleInput.value === memo.title) return;
  if (!accessToken && !offlineCopyId) {
    memo = createOfflineCopy(memo);
  }
  memo.title = titleInput.value;
  memo.updatedAt = Date.now();
  scheduleLocalSave();
  scheduleRenderAndSync();
}

function scheduleLocalSave() {
  clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(() => saveLocalData(), 400);
}

// Ctrl+↓ 용: 다음 줄(= 엔터로 구분된 다음 문단)의 맨 앞. 문단 = 엔터 한 번으로 구분된 줄.
function nextParagraphStart(text, pos) {
  const nl = text.indexOf('\n', pos);
  return (nl === -1) ? text.length : nl + 1; // 다음 줄 시작(없으면 문서 끝)
}

// Ctrl+↑ 용: 줄 중간이면 그 줄(= 문단) 맨 앞으로, 이미 줄 맨 앞이면 이전 줄 맨 앞으로.
function prevParagraphStart(text, pos) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1; // 현재 줄 시작 (없으면 0)
  if (pos > lineStart) return lineStart;                 // 줄 중간/끝 → 그 줄 맨 앞
  if (lineStart === 0) return 0;                         // 첫 줄 → 그대로
  return text.lastIndexOf('\n', lineStart - 2) + 1;      // 이미 줄 맨 앞 → 이전 줄 맨 앞
}

// 본문 커서 자리에 구분선 한 줄 삽입 (Alt+Shift+D=하이픈, Alt+Shift+E=등호)
// 길이는 창 크기와 무관하게 고정 (DIVIDER_LEN 글자)
const DIVIDER_LEN = 59;
function insertDivider(ch) {
  if (document.activeElement !== editor || viewerMode) return;
  const line = ch.repeat(DIVIDER_LEN);

  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const before = editor.value.slice(0, start);
  const after = editor.value.slice(end);
  const pre = (before === '' || before.endsWith('\n')) ? '' : '\n'; // 줄 중간이면 줄바꿈 먼저
  const insert = pre + line + '\n';
  editor.value = before + insert + after;
  const caret = (before + insert).length; // 커서는 구분선 다음 줄로
  editor.setSelectionRange(caret, caret);
  // 기존 입력 처리에 연결 → 저장·되돌리기(Ctrl+Z)·검색 하이라이트 자동 연동
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

// 현재 날짜(요일 포함), withTime이면 24시 HH:MM도 붙여 반환 — 예: 2026-06-21(일) 03:10
function formatDateStamp(withTime) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const wd = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  let s = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '(' + wd + ')';
  if (withTime) s += ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  return s;
}

// 현재 포커스된 입력칸(본문 또는 제목) 커서 자리에 텍스트 삽입
function insertTextAtCursor(text) {
  const el = document.activeElement;
  if ((el !== editor && el !== titleInput) || viewerMode) return;
  const start = el.selectionStart, end = el.selectionEnd;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const caret = start + text.length;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event('input', { bubbles: true })); // 저장·되돌리기 연동
}

// 에디터 스크롤 방향에 따라 툴바·제목 숨김/표시
let lastEditorScrollTop = 0;
let editorScrollLock = false;
function handleEditorScroll() {
  // 상태 변경 직후 보정 스크롤 무시 (트랜지션 중 떨림 방지)
  if (editorScrollLock) return;
  const st = editor.scrollTop;
  const delta = st - lastEditorScrollTop;
  // 미세한 변화는 기준점만 갱신
  if (Math.abs(delta) < 5) return;

  const isHidden = document.body.classList.contains('toolbar-hidden');
  if (delta > 0 && !isHidden) {
    // 아래로 스크롤 → 숨김 (펼치기는 ▼ 버튼 클릭으로만)
    document.body.classList.add('toolbar-hidden');
    editorScrollLock = true;
    setTimeout(() => {
      editorScrollLock = false;
      lastEditorScrollTop = editor.scrollTop;
    }, 350);
  } else {
    lastEditorScrollTop = st;
  }
}

function scheduleRenderAndSync() {
  // renderAll + Dropbox 동기화는 1.5초 디바운스
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 1500);
}

// 폴더 선택, undo/redo 등에서 호출: 즉시 저장 + 디바운스 동기화
function scheduleAutoSave() {
  saveLocalData();
  scheduleRenderAndSync();
}

function saveNow() {
  clearTimeout(saveTimer);
  // 아직 기기에 안 쓴 것만 쓴다 — 이미 쓰고 올린 것을 다시 '보낼 것'으로 표시하면 같은 파일을 또 올린다
  if (localSaveTimer) saveLocalData();
  renderAll();
  if (isDirty()) scheduleSyncToDropbox();
}

let syncTimer = null;
function scheduleSyncToDropbox() {
  if (!accessToken) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    setSyncStatus('syncing', '저장 중...');
    try {
      await syncToDropbox();
      setSyncStatus('synced', '저장 완료');
    } catch {
      setSyncStatus('error', '저장 실패');
    }
  }, 1000);
}

// 앱을 닫거나 다른 화면으로 넘어갈 때: 현재 내용을 즉시 기기에 저장 + 대기 중인 클라우드 전송을 바로 실행
function flushSave() {
  // 본문·제목은 입력할 때마다 바로 글에 반영되므로 여기서 편집기 내용을 글에 옮겨 적지 않는다.
  // 예전엔 '편집기와 글이 다르면' 옮겨 적으며 고친 시각을 찍었는데, 동기화로 글이 바뀐 직후 편집기에
  // 남아 있던 옛 내용이 그렇게 '방금 고친 최신'으로 둔갑해 다른 기기의 새 내용을 덮었다.
  // 그래도 다르다면(정상이면 없는 일) 화면 내용을 잃지 않게 사본으로만 남기고 원본은 건드리지 않는다.
  if (currentId && !reloadingForUpdate) {
    const memo = memos.find((m) => m.id === currentId);
    const lf = (s) => s.replace(/\r\n?/g, '\n');   // 입력칸은 줄바꿈을 \n 으로 바꿔 돌려준다
    if (memo && (lf(memo.content) !== editor.value || memo.title !== titleInput.value)) {
      memos.unshift(conflictCopy({ ...memo, content: editor.value, title: titleInput.value }));
      saveLocalData();
      refreshOpenMemo();
    }
  }
  if (localSaveTimer) saveLocalData();   // 모아 두던 기기 저장을 지금 끝낸다
  // 아직 못 보낸 변경이 있으면 기다리지 않고 지금 바로 보낸다.
  // (예전에는 '대기 중인 전송'이 있을 때만 보내서, 타이핑 1.5초 안에 앱을 벗어나면 아무것도 안 갔다)
  // 새 버전으로 다시 여는 중이면 올리지 않는다 — 새 코드가 열리자마자 이어서 올린다
  clearTimeout(syncTimer);
  syncTimer = null;
  if (accessToken && isDirty() && !reloadingForUpdate) syncToDropbox().catch(() => {});
}

// ── Viewer Mode ──
function toggleViewer() {
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  const newMode = !viewerMode;
  memo.viewerMode = newMode;
  memo.metaAt = Date.now();
  applyViewerMode(newMode);
  saveLocalData();
  scheduleSyncToDropbox();
}

function applyViewerMode(on) {
  viewerMode = on;
  editor.readOnly = on;
  titleInput.readOnly = on;
  editor.classList.toggle('viewer', on);
  $('#btn-viewer').classList.toggle('active', on);
}

// ── Undo / Redo (어절 단위) ──
let undoGroupOpen = false;     // 현재 타이핑 묶음이 열려 있는지
let undoIdleTimer = null;
// 어절 경계로 볼 문자: 공백·줄바꿈·구두점
const UNDO_WORD_BOUNDARY = /[\s.,!?;:'"()\[\]{}~…·，。！？；：、]/;

function scheduleUndoSnapshot(memo) {
  const before = memo.content;   // 이번 입력이 반영되기 전 내용
  const after = editor.value;    // 반영된 후 내용
  if (before === after) return;

  // 새 어절 묶음의 시작: '입력 전 상태'를 한 번만 저장
  if (!undoGroupOpen) {
    if (undoStack.length === 0 || undoStack[undoStack.length - 1] !== before) {
      undoStack.push(before);
      if (undoStack.length > UNDO_MAX) undoStack.shift();
    }
    redoStack = []; // 새 입력 시 되살리기 이력 초기화
    undoGroupOpen = true;
  }

  // 어절 경계(공백·구두점)를 입력하면 묶음을 끊어 다음 글자가 새 묶음이 되게 함
  if (UNDO_WORD_BOUNDARY.test(after.slice(-1))) {
    undoGroupOpen = false;
  }

  // 잠시(1.2초) 멈추면 묶음을 끊음
  clearTimeout(undoIdleTimer);
  undoIdleTimer = setTimeout(() => { undoGroupOpen = false; }, 1200);
}

// 옛 내용과 새 내용이 갈라지는 '바뀐 구간의 끝' 위치를 구한다 (되돌리기/되살리기 후 커서 이동용)
function caretAfterChange(oldStr, newStr) {
  const oldLen = oldStr.length, newLen = newStr.length;
  let p = 0;
  const maxP = Math.min(oldLen, newLen);
  while (p < maxP && oldStr[p] === newStr[p]) p++; // 공통 앞부분
  let s = 0;
  const maxS = Math.min(oldLen, newLen) - p;
  while (s < maxS && oldStr[oldLen - 1 - s] === newStr[newLen - 1 - s]) s++; // 공통 뒷부분
  return newLen - s; // 새 내용에서 바뀐 구간의 끝
}

// 되돌리기/되살리기로 본문을 교체한 뒤, 바뀐 지점으로 커서를 옮기고 화면에 보이게 한다
function restoreEditorContent(newContent) {
  const caret = caretAfterChange(editor.value, newContent);
  editor.value = newContent;
  editor.focus();
  editor.setSelectionRange(caret, caret);
  $('#editor-highlight').scrollTop = editor.scrollTop; // 하이라이트 오버레이 스크롤 동기화
}

function performUndo() {
  if (viewerMode) { showToast('읽기 전용 보기입니다'); return; }
  if (undoStack.length === 0) {
    showToast('되돌릴 내용이 없습니다');
    return;
  }
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;

  // 현재 상태를 redo 스택에 저장
  redoStack.push(editor.value);

  // 현재 내용과 같으면 한 단계 더 뒤로
  let prev = undoStack.pop();
  if (prev === editor.value && undoStack.length > 0) {
    prev = undoStack.pop();
  }

  const beforeUndo = editor.value;
  restoreEditorContent(prev); // 본문 교체 + 바뀐 지점으로 커서 이동
  if (memo.highlights && memo.highlights.length) memo.highlights = adjustHighlights(beforeUndo, prev, memo.highlights);
  memo.content = prev;
  memo.updatedAt = Date.now();
  undoGroupOpen = false; // 되돌린 뒤 새 입력은 새 묶음으로
  updateCharCount();
  repaintOverlay();
  scheduleAutoSave();
  showToast('되돌리기 완료');
}

function performRedo() {
  if (viewerMode) { showToast('읽기 전용 보기입니다'); return; }
  if (redoStack.length === 0) {
    showToast('되살릴 내용이 없습니다');
    return;
  }
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;

  // 현재 상태를 undo 스택에 저장
  undoStack.push(editor.value);

  let next = redoStack.pop();
  if (next === editor.value && redoStack.length > 0) {
    next = redoStack.pop();
  }

  const beforeRedo = editor.value;
  restoreEditorContent(next); // 본문 교체 + 바뀐 지점으로 커서 이동
  if (memo.highlights && memo.highlights.length) memo.highlights = adjustHighlights(beforeRedo, next, memo.highlights);
  memo.content = next;
  memo.updatedAt = Date.now();
  undoGroupOpen = false; // 되살린 뒤 새 입력은 새 묶음으로
  updateCharCount();
  repaintOverlay();
  scheduleAutoSave();
  showToast('되살리기 완료');
}

// ── Char Count ──
function updateCharCount() {
  const el = $('#char-count');
  if (!el) return;
  const len = editor.value.length;
  el.textContent = len.toLocaleString() + '자';
}

// ── Toolbar More ──
function toggleToolbarMore() {
  const extras = document.querySelectorAll('.toolbar-extra');
  const btn = $('#btn-toolbar-more');
  const expanded = btn.classList.toggle('active');
  extras.forEach((el) => el.classList.toggle('toolbar-show', expanded));
  $('#toolbar-right').classList.toggle('expanded', expanded);
  $('#toolbar-buttons').classList.toggle('expanded', expanded);
}

// ── Memo Dates ──
function updateMemoDates(memo) {
  const el = $('#memo-dates');
  if (!el || !memo) return;
  const fmt = (ts) => {
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  const textEl = $('#memo-dates-text');
  if (textEl) textEl.textContent = '작성: ' + fmt(memo.createdAt) + '　수정: ' + fmt(memo.updatedAt);
  el.style.display = 'flex';
}

// ── Help ──
function showHelpDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box help-box">
      <h3>도움말 · 사용 팁</h3>
      <div class="help-content">
        <p class="help-h">⌨️ 단축키 (PC)</p>
        <ul>
          <li><kbd>Ctrl</kbd>+<kbd>S</kbd> 저장·동기화</li>
          <li><kbd>Ctrl</kbd>+<kbd>N</kbd> 새 글</li>
          <li><kbd>Ctrl</kbd>+<kbd>F</kbd> 찾기·바꾸기</li>
          <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> 되돌리기 · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> 되살리기</li>
          <li><kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> 구분선 ------ · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> 구분선 ======</li>
          <li><kbd>Alt</kbd>+<kbd>;</kbd> 날짜 입력 · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>;</kbd> 날짜+시간 입력</li>
          <li><kbd>Alt</kbd>+<kbd>H</kbd> 선택 부분 형광펜(하이라이트) 켜기/끄기</li>
        </ul>
        <p class="help-h">🗂️ 폴더·정리</p>
        <ul>
          <li>${ico('folder')} 현재 글을 폴더에 지정 — 빈 글도 폴더를 정하면 사라지지 않습니다</li>
          <li><b>폴더 관리</b> — 폴더를 우클릭(휴대폰은 길게 누르기)하거나 폴더 목록 아래 '폴더 관리'. 순서·이름·휴면·비밀번호·삭제를 한 화면에서</li>
          <li>${ico('more')} 더보기에서 즐겨찾기(${ico('star')})·삭제(${ico('trash')})</li>
          <li>${ico('select')} 선택 모드로 여러 글을 한 번에 이동·삭제</li>
        </ul>
        <p class="help-h">📝 작성·보기</p>
        <ul>
          <li>${ico('template')} 템플릿 저장·불러오기 · ${ico('copy')} 본문만 복사 · ${ico('book')} 읽기 전용 보기</li>
          <li>형광펜(<kbd>Alt</kbd>+<kbd>H</kbd>)은 앱 안에서만 보이는 표시예요 — 복사·붙여넣기하면 순수 글자만 오갑니다</li>
          <li>글 목록에서 <b>더블클릭</b>하면 새 창으로 열립니다</li>
        </ul>
        <p class="help-h">💾 저장·백업·보안</p>
        <ul>
          <li>입력하면 자동 저장·자동 동기화 (최근 시각은 왼쪽 위에 표시)</li>
          <li>${ico('save')} 수동 백업 · 매일 자동 백업 · ${ico('trash')} 휴지통에서 복원</li>
          <li>폴더에 비밀번호 설정 가능 (Master로 전체 해제)</li>
        </ul>
      </div>
      <button class="btn btn-primary" id="help-close">닫기</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#help-close').onclick = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ── Find & Replace ──
let findMatches = [];
let findIndex = -1;
let findAllMode = false;
let searchKeyword = '';      // 찾기 중인 단어 (없으면 '')
let searchCurrentPos = -1;   // 찾기에서 '현재' 위치 (주황 표시)

function toggleFindReplace() {
  const bar = $('#find-replace-bar');
  const visible = bar.style.display !== 'none';
  bar.style.display = visible ? 'none' : 'flex';
  if (!visible) {
    $('#find-input').value = '';
    $('#replace-input').value = '';
    $('#find-count').textContent = '';
    findMatches = [];
    findIndex = -1;
    findAllMode = false;
    clearHighlight();
    $('#find-input').focus();
  } else {
    clearHighlight();
  }
}

function findCountOnly() {
  const keyword = $('#find-input').value;
  const content = editor.value;
  findMatches = [];
  findIndex = -1;
  findAndGo._lastKeyword = null;
  if (!keyword) { $('#find-count').textContent = ''; return; }
  let idx = 0;
  const lower = content.toLowerCase();
  const keyLower = keyword.toLowerCase();
  while ((idx = lower.indexOf(keyLower, idx)) !== -1) {
    findMatches.push(idx);
    idx += keyLower.length;
  }
  $('#find-count').textContent = findMatches.length + '건';
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── 형광펜(하이라이트) ──
// 본문은 순수 텍스트 그대로 두고(=복사·붙여넣기·검색·기존 노트 100% 그대로),
// '어디에 색을 칠할지'만 memo.highlights = [{start,end}, ...]에 별도로 저장한다.
// 화면 표시는 본문 textarea 뒤의 오버레이(#editor-highlight)에 배경색으로만 그린다.

// 범위 목록 정규화: 정렬 + 겹치거나 맞닿은 범위 병합 + 빈 범위 제거
function normalizeHighlights(list) {
  const arr = (list || [])
    .map((h) => ({ start: Math.max(0, h.start | 0), end: h.end | 0 }))
    .filter((h) => h.end > h.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const h of arr) {
    const last = out[out.length - 1];
    if (last && h.start <= last.end) last.end = Math.max(last.end, h.end);
    else out.push({ start: h.start, end: h.end });
  }
  return out;
}

function addHighlightRange(list, s, e) {
  return normalizeHighlights([...(list || []), { start: s, end: e }]);
}

function removeHighlightRange(list, s, e) {
  const out = [];
  for (const h of (list || [])) {
    if (h.end <= s || h.start >= e) { out.push(h); continue; } // 겹치지 않음 → 그대로
    if (h.start < s) out.push({ start: h.start, end: s });      // 왼쪽 조각 남김
    if (h.end > e) out.push({ start: e, end: h.end });          // 오른쪽 조각 남김
  }
  return normalizeHighlights(out);
}

// [s,e)가 통째로 칠해져 있는가 (하나의 병합 범위가 완전히 감싸면 true)
function isRangeFullyHighlighted(list, s, e) {
  for (const h of normalizeHighlights(list)) {
    if (h.start <= s && h.end >= e) return true;
  }
  return false;
}

// 옛/새 텍스트가 갈라지는 구간을 찾는다 (편집으로 밀린 형광펜 위치 보정용)
function diffRange(oldStr, newStr) {
  const oldLen = oldStr.length, newLen = newStr.length;
  let p = 0;
  const maxP = Math.min(oldLen, newLen);
  while (p < maxP && oldStr[p] === newStr[p]) p++;
  let s = 0;
  const maxS = Math.min(oldLen, newLen) - p;
  while (s < maxS && oldStr[oldLen - 1 - s] === newStr[newLen - 1 - s]) s++;
  return { p, oldEnd: oldLen - s, newEnd: newLen - s };
}

// 본문이 old→new로 바뀌었을 때, 형광펜 범위들을 새 좌표로 옮긴다
function adjustHighlights(oldText, newText, hls) {
  if (!hls || hls.length === 0) return hls || [];
  const { p, oldEnd, newEnd } = diffRange(oldText, newText);
  if (p === oldEnd && p === newEnd) return hls; // 변화 없음
  const delta = newEnd - oldEnd;
  const pureInsert = oldEnd === p; // 삭제 없이 삽입만 일어난 경우
  const out = [];
  for (const h of hls) {
    const a = h.start, b = h.end;
    if (b <= p) { out.push({ start: a, end: b }); continue; }                       // 변경 구간보다 앞 → 그대로
    if (a >= oldEnd) { out.push({ start: a + delta, end: b + delta }); continue; }  // 뒤 → 통째로 이동
    if (pureInsert) {
      // 삽입 지점이 형광펜 안쪽 → 삽입된 글자도 형광펜에 포함되게 늘림
      out.push({ start: a, end: b + delta });
      continue;
    }
    // 삭제/교체가 형광펜과 겹침 → 손대지 않은 양옆만 남기고 가운데는 해제
    const leftEnd = Math.min(b, p);
    if (leftEnd > a) out.push({ start: a, end: leftEnd });
    const rightStart = Math.max(a, oldEnd);
    if (b > rightStart) out.push({ start: rightStart + delta, end: b + delta });
  }
  return normalizeHighlights(out);
}

// Alt+H: 선택 영역 형광펜 켜기/끄기 (이미 전부 칠해져 있으면 지움)
function toggleHighlight() {
  if (viewerMode) return;
  if (document.activeElement !== editor) return;
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  const start = editor.selectionStart, end = editor.selectionEnd;
  if (start === end) { showToast('형광펜을 칠할 부분을 먼저 선택하세요'); return; }
  const cur = memo.highlights || [];
  if (isRangeFullyHighlighted(cur, start, end)) {
    memo.highlights = removeHighlightRange(cur, start, end);
  } else {
    memo.highlights = addHighlightRange(cur, start, end);
  }
  memo.updatedAt = Date.now();
  repaintOverlay();
  saveLocalData();
  scheduleRenderAndSync();
  editor.focus();
  editor.setSelectionRange(end, end); // 선택(블록) 해제 — 커서만 칠한 부분 끝으로
}

// 찾기 표시가 켜져 있는지
function searchActive() {
  return searchKeyword !== '' && findMatches.length > 0;
}

// 오버레이(형광펜 + 찾기 결과)를 현재 상태대로 다시 그린다
function repaintOverlay() {
  const hl = $('#editor-highlight');
  if (!hl) return;
  const memo = memos.find((m) => m.id === currentId);
  const userH = (memo && memo.highlights) ? memo.highlights : [];
  const marks = [];
  for (const h of userH) marks.push({ start: h.start, end: h.end, cls: 'user' });
  if (searchActive()) {
    const kl = searchKeyword.length;
    for (const pos of findMatches) {
      const cls = (!findAllMode && pos === searchCurrentPos) ? 'search-current' : 'search';
      marks.push({ start: pos, end: pos + kl, cls });
    }
  }
  if (marks.length === 0) {   // 표시할 게 없으면 비움
    if (overlayKeys.length || hl.firstChild) { hl.textContent = ''; overlayKeys = []; }
    return;
  }
  paintOverlayLines(hl, editor.value, marks);
  hl.scrollTop = editor.scrollTop;
}

// 겹침층을 줄(엔터로 나뉜 문단)마다 <div> 하나로 그리고, 지난번과 달라진 줄만 바꿔 끼운다.
// 예전엔 글자 하나 칠 때마다 글 전체를 다시 만들어 넣어, 긴 글(30만 자)에서 한 글자에 100ms 넘게 걸렸다.
// 줄마다 '열쇠'(그 줄 글자 + 그 줄 안의 표시)를 만들어 비교하고, 앞뒤로 같은 줄은 그대로 둔다.
let overlayKeys = [];
function paintOverlayLines(hl, text, marks) {
  const lines = text.split('\n');
  marks.sort((a, b) => a.start - b.start);
  const keys = new Array(lines.length);
  const lineMarks = new Array(lines.length);
  let pos = 0, mi = 0;
  let active = [];
  for (let i = 0; i < lines.length; i++) {
    const s = pos, e = pos + lines[i].length;
    while (mi < marks.length && marks[mi].start < e) active.push(marks[mi++]);
    active = active.filter((m) => m.end > s);
    const rel = [];
    for (const m of active) {
      const a = Math.max(m.start, s) - s, b = Math.min(m.end, e) - s;
      if (b > a) rel.push({ start: a, end: b, cls: m.cls });
    }
    lineMarks[i] = rel;
    keys[i] = rel.length ? lines[i] + '\u0001' + rel.map((r) => r.start + ',' + r.end + ',' + r.cls).join(';') : lines[i];
    pos = e + 1;
  }
  // 지금 그려진 것과 맞지 않으면(다른 글로 바뀐 직후 등) 전부 새로
  if (hl.childElementCount !== overlayKeys.length) { hl.textContent = ''; overlayKeys = []; }
  const old = overlayKeys;
  let a = 0;
  while (a < keys.length && a < old.length && keys[a] === old[a]) a++;
  let b = 0;
  while (b < keys.length - a && b < old.length - a && keys[keys.length - 1 - b] === old[old.length - 1 - b]) b++;
  // 바뀐 구간: 옛 [a, old.length-b) → 새 [a, keys.length-b)
  for (let k = old.length - b - 1; k >= a; k--) hl.children[k].remove();
  const ref = hl.children[a] || null;
  const frag = document.createDocumentFragment();
  for (let k = a; k < keys.length - b; k++) {
    const div = document.createElement('div');
    div.innerHTML = lines[k] ? renderMarks(lines[k], lineMarks[k]) : '\u200b';   // 빈 줄도 한 줄 높이를 차지하게
    frag.appendChild(div);
  }
  hl.insertBefore(frag, ref);
  overlayKeys = keys;
}

// 겹칠 수 있는 표시들을 우선순위(현재 찾기 > 찾기 > 형광펜)로 합쳐 <mark> HTML 생성
function renderMarks(text, marks) {
  const n = text.length;
  const prio = { user: 1, search: 2, 'search-current': 3 };
  const pts = new Set([0, n]);
  for (const m of marks) {
    if (m.start > 0 && m.start < n) pts.add(m.start);
    if (m.end > 0 && m.end < n) pts.add(m.end);
  }
  const xs = Array.from(pts).sort((a, b) => a - b);
  let out = '';
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i], b = xs[i + 1];
    let best = null, bestP = 0;
    for (const m of marks) {
      if (m.start <= a && m.end >= b) {
        const pr = prio[m.cls] || 0;
        if (pr > bestP) { bestP = pr; best = m.cls; }
      }
    }
    const seg = escHtml(text.slice(a, b));
    out += best ? '<mark class="' + best + '">' + seg + '</mark>' : seg;
  }
  return out;
}

function updateHighlight(keyword) {
  searchKeyword = keyword || '';
  searchCurrentPos = -1;
  repaintOverlay();
}

function clearHighlight() {
  searchKeyword = '';
  searchCurrentPos = -1;
  repaintOverlay(); // 찾기 표시만 지우고 형광펜은 다시 보이게
}

function findAndGo() {
  findAllMode = false;
  // 키워드가 바뀌었으면 재검색, 아니면 다음으로 이동
  const keyword = $('#find-input').value;
  if (findMatches.length === 0 || keyword.toLowerCase() !== (findAndGo._lastKeyword || '').toLowerCase()) {
    findCountOnly();
    findAndGo._lastKeyword = keyword;
  }
  if (findMatches.length > 0) findNavigate(1);
}

function findAllAndGo() {
  findAllMode = true;
  findCountOnly();
  if (findMatches.length === 0) { clearHighlight(); return; }
  updateHighlight($('#find-input').value);
  $('#find-count').textContent = findMatches.length + '건 전체';
  showToast(findMatches.length + '건 찾음');
}

function findNavigate(dir) {
  if (findMatches.length === 0) return;
  findAllMode = false;
  findIndex += dir;
  if (findIndex >= findMatches.length) findIndex = 0;
  if (findIndex < 0) findIndex = findMatches.length - 1;
  const pos = findMatches[findIndex];
  const keyword = $('#find-input').value;
  $('#find-count').textContent = (findIndex + 1) + '/' + findMatches.length;
  // 에디터에 포커스를 보내지 않고 하이라이트로 현재 위치 표시
  highlightAllWithCurrent(keyword, pos);
  scrollEditorToPos(pos);
}

function highlightAllWithCurrent(keyword, currentPos) {
  searchKeyword = keyword || '';
  searchCurrentPos = currentPos;
  repaintOverlay();
}

function scrollEditorToPos(pos) {
  // 화면에서 접힌 줄까지 반영하려면 실제로 그려진 표시(오버레이의 현재 찾기 표시) 위치를 쓴다
  const mk = $('#editor-highlight').querySelector('mark.search-current');
  if (mk) {
    editor.scrollTop = Math.max(0, mk.offsetTop - editor.clientHeight / 3);
    $('#editor-highlight').scrollTop = editor.scrollTop;
    return;
  }
  const textBefore = editor.value.substring(0, pos);
  const lines = textBefore.split('\n').length - 1;
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight);
  const targetScroll = lines * lineHeight - editor.clientHeight / 3;
  editor.scrollTop = Math.max(0, targetScroll);
  $('#editor-highlight').scrollTop = editor.scrollTop;
}

// ── Templates ──
function mergeTemplates(local, remote) {
  const permDelIds = new Set(deletedIds.map((d) => d.id || d));
  const map = new Map();
  for (const t of remote) { if (!permDelIds.has(t.id)) map.set(t.id, t); }
  for (const t of local) {
    if (permDelIds.has(t.id)) continue;
    const existing = map.get(t.id);
    if (!existing || t.updatedAt > existing.updatedAt) map.set(t.id, t);
  }
  return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);
}

function toggleTemplateDropdown() {
  const dd = $('#template-dropdown');
  const isOpen = dd.style.display !== 'none';
  if (isOpen) { dd.style.display = 'none'; return; }
  renderTemplateList();
  positionDropdown(dd, $('#btn-template'));
  dd.style.display = 'block';
}

function renderTemplateList() {
  const list = $('#template-list');
  if (templates.length === 0) {
    list.innerHTML = '<div class="template-empty">저장된 템플릿이 없습니다</div>';
    return;
  }
  list.innerHTML = templates.map((t) =>
    '<div class="template-item" data-id="' + t.id + '">' +
    '<span class="template-item-name">' + escHtml(t.title || '(제목 없음)') + '</span>' +
    '<button class="template-item-del" data-id="' + t.id + '" title="삭제">×</button>' +
    '</div>'
  ).join('');
  list.querySelectorAll('.template-item-name').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.parentElement.dataset.id;
      applyTemplate(id);
    });
  });
  list.querySelectorAll('.template-item-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTemplate(btn.dataset.id);
    });
  });
}

function saveAsTemplate() {
  if (!currentId) { showToast('메모를 먼저 선택하세요'); return; }
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  const name = prompt('템플릿 이름을 입력하세요:', memo.title || '');
  if (name === null) return;
  const tpl = {
    id: crypto.randomUUID(),
    title: name.trim() || '(제목 없음)',
    content: memo.content,
    folder: memo.folder || null,   // 템플릿에 폴더도 함께 저장
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  templates.unshift(tpl);
  saveLocalData();
  scheduleSyncToDropbox();
  renderTemplateList();
  showToast('템플릿이 저장되었습니다');
}

function applyTemplate(templateId) {
  const tpl = templates.find((t) => t.id === templateId);
  if (!tpl) return;
  $('#template-dropdown').style.display = 'none';

  // 현재 비어 있는(제목·본문 모두 빈) 노트가 열려 있으면 새로 만들지 않고 그 노트에 적용
  const cur = currentId ? memos.find((m) => m.id === currentId) : null;
  const applyToCurrent = !!(cur && !cur.title.trim() && !cur.content.trim());

  // 폴더 결정: 템플릿에 저장된 폴더(존재 시) 우선 → 현재 노트/현재 연 폴더 순
  let targetFolder = null;
  if (tpl.folder && folders.some((f) => f.id === tpl.folder)) {
    targetFolder = tpl.folder;
  } else if (applyToCurrent) {
    targetFolder = cur.folder;
  } else {
    targetFolder = (currentFolder && currentFolder !== '__none__') ? currentFolder : null;
    if (!targetFolder && currentId) {
      const c = memos.find((m) => m.id === currentId);
      if (c && c.folder) targetFolder = c.folder;
    }
  }

  let memo;
  if (applyToCurrent) {
    // 빈 새 노트에 그대로 적용 (별도 노트 생성하지 않음)
    memo = cur;
    memo.title = tpl.title;
    memo.content = tpl.content;
    memo.folder = targetFolder;
    memo.updatedAt = Date.now();
  } else {
    cleanupEmptyMemo();
    memo = {
      id: crypto.randomUUID(),
      title: tpl.title,
      content: tpl.content,
      folder: targetFolder,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      favorite: false,
    };
    memos.unshift(memo);
    currentId = memo.id;
  }
  saveLocalData();
  renderAll();
  showEditor(memo);
  scheduleSyncToDropbox();
  showToast('템플릿이 적용되었습니다');
}

function deleteTemplate(templateId) {
  const tpl = templates.find((t) => t.id === templateId);
  if (!tpl) return;
  if (!confirm('"' + tpl.title + '" 템플릿을 삭제하시겠습니까?')) return;
  deletedIds.push({ id: templateId, at: Date.now() });
  templates = templates.filter((t) => t.id !== templateId);
  saveLocalData();
  scheduleSyncToDropbox();
  renderTemplateList();
  showToast('템플릿이 삭제되었습니다');
}

function replaceAction() {
  if (viewerMode) { showToast('읽기 전용 보기에서는 바꿀 수 없습니다'); return; }
  const keyword = $('#find-input').value;
  const replacement = $('#replace-input').value;
  if (!keyword || findMatches.length === 0) return;
  const oldContent = editor.value; // 형광펜 위치 보정용(교체 전 본문)
  // 찾은 뒤 본문을 고쳤으면 기억해 둔 위치가 어긋나 엉뚱한 글자를 바꾼다 — 다시 찾고 멈춘다
  if (!findAllMode) {
    const p = findMatches[findIndex < 0 ? 0 : findIndex];
    if (oldContent.substr(p, keyword.length).toLowerCase() !== keyword.toLowerCase()) {
      findCountOnly();
      if (findMatches.length) findNavigate(1);
      showToast('본문이 바뀌어 다시 찾았습니다. 한 번 더 누르세요');
      return;
    }
  }
  // 바꾸기도 되돌릴 수 있게 바꾸기 전 본문을 남긴다
  if (undoStack[undoStack.length - 1] !== oldContent) {
    undoStack.push(oldContent);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }
  redoStack = [];
  undoGroupOpen = false;

  if (findAllMode) {
    // 모두 찾기 상태 → 전체 바꾸기
    const regex = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const count = (editor.value.match(regex) || []).length;
    if (count === 0) return;
    editor.value = editor.value.replace(regex, replacement);
    const memo = memos.find((m) => m.id === currentId);
    if (memo) {
      if (memo.highlights && memo.highlights.length) memo.highlights = adjustHighlights(oldContent, editor.value, memo.highlights);
      memo.content = editor.value; memo.updatedAt = Date.now();
    }
    saveLocalData();
    scheduleSyncToDropbox();
    updateCharCount();
    findMatches = [];
    findIndex = -1;
    findAllMode = false;
    clearHighlight();
    $('#find-count').textContent = count + '건 바꿈';
    showToast(count + '건 바꿨습니다');
  } else {
    // 찾기 상태 → 현재 1건 바꾸기
    if (findIndex < 0) findIndex = 0;
    const pos = findMatches[findIndex];
    const before = editor.value.substring(0, pos);
    const after = editor.value.substring(pos + keyword.length);
    editor.value = before + replacement + after;
    const memo = memos.find((m) => m.id === currentId);
    if (memo) {
      if (memo.highlights && memo.highlights.length) memo.highlights = adjustHighlights(oldContent, editor.value, memo.highlights);
      memo.content = editor.value; memo.updatedAt = Date.now();
    }
    saveLocalData();
    scheduleSyncToDropbox();
    updateCharCount();
    findCountOnly(); // 재검색
    if (findMatches.length > 0) {
      if (findIndex >= findMatches.length) findIndex = 0;
      findNavigate(0);
    }
  }
}

// ── Copy & Share ──
// 제목은 빼고 본문 텍스트만 복사한다.
function copyMemoToClipboard() {
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  navigator.clipboard.writeText(memo.content || '').then(() => {
    showToast('클립보드에 복사됨');
  }).catch(() => {
    showToast('복사 실패');
  });
}

function shareMemo() {
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  const text = (memo.title ? memo.title + '\n\n' : '') + memo.content;
  if (navigator.share) {
    navigator.share({ title: memo.title || 'Project Papers', text }).catch(() => {});
  } else {
    // Web Share API 미지원 시 클립보드 복사 대체
    navigator.clipboard.writeText(text).then(() => {
      showToast('공유 미지원 환경 — 클립보드에 복사됨');
    }).catch(() => {
      showToast('공유 실패');
    });
  }
}

// ── Select Mode & Bulk Actions ──
function toggleSelectMode() {
  selectMode = !selectMode;
  if (!selectMode) folderListCollapsed = false;
  selectedMemos.clear();
  selectedFolders.clear();
  lastCheckedMemoIndex = -1;
  lastCheckedFolderIndex = -1;
  touchSelectActive = false;
  $('#btn-select-mode').classList.toggle('active', selectMode);
  $('#bulk-actions').style.display = selectMode ? 'flex' : 'none';
  if (selectMode) $('#folder-dropdown').style.display = 'block';
  renderMemoList();
  renderFolderList();
}

function bulkDelete() {
  const hasMemos = selectedMemos.size > 0;
  const hasFolders = selectedFolders.size > 0;
  if (!hasMemos && !hasFolders) { showToast('선택된 항목이 없습니다'); return; }
  if (hasMemos && hasFolders) { showToast('메모와 폴더를 동시에 삭제할 수 없습니다. 하나만 선택해주세요.'); return; }

  const label = hasMemos ? selectedMemos.size + '개 메모' : selectedFolders.size + '개 폴더';
  // 1차 확인
  const o1 = document.createElement('div');
  o1.className = 'modal-overlay';
  o1.innerHTML = `<div class="modal-box"><p>${label}를 삭제할까요?</p><button class="btn btn-secondary" id="bd-cancel">취소</button> <button class="btn btn-primary" id="bd-ok">삭제</button></div>`;
  document.body.appendChild(o1);
  o1.querySelector('#bd-cancel').onclick = () => o1.remove();
  o1.addEventListener('click', (e) => { if (e.target === o1) o1.remove(); });
  o1.querySelector('#bd-ok').onclick = () => {
    o1.remove();
    // 2차 확인
    const o2 = document.createElement('div');
    o2.className = 'modal-overlay';
    o2.innerHTML = `<div class="modal-box"><p>${label}를 정말 삭제할까요?</p><button class="btn btn-secondary" id="bd-cancel2">취소</button> <button class="btn btn-primary" id="bd-ok2">삭제</button></div>`;
    document.body.appendChild(o2);
    o2.querySelector('#bd-cancel2').onclick = () => o2.remove();
    o2.addEventListener('click', (e) => { if (e.target === o2) o2.remove(); });
    o2.querySelector('#bd-ok2').onclick = () => {
      o2.remove();
      if (hasMemos) {
        for (const id of selectedMemos) {
          const memo = memos.find((m) => m.id === id);
          if (memo) trash.push({ type: 'memo', data: { ...memo }, deletedAt: Date.now() });
        }
        memos = memos.filter((m) => !selectedMemos.has(m.id));
        if (selectedMemos.has(currentId)) { currentId = null; hideEditor(); }
        selectedMemos.clear();
      } else {
        for (const id of selectedFolders) {
          deleteFolder(id);
        }
        selectedFolders.clear();
      }
      saveLocalData();
      renderAll();
      scheduleSyncToDropbox();
      showToast('삭제되었습니다');
    };
  };
}

function bulkMoveUnified() {
  const hasMemos = selectedMemos.size > 0;
  const hasFolders = selectedFolders.size > 0;
  if (!hasMemos && !hasFolders) { showToast('선택된 항목이 없습니다'); return; }
  if (hasMemos && hasFolders) { showToast('메모와 폴더를 동시에 이동할 수 없습니다. 하나만 선택해주세요.'); return; }

  if (hasMemos) {
    // 메모 이동
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    let opts = '<option value="">-- 폴더 없음 --</option>';
    const topFolders = folders.filter((f) => !f.parentId && !f.dormant).sort(sortBySortOrder);
    for (const f of topFolders) {
      opts += '<option value="' + f.id + '">' + escapeHtml(f.name) + '</option>';
      const children = getChildFolders(f.id);
      for (const c of children) {
        opts += '<option value="' + c.id + '">　' + escapeHtml(c.name) + '</option>';
      }
    }
    overlay.innerHTML = '<div class="modal-box"><p>' + selectedMemos.size + '개 메모를 이동할 폴더를 선택하세요</p><select style="width:100%;padding:8px;margin-bottom:16px;border:1px solid var(--border);border-radius:var(--radius);font-size:0.9rem;">' + opts + '</select><div><button class="btn btn-primary" id="bm-ok">이동</button> <button class="btn btn-secondary" id="bm-cancel">취소</button></div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector('#bm-cancel').onclick = () => overlay.remove();
    overlay.querySelector('#bm-ok').onclick = () => {
      const folder = overlay.querySelector('select').value || null;
      for (const id of selectedMemos) {
        const m = memos.find((x) => x.id === id);
        if (m) { m.folder = folder; m.updatedAt = Date.now(); }
      }
      selectedMemos.clear();
      overlay.remove();
      saveLocalData();
      renderAll();
      scheduleSyncToDropbox();
      showToast('이동되었습니다');
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  } else {
    // 폴더 이동
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const excludeIds = new Set(selectedFolders);
    for (const id of selectedFolders) {
      getChildFolders(id).forEach((c) => excludeIds.add(c.id));
    }
    let opts = '<option value="__top__">-- 최상위 (상위폴더 없음) --</option>';
    const topFolders = folders.filter((f) => !f.parentId && !f.dormant && !excludeIds.has(f.id)).sort(sortBySortOrder);
    for (const f of topFolders) {
      opts += '<option value="' + f.id + '">' + escapeHtml(f.name) + '</option>';
    }
    overlay.innerHTML = '<div class="modal-box"><p>' + selectedFolders.size + '개 폴더를 이동할 상위 폴더를 선택하세요</p><select style="width:100%;padding:8px;margin-bottom:16px;border:1px solid var(--border);border-radius:var(--radius);font-size:0.9rem;">' + opts + '</select><div><button class="btn btn-primary" id="bf-ok">이동</button> <button class="btn btn-secondary" id="bf-cancel">취소</button></div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector('#bf-cancel').onclick = () => overlay.remove();
    overlay.querySelector('#bf-ok').onclick = () => {
      const target = overlay.querySelector('select').value;
      const newParent = target === '__top__' ? null : target;
      if (newParent && [...selectedFolders].some((id) => getChildFolders(id).length)) {
        showToast('하위 폴더가 있는 폴더는 최상위로만 옮길 수 있습니다');
        return;
      }
      for (const id of selectedFolders) {
        const f = folders.find((x) => x.id === id);
        if (f) {
          f.parentId = newParent;
          f.sortOrder = nextSortOrder(newParent);
          f.updatedAt = Date.now();
        }
      }
      selectedFolders.clear();
      overlay.remove();
      saveLocalData();
      renderAll();
      scheduleSyncToDropbox();
      showToast('폴더가 이동되었습니다');
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }
}

// ── Render ──
function renderAll() {
  renderFolderList();
  renderMemoList();
  if (fm) renderFolderManager();
}

function toggleFolderDropdown() {
  const dd = $('#folder-dropdown');
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
}

function toggleFolderListCollapse() {
  folderListCollapsed = !folderListCollapsed;
  $('#folder-dropdown').style.display = 'block'; // 드롭다운 자체는 항상 유지
  renderFolderList();
}

function toggleFavFilter() {
  favFilterActive = !favFilterActive;
  const btn = $('#btn-fav-filter');
  btn.classList.toggle('active', favFilterActive); // 켜지면 CSS 가 별 속을 채운다
  renderMemoList();
}

function updateFolderToggleLabel() {
  const btn = $('#btn-folder-toggle');
  let label = '전체';
  if (currentFolder === '__none__') label = '미분류';
  else if (currentFolder) {
    const f = folders.find((f) => f.id === currentFolder);
    if (f) label = f.name;
  }
  btn.innerHTML = ico('folder') + ' ' + escapeHtml(label);
}

function renderFolderItem(f, isChild) {
  const count = isChild ? memos.filter((m) => m.folder === f.id && isVisibleMemo(m)).length : getFolderMemoCount(f.id);
  const lockIcon = f.password ? ico(unlockedFolders.has(f.id) ? 'unlock' : 'lock') : '';
  const childClass = isChild ? ' folder-item--child' : '';
  const folderCheckbox = selectMode ? `<input type="checkbox" class="folder-item-checkbox" data-folder-check="${f.id}"${selectedFolders.has(f.id) ? ' checked' : ''}>` : '';
  return `<div class="folder-item${childClass} ${currentFolder === f.id ? 'active' : ''}" data-folder="${f.id}">
    ${folderCheckbox}
    <span class="folder-item-name">${lockIcon ? lockIcon + ' ' : ''}${escapeHtml(f.name)} <span class="folder-count">(${count})</span></span>
  </div>`;
}

function renderFolderList() {
  const lockedIds = getLockedFolderIds();
  const dormantIds = getDormantFolderIds();
  const allCount = memos.filter((m) => !lockedIds.includes(m.folder) && !dormantIds.has(m.folder) && isVisibleMemo(m)).length;
  const collapseBtn = selectMode
    ? `<button class="folder-collapse-btn">${folderListCollapsed ? '목록 펼치기' : '목록 접기'}</button>`
    : '';
  let html = `<div class="folder-item ${currentFolder === null ? 'active' : ''}" data-folder="__all__">
    <span class="folder-item-name">전체 <span class="folder-count">(${allCount})</span></span>
    ${collapseBtn}
  </div>`;

  // 접힌 상태(선택 모드)에서는 전체 행만 표시, 펼쳐진 상태에서는 나머지 폴더 추가
  if (!selectMode || !folderListCollapsed) {

  // 활성 폴더 (휴면이 아닌 폴더)
  const topFolders = folders.filter((f) => !f.parentId && !f.dormant).sort(sortBySortOrder);
  for (const f of topFolders) {
    html += renderFolderItem(f, false);
    const children = getChildFolders(f.id);
    for (const c of children) {
      html += renderFolderItem(c, true);
    }
  }

  const noFolderCount = memos.filter((m) => !m.folder && isVisibleMemo(m)).length;
  if (folders.length > 0) {
    html += `<div class="folder-item ${currentFolder === '__none__' ? 'active' : ''}" data-folder="__none__">
      <span class="folder-item-name">미분류 <span class="folder-count">(${noFolderCount})</span></span>
    </div>`;
  }

  // 휴면 폴더 섹션
  const dormantTopFolders = folders.filter((f) => !f.parentId && f.dormant).sort(sortBySortOrder);
  if (dormantTopFolders.length > 0) {
    const dormantMemoCount = memos.filter((m) => dormantIds.has(m.folder) && isVisibleMemo(m)).length;
    html += `<div class="folder-dormant-toggle" id="dormant-toggle">
      <span>${ico('moon')} 휴면 폴더 <span class="folder-count">(${dormantMemoCount})</span></span>
      <span class="dormant-arrow">▶</span>
    </div>`;
    html += `<div class="folder-dormant-list" id="dormant-list" style="display:none;">`;
    for (const f of dormantTopFolders) {
      html += renderFolderItem(f, false);
      const children = getChildFolders(f.id);
      for (const c of children) {
        html += renderFolderItem(c, true);
      }
    }
    html += `</div>`;
  }

  } // end: !selectMode || !folderListCollapsed

  folderList.innerHTML = html;
  updateFolderToggleLabel();

  // 휴면 폴더 토글
  const dormantToggle = folderList.querySelector('#dormant-toggle');
  if (dormantToggle) {
    dormantToggle.addEventListener('click', () => {
      const list = folderList.querySelector('#dormant-list');
      const arrow = dormantToggle.querySelector('.dormant-arrow');
      if (list.style.display === 'none') {
        list.style.display = 'block';
        arrow.textContent = '▼';
      } else {
        list.style.display = 'none';
        arrow.textContent = '▶';
      }
    });
  }

  // 선택 모드: 폴더 체크박스 이벤트
  const selectableFolderItems = Array.from(folderList.querySelectorAll('.folder-item[data-folder]')).filter((el) => el.querySelector('.folder-item-checkbox'));
  folderList.querySelectorAll('.folder-item-checkbox').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const id = cb.dataset.folderCheck;
      if (cb.checked) selectedFolders.add(id); else selectedFolders.delete(id);
    });
    cb.addEventListener('click', (e) => e.stopPropagation());
  });

  // 모바일 롱프레스 범위 선택 (폴더)
  if (selectMode) {
    let fTouchStartIdx = -1;
    let fTouchLastIdx = -1;
    selectableFolderItems.forEach((el, idx) => {
      el.addEventListener('touchstart', (e) => {
        touchSelectActive = false;
        fTouchStartIdx = idx;
        fTouchLastIdx = idx;
        el._fLongPress = setTimeout(() => {
          touchSelectActive = true;
          const cb = el.querySelector('.folder-item-checkbox');
          if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
          lastCheckedFolderIndex = idx;
        }, 400);
      }, { passive: true });
      el.addEventListener('touchend', () => {
        clearTimeout(el._fLongPress);
        touchSelectActive = false;
      });
    });
    if (folderList._selMove) folderList.removeEventListener('touchmove', folderList._selMove);
    folderList._selMove = (e) => {
      if (!touchSelectActive) return;
      const touch = e.touches[0];
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      if (!target) return;
      const item = target.closest('.folder-item');
      if (!item) return;
      const idx = selectableFolderItems.indexOf(item);
      if (idx === -1 || idx === fTouchLastIdx) return;
      fTouchLastIdx = idx;
      const start = Math.min(fTouchStartIdx, idx);
      const end = Math.max(fTouchStartIdx, idx);
      for (let i = start; i <= end; i++) {
        const cb = selectableFolderItems[i].querySelector('.folder-item-checkbox');
        if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
      }
    };
    folderList.addEventListener('touchmove', folderList._selMove, { passive: true });
  } else if (folderList._selMove) {
    folderList.removeEventListener('touchmove', folderList._selMove);
    folderList._selMove = null;
  }

  folderList.querySelectorAll('.folder-item').forEach((el) => {
    // 진짜 폴더(전체·미분류 제외)는 우클릭(PC)·길게 누르기(휴대폰)로 폴더 관리 화면을 그 폴더에 맞춰 연다
    const realFolder = el.dataset.folder !== '__all__' && el.dataset.folder !== '__none__';
    let longPressTimer = null;
    let didLongPress = false;

    el.addEventListener('touchstart', () => {
      if (selectMode || !realFolder) return; // 선택 모드에서는 롱프레스 비활성화
      didLongPress = false;
      longPressTimer = setTimeout(() => {
        didLongPress = true;
        openFolderManager(el.dataset.folder);
      }, 500);
    }, { passive: true });

    el.addEventListener('touchend', (e) => {
      clearTimeout(longPressTimer);
      // 손을 뗄 때 생기는 클릭이 방금 뜬 관리 화면의 버튼을 누르지 않게
      if (didLongPress && e.cancelable) e.preventDefault();
    });
    el.addEventListener('touchmove', () => { clearTimeout(longPressTimer); });

    // 우클릭 (안드로이드는 길게 누르기에도 이 신호가 온다 — 이미 열려 있으면 그 폴더만 다시 짚는다)
    el.addEventListener('contextmenu', (e) => {
      if (selectMode || !realFolder) return;
      e.preventDefault();
      openFolderManager(el.dataset.folder);
    });

    el.addEventListener('click', (e) => {
      if (didLongPress) { didLongPress = false; return; }

      // 선택 모드: 폴더 체크박스 토글 + Shift 범위 선택
      if (selectMode) {
        if (el.dataset.folder === '__all__') { toggleFolderListCollapse(); return; }
        const cb = el.querySelector('.folder-item-checkbox');
        if (!cb) return; // 미분류는 체크박스 없음
        const idx = selectableFolderItems.indexOf(el);
        if (e.shiftKey && lastCheckedFolderIndex >= 0 && idx >= 0) {
          const start = Math.min(lastCheckedFolderIndex, idx);
          const end = Math.max(lastCheckedFolderIndex, idx);
          for (let i = start; i <= end; i++) {
            const c = selectableFolderItems[i].querySelector('.folder-item-checkbox');
            if (c && !c.checked) { c.checked = true; c.dispatchEvent(new Event('change')); }
          }
          lastCheckedFolderIndex = idx;
          return;
        }
        if (e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
        if (idx >= 0) lastCheckedFolderIndex = idx;
        return;
      }

      const val = el.dataset.folder;
      if (val === '__all__') { currentFolder = null; }
      else if (val === '__none__') { currentFolder = '__none__'; }
      else {
        if (isFolderLocked(val)) {
          showPasswordPrompt(val, () => {
            currentFolder = val;
            renderAll();
            if (!selectMode) $('#folder-dropdown').style.display = 'none';
          });
          return;
        }
        currentFolder = val;
      }
      renderAll();
      if (!selectMode) $('#folder-dropdown').style.display = 'none';
    });
  });
}

function renderMemoList() {
  const query = searchBox.value.toLowerCase().trim();
  // 현재 편집 중이 아닌 빈 메모는 목록에서 숨기기 (폴더 지정된 메모는 표시)
  let filtered = memos.filter((m) => m.id === currentId || !isBlankMemo(m));
  const lockedIds = getLockedFolderIds();

  if (currentFolder === '__none__') {
    filtered = filtered.filter((m) => !m.folder);
  } else if (currentFolder) {
    const childIds = getChildFolders(currentFolder).map((f) => f.id);
    filtered = filtered.filter((m) => m.folder === currentFolder || childIds.includes(m.folder));
  } else {
    // 전체 보기: 잠긴 폴더 + 휴면 폴더의 글 숨기기
    const dormantIds = getDormantFolderIds();
    filtered = filtered.filter((m) => !lockedIds.includes(m.folder) && !dormantIds.has(m.folder));
  }

  if (favFilterActive) {
    filtered = filtered.filter((m) => m.favorite);
  }

  if (query) {
    filtered = filtered.filter(
      (m) =>
        (m.title || '').toLowerCase().includes(query) ||
        (m.content || '').toLowerCase().includes(query)
    );
  }

  // 정렬
  if (memoSortKey === 'title') {
    filtered.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ko'));
  } else if (memoSortKey === 'createdAt') {
    filtered.sort((a, b) => b.createdAt - a.createdAt);
  } else {
    filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // 폴더 보기일 때(전체 보기가 아닐 때) 즐겨찾기 상단 고정
  if (currentFolder !== null && !query) {
    const favs = filtered.filter((m) => m.favorite);
    const normals = filtered.filter((m) => !m.favorite);
    // 즐겨찾기끼리는 최근 즐겨찾기 지정순
    favs.sort((a, b) => (b.favoritedAt || 0) - (a.favoritedAt || 0));
    filtered = [...favs, ...normals];
  }

  memoList.innerHTML = filtered
    .map((m) => {
      const title = m.title || formatCreatedAt(m.createdAt) + ' 새 글';
      const date = formatDate(m.updatedAt);
      const active = m.id === currentId ? 'active' : '';
      const favIcon = m.favorite ? '<span class="memo-item-fav">★</span>' : '';
      const checkbox = selectMode ? '<input type="checkbox" class="memo-item-checkbox" data-check="' + m.id + '"' + (selectedMemos.has(m.id) ? ' checked' : '') + '>' : '';
      return `
        <div class="memo-item ${active}" data-id="${m.id}">
          ${checkbox}
          ${favIcon}
          <div class="memo-item-info">
            <div class="memo-item-title">${escapeHtml(title)}</div>
          </div>
          <div class="memo-item-date">${date}</div>
        </div>
      `;
    })
    .join('');

  // 선택 모드: 체크박스 이벤트
  const memoItems = Array.from(memoList.querySelectorAll('.memo-item'));
  memoList.querySelectorAll('.memo-item-checkbox').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const id = cb.dataset.check;
      if (cb.checked) selectedMemos.add(id); else selectedMemos.delete(id);
    });
    cb.addEventListener('click', (e) => e.stopPropagation());
  });

  // 모바일 롱프레스 범위 선택
  if (selectMode) {
    let touchStartIndex = -1;
    let touchLastIndex = -1;
    memoItems.forEach((el, idx) => {
      el.addEventListener('touchstart', (e) => {
        if (!selectMode) return;
        touchSelectActive = false;
        touchStartIndex = idx;
        touchLastIndex = idx;
        el._longPressTimer = setTimeout(() => {
          touchSelectActive = true;
          // 시작점 선택
          const cb = el.querySelector('.memo-item-checkbox');
          if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
          lastCheckedMemoIndex = idx;
        }, 400);
      }, { passive: true });
      el.addEventListener('touchend', () => {
        clearTimeout(el._longPressTimer);
        touchSelectActive = false;
      });
    });
    if (memoList._selMove) memoList.removeEventListener('touchmove', memoList._selMove);
    memoList._selMove = (e) => {
      if (!touchSelectActive) return;
      const touch = e.touches[0];
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      if (!target) return;
      const item = target.closest('.memo-item');
      if (!item) return;
      const idx = memoItems.indexOf(item);
      if (idx === -1 || idx === touchLastIndex) return;
      touchLastIndex = idx;
      // 범위 내 모두 선택
      const start = Math.min(touchStartIndex, idx);
      const end = Math.max(touchStartIndex, idx);
      for (let i = start; i <= end; i++) {
        const cb = memoItems[i].querySelector('.memo-item-checkbox');
        if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
      }
    };
    memoList.addEventListener('touchmove', memoList._selMove, { passive: true });
  } else if (memoList._selMove) {
    memoList.removeEventListener('touchmove', memoList._selMove);
    memoList._selMove = null;
  }

  memoList.querySelectorAll('.memo-item').forEach((el, idx) => {
    let clickTimer = null;
    el.addEventListener('click', (e) => {
      if (selectMode) {
        // Shift+클릭 범위 선택
        if (e.shiftKey && lastCheckedMemoIndex >= 0) {
          const start = Math.min(lastCheckedMemoIndex, idx);
          const end = Math.max(lastCheckedMemoIndex, idx);
          for (let i = start; i <= end; i++) {
            const cb = memoItems[i].querySelector('.memo-item-checkbox');
            if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
          }
          lastCheckedMemoIndex = idx;
          return;
        }
        const cb = el.querySelector('.memo-item-checkbox');
        if (cb && e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
        lastCheckedMemoIndex = idx;
        return;
      }
      if (clickTimer) return;
      clickTimer = setTimeout(() => {
        clickTimer = null;
        const memo = memos.find((m) => m.id === el.dataset.id);
        if (memo) loadMemoInEditor(memo);
        $('#sidebar').classList.remove('open');
      }, 250);
    });
    el.addEventListener('dblclick', () => {
      if (selectMode) return;
      clearTimeout(clickTimer);
      clickTimer = null;
      const id = el.dataset.id;
      window.open(location.pathname + '?memo=' + id, '_blank', 'width=400,height=700');
    });
  });
}

// ── UI Helpers ──
function showApp() {
  loginScreen.style.display = 'none';
  app.style.display = 'flex';
  renderAll();
  updateSaveSyncTimes();
  if (accessToken) setSyncStatus('synced', '연결됨');
  else setSyncStatus('', '오프라인');
}

function setSyncStatus(cls, text) {
  syncStatus.className = cls;
  syncStatus.textContent = text;
}

let toastTimer = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function formatCreatedAt(ts) {
  const d = new Date(ts);
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}`;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ── Service Worker ──
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // 새 버전이 깔리면 쓰던 글을 기기에 저장하고 새 코드로 다시 연다.
  // 휴대폰은 앱을 닫지 않고 오래 띄워 두므로, 배포 뒤에도 옛 코드가 바뀐 동기화 규칙을 모른 채 계속 저장을 올린다
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloadingForUpdate) return;   // 처음 설치될 때는 다시 열 필요 없음
    reloadingForUpdate = true;
    if (localSaveTimer) saveLocalData();
    if (currentId) sessionStorage.setItem('reopen_memo', currentId);
    location.reload();
  });
}

// 새 버전이 나왔는지 확인 (앱으로 돌아올 때마다). 있으면 설치 → controllerchange → 다시 열기
function checkForUpdate() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
}
