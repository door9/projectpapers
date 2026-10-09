// ── 저장 칸·Dropbox 위치·동기화 방식 ──
// ?pilot        시범 운전 칸: 진짜 메모와 따로 돌린다
//               (기기 저장은 'pilot:' 칸, Dropbox 는 /projectpapers-pilot. 로그인만 함께 쓴다)
// ?ns=이름&split=1  시험용 — 이 컴퓨터(localhost)에서만. 한 브라우저 안에서 여러 기기를 흉내 낸다(split 없으면 옛 한 파일 방식)
const PAGE_PARAMS = new URLSearchParams(location.search);
const IS_LOCAL_TEST = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const PILOT = PAGE_PARAMS.has('pilot');
const TEST_NS = IS_LOCAL_TEST ? PAGE_PARAMS.get('ns') : null;
const STORE_NS = PILOT ? 'pilot:' : TEST_NS ? TEST_NS + ':' : '';
// Dropbox 안 데이터 위치. 2026-10-06 주소를 /projectpapers/ 로 바꾸며 폴더 이름도 바꿨다.
// 옛 폴더(OLD_DBX_ROOT)는 새 앱이 처음 동기화할 때 서버 안에서 복사해 오고 '옮겨 감' 표시를 단다(sync-split.js adoptOldRoot)
const DBX_ROOT = PILOT ? '/projectpapers-pilot' : '/projectpapers';
const OLD_DBX_ROOT = PILOT ? '/project-papers-pilot' : '/project-papers';
// 글 단위 동기화(sync-split.js) — 2026-10-04 전환. 옛 한 파일 방식은 옮겨 올 때와 시험에서만 쓴다
const SPLIT_SYNC = TEST_NS != null ? PAGE_PARAMS.get('split') === '1' : true;
// 로그인과 화면 설정(어두운 화면·글자 크기)은 칸과 상관없이 하나 — 화면 설정은 index.html 머리에서 그리기 전에도 읽는다
const SHARED_KEYS = new Set(['dbx_token', 'dbx_refresh', 'memo_theme', 'memo_font']);
// Dropbox 위치에 딸린 동기화 기록(받은 커서·파일 버전·기준점·못 보낸 변경)은 위치 이름을 붙여 따로 둔다.
// 옛 주소의 앱도 같은 기기 저장소(door9.github.io)를 쓰므로, 옛 앱이 옛 폴더 기록을 써도 섞이지 않게.
// 새 위치에서는 기록이 비어 있어 처음 맞추기(받아서 합치고 다른 것만 올리기)부터 한다. 글·폴더 자체는 함께 쓴다
const ROOT_KEYS = new Set(['split_revs', 'split_base', 'split_cursor', 'split_ready', 'split_frozen', 'split_frozen_at',
  'root_adopted', 'dbx_rev', 'sync_base', 'last_synced_at', 'pending_sync']);
const ROOT_TAG = DBX_ROOT.slice(1) + '/';
const store = {
  key: (k) => (SHARED_KEYS.has(k) ? k : STORE_NS + (ROOT_KEYS.has(k) ? ROOT_TAG : '') + k),
  getItem: (k) => window.localStorage.getItem(store.key(k)),
  // 기기 저장 공간이 가득 차도 앱이 멈추지 않게 — 알리고, Dropbox 로는 계속 보낸다(글은 화면·메모리에 있다)
  setItem: (k, v) => {
    try { window.localStorage.setItem(store.key(k), v); } catch (e) { onStorageFull(e); }
  },
  removeItem: (k) => window.localStorage.removeItem(store.key(k)),
  // 다른 창의 저장 신호(storage 이벤트)의 키 → 이 칸에서의 이름. 다른 칸·다른 위치 것이면 null
  nameOf: (raw) => {
    if (raw == null) return null;
    if (SHARED_KEYS.has(raw)) return raw;
    let k = raw;
    if (!STORE_NS) { if (raw.includes(':')) return null; }
    else if (raw.startsWith(STORE_NS)) k = raw.slice(STORE_NS.length);
    else return null;
    if (k.startsWith(ROOT_TAG)) return k.slice(ROOT_TAG.length);
    return ROOT_KEYS.has(k) || k.includes('/') ? null : k;
  },
};
// 시범·시험 창에서 새 창을 열 때도 같은 칸을 쓰게 주소 꼬리를 이어 붙인다
const MODE_QUERY = PILOT ? '&pilot' : TEST_NS ? '&ns=' + encodeURIComponent(TEST_NS) + (SPLIT_SYNC ? '&split=1' : '') : '';

// 이 화면의 판 번호 — 도움말 맨 아래에 보인다(휴대폰이 옛 코드로 도는지 확인용). sw.js 의 CACHE_NAME 과 함께 올린다
const APP_VERSION = '161';

let storageFullAt = 0;
function onStorageFull(e) {
  console.error('기기 저장 실패:', e);
  if (Date.now() - storageFullAt < 60000) return;   // 알림은 1분에 한 번만
  storageFullAt = Date.now();
  setTimeout(() => showToast('기기 저장 공간이 가득 차 이 기기에 저장하지 못했습니다. Dropbox 로는 계속 보냅니다 — 휴지통을 비우면 공간이 생깁니다', { duration: 8000 }), 0);
}

// 줄바꿈 맞추기 — 입력칸은 \r\n 을 \n 으로 바꿔 돌려준다
const lf = (s) => String(s || '').replace(/\r\n?/g, '\n');

// ── Config ──
const DROPBOX_CLIENT_ID = '0kfnwj8hluxzpun';
// PKCE(공개 클라이언트) 방식이므로 app secret은 코드에 두지 않는다 (공개 저장소 노출 방지)
const DROPBOX_FILE = DBX_ROOT + '/memos.json';
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
const BACKUP_DIR = DBX_ROOT + '/backups';
const BACKUP_MAX = 30;
const REDIRECT_URI = location.origin + location.pathname;

// ── State ──
let memos = [];
let folders = [];
let trash = []; // 휴지통: { type: 'memo'|'folder', data: {...}, deletedAt: timestamp }
let deletedIds = []; // 영구 삭제된 항목: { id, at } (동기화 시 되살아나지 않게. 지우지 않고 계속 둔다)
let currentId = null;
let currentFolder = null; // null = all
let accessToken = store.getItem('dbx_token') || null;
let refreshToken = store.getItem('dbx_refresh') || null;
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
const getRev = () => store.getItem('dbx_rev') || null;
const getSyncBase = () => { try { return JSON.parse(store.getItem('sync_base') || '{}'); } catch { return {}; } };
const isDirty = () => store.getItem('pending_sync') === '1';
let changeSeq = 0;   // 이 기기에서 고칠 때마다 1씩 — 올리는 동안 또 고쳤는지 가린다
let reloadingForUpdate = false;
function setRev(rev) {
  if (rev) store.setItem('dbx_rev', rev); else store.removeItem('dbx_rev');
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
  // 어두운 화면·글자 크기(index.html 머리에서 이미 입혔지만 같은 규칙으로 한 번 더)
  applyTheme();
  applyFont();

  await handleOAuthCallback();
  loadLocalData();
  cleanupEmptyMemo();

  // Cloudflare 잠금에 다시 로그인하고 돌아온 주소(?login=1)는 지운다
  if (PAGE_PARAMS.has('login')) {
    const p = new URLSearchParams(location.search);
    p.delete('login');
    history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : '') + location.hash);
  }

  // 옛 주소(/project-papers/)의 안내 페이지에서 넘어왔다 = 설치해 둔 앱이 아직 옛 주소를 가리킨다
  if (PAGE_PARAMS.get('moved') === '1') {
    const p = new URLSearchParams(location.search);
    p.delete('moved');
    history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : '') + location.hash);
    setTimeout(() => showToast('주소가 바뀌었습니다. 설치한 앱은 지우고 이 주소에서 다시 설치해 주세요'), 1000);
  }

  // URL 파라미터로 특정 메모 열기 (새 창) / ?new=1 이면 새 창에서 새 글 쓰기(Ctrl+N)
  const urlParams = new URLSearchParams(location.search);
  const openMemoId = urlParams.get('memo');
  const newNoteWindow = urlParams.get('new') === '1';

  // 새 창 모드는 URL 감지 즉시 적용 (햄버거 깜빡임·메모 미발견 시 노출 방지)
  if (openMemoId || newNoteWindow) {
    document.body.classList.add('popup-mode');
  }

  // 정렬·보던 폴더·즐겨찾기 필터는 다시 열어도 그대로
  restoreUiPrefs();

  if (accessToken) {
    showApp();
    syncFromDropbox().then(() => { checkAutoBackup(); startWatch(); });
  } else {
    // 오프라인 모드: 백업 필요 플래그만 저장
    markAutoBackupPending();
    // 로그인이 만료돼 로그아웃됐으면 로그인 화면에 까닭을 보여 준다
    const why = sessionStorage.getItem('logout_reason');
    if (why) {
      sessionStorage.removeItem('logout_reason');
      const p = document.createElement('p');
      p.className = 'login-reason';
      p.textContent = why;
      loginScreen.insertBefore(p, $('#btn-login'));
    }
  }

  // 네트워크 복구 시 자동 동기화 + 보류된 자동 백업 실행
  window.addEventListener('online', () => {
    if (accessToken) {
      syncFromDropbox().then(() => { checkAutoBackupPending(); startWatch(); });
    }
  });
  window.addEventListener('offline', () => { if (accessToken) settleSyncStatus(); });

  // 앱을 닫거나(beforeunload/pagehide), 다른 앱·화면으로 가려질 때(visibilitychange) 즉시 저장 + 동기화
  // 특히 휴대폰에서 홈으로 나가거나 앱을 전환할 때 beforeunload는 잘 안 불리므로 visibilitychange가 핵심
  window.addEventListener('beforeunload', flushSave);
  window.addEventListener('pagehide', flushSave);
  // PC: 창을 떠나면(다른 창을 누르거나 휴대폰으로 옮겨 가기 전) 모아 둔 변경을 바로 올린다
  window.addEventListener('blur', () => {
    if (accessToken && isDirty() && !reloadingForUpdate) syncToDropboxIfDirty().catch(onSyncError);
  });
  // PC: 창으로 돌아오면(다른 창을 눌렀다 다시 누름) 그사이 다른 기기에서 고친 것을 받는다
  window.addEventListener('focus', () => {
    if (!accessToken || document.visibilityState !== 'visible') return;
    if (Date.now() - lastPullAt > 30000) syncFromDropbox();
    startWatch();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { flushSave(); stopWatch(); return; }
    // 돌아왔을 때: 새 버전이 나왔는지 보고(나왔으면 새 코드로 다시 연다),
    // 못 보낸 변경을 올리고 다른 기기에서 고친 것을 받아 온다(30초 안에 받았으면 생략)
    checkForUpdate();
    if (!accessToken) return;
    if (isDirty() || Date.now() - lastPullAt > 30000) syncFromDropbox();
    startWatch();
    checkAutoBackup();   // 며칠 켜 둔 기기도 날이 바뀌면 그날 백업을 한다(오늘 했으면 바로 끝남)
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
  // 형광펜 단추 — 누를 때 본문의 선택(블록)이 풀리지 않게 포커스를 뺏지 않는다(휴대폰엔 Alt+H 가 없다)
  $('#btn-highlight').addEventListener('pointerdown', (e) => e.preventDefault());
  $('#btn-highlight').addEventListener('click', () => toggleHighlight(true));
  $('#sync-dot').addEventListener('click', () => { if (accessToken && (syncProblem || isDirty())) syncFromDropbox(); });
  // 화면 설정(어두운 화면·글자 크기) — 글 화면의 더보기, 목록 아래 '화면'
  $('#btn-display').addEventListener('click', showDisplaySettings);
  $('#btn-display-side').addEventListener('click', showDisplaySettings);
  $('#btn-conflict-compare').addEventListener('click', () => showConflictCompare(currentId));
  $('#btn-toolbar-more').addEventListener('click', toggleToolbarMore);
  $('#btn-template').addEventListener('click', toggleTemplateDropdown);
  $('#btn-template-save').addEventListener('click', saveAsTemplate);
  $('#btn-find').addEventListener('click', toggleFindReplace);
  $('#btn-copy').addEventListener('click', copyMemoToClipboard);
  $('#btn-share').addEventListener('click', shareMemo);
  $('#btn-viewer').addEventListener('click', toggleViewer);
  $('#btn-help').addEventListener('click', showHelpDialog);
  $('#btn-delete').addEventListener('click', confirmDelete);
  $('#memo-sort').addEventListener('change', (e) => { memoSortKey = e.target.value; saveUiPrefs(); renderMemoList(); });
  $('#btn-select-mode').addEventListener('click', toggleSelectMode);
  $('#btn-bulk-delete').addEventListener('click', bulkDelete);
  $('#btn-bulk-move').addEventListener('click', bulkMoveUnified);
  $('#btn-bulk-cancel').addEventListener('click', () => toggleSelectMode());
  // 찾을 말을 고치면 '모두' 상태를 푼다 — 안 그러면 새 낱말로 '바꾸기'가 전부 바꿨다
  $('#find-input').addEventListener('input', () => { findAllMode = false; updateReplaceLabel(); findCountOnly(); });
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
    // 한글 자판 상태에선 글자가 'ㄴ'처럼 올 수 있어, 그럴 땐 누른 자리(KeyS 등)로 본다
    const k = keyLetter(e);
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
    // Ctrl+F → 앱 찾기/바꾸기 (이미 열려 있으면 닫지 않고 찾기 칸으로)
    if (k === 'f') {
      if (!currentId) return;
      e.preventDefault();
      if ($('#find-replace-bar').style.display === 'none') toggleFindReplace();
      else { const fi = $('#find-input'); fi.focus(); fi.select(); }
    }
    // Ctrl+S → 저장 및 동기화
    if (k === 's') {
      e.preventDefault();
      saveLocalData();
      if (accessToken) {
        const notSent = '기기에 저장했습니다 — Dropbox 로는 아직 못 보냈습니다(잠시 뒤 다시 보냅니다)';
        syncToDropbox().then(() => showToast(syncProblem ? notSent : '저장 및 동기화 완료')).catch(() => showToast(notSent));
      } else {
        showToast('로컬에 저장됨');
      }
    }
  });

  // Esc → 맨 위에 뜬 것부터 닫는다: 대화상자 → 펼친 목록(폴더·템플릿) → 찾기 창. 폴더 관리 화면은 제 손으로 닫는다
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing) return;
    const overlays = document.querySelectorAll('.modal-overlay, .delete-confirm');
    if (overlays.length) {
      const top = overlays[overlays.length - 1];
      e.preventDefault();
      e.stopImmediatePropagation();
      if (top._close) top._close(); else top.remove();
      return;
    }
    if (fm) return;
    const dds = [$('#template-dropdown'), $('#folder-select-dropdown')].filter((d) => d.style.display !== 'none');
    if (dds.length) { e.preventDefault(); dds.forEach((d) => { d.style.display = 'none'; }); return; }
    if ($('#find-replace-bar').style.display !== 'none') { e.preventDefault(); toggleFindReplace(); editor.focus(); }
  });

  $('#menu-toggle').addEventListener('click', () => {
    $('#sidebar').classList.toggle('open');
  });
  // 휴대폰 뒤로가기가 목록(사이드바)도 한 겹으로 닫게 — 목록이 열리고 닫힐 때마다 기록 칸을 맞춘다
  new MutationObserver(() => layersChanged()).observe($('#sidebar'), { attributes: true, attributeFilter: ['class'] });

  // 에디터 영역 클릭: 사이드바 열려있으면 닫기만, 아니면 빈 화면(There you are)을 누르면 새 글
  $('#editor-area').addEventListener('click', (e) => {
    const sidebar = $('#sidebar');
    if (sidebar.classList.contains('open')) {
      sidebar.classList.remove('open');
      e.stopPropagation();
      return;
    }
    if (emptyState.style.display !== 'none' && e.target.closest('.empty-hero')) {
      createMemo();
    }
  });
  // 빈 화면의 최근 글: 누르면 바로 그 글, '모든 글 보기'는 목록(사이드바)
  $('#recent-list').addEventListener('click', (e) => {
    const item = e.target.closest('.recent-item');
    if (item) {
      const memo = memos.find((m) => m.id === item.dataset.id);
      if (memo) loadMemoInEditor(memo);
      return;
    }
    if (e.target.closest('.recent-all')) { e.stopPropagation(); $('#sidebar').classList.add('open'); }
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
    // Ctrl+N → 새 창(글 목록 없이 글 쓰기만 하는 창, 목록 더블클릭 때와 같은 창)을 열고 거기서 새 글
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && keyLetter(e) === 'n') {
      e.preventDefault();
      openNewNoteWindow();
    }
  });

  // 새 창으로 열린 경우 해당 메모 바로 표시 (popup-mode 클래스는 init 초반에 이미 적용됨)
  if (newNoteWindow) {
    // Ctrl+N 으로 열린 새 창: 새 글을 만들어 바로 쓰게 한다. 주소는 그 글 주소로 바꿔 둔다(새로고침해도 같은 글)
    if (!accessToken) showApp();
    const folderId = urlParams.get('folder');
    const id = crypto.randomUUID();
    history.replaceState(null, '', location.pathname + '?memo=' + id + MODE_QUERY);
    createMemo({ id, folder: folderId && folders.some((f) => f.id === folderId) ? folderId : null });
  } else if (openMemoId) {
    const memo = memos.find((m) => m.id === openMemoId);
    if (memo) {
      if (!accessToken) showApp();
      loadMemoInEditor(memo);
    }
  } else {
    // 다시 열면 쓰던 글을 쓰던 자리 그대로 연다 — 새 버전으로 다시 열렸을 때(reopen_memo)와,
    // 휴대폰이 앱을 내렸다가 다시 열 때(open_memo: 글을 연 채 앱을 떠났으면 남아 있다). 잠긴 폴더 글은 열지 않는다
    const reopenId = sessionStorage.getItem('reopen_memo') || store.getItem('open_memo');
    sessionStorage.removeItem('reopen_memo');
    const memo = reopenId && memos.find((m) => m.id === reopenId);
    if (memo && accessToken && !isFolderLocked(memo.folder)) loadMemoInEditor(memo, { restorePos: true });
  }
}

// 단축키 글자 — 영문이면 그대로(소문자), 한글 자판 상태처럼 다른 글자가 오면 누른 자리(e.code 'KeyN' → 'n')로
function keyLetter(e) {
  const key = (e.key || '').toLowerCase();
  if (/^[a-z]$/.test(key) || !/^Key[A-Z]$/.test(e.code || '')) return key;
  return e.code.slice(3).toLowerCase();
}

// ── 화면 설정: 어두운 화면 · 글자 크기 ──
// 기기마다 따로 둔다(휴대폰과 PC 는 화면도 쓰는 곳도 달라서). 글자 크기는 글마다가 아니라 모든 글 본문·제목에 함께.
// index.html 머리의 작은 스크립트가 같은 규칙으로 그리기 전에 먼저 입힌다(밝은 화면이 잠깐 번쩍이지 않게)
const THEME_KEY = 'memo_theme';   // 'light' | 'dark' | 'system'(기기 설정 따름). 없으면 밝게
const FONT_KEY = 'memo_font';     // 본문 글자 크기(px). 없으면 기본(PC 14, 휴대폰 17)
const FONT_MIN = 12, FONT_MAX = 28;
const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function themeSetting() {
  const t = store.getItem(THEME_KEY);
  return t === 'dark' || t === 'system' ? t : 'light';
}
function applyTheme() {
  const t = themeSetting();
  const dark = t === 'dark' || (t === 'system' && !!darkQuery && darkQuery.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  // 휴대폰 위 알림 줄·PC 앱 창 제목 줄 색도 맞춘다
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#1c1916' : '#fff1e5');
}
// '기기 설정 따름'이면 기기에서 어두운 모드를 켜고 끌 때 바로 따라간다
if (darkQuery) darkQuery.addEventListener('change', () => { if (themeSetting() === 'system') applyTheme(); });

function fontSetting() {
  const n = Number(store.getItem(FONT_KEY));
  return n >= FONT_MIN && n <= FONT_MAX ? n : 0;   // 0 = 기본
}
function defaultFontPx() {
  return window.matchMedia && window.matchMedia('(max-width: 768px) and (pointer: coarse)').matches ? 17 : 14;
}
function applyFont() {
  const n = fontSetting();
  const root = document.documentElement.style;
  if (n) {
    root.setProperty('--editor-font', n + 'px');
    root.setProperty('--title-font', Math.round(n * 1.15) + 'px');
  } else {
    root.removeProperty('--editor-font');
    root.removeProperty('--title-font');
  }
  // 본문 겹침층(형광펜·찾기 표시)도 같은 크기로 다시 맞춘다
  const hl = document.getElementById('editor-highlight');
  if (hl) hl.scrollTop = editor.scrollTop;
}

function showDisplaySettings() {
  if (document.querySelector('.disp-box')) return;
  const o = document.createElement('div');
  o.className = 'modal-overlay';
  o.innerHTML = `
    <div class="modal-box disp-box">
      <div class="trash-head"><h3>화면 설정</h3><button class="fm-icon-btn" data-disp="close" type="button" title="닫기">${ico('close')}</button></div>
      <div class="disp-label">화면</div>
      <div class="disp-seg" role="radiogroup" aria-label="화면">
        <button type="button" role="radio" data-theme-set="light">${ico('sun')}<span>밝게</span></button>
        <button type="button" role="radio" data-theme-set="dark">${ico('moon')}<span>어둡게</span></button>
        <button type="button" role="radio" data-theme-set="system">${ico('contrast')}<span>기기 설정 따름</span></button>
      </div>
      <div class="disp-label">글자 크기 <span class="disp-px"></span></div>
      <div class="disp-font">
        <button type="button" class="disp-step" data-step="-1" title="작게" aria-label="글자 작게">가</button>
        <input type="range" min="${FONT_MIN}" max="${FONT_MAX}" step="1" aria-label="글자 크기">
        <button type="button" class="disp-step big" data-step="1" title="크게" aria-label="글자 크게">가</button>
      </div>
      <div class="disp-preview">오늘 회의에서 논의한 내용을 정리하면 다음과 같다.
취재원과 통화했고 기사 방향을 다시 잡았다.</div>
      <div class="disp-foot"><button type="button" class="trash-link" data-disp="reset">기본 크기로</button></div>
    </div>`;
  const range = o.querySelector('input[type="range"]');
  const paint = () => {
    const t = themeSetting();
    o.querySelectorAll('[data-theme-set]').forEach((b) => {
      const on = b.dataset.themeSet === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    const n = fontSetting();
    const px = n || defaultFontPx();
    range.value = px;
    o.querySelector('.disp-px').textContent = px + (n ? '' : ' (기본)');
    o.querySelector('.disp-preview').style.fontSize = px + 'px';
    o.querySelector('[data-disp="reset"]').hidden = !n;
  };
  const setFont = (px) => {
    px = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(px)));
    if (px === defaultFontPx()) store.removeItem(FONT_KEY); else store.setItem(FONT_KEY, String(px));
    applyFont();
    paint();
  };
  range.addEventListener('input', () => setFont(Number(range.value)));
  o.addEventListener('click', (e) => {
    if (e.target === o) { o.remove(); return; }
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.disp === 'close') { o.remove(); return; }
    if (b.dataset.disp === 'reset') { store.removeItem(FONT_KEY); applyFont(); paint(); return; }
    if (b.dataset.themeSet) { store.setItem(THEME_KEY, b.dataset.themeSet); applyTheme(); paint(); return; }
    if (b.dataset.step) setFont((fontSetting() || defaultFontPx()) + Number(b.dataset.step));
  });
  document.body.appendChild(o);
  paint();
}

// ── 화면 설정 기억 (정렬·보던 폴더·즐겨찾기 필터) ──
function saveUiPrefs() {
  if (document.body.classList.contains('popup-mode')) return;
  store.setItem('ui_prefs', JSON.stringify({ sort: memoSortKey, folder: currentFolder, fav: favFilterActive }));
}
function restoreUiPrefs() {
  let p = null;
  try { p = JSON.parse(store.getItem('ui_prefs') || 'null'); } catch { /* 없음 */ }
  if (!p) return;
  if (['updatedAt', 'createdAt', 'title'].includes(p.sort)) { memoSortKey = p.sort; $('#memo-sort').value = p.sort; }
  favFilterActive = !!p.fav;
  $('#btn-fav-filter').classList.toggle('active', favFilterActive);
  // 폴더가 없어졌거나 잠겨 있으면 '전체'로 (열 때마다 비밀번호를 묻지 않게)
  if (p.folder === '__none__') currentFolder = '__none__';
  else if (p.folder && folders.some((f) => f.id === p.folder) && !isFolderLocked(p.folder)) currentFolder = p.folder;
}

// ── 뒤로가기(휴대폰 제스처) — 맨 위 한 겹만 닫는다: 폴더 관리 > 목록(사이드바) > 열린 글 ──
// 무엇이든 열려 있으면 기록 칸 하나를 쌓아 두고, 뒤로가기로 한 겹을 닫은 뒤에도 남은 게 있으면 다시 쌓는다.
// 모두 닫히면(삭제 등 화면 조작으로) 쌓아 둔 칸을 거둔다. 그래서 목록만 열린 채 뒤로가기를 해도 앱이 꺼지지 않는다
let skipNextPopstate = false;
function sidebarIsOpen() { return $('#sidebar').classList.contains('open'); }
function anyLayerOpen() { return !!fm || sidebarIsOpen() || editorContainer.style.display !== 'none'; }
function layersChanged() {
  const has = !!(history.state && history.state.app);
  const open = anyLayerOpen();
  if (open && !has) history.pushState({ app: true }, '');
  else if (!open && has && !skipNextPopstate) { skipNextPopstate = true; history.back(); }
}
window.addEventListener('popstate', () => {
  if (skipNextPopstate) { skipNextPopstate = false; layersChanged(); return; }
  if (fm) closeFolderManager(true);
  else if (sidebarIsOpen()) $('#sidebar').classList.remove('open');
  else if (editorContainer.style.display !== 'none') { hideEditor(); currentId = null; renderMemoList(); }
  layersChanged();
});

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
      store.setItem('dbx_token', token);
      sessionStorage.removeItem('oauth_state');
      history.replaceState(null, '', location.pathname);
    }
    return;
  }

  // Exchange code for tokens
  const codeVerifier = sessionStorage.getItem('code_verifier');
  try {
    const res = await timedFetch('https://api.dropboxapi.com/oauth2/token', {
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
    store.setItem('dbx_token', accessToken);
    if (refreshToken) store.setItem('dbx_refresh', refreshToken);
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
    const res = await timedFetch('https://api.dropboxapi.com/oauth2/token', {
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
    store.setItem('dbx_token', accessToken);
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
  store.removeItem('dbx_token');
  store.removeItem('dbx_refresh');
  location.reload();
}

// Dropbox 로그인이 끝났다(갱신 토큰도 거절됨) — 새로고침 뒤 로그인 화면에서 까닭을 보여 준다
// (예전엔 알림을 띄우자마자 새로고침돼 아무 설명 없이 로그인 화면만 나왔다). 기기에 저장된 글은 그대로다
function authExpired() {
  sessionStorage.setItem('logout_reason', 'Dropbox 로그인이 만료되었습니다. 다시 로그인하면 이 기기의 글을 그대로 이어서 맞춥니다.');
  logout();
  throw new Error('auth expired');
}

// 응답이 끝내 안 오면(지하철 등에서 통신이 멎음) 기다리지 않고 실패로 본다 — 안 그러면 동기화 줄이 막혀
// 그 뒤 동기화가 모두 멈췄다. 큰 파일(한 파일 0.9MB·압축 받기)은 넉넉히
const DBX_TIMEOUT = 30000;
const DBX_TIMEOUT_BIG = 120000;
function timedFetch(url, init = {}, ms = DBX_TIMEOUT) {
  const ctl = new AbortController();
  // 응답 머리만 받고 본문을 읽다 멎을 수도 있어, 끝날 때까지 시계를 끄지 않는다(다 읽은 뒤 끊어도 해가 없다)
  setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...init, signal: ctl.signal }).catch((e) => {
    if (ctl.signal.aborted) { const t = new Error('timeout'); t.timeout = true; throw t; }
    throw e;
  });
}

// 409 응답 까닭 — Dropbox 공간이 가득 찼는지
async function dbxSpaceFull(res) {
  try { return /insufficient_space/.test(JSON.stringify(await res.clone().json())); } catch { return false; }
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
  const res = await timedFetch('https://content.dropboxapi.com/2/files/upload', {
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
  }, DBX_TIMEOUT_BIG);
  if (res.status === 401) {
    if (!retried && await refreshAccessToken()) {
      return dbxUpload(content, true, attempt);
    }
    authExpired();
  }
  // Dropbox 공간이 가득 찼다 — 다시 해도 안 된다
  if (res.status === 409 && await dbxSpaceFull(res)) { const e = new Error('insufficient space'); e.space = true; throw e; }
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
  const res = await timedFetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Dropbox-API-Arg': JSON.stringify({ path: DROPBOX_FILE }),
    },
  }, DBX_TIMEOUT_BIG);
  if (res.status === 409 || res.status === 404) { setRev(null); return null; } // 아직 파일 없음
  if (res.status === 401) {
    if (!retried && await refreshAccessToken()) {
      return dbxDownload(true, attempt);
    }
    authExpired();
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

// 파일 버전 번호(rev)만 묻는다 — 응답이 수백 바이트. 파일이 없으면 null
async function dbxGetMetadata(retried, attempt = 0) {
  const res = await timedFetch('https://api.dropboxapi.com/2/files/get_metadata', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path: DROPBOX_FILE }),
  });
  if (res.status === 409) return null;
  if (res.status === 401) {
    if (!retried && await refreshAccessToken()) {
      return dbxGetMetadata(true, attempt);
    }
    authExpired();
  }
  if (res.status === 429 && attempt < DBX_MAX_RETRY) {
    await dbxSleep(dbxRetryDelay(res, attempt));
    return dbxGetMetadata(retried, attempt + 1);
  }
  if (!res.ok) throw new Error('metadata failed: ' + res.status);
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
    if (SPLIT_SYNC) {
      // 글 단위: 못 보낸 변경을 먼저 올린 뒤 Dropbox 서버 안에서 sync/ 를 통째로 복사(휴대폰 데이터를 쓰지 않는다)
      await syncToDropboxIfDirty();
      await splitBackup('backup_' + ts);
    } else {
      const backupPath = BACKUP_DIR + '/backup_' + ts + '.json';
      const obj = backupPayload();
      const data = JSON.stringify(obj, null, 2);
      // 백업 파일 업로드
      await dbxUploadTo(backupPath, data);
    }

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
  const res = await timedFetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', mute: true }),
    },
    body: content,
  }, DBX_TIMEOUT_BIG);
  if (res.status === 401) {
    if (!retried && await refreshAccessToken()) return dbxUploadTo(path, content, true, attempt);
    authExpired();
  }
  if ((res.status === 429 || res.status === 409) && attempt < DBX_MAX_RETRY) {
    await dbxSleep(dbxRetryDelay(res, attempt));
    return dbxUploadTo(path, content, retried, attempt + 1);
  }
  if (!res.ok) throw new Error('upload failed: ' + res.status);
  return res.json();
}

async function dbxListFolder(path, retried, attempt = 0) {
  const res = await timedFetch('https://api.dropboxapi.com/2/files/list_folder', {
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
    authExpired();
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
  const res = await timedFetch('https://api.dropboxapi.com/2/files/delete_v2', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path }),
  });
  if (res.status === 401) {
    if (!retried && await refreshAccessToken()) return dbxDelete(path, true, attempt);
    authExpired();
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
    .filter((e) => (e['.tag'] === 'file' || e['.tag'] === 'folder') && e.name.startsWith('backup_'))
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
  const lastDate = store.getItem('auto_backup_date');
  if (lastDate !== today) {
    store.setItem('auto_backup_pending', 'true');
  }
}

let autoBackupRunning = false;   // 앱 열기·돌아오기가 겹쳐도 백업은 한 번만
async function checkAutoBackup() {
  if (!accessToken || autoBackupRunning) return;
  const today = getTodayKST();
  const lastDate = store.getItem('auto_backup_date');
  if (lastDate === today) return; // 오늘 이미 백업함

  // Dropbox에 오늘 날짜 자동 백업 파일이 있는지 확인
  autoBackupRunning = true;
  try {
    const entries = await dbxListFolder(BACKUP_DIR);
    const todayTag = today.replace(/-/g, '');
    const alreadyExists = entries.some((e) =>
      (e['.tag'] === 'file' || e['.tag'] === 'folder') && e.name.includes(todayTag) && e.name.includes('(auto backup)')
    );
    if (alreadyExists) {
      store.setItem('auto_backup_date', today);
      return;
    }
    await performAutoBackup(today);
  } catch (e) {
    console.error('Auto backup check error:', e);
  } finally {
    autoBackupRunning = false;
  }
}

async function checkAutoBackupPending() {
  if (!accessToken) return;
  const pending = store.getItem('auto_backup_pending');
  if (pending !== 'true') return;
  store.removeItem('auto_backup_pending');
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
    if (SPLIT_SYNC) {
      await splitBackup('backup_' + ts + ' (auto backup)');
    } else {
      const backupPath = BACKUP_DIR + '/backup_' + ts + ' (auto backup).json';
      const obj = backupPayload();
      const data = JSON.stringify(obj, null, 2);
      await dbxUploadTo(backupPath, data);
    }
    await pruneBackups();
    store.setItem('auto_backup_date', today);
    showToast('자동 백업 완료');
  } catch (e) {
    console.error('Auto backup error:', e);
    showToast('자동 백업 실패 — 앱으로 다시 돌아올 때 다시 합니다');
  }
}

// ── Sync ──
// 합친 결과가 받은 원격과 같은가 (같으면 올릴 필요가 없다)
function sameAsRemote(remote) {
  if (!remote || Array.isArray(remote)) return false;
  const key = (arr, f) => JSON.stringify((arr || []).map(f).sort());
  const mk = (m) => m.id + ':' + m.updatedAt + ':' + (m.metaAt || 0);
  const fk = (f) => [f.id, f.name, f.parentId || '', f.sortOrder, f.updatedAt || 0, f.password || '', f.dormant ? 1 : 0, f.dormantNote || ''].join('|');
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
  const last = Number(store.getItem('last_synced_at')) || 0;
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
function pullAndMerge() {
  return SPLIT_SYNC ? splitPull() : legacyPullAndMerge();
}

async function legacyPullAndMerge() {
  lastPullAt = Date.now();
  // 받기 전에 '바뀌었나'만 먼저 묻는다(Evernote 의 변경 번호와 같은 발상).
  // 지난번에 받거나 올린 버전 그대로면 다른 기기가 고친 것이 없으므로 0.9MB 파일을 받지 않는다.
  // 기기에 아무것도 없으면(처음 로그인 등) 묻지 않고 받는다.
  const rev = getRev();
  if (rev && !isLocalEmpty()) {
    const meta = await dbxGetMetadata();
    if (meta && meta.rev === rev) return false;
  }
  const remote = await dbxDownload();
  if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
    // 이 앱보다 새 규칙으로 쓰인 파일이면 올리지 않는다(옛 화면이 새 데이터를 망가뜨리지 않게)
    // 글 단위로 옮겨 간 파일(dataVersion 4)은 글 단위 앱에겐 '옛 사본'일 뿐이다
    if ((remote.dataVersion || 0) > DATA_VERSION && !SPLIT_SYNC) markOutdated();
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
  else store.setItem('pending_sync', '1');
  // 합친 즉시 편집기에도 반영한다 — 글은 바뀌었는데 편집기에 옛 내용이 남아 있으면,
  // 그 위에 한 글자만 쳐도 옛 내용이 '방금 고친 최신'으로 올라간다(예전엔 올리기가 끝난 뒤에야 반영했다)
  refreshOpenMemo();
  notifyConflicts();
  return remote === null;
}

let remoteNoticeAt = 0;
// 동기화로 지금 열린 글이 바뀌었으면 편집기에 반영한다 — 커서·스크롤은 바뀐 곳에 맞춰 그대로.
// 다른 기기 내용이 들어오면 되돌리기 기록을 끊는다: 그 전 기록으로 되돌리면 방금 들어온 내용까지 지운 판이
// 올라간다(예전엔 Ctrl+Z 한 번에 휴대폰에서 덧붙인 문단이 사라졌다)
function refreshOpenMemo() {
  if (!currentId) return;
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) {
    currentId = null;
    hideEditor();
    renderMemoList();
    showToast('다른 기기에서 지운 글이라 닫았습니다');
    return;
  }
  const content = lf(memo.content);
  if (editor.value !== content) {
    const { p, oldEnd, newEnd } = diffRange(editor.value, content);
    const move = (x) => (x >= oldEnd ? x + newEnd - oldEnd : x > p ? newEnd : x);
    const s = move(editor.selectionStart), e = move(editor.selectionEnd);
    const top = editor.scrollTop;
    editor.value = content;
    try { editor.setSelectionRange(s, e); } catch { /* 포커스 없으면 무시 */ }
    editor.scrollTop = top;
    undoStack = [];
    redoStack = [];
    undoGroupOpen = false;
    updateCharCount();
    // 알림은 30초에 한 번만 — 다른 기기에서 계속 쓰는 동안 몇 초마다 뜨지 않게
    if (Date.now() - remoteNoticeAt > 30000) {
      remoteNoticeAt = Date.now();
      showToast('다른 기기에서 고친 내용을 반영했습니다');
    }
  }
  if (titleInput.value !== memo.title) titleInput.value = memo.title;
  updateMemoDates(memo);
  updateFolderSelect(memo.folder);
  updateFavButton(memo);
  if (!!memo.viewerMode !== viewerMode) applyViewerMode(!!memo.viewerMode);
  updateConflictBar(memo);
  repaintOverlay();   // 형광펜도 다른 기기에서 바뀌었을 수 있다
}

// 받기 + (보낼 게 있으면) 올리기. 이미 하고 있으면 그것을 함께 기다린다
// (그사이 또 바뀌면 Dropbox 변경 알림이 다시 깨운다)
let syncInFlight = null;
function syncFromDropbox() {
  if (!accessToken) return Promise.resolve();
  if (syncInFlight) return syncInFlight;
  setSyncStatus('syncing', '동기화 중...');
  const run = queueSync(async () => {
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
      settleSyncStatus('동기화 완료');
      renderAll();
      refreshOpenMemo();
    } catch (e) {
      onSyncError(e);
    }
  });
  syncInFlight = run.finally(() => { syncInFlight = null; });
  return syncInFlight;
}

// ── 동기화 상태를 사실대로 ──
// 올리기가 거절되거나(Dropbox 공간 부족·계속 겹침) 통신이 끊겨 못 보낸 게 남으면 '못 보냄'으로 두고 잠시 뒤
// 저절로 다시 시도한다(15초 → 30초 → … 최대 5분). 예전엔 거절돼도 '동기화 완료'·'저장 완료'로 보였고 다시 하지도 않았다
let syncProblem = null;   // null | 'network' | 'offline' | 'space' | 'rejected' | 'guard'
let retryTimer = null;
let retryDelay = 0;
const PROBLEM_LABEL = {
  network: '못 보냄 · 다시 시도 중',
  offline: '오프라인 · 연결되면 보냄',
  space: 'Dropbox 공간 부족',
  rejected: '못 보냄 · 다시 시도 중',
  guard: '동기화 멈춤',
};
function settleSyncStatus(okLabel = '동기화 완료') {
  if (!accessToken) return;
  if (!isDirty()) syncProblem = null;
  else if (!navigator.onLine) syncProblem = 'offline';
  if (syncProblem) {
    setSyncStatus('error', PROBLEM_LABEL[syncProblem] || '못 보냄');
    if (syncProblem !== 'offline' && syncProblem !== 'guard') scheduleRetry();
    return;
  }
  retryDelay = 0;
  clearTimeout(retryTimer);
  retryTimer = null;
  setSyncStatus('synced', okLabel);
}
function onSyncError(e) {
  console.error('Sync error:', e);
  if (e && e.message === 'auth expired') return;
  syncProblem = e && e.space ? 'space' : navigator.onLine ? 'network' : 'offline';
  if (syncProblem === 'space') warnSpace();
  if (!isDirty()) {
    // 보낼 것은 없고 받기만 실패했다 — 표시하고 잠시 뒤 다시
    setSyncStatus('error', syncProblem === 'offline' ? '오프라인' : '동기화 실패');
    if (syncProblem !== 'offline') scheduleRetry();
    return;
  }
  settleSyncStatus();
}
function scheduleRetry() {
  if (retryTimer) return;
  retryDelay = Math.min(retryDelay ? retryDelay * 2 : 15000, 300000);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (accessToken && navigator.onLine) syncFromDropbox();
  }, retryDelay);
}
let spaceWarned = false;
function warnSpace() {
  if (spaceWarned) return;
  spaceWarned = true;
  showToast('Dropbox 저장 공간이 가득 차 올리지 못했습니다. 공간을 비우면 자동으로 다시 보냅니다', { duration: 10000 });
}

// 편집 화면 아래(글자 수 옆)의 동기화 표시 — 사이드바를 열지 않아도(휴대폰) 보낸 상태를 알 수 있게
function updateSyncIndicator() {
  const el = document.getElementById('sync-dot');
  if (!el) return;
  let cls = 'ok', text = '동기화됨';
  if (!accessToken) { cls = 'local'; text = '기기에만 저장'; }
  else if (freshCheck) { cls = 'busy'; text = '최신 내용 확인 중'; }
  else if (syncStatus.classList.contains('syncing')) { cls = 'busy'; text = '동기화 중'; }
  else if (syncProblem) { cls = 'bad'; text = PROBLEM_LABEL[syncProblem] || '못 보냄'; }
  else if (isDirty()) { cls = 'wait'; text = '저장됨'; }
  el.className = cls;
  el.textContent = text;
  el.title = cls === 'bad' ? '누르면 지금 다시 보냅니다' : cls === 'wait' ? '이 기기에 저장됨 — 곧 Dropbox 로 보냅니다' : '';
}

// 이 기기에 내용이 하나도 없는 상태인가(글·폴더·템플릿·휴지통 모두 빔)
function isLocalEmpty() {
  return syncableMemos().length === 0 && folders.length === 0 && templates.length === 0 && trash.length === 0;
}

// force=true 는 사용자가 직접 전부 지운 경우처럼 빈 상태를 일부러 올릴 때만
function syncToDropbox(force) {
  if (!accessToken) return Promise.resolve();
  return queueSync(() => uploadNow(force)).then(
    () => settleSyncStatus('동기화 완료'),
    (e) => { onSyncError(e); throw e; });
}

async function uploadNow(force, retriedConflict) {
  if (SPLIT_SYNC) return splitPush(force, retriedConflict);
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
  syncProblem = null;
  lastUploadAt = Date.now();
  if (isDirty()) pendingSince = lastUploadAt;   // 올리는 동안 또 고쳤으면 그때부터 다시 센다
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
    // 폴더도 본문과 따로 — 늦게 옮긴 쪽을 따른다(예전엔 다른 기기가 본문을 고쳤으면 그 판이 통째로 남아
    // 이 기기에서 옮긴 폴더가 소리 없이 되돌아갔다)
    if ((loser.folderAt || 0) > (winner.folderAt || 0)) {
      winner = { ...winner, folder: loser.folder, folderAt: loser.folderAt };
    }
    map.set(r.id, winner);
    if (pick.conflict && !copied.has(loser.id + '|' + loser.updatedAt)) {
      extras.push(conflictCopy(loser));
      copied.add(loser.id + '|' + loser.updatedAt);
    }
  }
  for (const m of local) if (!map.has(m.id)) map.set(m.id, m);
  const permDelIds = new Set(deletedIds.map((d) => d.id || d));
  newConflicts.push(...extras.map((c) => c.id));
  return Array.from(map.values()).concat(extras)
    .filter((m) => !m.deleted && !permDelIds.has(m.id))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// 합치다 충돌본이 생겼으면 알린다(예전엔 목록에서 우연히 봐야 알았다). '보기'를 누르면 그 충돌본을 연다 —
// 충돌본 위의 '원본과 비교'로 무엇이 다른지 문단(줄)마다 볼 수 있다
let newConflicts = [];
function notifyConflicts() {
  const ids = newConflicts.filter((id) => memos.some((m) => m.id === id));
  newConflicts = [];
  if (!ids.length) return;
  showToast(`같은 글을 두 기기에서 고쳐 충돌본 ${ids.length}개를 남겼습니다`, {
    action: '보기',
    duration: 10000,
    onAction: () => {
      const m = memos.find((x) => x.id === ids[0]);
      if (m) { loadMemoInEditor(m); $('#sidebar').classList.remove('open'); }
    },
  });
}

// 충돌본을 열면 제목 아래에 '원본과 비교' 막대를 보인다(원본이 남아 있을 때만)
function updateConflictBar(memo) {
  const bar = document.getElementById('conflict-bar');
  if (!bar) return;
  const orig = memo && memo.conflictOf && memos.find((m) => m.id === memo.conflictOf);
  bar.style.display = orig ? 'flex' : 'none';
}

// 두 글을 문단(=엔터로 나뉜 줄)마다 견준다 → [{ t: 'same'|'del'|'add', s }]. del = 원본에만, add = 충돌본에만
function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const out = a.slice(0, pre).map((s) => ({ t: 'same', s }));
  if (A.length * B.length > 4e6) {
    // 너무 길면 가운데는 통째로 견준다(드문 경우)
    A.forEach((s) => out.push({ t: 'del', s }));
    B.forEach((s) => out.push({ t: 'add', s }));
  } else {
    // 가장 긴 공통 부분(LCS) 표를 뒤에서부터 채운 뒤 앞에서부터 따라간다
    const n = A.length, m = B.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push({ t: 'same', s: A[i] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: 'del', s: A[i++] });
      else out.push({ t: 'add', s: B[j++] });
    }
    while (i < n) out.push({ t: 'del', s: A[i++] });
    while (j < m) out.push({ t: 'add', s: B[j++] });
  }
  b.slice(b.length - suf).forEach((s) => out.push({ t: 'same', s }));
  return out;
}

// 충돌본과 원본을 문단마다 견줘 보여 준다 — 원본에만 있는 문단 / 충돌본에만 있는 문단. 같은 문단이 길게 이어지면 접는다
function showConflictCompare(copyId) {
  const copy = memos.find((m) => m.id === copyId);
  const orig = copy && copy.conflictOf && memos.find((m) => m.id === copy.conflictOf);
  if (!copy || !orig) { showToast('원본 글이 없습니다'); return; }
  const rows = diffLines(lf(orig.content).split('\n'), lf(copy.content).split('\n'));
  const changed = rows.filter((r) => r.t !== 'same').length;
  const line = (r) => `<div class="cmp-line cmp-${r.t}">${r.s ? escapeHtml(r.s) : '&nbsp;'}</div>`;
  let html = '';
  for (let i = 0; i < rows.length;) {
    if (rows[i].t !== 'same') { html += line(rows[i++]); continue; }
    let j = i;
    while (j < rows.length && rows[j].t === 'same') j++;
    const run = rows.slice(i, j);
    // 바뀐 곳 앞뒤 두 문단만 남기고 접는다
    const head = i === 0 ? 0 : 2, tail = j === rows.length ? 0 : 2;
    if (run.length > head + tail + 1) {
      html += run.slice(0, head).map(line).join('') +
        `<div class="cmp-fold">같은 문단 ${run.length - head - tail}개</div>` + run.slice(run.length - tail).map(line).join('');
    } else html += run.map(line).join('');
    i = j;
  }
  const baseTitle = (copy.title || '').replace(/ \(충돌본 [^)]*\)$/, '');
  const titleNote = baseTitle !== (orig.title || '') ? `<p class="cmp-title">제목: 원본 "${escapeHtml(orig.title || '')}" · 충돌본 "${escapeHtml(baseTitle)}"</p>` : '';
  const o = document.createElement('div');
  o.className = 'modal-overlay';
  o.innerHTML = `
    <div class="modal-box cmp-box">
      <div class="trash-head"><h3>원본과 비교</h3><button class="fm-icon-btn" data-cmp="close" type="button" title="닫기">${ico('close')}</button></div>
      <p class="cmp-legend"><span class="cmp-key cmp-del">원본에만</span><span class="cmp-key cmp-add">충돌본에만</span>${changed ? '' : '<span>본문이 같습니다</span>'}</p>
      ${titleNote}
      <div class="cmp-body">${html}</div>
      <div class="cmp-foot">
        <button class="btn btn-secondary" data-cmp="orig" type="button">원본 열기</button>
        <button class="btn btn-primary" data-cmp="trash" type="button">충돌본 지우기</button>
      </div>
    </div>`;
  document.body.appendChild(o);
  o.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmp]');
    if (e.target !== o && !b) return;
    o.remove();
    if (!b) return;
    if (b.dataset.cmp === 'orig') loadMemoInEditor(orig);
    else if (b.dataset.cmp === 'trash') deleteMemo(copy.id);   // 휴지통으로(되살릴 수 있다)
  });
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
  if (savedEl) savedEl.textContent = '최근 저장 ' + fmtFullTime(store.getItem('last_saved_at'));
  if (syncedEl) syncedEl.textContent = '최근 동기화 ' + fmtFullTime(store.getItem('last_synced_at'));
  updateSyncIndicator();
}

// base: 원격과 같아진 상태(올린 그 순간의 상태). 없으면 지금 상태. clean=false면 그 뒤 고친 게 있어 '보낼 것'을 남긴다
function markSynced(base, clean = true) {
  store.setItem('last_synced_at', String(Date.now()));
  store.setItem('pending_sync', clean ? '0' : '1');
  if (clean) pendingSince = 0;
  // 원격과 같아진 내용을 다음 합치기의 기준점으로 삼는다
  store.setItem('sync_base', JSON.stringify(base || baseSnapshot(syncableMemos())));
  updateSaveSyncTimes();
}

function saveLocalData(changed = true) {
  clearTimeout(localSaveTimer);
  localSaveTimer = null;
  store.setItem('memos', JSON.stringify(memos));
  store.setItem('folders', JSON.stringify(folders));
  store.setItem('trash', JSON.stringify(trash));
  store.setItem('deletedIds', JSON.stringify(deletedIds));
  store.setItem('templates', JSON.stringify(templates));
  if (masterPasswordHash) store.setItem('master_pw', masterPasswordHash);
  else store.removeItem('master_pw');
  store.setItem('master_pw_at', String(masterPasswordAt || 0));
  store.setItem('last_saved_at', String(Date.now()));
  if (changed) { store.setItem('pending_sync', '1'); changeSeq++; }   // 아직 클라우드로 못 보낸 변경이 있다
  updateSaveSyncTimes();
}

function loadLocalData() {
  try {
    const md = store.getItem('memos');
    if (md) memos = JSON.parse(md);
    const fd = store.getItem('folders');
    if (fd) folders = JSON.parse(fd);
    const td = store.getItem('trash');
    if (td) trash = JSON.parse(td);
    const dd = store.getItem('deletedIds');
    if (dd) deletedIds = JSON.parse(dd);
    const tp = store.getItem('templates');
    if (tp) templates = JSON.parse(tp);
    masterPasswordHash = store.getItem('master_pw') || null;
    masterPasswordAt = Number(store.getItem('master_pw_at')) || 0;
    // 마이그레이션: sortOrder 없는 폴더에 순번 부여
    folders.forEach((f, i) => { if (f.sortOrder === undefined) f.sortOrder = i; });
  } catch {}
}

function sortBySortOrder(a, b) { return (a.sortOrder ?? 999) - (b.sortOrder ?? 999); }

function getChildFolders(parentId) {
  return folders.filter((f) => f.parentId === parentId).sort(sortBySortOrder);
}

// ── 폴더 계층: 최상위 → 하위 → 그 하위, 3단계까지 ──
const MAX_FOLDER_DEPTH = 3;

// 아래로 딸린 폴더 전부(자식·손자). 자료가 꼬여 고리가 생겨도 멈추게 본 것은 다시 보지 않는다
function getDescendantIds(id) {
  const out = new Set();
  const walk = (pid) => {
    for (const c of folders) if (c.parentId === pid && c.id !== id && !out.has(c.id)) { out.add(c.id); walk(c.id); }
  };
  walk(id);
  return [...out];
}

// 최상위 = 1. 부모가 사라진 폴더는 거기서 끊어 센다
function folderDepth(id) {
  let d = 0;
  const seen = new Set();
  let f = folders.find((x) => x.id === id);
  while (f && !seen.has(f.id)) {
    seen.add(f.id);
    d++;
    f = f.parentId ? folders.find((x) => x.id === f.parentId) : null;
  }
  return d;
}

// 이 폴더부터 맨 아래까지 몇 단계인가 (하위가 없으면 1)
function subtreeHeight(id, seen = new Set()) {
  if (seen.has(id)) return 0;
  seen.add(id);
  const kids = folders.filter((c) => c.parentId === id);
  return 1 + (kids.length ? Math.max(...kids.map((k) => subtreeHeight(k.id, seen))) : 0);
}

// id 폴더(딸린 폴더 포함)를 parentId 아래로 넣을 수 있나 — 자기·자기 하위 안으로는 못 넣고, 합쳐서 3단계를 넘으면 안 된다
function canMoveFolderUnder(id, parentId) {
  if (!parentId) return true;
  if (parentId === id || !folders.some((f) => f.id === parentId)) return false;
  if (getDescendantIds(id).includes(parentId)) return false;
  return folderDepth(parentId) + subtreeHeight(id) <= MAX_FOLDER_DEPTH;
}

// 최상위 폴더 — 사용 중 먼저, 휴면은 뒤
function topFoldersInOrder() {
  const tops = folders.filter((f) => !f.parentId);
  return [...tops.filter((f) => !f.dormant).sort(sortBySortOrder), ...tops.filter((f) => f.dormant).sort(sortBySortOrder)];
}

// 목록용: 주어진 최상위 폴더들부터 깊이 우선으로 [{ f, depth }]
function folderTree(tops) {
  const out = [];
  const seen = new Set();
  const walk = (f, depth) => {
    if (seen.has(f.id)) return;
    seen.add(f.id);
    out.push({ f, depth });
    if (depth < MAX_FOLDER_DEPTH) getChildFolders(f.id).forEach((c) => walk(c, depth + 1));
  };
  tops.forEach((t) => walk(t, 1));
  return out;
}

function nextSortOrder(parentId) {
  const siblings = folders.filter((f) => (f.parentId || null) === (parentId || null));
  return siblings.length === 0 ? 0 : Math.max(...siblings.map((f) => f.sortOrder ?? 0)) + 1;
}

function isVisibleMemo(m) {
  return m.title.trim() || m.content.trim();
}

// 이 폴더와 아래 폴더(손자까지)의 글 수
function getFolderMemoCount(folderId) {
  const ids = new Set([folderId, ...getDescendantIds(folderId)]);
  return memos.filter((m) => ids.has(m.folder) && isVisibleMemo(m)).length;
}

// 휴면 폴더 + 그 아래 폴더 전부(손자까지)
function getDormantFolderIds() {
  const ids = new Set();
  for (const f of folders) {
    if (f.dormant) { ids.add(f.id); getDescendantIds(f.id).forEach((c) => ids.add(c)); }
  }
  return ids;
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
      // 지금 연 폴더 안에 만든다(3단계까지). 이미 3단계면 그 옆(같은 부모 아래)에
      let parentId = null;
      if (currentFolder && currentFolder !== '__none__') {
        const cur = folders.find((f) => f.id === currentFolder);
        if (cur) parentId = folderDepth(cur.id) < MAX_FOLDER_DEPTH ? cur.id : (cur.parentId || null);
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

function confirmDeleteFolder(id) {
  confirmDeleteFolders([id]);
}

// 여러 폴더를 한꺼번에 지운다(2번 확인). 위아래 폴더를 같이 골랐으면 아래 것은 위 것과 함께 지워지므로 따로 세지 않는다
function confirmDeleteFolders(ids, onDone) {
  const picked = ids.map((id) => folders.find((f) => f.id === id)).filter(Boolean);
  const roots = picked.filter((f) => !picked.some((p) => p.id !== f.id && getDescendantIds(p.id).includes(f.id)));
  if (!roots.length) return;
  const allIds = new Set();
  roots.forEach((f) => { allIds.add(f.id); getDescendantIds(f.id).forEach((c) => allIds.add(c)); });
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

function deleteFolder(id) {
  const folder = folders.find((f) => f.id === id);
  const childFolders = getDescendantIds(id).map((cid) => folders.find((f) => f.id === cid)).filter(Boolean);
  const allIds = [id, ...childFolders.map((f) => f.id)];
  // 함께 지운 것끼리 같은 표(batch)를 단다 — 폴더를 복원하면 안의 하위 폴더·글도 함께 돌아오게
  const now = Date.now();
  const batch = id + '@' + now;
  // 폴더 + 하위 폴더 내 메모들을 휴지통으로 이동
  const folderMemos = memos.filter((m) => allIds.includes(m.folder));
  for (const m of folderMemos) {
    trash.push({ type: 'memo', data: { ...m }, deletedAt: now, batch });
  }
  memos = memos.filter((m) => !allIds.includes(m.folder));
  // 하위 폴더 휴지통으로
  for (const cf of childFolders) {
    trash.push({ type: 'folder', data: { ...cf }, deletedAt: now, batch });
  }
  // 폴더 자체도 휴지통으로
  if (folder) {
    trash.push({ type: 'folder', data: { ...folder }, deletedAt: now, batch });
  }
  folders = folders.filter((f) => !allIds.includes(f.id));
  if (allIds.includes(currentFolder)) { currentFolder = null; saveUiPrefs(); }
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
// target = { parentId, dormant, beforeId, note } — beforeId 앞에 넣는다(없으면 그 칸·묶음 맨 끝).
// note: 휴면 칸에 넣을 때 들어갈 휴면 묶음(휴면 메모). 생략하면 지금 메모를 그대로 둔다.
// 최상위는 [사용 중 …, 휴면 …]을 한 줄로 보고 번호를 다시 매긴다. 실제로 자리가 바뀌는지(moved)도 함께 돌려준다.
function planFolderMove(id, { parentId = null, dormant = false, beforeId = null, note } = {}) {
  const f = folders.find((x) => x.id === id);
  if (!f) return null;
  if (parentId) {
    if (!canMoveFolderUnder(id, parentId)) return null;     // 자기 안으로·3단계 넘게는 못 들어간다
    dormant = false;                                         // 하위 폴더는 부모의 휴면을 따른다
  }
  dormant = !!dormant;
  const curNote = f.dormantNote || '';
  const newNote = !dormant ? '' : note !== undefined ? note : (f.dormant && !f.parentId ? curNote : '');
  const group = folders.filter((x) => (x.parentId || null) === parentId);
  const before = parentId
    ? group.sort(sortBySortOrder)
    : [...group.filter((x) => !x.dormant).sort(sortBySortOrder), ...group.filter((x) => x.dormant).sort(sortBySortOrder)];
  // 자기 자신 앞 = 지금 자리 그대로(바로 다음 폴더 앞)
  if (beforeId === id) { const i = before.findIndex((x) => x.id === id); beforeId = before[i + 1] ? before[i + 1].id : null; }
  const list = before.filter((x) => x.id !== id);
  let idx = beforeId ? list.findIndex((x) => x.id === beforeId) : -1;
  if (idx < 0) {
    if (parentId) idx = list.length;
    else if (!dormant) idx = list.filter((x) => !x.dormant).length;
    else {
      // 휴면 묶음 맨 끝 = 같은 메모를 단 마지막 폴더 바로 뒤
      let last = -1;
      list.forEach((x, i) => { if (x.dormant && (x.dormantNote || '') === newNote) last = i; });
      idx = last >= 0 ? last + 1 : list.length;
    }
  }
  list.splice(idx, 0, f);
  const moved = (f.parentId || null) !== parentId || !!f.dormant !== dormant || (dormant && curNote !== newNote) ||
    before.map((x) => x.id).join() !== list.map((x) => x.id).join();
  return { f, parentId, dormant, note: newNote, list, moved };
}

// quiet: 여러 개를 연달아 옮길 때 — 저장·다시 그리기는 부른 쪽에서 한 번만
function applyFolderMove(plan, quiet) {
  const { f, parentId, dormant, note, list } = plan;
  const now = Date.now();
  if ((f.parentId || null) !== parentId) f.parentId = parentId;
  if (dormant) {
    if (!f.dormant) { f.dormant = true; f.dormantAt = now; }
    if (note) f.dormantNote = note; else delete f.dormantNote;
  } else if (f.dormant || f.dormantNote || f.dormantAt) {
    f.dormant = false;
    delete f.dormantNote;
    delete f.dormantAt;
  }
  f.updatedAt = now;
  list.forEach((x, i) => { if (x.sortOrder !== i) { x.sortOrder = i; x.updatedAt = now; } });
  if (quiet) return;
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
}

// 폴더 옮기기 대화상자 — 하나든 여럿이든. 고른 폴더의 하위까지 같이 골랐으면 하위는 부모와 함께 따라간다
function showMoveFoldersDialog(ids, onDone) {
  const picked = ids.map((id) => folders.find((f) => f.id === id)).filter(Boolean);
  const order = new Map(folderTree(topFoldersInOrder()).map(({ f }, i) => [f.id, i]));
  const roots = picked
    .filter((f) => !picked.some((p) => p.id !== f.id && getDescendantIds(p.id).includes(f.id)))
    .sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  if (!roots.length) return;
  const blocked = new Set();
  roots.forEach((r) => { blocked.add(r.id); getDescendantIds(r.id).forEach((c) => blocked.add(c)); });
  const single = roots.length === 1 ? roots[0] : null;
  let anyDisabled = false;
  let opts = `<option value=""${single && !single.parentId ? ' selected' : ''}>-- 최상위 --</option>`;
  for (const { f, depth } of folderTree(topFoldersInOrder())) {
    if (blocked.has(f.id)) continue;
    const ok = roots.every((r) => canMoveFolderUnder(r.id, f.id));
    if (!ok) anyDisabled = true;
    const pad = '　'.repeat(depth - 1) + (depth > 1 ? '└ ' : '');
    opts += `<option value="${f.id}"${ok ? '' : ' disabled'}${single && single.parentId === f.id ? ' selected' : ''}>${pad}${escapeHtml(f.name)}${f.dormant ? ' (휴면)' : ''}</option>`;
  }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <p>${single ? `"${escapeHtml(single.name)}" 폴더를 옮길 곳` : `${roots.length}개 폴더를 옮길 곳`}</p>
      <select id="move-folder-select" style="width:100%;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:0.9rem;outline:none;margin-bottom:${anyDisabled ? 6 : 16}px;">
        ${opts}
      </select>
      ${anyDisabled ? '<p style="font-size:0.75rem;color:var(--text2);margin-bottom:14px">흐린 폴더는 3단계를 넘어 들어갈 수 없습니다</p>' : ''}
      <button class="btn btn-secondary" id="movef-cancel">취소</button>
      <button class="btn btn-primary" id="movef-ok">옮기기</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#movef-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#movef-ok').onclick = () => {
    const target = overlay.querySelector('#move-folder-select').value || null;
    overlay.remove();
    let n = 0;
    for (const r of roots) {
      if ((r.parentId || null) === target) continue;   // 이미 거기 있으면 순서도 건드리지 않는다
      const plan = planFolderMove(r.id, { parentId: target, dormant: false });
      if (!plan || !plan.moved) continue;
      applyFolderMove(plan, true);
      n++;
    }
    if (n) {
      saveLocalData();
      renderAll();
      scheduleSyncToDropbox();
      showToast(single ? '폴더가 이동되었습니다' : n + '개 폴더를 옮겼습니다');
    }
    if (onDone) onDone();
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ── 휴면 ──
// 휴면은 최상위 폴더에 건다. 그 아래 폴더·글은 모두 따라서 '전체'에서 숨는다.
// 휴면 메모(dormantNote) = '어느 부서·팀, 언제' 같은 한 줄. 같은 메모를 단 폴더끼리 휴면 칸에서 한 묶음으로 보인다.
function setFoldersDormant(ids, on, note = '') {
  const now = Date.now();
  note = (note || '').trim();
  let n = 0;
  for (const id of ids) {
    const f = folders.find((x) => x.id === id);
    if (!f || f.parentId || !!f.dormant === on) continue;
    if (on) {
      f.dormant = true;
      f.dormantAt = now;
      if (note) f.dormantNote = note; else delete f.dormantNote;
    } else {
      f.dormant = false;
      delete f.dormantNote;
      delete f.dormantAt;
    }
    f.updatedAt = now;
    n++;
  }
  if (!n) return;
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
  showToast((n > 1 ? n + '개 폴더' : '폴더') + (on ? '가 휴면 처리되었습니다' : '의 휴면이 해제되었습니다'));
}

function setDormantNote(ids, note) {
  note = (note || '').trim();
  const now = Date.now();
  let n = 0;
  for (const id of ids) {
    const f = folders.find((x) => x.id === id);
    if (!f || f.parentId || !f.dormant || (f.dormantNote || '') === note) continue;
    if (note) f.dormantNote = note; else delete f.dormantNote;
    f.updatedAt = now;
    n++;
  }
  if (!n) return;
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
  showToast('휴면 메모를 저장했습니다');
}

// mode 'sleep': 휴면 처리(메모 입력) / 'note': 이미 휴면인 폴더들의 메모 고치기
function showDormantDialog(ids, { mode = 'sleep', note = '', onDone } = {}) {
  let tops = ids.map((id) => folders.find((f) => f.id === id)).filter((f) => f && !f.parentId);
  tops = tops.filter((f) => (mode === 'sleep' ? !f.dormant : f.dormant));
  if (!tops.length) return;
  let title = '휴면 메모';
  let info = '';
  if (mode === 'sleep') {
    const all = new Set();
    tops.forEach((f) => { all.add(f.id); getDescendantIds(f.id).forEach((c) => all.add(c)); });
    const sub = all.size - tops.length;
    const memoN = memos.filter((m) => all.has(m.folder) && isVisibleMemo(m)).length;
    title = tops.length === 1 ? `"${escapeHtml(tops[0].name)}" 휴면 처리` : `${tops.length}개 폴더 휴면 처리`;
    info = (sub ? `하위 폴더 ${sub}개와 ` : '') + `메모 ${memoN}개가 함께 휴면에 들어갑니다`;
  }
  const notes = [...new Set(folders.filter((f) => f.dormant && f.dormantNote).map((f) => f.dormantNote))];
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <p>${title}</p>
      ${info ? `<p style="font-size:0.85rem;color:var(--text2);margin-top:-8px">${info}</p>` : ''}
      <input type="text" id="dn-input" list="dn-list" maxlength="80" autocomplete="off"
        placeholder="휴면 메모 (예: 사회부 기동팀, 2024.10–2025.10)" value="${escapeHtml(note)}">
      <datalist id="dn-list">${notes.map((n) => `<option value="${escapeHtml(n)}">`).join('')}</datalist>
      <div>
        <button class="btn btn-secondary" id="dn-cancel">취소</button>
        <button class="btn btn-primary" id="dn-ok">${mode === 'sleep' ? '휴면 처리' : '저장'}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#dn-input');
  input.focus();
  input.select();
  const ok = () => {
    const v = input.value;
    overlay.remove();
    if (mode === 'sleep') setFoldersDormant(tops.map((f) => f.id), true, v);
    else setDormantNote(tops.map((f) => f.id), v);
    if (onDone) onDone();
  };
  overlay.querySelector('#dn-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#dn-ok').onclick = ok;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ok(); } });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// 휴면 묶음: 휴면 메모가 같은 최상위 휴면 폴더끼리. 최근에 휴면한 묶음이 위, 메모 없는 묶음은 맨 아래
function dormantGroups() {
  const map = new Map();
  for (const f of folders.filter((x) => !x.parentId && x.dormant).sort(sortBySortOrder)) {
    const note = f.dormantNote || '';
    if (!map.has(note)) map.set(note, { note, tops: [], at: 0 });
    const g = map.get(note);
    g.tops.push(f);
    g.at = Math.max(g.at, f.dormantAt || 0);
  }
  return [...map.values()].sort((a, b) => (!a.note - !b.note) || b.at - a.at);
}

function formatDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

// ── 폴더 관리 화면 (크롬 북마크 관리자처럼 한 화면에서) ──
// 사이드바 폴더를 우클릭(휴대폰은 길게 누르기)하거나 폴더 목록 아래 '폴더 관리'로 연다.
// 줄 끝 ⋮ 하나에 모든 기능: 열기·이름 바꾸기·하위 폴더·옮기기·비밀번호·휴면(최상위만)·삭제.
// 체크박스로 여럿을 골라 한꺼번에 옮기기·휴면·삭제. 폴더는 3단계까지.
// 왼쪽 손잡이를 끌어 순서를 바꾸고, 다른 폴더 위에 놓으면 그 하위로, 휴면 묶음에 놓으면 그 묶음으로 휴면.
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
        왼쪽 손잡이(${ico('grip')})를 끌어 순서 바꾸기 · 다른 폴더 위에 놓으면 그 하위로(3단계까지) · 휴면 묶음에 놓으면 그 묶음으로 휴면<br>
        체크박스로 여러 폴더를 골라 한꺼번에 옮기기·휴면·삭제 · PC는 Shift+클릭으로 범위 선택<br>
        휴면은 최상위 폴더에 걸고, 아래 폴더와 글은 함께 '전체'에서 숨겨집니다 · 휴면 메모가 같은 폴더끼리 한 묶음<br>
        이름은 두 번 클릭해 바로 고칠 수 있어요
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
    if (fm && fm.menu && !e.target.closest('.fm-menu') && !e.target.closest('[data-act]')) closeFmMenu();
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

  // 휴대폰 뒤로가기 제스처가 앱·글 대신 이 화면을 먼저 닫게 한다(layersChanged)
  layersChanged();
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
  if (!fromPopstate) layersChanged();
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

// 화면 순서: 사용 중 칸은 최상위 → 하위 → 그 하위(깊이 우선), 휴면 칸은 휴면 묶음마다 같은 순서.
// 어디에도 안 걸리는 폴더(부모가 사라졌거나 4단계 이상)는 사이드바엔 안 보이므로 사용 중 칸 끝에 꺼내 둔다 — 끌어 옮기면 바로잡힌다.
function fmSections() {
  const placed = new Set();
  const tree = (tops) => { const rows = folderTree(tops); rows.forEach((r) => placed.add(r.f.id)); return rows; };
  const active = tree(folders.filter((f) => !f.parentId && !f.dormant).sort(sortBySortOrder));
  const groups = dormantGroups().map((g) => ({ ...g, rows: tree(g.tops) }));
  const stray = folders.filter((f) => !placed.has(f.id)).sort(sortBySortOrder);
  return { active, groups, stray };
}

function fmRowHtml(f, depth, stray) {
  const count = getFolderMemoCount(f.id);
  const name = fm.editing === f.id
    ? `<input class="fm-input" value="${escapeHtml(f.name)}" maxlength="60" aria-label="폴더 이름">`
    : `<span class="fm-name-text">${escapeHtml(f.name)}</span>${f.password ? `<span class="fm-lock" title="비밀번호 걸림">${ico('lock')}</span>` : ''}`;
  const sel = fm.selected.has(f.id);
  return `<div class="fm-row fm-d${depth}${sel ? ' selected' : ''}" data-id="${f.id}" data-depth="${depth}" data-parent="${depth > 1 ? f.parentId : ''}"${stray ? ' data-stray="1"' : ''}>
    <label class="fm-check" title="선택"><input type="checkbox" data-check="${f.id}"${sel ? ' checked' : ''}></label>
    <span class="fm-grip" title="끌어서 옮기기">${ico('grip')}</span>
    <span class="fm-name">${ico('folder')}${name}</span>
    <span class="fm-count">${count}</span>
    <button class="fm-more" data-act="menu" type="button" title="더보기">${ico('more')}</button>
  </div>`;
}

function fmNewRowHtml(depth) {
  return `<div class="fm-row fm-new fm-d${depth}">
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
  const { active, groups, stray } = fmSections();
  const creating = fm.creating;
  // 하위 폴더를 만드는 중이면 그 부모 묶음(하위·손자 포함) 맨 끝에 입력 줄을 끼운다
  const rowsHtml = (rows) => {
    let at = -1, depth = 0;
    if (creating && creating.parentId) {
      const sub = new Set([creating.parentId, ...getDescendantIds(creating.parentId)]);
      rows.forEach((r, i) => { if (sub.has(r.f.id)) at = i; });
      const p = rows.find((r) => r.f.id === creating.parentId);
      depth = p ? p.depth + 1 : 0;
    }
    return rows.map((r, i) => fmRowHtml(r.f, r.depth) + (i === at && depth ? fmNewRowHtml(depth) : '')).join('');
  };
  const activeHtml = rowsHtml(active) + stray.map((f) => fmRowHtml(f, 1, true)).join('') +
    (creating && !creating.parentId ? fmNewRowHtml(1) : '');
  const groupsHtml = groups.map((g) => `
    <div class="fm-group" data-note="${escapeHtml(g.note)}">
      <div class="fm-group-head">
        ${ico('tag')}<span class="fm-group-note${g.note ? '' : ' empty'}">${g.note ? escapeHtml(g.note) : '휴면 메모 없음'}</span>
        <span class="fm-group-meta">폴더 ${g.rows.length}${g.at ? ' · ' + formatDay(g.at) + ' 휴면' : ''}</span>
        <button class="fm-more" data-act="gmenu" type="button" title="묶음 메뉴">${ico('more')}</button>
      </div>
      ${rowsHtml(g.rows)}
    </div>`).join('');
  const nDormant = groups.reduce((n, g) => n + g.rows.length, 0);
  const scroll = fm.body.scrollTop;
  fm.body.innerHTML = `
    <div class="fm-section" data-section="active">
      <div class="fm-section-head">${ico('folder')} 폴더 <span class="fm-section-n">${active.length + stray.length}</span></div>
      ${activeHtml || '<div class="fm-empty">비어 있음</div>'}
    </div>
    <div class="fm-section" data-section="dormant">
      <div class="fm-section-head">${ico('moon')} 휴면 <span class="fm-section-n">${nDormant}</span></div>
      ${groupsHtml || '<div class="fm-empty">비어 있음</div>'}
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
  if (btn.dataset.act === 'menu') {
    const id = btn.closest('.fm-row').dataset.id;
    if (fm.menu && fm.menu.key === id) closeFmMenu(); else openFolderMenu(id, btn);
  } else if (btn.dataset.act === 'gmenu') {
    const note = btn.closest('.fm-group').dataset.note;
    if (fm.menu && fm.menu.key === 'g:' + note) closeFmMenu(); else openGroupMenu(note, btn);
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

// 줄 표시·체크 상태와 위쪽 선택 막대(N개 선택 · 옮기기 · 휴면 처리 · 휴면 해제 · 삭제)를 맞춘다
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
    <span class="fm-sel-actions">
      <button class="fm-sel-btn" data-sel="move" type="button">${ico('folder-move')}<span>옮기기</span></button>
      ${canSleep ? `<button class="fm-sel-btn" data-sel="sleep" type="button">${ico('moon')}<span>휴면 처리</span></button>` : ''}
      ${canWake ? `<button class="fm-sel-btn" data-sel="wake" type="button">${ico('sun')}<span>휴면 해제</span></button>` : ''}
      <button class="fm-sel-btn danger" data-sel="delete" type="button">${ico('trash')}<span>삭제</span></button>
    </span>`;
}

function onFmSelbarClick(e) {
  const b = e.target.closest('[data-sel]');
  if (!b || !fm) return;
  const ids = [...fm.selected];
  const done = () => { if (fm) { fm.selected.clear(); updateFmSelection(); } };
  if (b.dataset.sel === 'clear') done();
  else if (b.dataset.sel === 'move') showMoveFoldersDialog(ids, done);
  else if (b.dataset.sel === 'sleep') showDormantDialog(ids, { mode: 'sleep', onDone: done });
  else if (b.dataset.sel === 'wake') { setFoldersDormant(ids, false); done(); }
  else if (b.dataset.sel === 'delete') confirmDeleteFolders(ids, done);
}

// ⋮ 메뉴 하나를 단추 아래에 띄운다. items = [[동작, 아이콘, 글자], …]
function openFmMenu({ key, anchor, row, items, onPick }) {
  closeFmMenu();
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
  fm.menu = { el: menu, key, row };
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mact]');
    if (!b) return;
    closeFmMenu();
    onPick(b.dataset.mact);
  });
}

function openFolderMenu(id, anchor) {
  const f = folders.find((x) => x.id === id);
  if (!f) return;
  const row = anchor.closest('.fm-row');
  const depth = Number(row.dataset.depth) || 1;
  const stray = !!row.dataset.stray;
  const isTop = depth === 1 && !stray;
  const items = [
    ['open', 'folder', '열기'],
    ['rename', 'edit', '이름 바꾸기'],
    depth < MAX_FOLDER_DEPTH && !stray ? ['child', 'folder-plus', '하위 폴더 만들기'] : null,
    ['move', 'folder-move', '다른 폴더로 옮기기'],
    ['password', f.password ? 'lock' : 'key', f.password ? '비밀번호 바꾸기·풀기' : '비밀번호 걸기'],
    isTop && !f.dormant ? ['sleep', 'moon', '휴면 처리'] : null,
    isTop && f.dormant ? ['note', 'tag', '휴면 메모 바꾸기'] : null,
    isTop && f.dormant ? ['wake', 'sun', '휴면 해제'] : null,
    ['delete', 'trash', '삭제'],
  ].filter(Boolean);
  openFmMenu({ key: id, anchor, row, items, onPick: (act) => runFmAction(act, id) });
}

// 휴면 묶음 머리줄의 ⋮ — 묶음 메모 고치기·모두 휴면 해제
function openGroupMenu(note, anchor) {
  const ids = folders.filter((f) => !f.parentId && f.dormant && (f.dormantNote || '') === note).map((f) => f.id);
  openFmMenu({
    key: 'g:' + note,
    anchor,
    row: anchor.closest('.fm-group-head'),
    items: [['gnote', 'tag', note ? '휴면 메모 고치기' : '휴면 메모 달기'], ['gwake', 'sun', '모두 휴면 해제']],
    onPick: (act) => {
      if (act === 'gnote') showDormantDialog(ids, { mode: 'note', note });
      else if (act === 'gwake') setFoldersDormant(ids, false);
    },
  });
}

function closeFmMenu() {
  if (!fm || !fm.menu) return;
  fm.menu.el.remove();
  fm.menu.row.classList.remove('menu-open');
  fm.menu = null;
}

function runFmAction(act, id) {
  const f = folders.find((x) => x.id === id);
  if (act === 'open') openFolderFromManager(id);
  else if (act === 'rename') startFmRename(id);
  else if (act === 'child') startFmCreate(id);
  else if (act === 'move') showMoveFoldersDialog([id]);
  else if (act === 'password') showSetPasswordDialog(id);
  else if (act === 'sleep') showDormantDialog([id], { mode: 'sleep' });
  else if (act === 'note') showDormantDialog([id], { mode: 'note', note: (f && f.dormantNote) || '' });
  else if (act === 'wake') setFoldersDormant([id], false);
  else if (act === 'delete') confirmDeleteFolder(id);
}

function openFolderFromManager(id) {
  closeFolderManager();
  const go = () => {
    currentFolder = id;
    saveUiPrefs();
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
  if (parentId && folderDepth(parentId) >= MAX_FOLDER_DEPTH) return;
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
    if (name && (!parentId || (folders.some((p) => p.id === parentId) && folderDepth(parentId) < MAX_FOLDER_DEPTH))) {
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
  const blockIds = new Set([id, ...getDescendantIds(id)]);
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
    id, ghost, line, x: e.clientX, y: e.clientY, target: null, raf: 0, pointerId: e.pointerId,
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

// 손가락·마우스 위치 → 놓을 자리. { into: 폴더id } 또는 { parentId, dormant, note, beforeId, lineEl, box }
// 놓을 수 있는 칸(box) = 사용 중 칸, 휴면 묶음 하나하나(묶음이 하나도 없으면 휴면 칸 자체)
function fmDropTarget(x, y) {
  const d = fm.drag;
  const br = fm.body.getBoundingClientRect();
  const hx = Math.min(Math.max(x, br.left + 24), br.right - 24);
  const hy = Math.min(Math.max(y, br.top + 1), br.bottom - 1);
  const el = document.elementFromPoint(hx, hy);
  if (!el || !fm.body.contains(el)) return null;
  const dormantSec = fm.body.querySelector('.fm-section[data-section="dormant"]');
  const groupEls = [...fm.body.querySelectorAll('.fm-group')];
  const boxes = [fm.body.querySelector('.fm-section[data-section="active"]'), ...(groupEls.length ? groupEls : [dormantSec])];
  let box = el.closest('.fm-group') || el.closest('.fm-section');
  let outside = 0;   // 칸 사이·머리줄·아래 여백이면 가장 가까운 칸의 맨 앞(-1)·맨 끝(1)
  if (!boxes.includes(box)) {
    box = null;
    let best = Infinity;
    for (const b of boxes) {
      const r = b.getBoundingClientRect();
      const dist = hy < r.top ? r.top - hy : hy > r.bottom ? hy - r.bottom : 0;
      if (dist < best) { best = dist; box = b; outside = hy < r.top ? -1 : 1; }
    }
    if (!box) return null;
  }
  const isDormant = box !== boxes[0];
  const note = box.classList.contains('fm-group') ? box.dataset.note : '';
  const rows = [...box.querySelectorAll('.fm-row[data-id]')];
  // beforeEl 앞(없으면 칸 맨 끝)에 넣기 = beforeEl 의 부모 아래로.
  // 그 부모 아래로 못 들어가면(3단계 초과) 한 단계 위로: 부모 바로 다음 자리(부모의 다음 형제 앞, 없으면 그 윗부모 묶음 끝)
  const gap = (beforeEl) => {
    let parent = beforeEl ? (beforeEl.dataset.parent || null) : null;
    let beforeId = beforeEl ? beforeEl.dataset.id : null;
    let lineEl = beforeEl;
    while (parent && !canMoveFolderUnder(d.id, parent)) {
      const pRow = rows.find((x) => x.dataset.id === parent);
      if (!pRow) { parent = null; break; }
      const pDepth = Number(pRow.dataset.depth);
      let i = rows.indexOf(pRow) + 1;
      while (rows[i] && Number(rows[i].dataset.depth) > pDepth) i++;
      const next = rows[i] && Number(rows[i].dataset.depth) === pDepth ? rows[i] : null;
      parent = pRow.dataset.parent || null;
      beforeId = next ? next.dataset.id : null;
      lineEl = rows[i] || null;
    }
    if (parent) return { parentId: parent, beforeId, lineEl, box };
    return { parentId: null, dormant: isDormant, note: isDormant ? note : undefined, beforeId, lineEl, box };
  };
  const rowEl = outside ? null : el.closest('.fm-row[data-id]');
  if (!rowEl) return gap(outside < 0 || el.closest('.fm-section-head, .fm-group-head') ? (rows[0] || null) : null);
  const r = rowEl.getBoundingClientRect();
  const rel = (hy - r.top) / r.height;
  const canInto = !rowEl.dataset.stray && rowEl.dataset.id !== d.id && canMoveFolderUnder(d.id, rowEl.dataset.id);
  if (canInto && rel > 0.25 && rel < 0.75) return { into: rowEl.dataset.id };
  if (rel < 0.5) return gap(rowEl);
  return gap(rows[rows.indexOf(rowEl) + 1] || null);
}

function fmTargetPlan(t) {
  if (!t) return null;
  const plan = t.into
    ? planFolderMove(fm.drag.id, { parentId: t.into })
    : planFolderMove(fm.drag.id, { parentId: t.parentId, dormant: t.dormant, beforeId: t.beforeId, note: t.note });
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
    const last = [...t.box.querySelectorAll('.fm-row')].pop();
    if (!last) { const empty = t.box.querySelector('.fm-empty'); if (empty) empty.classList.add('fm-drop-here'); return; }
    top = last.offsetTop + last.offsetHeight;
  }
  d.line.style.top = (top - 1) + 'px';
  // 하위로 들어가는 자리는 들어갈 단계의 손잡이 위치부터 들여 긋는다
  const base = fm.body.querySelector('.fm-row.fm-d1 .fm-grip');
  d.line.style.left = (t.parentId && base ? base.offsetLeft + folderDepth(t.parentId) * 28 : 10) + 'px';
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
// 새 글이 들어갈 폴더 (cleanupEmptyMemo가 currentId를 비우기 전에 정한다)
// 1) 특정 폴더를 연 상태면 그 폴더
// 2) 전체/미분류 보기지만 지금 보고 있는 글이 어떤 폴더에 속하면 그 폴더
// 3) 둘 다 아니면 폴더 없음
function newMemoFolder() {
  let targetFolder = (currentFolder && currentFolder !== '__none__') ? currentFolder : null;
  if (!targetFolder && currentId) {
    const cur = memos.find((m) => m.id === currentId);
    if (cur && cur.folder) targetFolder = cur.folder;
  }
  return targetFolder;
}

// opts(새 창에서만): { id, folder } — 단추·빈 화면에서 부르면 클릭 신호가 들어오므로 무시한다
function createMemo(opts) {
  const o = opts && !(opts instanceof Event) ? opts : {};
  const targetFolder = 'folder' in o ? o.folder : newMemoFolder();
  cleanupEmptyMemo();
  const memo = {
    id: o.id || crypto.randomUUID(),
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

// Ctrl+N: 글 쓰기 전용 새 창(목록 더블클릭으로 여는 창과 같은 모양)을 열어 거기서 새 글을 쓴다.
// 새 글이 들어갈 폴더는 이 창에서 정해 넘긴다(연 폴더 → 보고 있던 글의 폴더). 새 창이 막혔으면 이 창에서
function openNewNoteWindow() {
  const folder = newMemoFolder();
  const url = location.pathname + '?new=1' + (folder ? '&folder=' + encodeURIComponent(folder) : '') + MODE_QUERY;
  const w = window.open(url, '_blank', 'width=400,height=700');
  if (!w) createMemo();
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
  // 지울 글은 지금 정한다 — 확인하는 사이 동기화로 글이 닫혀도 엉뚱한 일이 없게
  const id = currentId;
  const memo = memos.find((m) => m.id === id);
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
      if (memos.some((m) => m.id === id)) deleteMemo(id);
    };
  };
}

// 앱 모양의 확인 창(브라우저 기본 확인 창 대신) — Esc·바깥 누르기 = 취소
function askConfirm(message, okLabel, onOk) {
  const o = document.createElement('div');
  o.className = 'modal-overlay';
  o.innerHTML = `<div class="modal-box"><p>${message}</p><button class="btn btn-secondary" data-ask="no" type="button">취소</button> <button class="btn btn-primary" data-ask="yes" type="button">${okLabel}</button></div>`;
  document.body.appendChild(o);
  o.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ask]');
    if (e.target !== o && !b) return;
    o.remove();
    if (b && b.dataset.ask === 'yes') onOk();
  });
  o.querySelector('[data-ask="yes"]').focus();
}

// ── Trash ──
// 항목은 순번이 아니라 '종류:id'로 가린다 — 창을 연 사이 동기화로 목록이 바뀌어도 누른 그 항목에만 적용된다
// (예전엔 순번으로 찾아, 동기화가 끼면 엉뚱한 글이 복원·영구 삭제됐다). 열려 있는 동안 바뀌면 목록을 다시 그린다
let trashView = null;
const trashKey = (t) => t.type + ':' + (t.data && t.data.id);
function findTrash(key) { return trash.find((t) => trashKey(t) === key); }
function trashName(t) {
  return t.type === 'folder' ? (t.data.name || '이름 없는 폴더') : (t.data.title || formatCreatedAt(t.data.createdAt) + ' 새 글');
}
// 함께 지운 무리(폴더를 지울 때 같이 들어간 하위 폴더·글). 표(batch)가 없던 옛 항목은 지운 시각이 5초 안이면 같은 무리로 본다
function sameTrashBatch(a, b) {
  return a.batch ? a.batch === b.batch : !b.batch && Math.abs((a.deletedAt || 0) - (b.deletedAt || 0)) <= 5000;
}
// 폴더 항목과 함께 돌아올 하위 폴더(부모부터 차례로)·글
function trashBundle(item) {
  const order = [item];
  const alive = new Set([item.data.id]);
  const sub = trash.filter((t) => t.type === 'folder' && t !== item && sameTrashBatch(item, t));
  for (let grew = true; grew;) {
    grew = false;
    for (const t of sub) if (!order.includes(t) && alive.has(t.data.parentId)) { order.push(t); alive.add(t.data.id); grew = true; }
  }
  const notes = trash.filter((t) => t.type === 'memo' && sameTrashBatch(item, t) && alive.has(t.data.folder));
  return { folders: order, memos: notes };
}

function showTrashView() {
  if (trashView) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const open = new Set();   // 미리 보기를 펼친 항목
  let filter = '';
  overlay.innerHTML = `
    <div class="modal-box trash-box">
      <div class="trash-head">
        <h3>${ico('trash')}<span>휴지통</span><span class="trash-n"></span></h3>
        <button class="fm-icon-btn" data-tact="close" type="button" title="닫기">${ico('close')}</button>
      </div>
      <input class="trash-filter" type="search" placeholder="휴지통에서 찾기" hidden>
      <div class="trash-list"></div>
      <div class="trash-foot">
        <button class="trash-link" data-tact="restore-all" type="button">모두 복원</button>
        <button class="trash-link danger" data-tact="empty" type="button">비우기</button>
      </div>
    </div>`;
  const list = overlay.querySelector('.trash-list');
  const input = overlay.querySelector('.trash-filter');

  const row = (t) => {
    const key = trashKey(t);
    const isFolder = t.type === 'folder';
    let meta = formatDate(t.deletedAt) + ' 지움';
    if (isFolder) {
      const b = trashBundle(t);
      const extra = [b.folders.length > 1 ? `하위 폴더 ${b.folders.length - 1}개` : '', b.memos.length ? `글 ${b.memos.length}편` : ''].filter(Boolean).join('·');
      if (extra) meta += ' · ' + extra + ' 함께';
    } else if (t.data.folder) {
      const f = folders.find((x) => x.id === t.data.folder);
      if (f) meta += ' · ' + escapeHtml(f.name);
    }
    const preview = isFolder ? '' : `<div class="trash-preview"${open.has(key) ? '' : ' hidden'}>${escapeHtml((t.data.content || '').substring(0, 300)) || '<i>내용 없음</i>'}</div>`;
    return `<div class="trash-item" data-key="${escapeHtml(key)}">
      <div class="trash-row">
        <div class="trash-main"${isFolder ? '' : ' data-tact="preview"'}>
          ${ico(isFolder ? 'folder' : 'note')}
          <div class="trash-text"><div class="trash-name">${escapeHtml(trashName(t))}</div><div class="trash-meta">${meta}</div></div>
        </div>
        <button class="btn btn-secondary trash-btn" data-tact="restore" type="button">복원</button>
        <button class="trash-btn trash-del" data-tact="delete" type="button" title="영구 삭제">삭제</button>
      </div>
      ${preview}
    </div>`;
  };

  const renderList = () => {
    const q = filter.trim().toLowerCase();
    const items = [...trash].sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))   // 방금 지운 것이 위
      .filter((t) => !q || trashName(t).toLowerCase().includes(q) || (t.data.content || '').toLowerCase().includes(q));
    overlay.querySelector('.trash-n').textContent = trash.length ? String(trash.length) : '';
    input.hidden = trash.length <= 8 && !filter;
    list.innerHTML = trash.length === 0
      ? '<p class="trash-empty">휴지통이 비어 있습니다.</p>'
      : items.length ? items.map(row).join('') : '<p class="trash-empty">찾는 항목이 없습니다.</p>';
    overlay.querySelector('.trash-foot').hidden = trash.length === 0;
  };

  const close = () => { overlay.remove(); trashView = null; };
  overlay._close = close;
  trashView = { renderList };

  input.addEventListener('input', () => { filter = input.value; renderList(); });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { close(); return; }
    const b = e.target.closest('[data-tact]');
    if (!b) return;
    const act = b.dataset.tact;
    if (act === 'close') { close(); return; }
    if (act === 'empty') {
      askConfirm(`휴지통의 ${trash.length}개 항목을 모두 영구 삭제할까요?<br><span class="ask-note">되돌릴 수 없습니다</span>`, '비우기', () => {
        for (const t of trash) deletedIds.push({ id: t.data.id, at: Date.now() });
        trash = [];
        saveLocalData();
        syncToDropbox().catch(() => {});
        renderAll();
        showToast('휴지통을 비웠습니다');
      });
      return;
    }
    if (act === 'restore-all') {
      askConfirm(`휴지통의 ${trash.length}개 항목을 모두 복원할까요?`, '모두 복원', () => {
        const n = restoreAllTrash();
        showToast(`${n}개를 복원했습니다`);
      });
      return;
    }
    const item = b.closest('.trash-item');
    const key = item && item.dataset.key;
    if (!key) return;
    if (act === 'preview') {
      if (open.has(key)) open.delete(key); else open.add(key);
      const pv = item.querySelector('.trash-preview');
      if (pv) pv.hidden = !open.has(key);
      return;
    }
    const t = findTrash(key);
    if (!t) { showToast('이미 다른 곳에서 처리된 항목입니다'); renderList(); return; }
    if (act === 'restore') {
      const r = restoreTrashItem(t);
      saveLocalData();
      renderAll();
      scheduleSyncToDropbox();
      showToast(r.folders ? `폴더${r.folders > 1 ? ' ' + r.folders + '개' : ''}${r.memos ? '와 글 ' + r.memos + '편' : ''}을 복원했습니다`
        : r.toNone ? '원래 폴더가 없어 미분류로 복원했습니다' : '복원되었습니다');
    } else if (act === 'delete') {
      askConfirm(`"${escapeHtml(trashName(t))}"을(를) 영구 삭제할까요?<br><span class="ask-note">되돌릴 수 없습니다</span>`, '영구 삭제', () => {
        const cur = findTrash(key);
        if (!cur) return;
        deletedIds.push({ id: cur.data.id, at: Date.now() });
        trash = trash.filter((x) => x !== cur);
        saveLocalData();
        syncToDropbox().catch(() => {});
        renderAll();
        showToast('영구 삭제되었습니다');
      });
    }
  });

  document.body.appendChild(overlay);
  renderList();
}

// 휴지통 항목 하나 되살리기(저장·다시 그리기는 부른 쪽에서). 폴더면 함께 지운 하위 폴더·글도 같이
function restoreTrashItem(item) {
  const now = Date.now();
  const r = { memos: 0, folders: 0, toNone: false };
  if (item.type === 'memo') {
    const d = item.data;
    // 원래 폴더가 아직 존재하면 그 폴더로, 없으면 미분류로 복원
    if (d.folder && !folders.some((f) => f.id === d.folder)) { d.folder = null; d.folderAt = now; r.toNone = true; }
    d.updatedAt = now;
    memos.unshift(d);
    trash = trash.filter((x) => x !== item);
    r.memos = 1;
    return r;
  }
  const b = trashBundle(item);
  const root = item.data;
  // 같은 이름의 폴더가 이미 있으면 이름 뒤에 (복원) 추가
  if (folders.some((f) => f.name === root.name)) root.name += ' (복원)';
  // 부모 폴더가 없거나, 하위까지 합쳐 3단계를 넘으면 최상위로 복원
  const rel = new Map([[root.id, 1]]);
  for (const t of b.folders.slice(1)) rel.set(t.data.id, (rel.get(t.data.parentId) || 1) + 1);
  const height = Math.max(...rel.values());
  if (root.parentId && (!folders.some((f) => f.id === root.parentId) || folderDepth(root.parentId) + height > MAX_FOLDER_DEPTH)) {
    root.parentId = null;
  }
  for (const t of b.folders) {
    t.data.sortOrder = nextSortOrder(t.data.parentId || null);
    t.data.updatedAt = now;
    folders.push(t.data);
  }
  for (const t of b.memos) {
    t.data.updatedAt = now;
    memos.unshift(t.data);
  }
  const back = new Set([...b.folders, ...b.memos]);
  trash = trash.filter((x) => !back.has(x));
  r.folders = b.folders.length;
  r.memos = b.memos.length;
  return r;
}

// 휴지통 전부 되살리기 — 폴더부터(부모가 휴지통에 없는 것부터), 그다음 글. 되살린 개수를 돌려준다
function restoreAllTrash() {
  let n = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const inTrash = new Set(trash.filter((t) => t.type === 'folder').map((t) => t.data.id));
    const next = trash.find((t) => t.type === 'folder' && !inTrash.has(t.data.parentId)) || trash.find((t) => t.type === 'folder');
    if (!next) break;
    const r = restoreTrashItem(next);
    n += r.folders + r.memos;
  }
  for (const t of [...trash]) { if (t.type === 'memo') { restoreTrashItem(t); n++; } }
  saveLocalData();
  renderAll();
  scheduleSyncToDropbox();
  return n;
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
  const key = store.nameOf(e.key);   // 다른 칸(시범 운전 등)의 신호는 무시
  if (key === 'last_saved_at' || key === 'last_synced_at' || key === 'pending_sync') { updateSaveSyncTimes(); return; }
  // 다른 창(새 창 등)에서 바꾼 화면 설정도 바로
  if (key === THEME_KEY) { applyTheme(); return; }
  if (key === FONT_KEY) { applyFont(); return; }
  if (key !== 'memos') return; // saveLocalData는 항상 memos를 함께 저장하므로 이 키만 보면 됨
  // 이 창에 열린 빈 새 글(아직 아무것도 안 씀)은 다른 창이 '빈 글 정리'로 지워도 이 창에선 남긴다 —
  // Ctrl+N 새 창에서 쓰기 시작하기 전에 목록 창이 정리해 버리면 새 창의 글이 닫혔다
  const mine = currentId && memos.find((m) => m.id === currentId);
  loadLocalData();
  if (mine && isBlankMemo(mine) && !memos.some((m) => m.id === mine.id) && !trash.some((t) => t.data && t.data.id === mine.id)) {
    memos.unshift(mine);
  }
  renderAll();
  updateSaveSyncTimes();
  if (!currentId) return;
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) { currentId = null; hideEditor(); return; } // 다른 창에서 이 글이 삭제됨
  // 이 창에서 직접 입력 중(창이 활성 + 입력칸 포커스)이면 본문을 덮어쓰지 않음(편집 손실 방지)
  const busyHere = document.hasFocus() && (document.activeElement === editor || document.activeElement === titleInput);
  if (!busyHere) {
    const content = lf(memo.content);
    if (editor.value !== content) {
      editor.value = content;
      // 다른 창에서 고친 내용이 들어왔다 — 그 전 되돌리기 기록으로 돌아가면 그 내용까지 지워진다
      undoStack = [];
      redoStack = [];
      undoGroupOpen = false;
    }
    if (titleInput.value !== memo.title) titleInput.value = memo.title;
    updateCharCount();
    updateFavButton(memo);
    updateFolderSelect(memo.folder);
    repaintOverlay(); // 다른 창에서 바뀐 형광펜 반영
  }
  updateMemoDates(memo);
  updatePopupTitle(memo);
}

// 새 창(글 쓰기 전용)은 창 제목을 글 제목으로 — 작업 표시줄에서 어느 글인지 보이게
function updatePopupTitle(memo) {
  if (!document.body.classList.contains('popup-mode') || !memo) return;
  document.title = ((memo.title || '').trim() || '새 글') + ' · Project Papers';
}

// ── Editor ──
function showEditor(memo) {
  editorToolbar.style.display = 'flex';
  editorContainer.style.display = 'flex';
  $('#char-count').style.display = 'flex';
  if (emptyState.style.display !== 'none') emptyScrollTop = recentScrollTop();   // 최근 글을 어디까지 내려 봤는지
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
  freshCheck = false;   // 받는 중 표시는 이 글을 연 쪽(loadMemoInEditor)에서 필요하면 다시 켠다
  applyViewerMode(!!memo.viewerMode);
  updateSyncIndicator();
  updatePopupTitle(memo);
  // 찾기/바꾸기 패널·더보기 닫기
  $('#find-replace-bar').style.display = 'none';
  document.querySelectorAll('.toolbar-extra').forEach((el) => el.classList.remove('toolbar-show'));
  $('#btn-toolbar-more').classList.remove('active');
  $('#toolbar-right').classList.remove('expanded');
  $('#toolbar-buttons').classList.remove('expanded');
  // 이전 글에서 쓰던 찾기 표시 초기화 후, 이 글의 형광펜을 오버레이에 그림
  searchKeyword = ''; searchCurrentPos = -1; findMatches = []; findIndex = -1; findAllMode = false;
  updateReplaceLabel();
  repaintOverlay();
  // 툴바가 접힌 채(본문을 내려 읽던 중) 새 글을 열어도 제목 칸이 보이게 펼친다 — 안 그러면 안 보이는 제목 칸에 글자가 써진다
  document.body.classList.remove('toolbar-hidden');
  lastEditorScrollTop = 0;
  updateConflictBar(memo);
  // 다시 열 때 이 글부터(휴대폰이 앱을 내려도) — 새 창은 따로 기억하지 않는다
  if (!document.body.classList.contains('popup-mode')) store.setItem('open_memo', memo.id);
  // 뒤로가기(모바일 제스처)가 앱을 끄지 않고 글을 먼저 닫게 한다
  layersChanged();
}

function hideEditor() {
  cleanupEmptyMemo();
  editorToolbar.style.display = 'none';
  editorContainer.style.display = 'none';
  $('#char-count').style.display = 'none';
  $('#find-replace-bar').style.display = 'none';
  $('#memo-dates').style.display = 'none';
  $('#conflict-bar').style.display = 'none';
  emptyState.style.display = 'flex';
  if (!document.body.classList.contains('popup-mode')) store.removeItem('open_memo');
  renderRecentList();
  setRecentScrollTop(emptyScrollTop);   // 글을 열기 전 보던 자리로
  // 삭제 등 다른 이유로 글이 닫히면 쌓아 둔 기록 칸도 거둬, 다음 뒤로가기가 헛돌지 않게 한다
  layersChanged();
}

// 제목·본문이 모두 비어 있고 특정 폴더에도 속하지 않은 메모만 '빈 메모'로 본다.
// 폴더를 지정했다면(미분류가 아닌 특정 폴더) 빈 메모여도 보존한다.
function isBlankMemo(m) {
  return !m.title.trim() && !m.content.trim() && !m.folder;
}

function cleanupEmptyMemo(keepId) {
  // 빈 메모를 모두 정리한다. 한 번도 올린 적 없는 빈 글은 그냥 지우고,
  // 예전에 내용이 있어 올렸던 글을 비운 것이면 휴지통에 넣는다(다른 기기에서도 지워지고, 복원도 된다).
  // keepId: 지금 막 열려는 글은 남긴다
  const blanks = memos.filter((m) => m.id !== keepId && isBlankMemo(m));
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

// 글 열기 — 기기에 있는 내용으로 바로 연다(통신을 기다리지 않는다).
// 예전엔 30초 지났으면 받기가 끝날 때까지 기다렸다 열어, 통신이 멎으면 글이 아예 안 열리고
// 느리면 기다리다 누른 다른 글이 몇 초 뒤 처음 글로 바뀌었다.
// 다른 기기에서 바뀌었을 수 있으면 받는 동안(최대 4초)만 고치지 못하게 두고, 받은 내용은 refreshOpenMemo 가 반영한다
// opts.restorePos: 쓰던 자리(커서·스크롤)로 / opts.query: 목록 검색어 — 본문에서 그 자리를 찾아 보여 준다
function loadMemoInEditor(memo, opts = {}) {
  // 빈 메모 정리를 먼저(지금 열 글은 빼고 — 폴더 없는 빈 새 글을 다시 누른 경우)
  cleanupEmptyMemo(memo.id);
  if (localSaveTimer) saveLocalData();
  memo = memos.find((m) => m.id === memo.id);
  if (!memo) return;
  offlineCopyId = null;
  currentId = memo.id;
  // 글을 열어도 사이드바 폴더 선택은 그대로 둔다 — '전체'에서 열면 전체 목록, 특정 폴더에서 열면 그 폴더 목록이 유지된다
  // (예전엔 글이 속한 폴더로 바뀌어, 전체 목록을 보다 글을 고르면 목록이 갑자기 그 폴더 글로 줄어들었다)
  showEditor(memo);
  renderMemoList();
  renderFolderList();
  if (opts.restorePos) restoreEditorPos(memo.id);
  if (opts.query) revealQuery(opts.query);
  if (!accessToken) return;
  if (needsFreshPull()) {
    // 받기 + 못 보낸 변경 올리기. 받는 동안은 잠깐 고치지 못하게(옛 내용 위에 쓰면 충돌본이 생긴다)
    setFreshCheck(true);
    const done = () => setFreshCheck(false);
    Promise.race([syncFromDropbox(), dbxSleep(4000)]).then(done, done);
  } else if (syncTimer || isDirty()) {
    // 글 전환 시 못 보낸 변경이 있으면 바로 보낸다
    syncToDropboxIfDirty().catch(onSyncError);
  }
}

// 다른 기기 변경을 받아 와야 하나 — 30초 안에 받았거나, Dropbox 변경 알림을 듣고 있으면(바뀌면 바로 받는다) 아니다
function needsFreshPull() {
  if (Date.now() - lastPullAt < 30000) return false;
  return !(typeof watchIsLive === 'function' && watchIsLive());
}

let freshCheck = false;   // 글을 연 직후 최신 내용을 받는 중 — 그동안은 고치지 못한다
function setFreshCheck(on) {
  freshCheck = on;
  applyEditable();
  updateSyncIndicator();
}
function applyEditable() {
  const ro = viewerMode || freshCheck;
  editor.readOnly = ro;
  titleInput.readOnly = ro;
}

// 쓰던 자리(커서·스크롤) 기억 — 앱이 내려갔다 다시 열리거나 새 버전으로 다시 열려도 그 자리로
function saveEditorPos() {
  if (!currentId || document.body.classList.contains('popup-mode')) return;
  store.setItem('open_pos', JSON.stringify({ id: currentId, s: editor.selectionStart, e: editor.selectionEnd, top: editor.scrollTop }));
}
function restoreEditorPos(id) {
  let p = null;
  try { p = JSON.parse(store.getItem('open_pos') || 'null'); } catch { /* 없음 */ }
  if (!p || p.id !== id) return;
  const n = editor.value.length;
  try { editor.setSelectionRange(Math.min(p.s || 0, n), Math.min(p.e || 0, n)); } catch { /* 무시 */ }
  editor.scrollTop = p.top || 0;
  $('#editor-highlight').scrollTop = editor.scrollTop;
  lastEditorScrollTop = editor.scrollTop;
}

let offlineCopyId = null; // 오프라인 복사본 추적

function updateFolderSelect(selectedFolder) {
  // 버튼 title에 현재 폴더 이름 표시
  const folder = selectedFolder ? folders.find((f) => f.id === selectedFolder) : null;
  const folderName = folder ? folder.name : '폴더 없음';
  const btn = $('#btn-folder-select');
  if (btn) btn.title = `폴더: ${folderName}`;

  // 드롭다운 리스트 생성
  let html = `<div class="folder-select-item ${!selectedFolder ? 'active' : ''}" data-folder="">-- 폴더 없음 --</div>`;
  for (const { f, depth } of folderTree(topFoldersInOrder())) {
    const cls = depth === 2 ? ' folder-select-item--child' : depth === 3 ? ' folder-select-item--grand' : '';
    html += `<div class="folder-select-item${cls} ${f.id === selectedFolder ? 'active' : ''}" data-folder="${f.id}">${depth > 1 ? '└ ' : ''}${escapeHtml(f.name)}</div>`;
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
  $('#folder-select-dropdown').style.display = 'none';
  if (!memo || (memo.folder || null) === folderId) return;
  setMemoFolder(memo, folderId);
  updateFolderSelect(folderId);
  scheduleAutoSave();
}

// 글의 폴더를 바꾼다. 폴더 지정도 '수정'이므로 updatedAt 을 갱신하고(안 하면 동기화 병합에서 되돌려지고
// 빈 메모로 여겨져 지워질 수 있다), 폴더를 바꾼 시각(folderAt)을 따로 적는다 — 다른 기기가 그사이 본문을 고쳐
// 그쪽 판이 남더라도 폴더는 늦게 바꾼 쪽을 따르게(mergeMemos)
function setMemoFolder(memo, folderId) {
  const now = Date.now();
  memo.folder = folderId || null;
  memo.folderAt = now;
  memo.updatedAt = now;
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

function onEditorInput(e) {
  let memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  // 글자가 실제로 안 바뀐 입력 신호(휴대폰 자판이 낱말을 다시 잡을 때 등)에는 '고친 시각'을 찍지 않는다
  if (editor.value === memo.content) return;
  // 오프라인 상태에서 편집 시 복사본 생성
  if (!accessToken && !offlineCopyId) {
    memo = createOfflineCopy(memo);
  }
  scheduleUndoSnapshot(memo, e);
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
  updatePopupTitle(memo);
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

// 올리기는 모아서 한다 — 한 번 올릴 때마다 파일 전체(0.9MB)가 나가므로, 쓰다가 잠깐 멈출 때마다 올리지 않는다.
//  · 손을 10초 놓으면 올린다. 단, 지난번에 올린 뒤 30초는 지나야 한다.
//  · 쉬지 않고 오래 쓰면(90초 넘게 못 보냄) 쉬지 않아도 올린다.
//  · 앱을 벗어날 때(flushSave)·다른 글을 열 때·PC 창을 떠날 때·Ctrl+S·동기화 단추는 기다리지 않고 바로 올린다.
// 기기 안 저장은 지금처럼 바로 하므로, 올리기가 늦어져도 글을 잃지 않는다.
// 글 단위 동기화는 한 번에 몇 KB 라 더 촘촘하게(3초 쉼, 10초 간격, 60초 최대 대기)
const SYNC_IDLE_MS = SPLIT_SYNC ? 3000 : 10000;
const SYNC_MIN_GAP_MS = SPLIT_SYNC ? 10000 : 30000;
const SYNC_MAX_WAIT_MS = SPLIT_SYNC ? 60000 : 90000;
let syncTimer = null;
let lastUploadAt = 0;     // 마지막으로 올린 시각
let pendingSince = 0;     // 아직 못 보낸 변경이 처음 생긴 시각
function scheduleSyncToDropbox() {
  if (!accessToken) return;
  const now = Date.now();
  if (!pendingSince) pendingSince = now;
  const readyAt = now - pendingSince >= SYNC_MAX_WAIT_MS ? now : now + SYNC_IDLE_MS;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runScheduledSync, Math.max(readyAt, lastUploadAt + SYNC_MIN_GAP_MS) - now);
}

async function runScheduledSync() {
  syncTimer = null;
  // 그사이 다른 길로 방금 올렸으면 간격을 채울 때까지 다시 기다린다
  const wait = lastUploadAt + SYNC_MIN_GAP_MS - Date.now();
  if (wait > 0) { syncTimer = setTimeout(runScheduledSync, wait); return; }
  if (!accessToken || !isDirty()) { settleSyncStatus('저장 완료'); return; }
  setSyncStatus('syncing', '저장 중...');
  try {
    await syncToDropboxIfDirty();
    settleSyncStatus('저장 완료');
  } catch (e) {
    onSyncError(e);
  }
}

// 지금 바로 올리되, 차례가 왔을 때 보낼 것이 남아 있을 때만 (앞서 줄 선 올리기가 이미 보냈으면 또 보내지 않는다)
function syncToDropboxIfDirty() {
  if (!accessToken) return Promise.resolve();
  clearTimeout(syncTimer);
  syncTimer = null;
  return queueSync(() => (isDirty() ? uploadNow() : undefined)).then(() => settleSyncStatus('저장 완료'));
}

// 앱을 닫거나 다른 화면으로 넘어갈 때: 현재 내용을 즉시 기기에 저장 + 대기 중인 클라우드 전송을 바로 실행
function flushSave() {
  // 본문·제목은 입력할 때마다 바로 글에 반영되므로 여기서 편집기 내용을 글에 옮겨 적지 않는다.
  // 예전엔 '편집기와 글이 다르면' 옮겨 적으며 고친 시각을 찍었는데, 동기화로 글이 바뀐 직후 편집기에
  // 남아 있던 옛 내용이 그렇게 '방금 고친 최신'으로 둔갑해 다른 기기의 새 내용을 덮었다.
  // 그래도 다르다면(정상이면 없는 일) 화면 내용을 잃지 않게 사본으로만 남기고 원본은 건드리지 않는다.
  if (currentId && !reloadingForUpdate) {
    const memo = memos.find((m) => m.id === currentId);
    if (memo && (lf(memo.content) !== editor.value || memo.title !== titleInput.value)) {
      memos.unshift(conflictCopy({ ...memo, content: editor.value, title: titleInput.value }));
      saveLocalData();
      refreshOpenMemo();
    }
  }
  if (localSaveTimer) saveLocalData();   // 모아 두던 기기 저장을 지금 끝낸다
  saveEditorPos();                       // 다시 열 때 쓰던 자리로
  // 아직 못 보낸 변경이 있으면 기다리지 않고 지금 바로 보낸다.
  // (예전에는 '대기 중인 전송'이 있을 때만 보내서, 타이핑 1.5초 안에 앱을 벗어나면 아무것도 안 갔다)
  // 새 버전으로 다시 여는 중이면 올리지 않는다 — 새 코드가 열리자마자 이어서 올린다
  if (accessToken && isDirty() && !reloadingForUpdate) syncToDropboxIfDirty().catch(onSyncError);
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
  applyEditable();
  editor.classList.toggle('viewer', on);
  $('#btn-viewer').classList.toggle('active', on);
}

// ── Undo / Redo (어절 단위) ──
let undoGroupOpen = false;     // 현재 타이핑 묶음이 열려 있는지
let undoGroupKind = 'insert';  // 지금 묶음이 쓰기인지 지우기인지
let undoIdleTimer = null;
// 어절 경계로 볼 문자: 공백·줄바꿈·구두점
const UNDO_WORD_BOUNDARY = /[\s.,!?;:'"()\[\]{}~…·，。！？；：、]/;

// e = 입력 신호(InputEvent). 경계는 '방금 친 글자'로 본다 — 예전엔 글 맨 끝 글자를 봐서, 글 끝이 마침표면
// 글 중간에서 쓸 때 한 글자(한글은 ㅎ·하·한 조합 단계마다)가 한 칸씩 쌓여 되돌리기 50칸이 금방 찼다
function scheduleUndoSnapshot(memo, e) {
  const before = memo.content;   // 이번 입력이 반영되기 전 내용
  const after = editor.value;    // 반영된 후 내용
  if (before === after) return;
  const type = (e && e.inputType) || '';
  const composing = !!(e && (e.isComposing || type === 'insertCompositionText'));   // 한글 조합 중
  const kind = type.startsWith('delete') ? 'delete' : 'insert';
  // 붙여넣기·끌어 놓기·자동 고침·프로그램이 넣은 것(구분선·날짜)은 그 하나로 한 덩어리
  const lump = !type || type === 'insertFromPaste' || type === 'insertFromDrop' || type === 'insertReplacementText';
  // 쓰다가 지우기로(또는 그 반대로) 넘어가면 새 묶음
  if (undoGroupOpen && (lump || (kind !== undoGroupKind && !composing))) undoGroupOpen = false;

  // 새 어절 묶음의 시작: '입력 전 상태'를 한 번만 저장
  if (!undoGroupOpen) {
    if (undoStack.length === 0 || undoStack[undoStack.length - 1] !== before) {
      undoStack.push(before);
      if (undoStack.length > UNDO_MAX) undoStack.shift();
    }
    redoStack = []; // 새 입력 시 되살리기 이력 초기화
    undoGroupOpen = true;
    undoGroupKind = kind;
  }

  if (lump) undoGroupOpen = false;
  else if (!composing && kind === 'insert') {
    // 어절 경계(공백·구두점·줄바꿈)를 입력하면 묶음을 끊어 다음 글자가 새 묶음이 되게 함
    const ch = e && typeof e.data === 'string' && e.data ? e.data.slice(-1)
      : (type === 'insertLineBreak' || type === 'insertParagraph') ? '\n'
      : after.charAt(editor.selectionStart - 1);
    if (UNDO_WORD_BOUNDARY.test(ch)) undoGroupOpen = false;
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
  const el = $('#char-count-n');
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
          <li><kbd>Ctrl</kbd>+<kbd>N</kbd> 새 창에서 새 글</li>
          <li><kbd>Ctrl</kbd>+<kbd>F</kbd> 찾기·바꾸기</li>
          <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> 되돌리기 · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> 되살리기</li>
          <li><kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> 구분선 ------ · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> 구분선 ======</li>
          <li><kbd>Alt</kbd>+<kbd>;</kbd> 날짜 입력 · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>;</kbd> 날짜+시간 입력</li>
          <li><kbd>Alt</kbd>+<kbd>H</kbd> 선택 부분 형광펜(하이라이트) 켜기/끄기</li>
          <li><kbd>Esc</kbd> 찾기 창·대화상자 닫기</li>
        </ul>
        <p class="help-h">🗂️ 폴더·정리</p>
        <ul>
          <li>${ico('folder')} 현재 글을 폴더에 지정 — 빈 글도 폴더를 정하면 사라지지 않습니다</li>
          <li><b>폴더 관리</b> — 폴더를 우클릭(휴대폰은 길게 누르기)하거나 폴더 목록 아래 '폴더 관리'. 순서·이름·옮기기·휴면(메모 달기)·비밀번호·삭제를 한 화면에서. 체크박스로 여러 개를 한꺼번에. 폴더는 3단계까지</li>
          <li>${ico('more')} 더보기에서 형광펜(${ico('marker')})·되살리기(${ico('redo')})·공유(${ico('share')})·즐겨찾기(${ico('star')})·삭제(${ico('trash')})</li>
          <li>${ico('select')} 선택 모드로 여러 글을 한 번에 이동·삭제</li>
        </ul>
        <p class="help-h">📝 작성·보기</p>
        <ul>
          <li>${ico('template')} 템플릿 저장·불러오기 · ${ico('copy')} 본문만 복사 · ${ico('book')} 읽기 전용 보기</li>
          <li>형광펜(<kbd>Alt</kbd>+<kbd>H</kbd>, 휴대폰은 더보기의 ${ico('marker')})은 앱 안에서만 보이는 표시예요 — 복사·붙여넣기하면 순수 글자만 오갑니다</li>
          <li>글 목록에서 <b>더블클릭</b>하면 새 창으로 열립니다</li>
          <li>${ico('type')} 화면 설정 — 어두운 화면(밝게·어둡게·기기 설정 따름)과 글자 크기(모든 글 공통). 더보기 또는 목록 아래 '화면'</li>
        </ul>
        <p class="help-h">💾 저장·백업·보안</p>
        <ul>
          <li>입력하면 자동 저장·자동 동기화 (최근 시각은 왼쪽 위에 표시)</li>
          <li>${ico('save')} 수동 백업 · 매일 자동 백업 · ${ico('trash')} 휴지통에서 복원</li>
          <li>폴더에 비밀번호 설정 가능 (Master로 전체 해제)</li>
        </ul>
      </div>
      <p class="help-ver">판 ${APP_VERSION}</p>
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
    // 본문에서 고른(블록) 낱말이 있으면 그것을 찾기 칸에 넣어 둔다
    const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    const fi = $('#find-input');
    fi.value = sel && sel.length <= 100 && !sel.includes('\n') ? sel : '';
    $('#replace-input').value = '';
    $('#find-count').textContent = '';
    findMatches = [];
    findIndex = -1;
    findAllMode = false;
    updateReplaceLabel();
    clearHighlight();
    fi.focus();
    fi.select();
    if (fi.value) findCountOnly();
  } else {
    clearHighlight();
  }
}

// '모두'를 누른 상태에서 '바꾸기'는 전부 바꾼다 — 단추 이름으로 알린다(예전엔 같은 이름이라 한 건만 바꾸려다 전부 바뀌었다)
function updateReplaceLabel() {
  const b = $('#replace-one');
  if (b) b.textContent = findAllMode ? '모두 바꾸기' : '바꾸기';
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

// Alt+H(또는 더보기의 형광펜 단추): 선택 영역 형광펜 켜기/끄기 (이미 전부 칠해져 있으면 지움)
// fromButton: 단추로 눌렀다 — 본문에 포커스가 없어도 마지막으로 고른 부분에 칠한다(휴대폰엔 Alt 가 없다)
function toggleHighlight(fromButton) {
  if (viewerMode) { if (fromButton) showToast('읽기 전용 보기입니다'); return; }
  const focused = document.activeElement === editor;
  if (!focused && !fromButton) return;
  const memo = memos.find((m) => m.id === currentId);
  if (!memo) return;
  const start = editor.selectionStart, end = editor.selectionEnd;
  if (start === end) { showToast('형광펜을 칠할 부분을 먼저 선택하세요'); return; }
  const cur = memo.highlights || [];
  const off = isRangeFullyHighlighted(cur, start, end);
  memo.highlights = off ? removeHighlightRange(cur, start, end) : addHighlightRange(cur, start, end);
  memo.updatedAt = Date.now();
  repaintOverlay();
  saveLocalData();
  scheduleRenderAndSync();
  // 선택(블록) 해제 — 커서만 칠한 부분 끝으로. 단추로 칠했고 본문에 포커스가 없었으면 자판을 띄우지 않는다
  if (focused) editor.focus();
  editor.setSelectionRange(end, end);
  if (fromButton) showToast(off ? '형광펜을 지웠습니다' : '형광펜을 칠했습니다');
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
  updateReplaceLabel();
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
  if (findMatches.length === 0) { findAllMode = false; updateReplaceLabel(); clearHighlight(); return; }
  updateReplaceLabel();
  updateHighlight($('#find-input').value);
  $('#find-count').textContent = findMatches.length + '건 전체';
  showToast(findMatches.length + '건 찾음');
}

// 목록 검색어로 글을 열면 본문에서 그 자리를 찾아 보여 준다(찾기 창에 검색어를 넣고 첫 자리로).
// 자판이 뜨지 않게 찾기 칸에 포커스는 주지 않는다
function revealQuery(q) {
  if (!q || !editor.value.toLowerCase().includes(q.toLowerCase())) return;
  $('#find-replace-bar').style.display = 'flex';
  $('#find-input').value = q;
  $('#replace-input').value = '';
  findAllMode = false;
  updateReplaceLabel();
  findCountOnly();
  if (findMatches.length) findNavigate(1);
}

function findNavigate(dir) {
  if (findMatches.length === 0) return;
  findAllMode = false;
  updateReplaceLabel();
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
    if ((memo.folder || null) !== (targetFolder || null)) setMemoFolder(memo, targetFolder);
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
    // 바꿀 말을 글자 그대로 넣는다 — 문자열로 넘기면 $& · $' · $$ 같은 기호가 다른 글자로 바뀐다
    editor.value = editor.value.replace(regex, () => replacement);
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
    updateReplaceLabel();
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
    // 바꾼 자리 바로 다음 결과로 간다(끝까지 갔으면 처음으로). 예전엔 재검색 뒤 맨 마지막 결과로 튀었다
    if (findMatches.length > 0) {
      const from = pos + replacement.length;
      const i = findMatches.findIndex((p) => p >= from);
      findIndex = (i < 0 ? 0 : i) - 1;
      findNavigate(1);
    } else {
      clearHighlight();
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
    for (const { f, depth } of folderTree(folders.filter((x) => !x.parentId && !x.dormant).sort(sortBySortOrder))) {
      opts += '<option value="' + f.id + '">' + '\u3000'.repeat(depth - 1) + escapeHtml(f.name) + '</option>';
    }
    overlay.innerHTML = '<div class="modal-box"><p>' + selectedMemos.size + '개 메모를 이동할 폴더를 선택하세요</p><select style="width:100%;padding:8px;margin-bottom:16px;border:1px solid var(--border);border-radius:var(--radius);font-size:0.9rem;">' + opts + '</select><div><button class="btn btn-primary" id="bm-ok">이동</button> <button class="btn btn-secondary" id="bm-cancel">취소</button></div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector('#bm-cancel').onclick = () => overlay.remove();
    overlay.querySelector('#bm-ok').onclick = () => {
      const folder = overlay.querySelector('select').value || null;
      for (const id of selectedMemos) {
        const m = memos.find((x) => x.id === id);
        if (m && (m.folder || null) !== folder) setMemoFolder(m, folder);
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
    // 폴더 이동 — 폴더 관리 화면과 같은 대화상자
    showMoveFoldersDialog([...selectedFolders], () => { selectedFolders.clear(); renderAll(); });
  }
}

// ── Render ──
function renderAll() {
  renderFolderList();
  renderMemoList();
  if (fm) renderFolderManager();
  if (trashView) trashView.renderList();   // 휴지통 창이 열려 있으면 바뀐 목록으로
  renderRecentList();
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
  saveUiPrefs();
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

function renderFolderItem(f, depth) {
  const count = getFolderMemoCount(f.id);
  const lockIcon = f.password ? ico(unlockedFolders.has(f.id) ? 'unlock' : 'lock') : '';
  const childClass = depth === 2 ? ' folder-item--child' : depth >= 3 ? ' folder-item--grand' : '';
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
  for (const { f, depth } of folderTree(folders.filter((x) => !x.parentId && !x.dormant).sort(sortBySortOrder))) {
    html += renderFolderItem(f, depth);
  }

  const noFolderCount = memos.filter((m) => !m.folder && isVisibleMemo(m)).length;
  if (folders.length > 0) {
    html += `<div class="folder-item ${currentFolder === '__none__' ? 'active' : ''}" data-folder="__none__">
      <span class="folder-item-name">미분류 <span class="folder-count">(${noFolderCount})</span></span>
    </div>`;
  }

  // 휴면 폴더 섹션
  const groups = dormantGroups();
  if (groups.length > 0) {
    const dormantMemoCount = memos.filter((m) => dormantIds.has(m.folder) && isVisibleMemo(m)).length;
    html += `<div class="folder-dormant-toggle" id="dormant-toggle">
      <span>${ico('moon')} 휴면 폴더 <span class="folder-count">(${dormantMemoCount})</span></span>
      <span class="dormant-arrow">▶</span>
    </div>`;
    html += `<div class="folder-dormant-list" id="dormant-list" style="display:none;">`;
    // 휴면 메모가 같은 폴더끼리 묶어, 묶음마다 메모를 이름표로 단다
    for (const g of groups) {
      if (g.note || groups.length > 1) {
        html += `<div class="folder-dormant-group">${ico('tag')}<span>${g.note ? escapeHtml(g.note) : '휴면 메모 없음'}</span></div>`;
      }
      for (const { f, depth } of folderTree(g.tops)) html += renderFolderItem(f, depth);
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
            saveUiPrefs();
            renderAll();
            if (!selectMode) $('#folder-dropdown').style.display = 'none';
          });
          return;
        }
        currentFolder = val;
      }
      saveUiPrefs();
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
    const ids = new Set([currentFolder, ...getDescendantIds(currentFolder)]);
    filtered = filtered.filter((m) => ids.has(m.folder));
  } else {
    // 전체 보기: 잠긴 폴더 + 휴면 폴더의 글 숨기기
    const dormantIds = getDormantFolderIds();
    filtered = filtered.filter((m) => !lockedIds.includes(m.folder) && !dormantIds.has(m.folder));
  }

  if (favFilterActive) {
    filtered = filtered.filter((m) => m.favorite);
  }

  const hit = (m) => (m.title || '').toLowerCase().includes(query) || (m.content || '').toLowerCase().includes(query);
  if (query) filtered = filtered.filter(hit);

  // 정렬
  const sortList = (list) => {
    if (memoSortKey === 'title') list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ko'));
    else if (memoSortKey === 'createdAt') list.sort((a, b) => b.createdAt - a.createdAt);
    else list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  };
  sortList(filtered);

  // '전체'에서 찾을 때는 휴면 폴더 글도 따로 모아 아래에 보여 준다(잠긴 폴더 글은 보이지 않는다).
  // 예전엔 휴면 폴더 글이 검색에 아예 안 나와, 있는 글을 못 찾았다
  let dormantHits = [];
  if (query && currentFolder === null) {
    const dormantIds = getDormantFolderIds();
    dormantHits = sortList(memos.filter((m) => dormantIds.has(m.folder) && !lockedIds.includes(m.folder) &&
      !isBlankMemo(m) && hit(m) && (!favFilterActive || m.favorite)));
  }

  // 폴더 보기일 때(전체 보기가 아닐 때) 즐겨찾기 상단 고정
  if (currentFolder !== null && !query) {
    const favs = filtered.filter((m) => m.favorite);
    const normals = filtered.filter((m) => !m.favorite);
    // 즐겨찾기끼리는 최근 즐겨찾기 지정순
    favs.sort((a, b) => (b.favoritedAt || 0) - (a.favoritedAt || 0));
    filtered = [...favs, ...normals];
  }

  const itemHtml = (m, extraCls = '') => {
    const title = m.title || formatCreatedAt(m.createdAt) + ' 새 글';
    const date = formatDate(m.updatedAt);
    const active = m.id === currentId ? 'active' : '';
    const favIcon = m.favorite ? '<span class="memo-item-fav">★</span>' : '';
    const checkbox = selectMode ? '<input type="checkbox" class="memo-item-checkbox" data-check="' + m.id + '"' + (selectedMemos.has(m.id) ? ' checked' : '') + '>' : '';
    // 검색어가 본문에 있으면 찾은 자리 둘레를 한 줄로
    const snip = query ? searchSnippet(m, query) : '';
    return `
        <div class="memo-item ${active}${extraCls}" data-id="${m.id}">
          ${checkbox}
          ${favIcon}
          <div class="memo-item-info">
            <div class="memo-item-title">${escapeHtml(title)}</div>
            ${snip ? `<div class="memo-item-snippet">${snip}</div>` : ''}
          </div>
          <div class="memo-item-date">${date}</div>
        </div>
      `;
  };
  memoList.innerHTML = filtered.map((m) => itemHtml(m)).join('') +
    (dormantHits.length ? `<div class="memo-list-divider">${ico('moon')}<span>휴면 폴더에서 찾은 글 ${dormantHits.length}</span></div>` +
      dormantHits.map((m) => itemHtml(m, ' dormant-hit')).join('') : '') +
    (query && !filtered.length && !dormantHits.length ? '<div class="memo-list-empty">찾는 글이 없습니다</div>' : '');

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
      const open = () => {
        const memo = memos.find((m) => m.id === el.dataset.id);
        // 검색해서 연 글이면 본문에서 찾은 자리를 보여 준다
        if (memo) loadMemoInEditor(memo, { query: searchBox.value.trim() });
        $('#sidebar').classList.remove('open');
      };
      // 손가락으로 누르면 바로 연다 — 0.25초 기다림은 마우스 더블클릭(새 창)과 가르려는 것이라 휴대폰엔 필요 없다
      const touch = e.pointerType ? e.pointerType !== 'mouse' : matchMedia('(pointer: coarse)').matches;
      if (touch) { open(); return; }
      if (clickTimer) return;
      clickTimer = setTimeout(() => { clickTimer = null; open(); }, 250);
    });
    el.addEventListener('dblclick', () => {
      if (selectMode) return;
      clearTimeout(clickTimer);
      clickTimer = null;
      const id = el.dataset.id;
      window.open(location.pathname + '?memo=' + id + MODE_QUERY, '_blank', 'width=400,height=700');
    });
  });
}

// 검색어가 본문에 있으면 그 둘레 한 줄(찾은 말은 굵게) — 목록에서 어느 대목이 걸렸는지 보이게
function searchSnippet(m, q) {
  const c = m.content || '';
  const i = c.toLowerCase().indexOf(q);
  if (i < 0) return '';
  const from = Math.max(0, i - 16);
  const to = Math.min(c.length, i + q.length + 40);
  const clean = (x) => escapeHtml(x.replace(/\s+/g, ' '));
  return (from > 0 ? '…' : '') + clean(c.slice(from, i)) + '<b>' + clean(c.slice(i, i + q.length)) + '</b>' +
    clean(c.slice(i + q.length, to)) + (to < c.length ? '…' : '');
}

// 빈 화면(There you are) 아래 최근 글 — 휴대폰에서 앱을 열면 목록을 열지 않고도 바로 고를 수 있게(넓은 화면에선 숨김)
// 최근 수정한 순으로 전부(잠긴·휴면 폴더 글은 빼고) — 첫 화면은 그대로 두고 최근 글 상자 안에서만 굴려 옛 글까지 본다.
// 바뀐 게 없으면 다시 그리지 않고, 다시 그려도 굴려 둔 자리는 그대로
function renderRecentList() {
  const box = document.getElementById('recent-list');
  if (!box) return;
  const put = (html) => {
    if (box._html === html) return;
    const top = recentScrollTop();
    box.innerHTML = html; box._html = html;
    setRecentScrollTop(top);
  };
  if (emptyState.style.display === 'none' || !memos.length) { put(''); return; }
  const hidden = new Set([...getLockedFolderIds(), ...getDormantFolderIds()]);
  const recent = memos.filter((m) => !isBlankMemo(m) && !hidden.has(m.folder))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (!recent.length) { put(''); return; }
  put('<div class="recent-head">최근 글</div><div class="recent-scroll">' + recent.map((m) =>
    `<button class="recent-item" type="button" data-id="${m.id}"><span class="recent-title">${escapeHtml(m.title || formatCreatedAt(m.createdAt) + ' 새 글')}</span><span class="recent-date">${formatDate(m.updatedAt)}</span></button>`).join('') +
    '</div><button class="recent-all" type="button">모든 글 보기</button>');
}
// 최근 글 상자를 굴려 둔 자리 — 글을 열었다 돌아오면 보던 자리로
let emptyScrollTop = 0;
function recentScrollTop() {
  const sc = document.querySelector('#recent-list .recent-scroll');
  return sc ? sc.scrollTop : 0;
}
function setRecentScrollTop(top) {
  const sc = document.querySelector('#recent-list .recent-scroll');
  if (sc) sc.scrollTop = top;
}

// ── UI Helpers ──
function showApp() {
  // 시범 운전 표시 — 진짜 메모와 헷갈리지 않게
  if (PILOT && !$('#pilot-badge')) {
    const b = document.createElement('span');
    b.id = 'pilot-badge';
    b.textContent = '시범 운전';
    b.title = '새 동기화 방식 시험 중 — 진짜 메모와 따로 저장됩니다';
    const h1 = $('#sidebar-header h1');
    h1.insertBefore(b, h1.querySelector('span'));
    document.title = 'Project Papers (시범 운전)';
  }
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
  updateSyncIndicator();
}

let toastTimer = null;
// opts: { action: '단추 글', onAction: 누르면 할 일, duration: 보이는 시간(ms) } — 없으면 예전처럼 글만 잠깐
function showToast(msg, opts) {
  toast.textContent = msg;
  const action = opts && opts.action;
  toast.classList.toggle('has-action', !!action);
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action;
    b.addEventListener('click', () => { toast.classList.remove('show'); opts.onAction(); });
    toast.appendChild(b);
  }
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), (opts && opts.duration) || 2500);
}

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  }
  // 올해가 아닌 글은 연도도 붙인다(예전엔 '3월 5일'만 보여 작년 글과 헷갈렸다)
  if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
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

// 화면에 넣을 글자 — 속성(value="…" 등)에 넣어도 깨지지 않게 따옴표까지 바꾼다
// (예전엔 따옴표를 그대로 둬, '특집 "A" 기획' 폴더 이름이 이름 바꾸기 칸에 '특집'으로 잘려 나왔다)
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Cloudflare 잠금(Access) 로그인 만료 ──
// 로그인이 만료되면 앱은 기기에 저장해 둔 사본으로 열리지만 새 버전을 못 받는다 — 알리고 다시 로그인하게 한다.
// 잠금이 없는 곳(GitHub Pages)에서는 sw.js 가 그대로 받아지므로 아무 일도 없다
let loginAsked = false;
function loginExpired() {
  if (!navigator.onLine) return Promise.resolve(false);   // 통신이 안 되면 묻지 않는다(콘솔에 오류만 남는다)
  return fetch('sw.js', { cache: 'no-store', redirect: 'manual' }).then((res) => res.type === 'opaqueredirect').catch(() => false);
}
async function checkLogin() {
  if (!(await loginExpired())) return false;
  if (!loginAsked) {   // 한 번 열 때 한 번만
    loginAsked = true;
    showToast('로그인이 만료되어 새 버전을 받지 못합니다.', { action: '다시 로그인', onAction: () => location.assign('./?login=1'), duration: 15000 });
  }
  return true;
}

// ── Service Worker ──
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  checkLogin();
  // 새 버전이 깔리면 쓰던 글을 기기에 저장하고 새 코드로 다시 연다.
  // 휴대폰은 앱을 닫지 않고 오래 띄워 두므로, 배포 뒤에도 옛 코드가 바뀐 동기화 규칙을 모른 채 계속 저장을 올린다
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloadingForUpdate) return;   // 처음 설치될 때는 다시 열 필요 없음
    reloadingForUpdate = true;
    if (localSaveTimer) saveLocalData();
    saveEditorPos();   // 다시 열면 쓰던 자리(커서·스크롤)로
    if (currentId) sessionStorage.setItem('reopen_memo', currentId);
    location.reload();
  });
}

// 새 버전이 나왔는지 확인 (앱으로 돌아올 때마다). 있으면 설치 → controllerchange → 다시 열기
// 그 전에 잠금 로그인이 만료됐는지 본다(만료면 받을 수 없으니 안내만)
function checkForUpdate() {
  if (!('serviceWorker' in navigator)) return;
  checkLogin().then((expired) => {
    if (!expired) navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
  });
}
