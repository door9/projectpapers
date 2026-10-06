// ── 글 단위 동기화 ──
// Dropbox <뿌리>/sync/ 아래에 글 한 편 = 파일 하나로 둔다.
//   meta.json               폴더·템플릿·영구삭제 기록·Master
//   notes/<글id>.json        글
//   trash/<종류>-<id>.json   휴지통 항목(글·폴더)
// 받기: '지난번 이후 바뀐 파일 목록'(list_folder 커서)만 묻고, 바뀐 파일만 받는다.
// 올리기: 지난 동기화 때 모습(지문)과 달라진 파일만, 그 파일의 Dropbox 버전 위에만 덮어쓴다 → 충돌도 글 단위로 가린다.
// 합치기 규칙(계보·충돌본·휴지통 시각 비교)은 한 파일 시절 것을 그대로 쓴다.
// app.js 의 pullAndMerge·uploadNow 가 SPLIT_SYNC 일 때 이쪽(splitPull·splitPush)을 부른다.

const SPLIT_DIR = DBX_ROOT + '/sync';
const SPLIT_DATA_VERSION = 4;

// ── 파일 열쇠: 'meta' | 'n:<글id>' | 't:<종류>:<id>' ──
function splitPath(key) {
  if (key === 'meta') return SPLIT_DIR + '/meta.json';
  if (key.startsWith('n:')) return SPLIT_DIR + '/notes/' + key.slice(2) + '.json';
  const m = key.match(/^t:([^:]+):(.+)$/);
  return SPLIT_DIR + '/trash/' + m[1] + '-' + m[2] + '.json';
}

// Dropbox 경로(또는 압축 파일 안 이름) → 열쇠. sync/ 밖이거나 모르는 파일이면 null
function splitKeyOf(path) {
  const i = path.toLowerCase().lastIndexOf('/sync/');
  if (i < 0) return null;
  const rel = path.slice(i + 6);
  if (rel.toLowerCase() === 'meta.json') return 'meta';
  let m = rel.match(/^notes\/([^/]+)\.json$/i);
  if (m) return 'n:' + m[1];
  m = rel.match(/^trash\/(memo|folder)-([^/]+)\.json$/i);
  if (m) return 't:' + m[1].toLowerCase() + ':' + m[2];
  return null;
}

// 열쇠 순서와 상관없이 같은 내용이면 같은 글자열(→ 같은 지문)
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

// 이 기기가 아는 원격 상태: revs = 파일마다 Dropbox 버전, base = 그 내용의 지문
function splitJSON(k) { try { return JSON.parse(store.getItem(k) || '{}'); } catch { return {}; } }
function splitState() { return { revs: splitJSON('split_revs'), base: splitJSON('split_base') }; }
function saveSplitState(st) {
  store.setItem('split_revs', JSON.stringify(st.revs));
  store.setItem('split_base', JSON.stringify(st.base));
}

// 목록은 id 순으로 — 기기마다 배열 순서가 달라도 같은 내용이면 같은 파일이 되게(괜히 서로 다시 올리지 않게)
const byId = (arr, idOf = (x) => x.id) => [...arr].sort((a, b) => String(idOf(a)).localeCompare(String(idOf(b))));
function splitMeta() {
  const o = {
    folders: byId(folders),
    templates: byId(templates),
    deletedIds: byId(deletedIds, (d) => d.id || d),
    masterPasswordAt: masterPasswordAt || 0,
    dataVersion: SPLIT_DATA_VERSION,
  };
  // 옛 한 파일을 얼렸다는 표시 — 다른 기기가 처음 맞출 때 옛 파일(0.8MB)을 받아 확인하지 않아도 되게
  const frozenAt = Number(store.getItem('split_frozen_at')) || 0;
  if (frozenAt) o.legacyFrozenAt = frozenAt;
  if (masterPasswordHash) o.masterPassword = masterPasswordHash;
  return o;
}

// 원격이 이래야 한다 — 열쇠 → 파일 내용
function splitWanted() {
  const want = new Map();
  want.set('meta', canon(splitMeta()));
  for (const t of trash) if (t && t.data && t.data.id) want.set('t:' + t.type + ':' + t.data.id, canon(t));
  for (const m of syncableMemos()) want.set('n:' + m.id, canon(m));
  return want;
}

const isPermDeleted = (id) => deletedIds.some((d) => (d.id || d) === id);

// ── Dropbox 호출 ──
// 401 → 토큰 갱신 한 번, 429 → 잠깐 쉬고 다시. 409(충돌·없음)는 부른 쪽에서 본다
async function dbxFetch(url, init, attempt = 0, retried = false) {
  const res = await fetch(url, {
    method: 'POST',
    body: init.body,
    headers: { 'Authorization': 'Bearer ' + accessToken, ...init.headers },
  });
  if (res.status === 401) {
    if (!retried && await refreshAccessToken()) return dbxFetch(url, init, attempt, true);
    showToast('Dropbox 인증 만료. 다시 로그인해주세요.');
    logout();
    throw new Error('auth expired');
  }
  if (res.status === 429 && attempt < DBX_MAX_RETRY) {
    await dbxSleep(dbxRetryDelay(res, attempt));
    return dbxFetch(url, init, attempt + 1, retried);
  }
  return res;
}

// Dropbox-API-Arg 머리글은 ASCII 만 된다
const dbxArg = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

async function dbxRpc(endpoint, arg) {
  const res = await dbxFetch('https://api.dropboxapi.com/2/' + endpoint, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(arg),
  });
  let data = null;
  try { data = await res.json(); } catch { /* 본문 없음 */ }
  return { status: res.status, ok: res.ok, data };
}

// 올리기. mode: 'add'(새로) | { '.tag': 'update', update: rev }(그 버전 위에만). 충돌이면 { conflict: true }
async function dbxPut(path, body, mode) {
  const res = await dbxFetch('https://content.dropboxapi.com/2/files/upload', {
    headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': dbxArg({ path, mode, autorename: false, mute: true }) },
    body,
  });
  if (res.status === 409) return { conflict: true };
  if (!res.ok) throw new Error('upload failed: ' + res.status);
  const meta = await res.json();
  return { rev: meta.rev };
}

// 받기 → { text, rev }, 없으면 null
async function dbxGet(path) {
  const res = await dbxFetch('https://content.dropboxapi.com/2/files/download', {
    headers: { 'Dropbox-API-Arg': dbxArg({ path }) },
  });
  if (res.status === 409) return null;
  if (!res.ok) throw new Error('download failed: ' + res.status);
  let rev = null;
  try { rev = JSON.parse(res.headers.get('dropbox-api-result')).rev; } catch { /* 머리글 없음 */ }
  return { text: await res.text(), rev };
}

// sync/ 의 바뀐 파일 목록. 커서가 없거나 무효(reset)면 처음부터 전체 목록(full)
async function splitList() {
  const cursor = store.getItem('split_cursor');
  let r = null;
  let full = false;
  if (cursor) {
    r = await dbxRpc('files/list_folder/continue', { cursor });
    if (r.status === 409) r = null;
    else if (!r.ok) throw new Error('list failed: ' + r.status);
  }
  if (!r) {
    full = true;
    r = await dbxRpc('files/list_folder', { path: SPLIT_DIR, recursive: true });
    if (r.status === 409) return { missing: true, full, entries: [], cursor: null };
    if (!r.ok) throw new Error('list failed: ' + r.status);
  }
  const entries = [...r.data.entries];
  let d = r.data;
  while (d.has_more) {
    const n = await dbxRpc('files/list_folder/continue', { cursor: d.cursor });
    if (!n.ok) throw new Error('list failed: ' + n.status);
    d = n.data;
    entries.push(...d.entries);
  }
  return { missing: false, full, entries, cursor: d.cursor };
}

// 압축 파일(zip)에서 글자 파일들을 꺼낸다 → Map(이름 → 글자열). 중앙 목록만 믿는다(로컬 머리의 크기는 0 일 수 있음)
async function unzipText(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let e = buf.byteLength - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('zip: 끝 표시 없음');
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64 는 못 읽음');
  const dec = new TextDecoder();
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip: 목록 깨짐');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const data = u8.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else throw new Error('zip: 압축 방식 ' + method);
    out.set(name, dec.decode(bytes));
  }
  return out;
}

// 여러 파일 받기 → Map(열쇠 → { text, rev }). 처음(전체 목록)이고 많으면 폴더를 압축 파일 하나로 — 안 되면 하나씩
async function splitFetchFiles(keys, full) {
  const out = new Map();
  const want = new Set(keys);
  if (full && keys.length > 20 && typeof DecompressionStream !== 'undefined') {
    try {
      const res = await dbxFetch('https://content.dropboxapi.com/2/files/download_zip', {
        headers: { 'Dropbox-API-Arg': dbxArg({ path: SPLIT_DIR }) },
      });
      if (res.ok) {
        for (const [name, text] of await unzipText(await res.arrayBuffer())) {
          const k = splitKeyOf('/' + name);
          if (k && want.has(k)) out.set(k, { text, rev: null });
        }
      }
    } catch (e) {
      console.warn('압축 받기 실패 — 하나씩 받습니다', e);
    }
  }
  const rest = keys.filter((k) => !out.has(k));
  for (let i = 0; i < rest.length; i += 4) {
    const part = await Promise.all(rest.slice(i, i + 4).map((k) => dbxGet(splitPath(k)).then((r) => [k, r])));
    for (const [k, r] of part) if (r) out.set(k, r);
  }
  return out;
}

// ── 받기 ──
// 받아 합친다(올리지는 않는다). 원격에 아무것도 없으면(sync/ 도 옛 파일도) true
async function splitPull() {
  lastPullAt = Date.now();
  if (store.getItem('split_ready') !== '1') return splitFirstSync();
  const L = await splitList();
  if (L.missing) {
    // sync/ 가 통째로 사라졌다 — 처음처럼 다시 맞춘다(이 기기 내용을 올린다)
    store.removeItem('split_ready');
    return splitFirstSync();
  }
  await splitApply(L);
  return false;
}

// 목록에 나온 변경을 이 기기에 반영
async function splitApply(L) {
  const st = splitState();
  const latest = new Map();   // 열쇠 → 마지막 상태(rev, 지워졌으면 null)
  // 지워진 항목은 경로가 소문자로만 올 수 있다 → 알던 열쇠와 대소문자 없이 맞춘다
  const known = new Map(Object.keys(st.revs).map((k) => [k.toLowerCase(), k]));
  for (const e of L.entries) {
    let k = splitKeyOf(e.path_display || e.path_lower || '');
    if (!k) continue;
    k = known.get(k.toLowerCase()) || k;
    if (e['.tag'] === 'file') latest.set(k, e.rev);
    else if (e['.tag'] === 'deleted') latest.set(k, null);
  }
  // 전체 목록이면, 알던 파일 중 목록에 없는 것은 원격에서 사라진 것
  if (L.full) for (const k of Object.keys(st.revs)) if (!latest.has(k)) latest.set(k, null);
  const need = [...latest].filter(([k, rev]) => rev && st.revs[k] !== rev).map(([k]) => k);
  if (need.length > 20) setSyncStatus('syncing', `받는 중 (${need.length})`);
  const got = need.length ? await splitFetchFiles(need, L.full) : new Map();
  const take = (k) => {
    const g = got.get(k);
    if (!g) return null;
    let obj;
    try { obj = JSON.parse(g.text); } catch { return null; }
    st.revs[k] = g.rev || latest.get(k);
    st.base[k] = textHash(g.text);   // 원격에 있는 그 내용의 지문
    return obj;
  };

  // 1) meta — 폴더·템플릿·영구삭제 기록·Master
  const meta = take('meta');
  if (meta) {
    if ((meta.dataVersion || 0) > SPLIT_DATA_VERSION) markOutdated();
    if (Array.isArray(meta.deletedIds)) deletedIds = mergeDeletedIds(deletedIds, meta.deletedIds);
    if (Array.isArray(meta.folders)) {
      retireGoneItems({ folders: meta.folders });   // 다른 기기에서 지운 폴더
      folders = mergeFolders(folders, meta.folders);
    }
    if (Array.isArray(meta.templates)) templates = mergeTemplates(templates, meta.templates);
    if (meta.legacyFrozenAt && meta.legacyFrozenAt > (Number(store.getItem('split_frozen_at')) || 0)) {
      store.setItem('split_frozen_at', String(meta.legacyFrozenAt));
      store.setItem('split_frozen', '1');
    }
    const rAt = meta.masterPasswordAt || 0;
    if (rAt > masterPasswordAt || (rAt === masterPasswordAt && !masterPasswordHash && meta.masterPassword)) {
      masterPasswordHash = meta.masterPassword || null;
      masterPasswordAt = rAt;
    }
  }
  // 2) 휴지통
  const remoteTrash = need.filter((k) => k.startsWith('t:')).map(take).filter((t) => t && t.data && t.data.id);
  if (remoteTrash.length) trash = mergeTrash(trash, remoteTrash);
  // 3) 글 — 같은 글이 양쪽에 있으면 계보·기준점으로 가린다(충돌본 포함)
  const remoteNotes = need.filter((k) => k.startsWith('n:')).map(take).filter((m) => m && m.id);
  if (remoteNotes.length) memos = mergeMemos(memos, remoteNotes);
  // 4) 원격에서 사라진 파일
  for (const [k, rev] of latest) {
    if (rev) continue;
    const had = st.base[k];
    delete st.revs[k];
    delete st.base[k];
    if (!had) continue;   // 원격에 있다고 알던 적 없는 파일
    if (k.startsWith('n:')) {
      const id = k.slice(2);
      const m = memos.find((x) => x.id === id);
      if (!m || textHash(canon(m)) !== had) continue;   // 그 뒤 이 기기에서 고쳤다 → 남긴다(다시 올라간다)
      memos = memos.filter((x) => x.id !== id);
      // 다른 기기가 휴지통에 넣었으면 그 휴지통 파일이 함께 온다. 그게 없고 영구 삭제도 아니면 혹시 몰라 휴지통에 둔다
      if (!trash.some((t) => t.type === 'memo' && t.data && t.data.id === id) && !isPermDeleted(id)) {
        trash.push({ type: 'memo', data: { ...m }, deletedAt: Date.now() });
      }
    } else if (k.startsWith('t:')) {
      const [, type, id] = k.match(/^t:([^:]+):(.+)$/);
      const i = trash.findIndex((t) => t.type === type && t.data && t.data.id === id);
      if (i >= 0 && textHash(canon(trash[i])) === had) trash.splice(i, 1);   // 다른 기기에서 복원했거나 영구 삭제했다
    }
  }
  reconcileTrash();
  saveLocalData(false);
  store.setItem('split_cursor', L.cursor);
  saveSplitState(st);
  splitFinish(st);
  refreshOpenMemo();
}

// 동기화 끝 정리 — 원격과 같아진 글·폴더는 다음 합치기의 기준점으로 삼고, 남은 변경이 있는지 적는다
function splitFinish(st, seq) {
  const want = splitWanted();
  let clean = seq === undefined || (seq === changeSeq && !localSaveTimer);
  for (const [k, body] of want) if (st.base[k] !== textHash(body)) { clean = false; break; }
  if (clean) {
    const live = new Set(memos.map((m) => m.id));
    for (const k of Object.keys(st.base)) {
      if (!want.has(k) && !(k.startsWith('n:') && live.has(k.slice(2)))) { clean = false; break; }
    }
  }
  const sb = getSyncBase();
  for (const m of syncableMemos()) {
    const k = 'n:' + m.id;
    if (st.base[k] === textHash(want.get(k))) sb[m.id] = { t: m.updatedAt, h: memoHash(m) };
  }
  if (st.base.meta === textHash(want.get('meta'))) for (const f of folders) sb['f:' + f.id] = f.updatedAt || 0;
  store.setItem('sync_base', JSON.stringify(sb));
  store.setItem('last_synced_at', String(Date.now()));
  store.setItem('pending_sync', clean ? '0' : '1');
  if (clean) pendingSince = 0;
  updateSaveSyncTimes();
}

// ── 올리기 ──
// 달라진 파일만 올리고, 이 기기에서 없어진 것은 지운다. 충돌(다른 기기가 먼저 고침)이 있으면 받아 합친 뒤 한 번 더
async function splitPush(force, retried) {
  if (!accessToken || outdatedClient) return;
  if (!force && isLocalEmpty()) { console.warn('빈 상태라 올리지 않음'); return; }
  if (store.getItem('split_ready') !== '1') { await splitFirstSync(); return; }
  const list = syncableMemos();
  if (stampLineage(list) || localSaveTimer) saveLocalData(false);
  const seq = changeSeq;
  const st = splitState();
  const want = splitWanted();
  const ups = [...want.keys()].filter((k) => st.base[k] !== textHash(want.get(k)));
  const live = new Set(memos.map((m) => m.id));
  // 원격에 있다고 아는데 이제 없어야 할 것. 비어 있을 뿐 아직 목록에 있는 글은 지우지 않는다(다시 쓰는 중일 수 있다)
  const dels = Object.keys(st.revs).filter((k) => !want.has(k) && !(k.startsWith('n:') && live.has(k.slice(2))));
  // 안전장치: 원격 글을 한꺼번에 많이 지우려 하면 멈춘다(기기 저장이 망가져 비었을 때 원격까지 지우지 않게)
  const known = Object.keys(st.revs).filter((k) => k.startsWith('n:')).length;
  const delNotes = dels.filter((k) => k.startsWith('n:')).length;
  if (!force && delNotes > 10 && delNotes > known / 2) {
    setSyncStatus('error', '동기화 멈춤');
    showToast('글이 한꺼번에 많이 사라진 상태라 Dropbox 에서 지우지 않았습니다');
    return;
  }
  if (!ups.length && !dels.length) {
    splitFinish(st, seq);
    if (!retried && store.getItem('split_frozen') !== '1') await freezeLegacy();
    return;
  }
  // 휴지통 → 글 → meta 순으로 올리고(지운 기록이 글보다 먼저 남게), 지우기는 맨 뒤
  const rank = (k) => (k.startsWith('t:') ? 0 : k.startsWith('n:') ? 1 : 2);
  ups.sort((a, b) => rank(a) - rank(b));
  const total = ups.length + dels.length;
  let done = 0;
  let conflict = false;
  for (const k of ups) {
    if (total > 10) setSyncStatus('syncing', `올리는 중 ${++done}/${total}`);
    const body = want.get(k);
    const r = await dbxPut(splitPath(k), body, st.revs[k] ? { '.tag': 'update', update: st.revs[k] } : 'add');
    if (r.conflict) { conflict = true; continue; }
    st.revs[k] = r.rev;
    st.base[k] = textHash(body);
    saveSplitState(st);   // 중간에 끊겨도 올린 만큼은 기억한다
  }
  for (const k of dels) {
    if (total > 10) setSyncStatus('syncing', `올리는 중 ${++done}/${total}`);
    let r = await dbxRpc('files/delete_v2', { path: splitPath(k), parent_rev: st.revs[k] });
    if (r.status === 400) r = await dbxRpc('files/delete_v2', { path: splitPath(k) });   // parent_rev 를 못 받는 경우
    const gone = r.ok || (r.status === 409 && /not_found/.test(JSON.stringify(r.data || '')));
    if (gone) { delete st.revs[k]; delete st.base[k]; saveSplitState(st); }
    else if (r.status === 409) conflict = true;
    else throw new Error('delete failed: ' + r.status);
  }
  lastUploadAt = Date.now();
  if (conflict && !retried) {
    await splitPull();
    renderAll();
    return splitPush(force, true);
  }
  splitFinish(st, seq);
  if (isDirty()) pendingSince = lastUploadAt;
  // 옮기다 끊겨 옛 파일을 아직 못 얼렸으면 지금 마저(옛 앱이 계속 옛 파일에 쓰지 않게)
  if (!retried && store.getItem('split_frozen') !== '1') await freezeLegacy();
}

// ── 처음 맞추기·옮겨 오기 ──
// 이 기기에서 글 단위 동기화를 처음 할 때. 아무도 안 옮겼으면 옛 한 파일을 받아 합친 뒤 내가 옮긴다.
// 이미 옮겨져 있으면 전체를 받아(압축 파일 하나) 이 기기 내용과 합치고, 다른 것만 올린다.
async function splitFirstSync() {
  setSyncStatus('syncing', '새 동기화 방식으로 맞추는 중...');
  await adoptOldRoot();
  store.removeItem('split_cursor');
  saveSplitState({ revs: {}, base: {} });
  let L = await splitList();
  const hasMeta = !L.missing && L.entries.some((e) => e['.tag'] === 'file' && splitKeyOf(e.path_display || '') === 'meta');
  if (!hasMeta) {
    // 시범 운전 첫 실행: 진짜 파일을 시범 폴더로 복사해 온다(서버 안 복사, 진짜 파일은 그대로)
    if (PILOT && !(await dbxGetMetadata())) {
      const c = await dbxRpc('files/copy_v2', { from_path: '/projectpapers/memos.json', to_path: DROPBOX_FILE, autorename: false });
      if (!c.ok && c.status !== 409) throw new Error('pilot copy failed: ' + c.status);
    }
    // 아직 아무도 안 옮겼다 → 옛 한 파일을 받아 이 기기 내용과 합친다(옛 규칙 그대로)
    const legacyMissing = await legacyPullAndMerge();
    if (legacyMissing && isLocalEmpty()) return true;   // 원격에도 이 기기에도 아무것도 없다
    // meta.json 을 '새로 만들기'로 먼저 써서 자리를 잡는다 — 두 기기가 동시에 옮기면 한쪽만 된다
    const body = canon(splitMeta());
    const r = await dbxPut(splitPath('meta'), body, 'add');
    if (!r.conflict) {
      const st = splitState();
      st.revs.meta = r.rev;
      st.base.meta = textHash(body);
      saveSplitState(st);
    }
    L = await splitList();
  }
  await splitApply(L);
  store.setItem('split_ready', '1');
  await splitPush(false, false);
  if (store.getItem('split_frozen') !== '1') await freezeLegacy();
  await splitPush(false, true);   // 얼렸다는 표시를 meta 에 올린다
  return false;
}

// ── 옛 폴더에서 옮겨 오기 (2026-10-06 /project-papers → /projectpapers) ──
// 옮기기(move)가 아니라 서버 안 복사 + 옛 폴더에 '옮겨 감' 표시. 아직 옛 주소로 떠 있는 앱이
// 옛 폴더가 통째로 사라진 것을 보면 글이 모두 지워졌다고 여기거나 옛 폴더를 다시 만들 수 있어서다.
// 표시(meta dataVersion 5)를 본 옛 앱은 올리기를 멈추고 새로고침해 → 옛 주소의 안내 페이지 → 새 주소로 온다.
// 복사와 표시 사이에 옛 앱이 옛 폴더에 올린 것은 그 기기 저장에 남아 있다가, 그 기기가 새 앱으로 오면 처음 맞추기에서 올라간다.
async function adoptOldRoot() {
  if (store.getItem('root_adopted') === '1' || OLD_DBX_ROOT === DBX_ROOT) return;
  const here = await dbxRpc('files/get_metadata', { path: SPLIT_DIR + '/meta.json' });
  if (!here.ok) {
    if (here.status !== 409) throw new Error('lookup failed: ' + here.status);
    // 새 폴더가 아직 없다 → 내가 옮긴다. 글 폴더(sync)를 먼저 복사하고 바로 옛 쪽에 표시를 단 뒤, 백업·옛 한 파일을 복사
    await copyFromOldRoot('sync');
    await markOldRootMoved();
    await copyFromOldRoot('backups');
    await copyFromOldRoot('memos.json');
  } else {
    await markOldRootMoved();   // 다른 기기가 옮겼다. 표시를 못 달고 끊겼을 수 있으니 확인만
  }
  store.setItem('root_adopted', '1');
}

// 옛 폴더에 없거나(처음부터 새 위치) 새 쪽에 이미 있으면(다른 기기가 동시에 옮김) 그냥 지나간다
async function copyFromOldRoot(name) {
  const r = await dbxRpc('files/copy_v2', { from_path: OLD_DBX_ROOT + '/' + name, to_path: DBX_ROOT + '/' + name, autorename: false });
  if (r.ok) return;
  const why = (r.data && r.data.error_summary) || '';
  if (r.status === 409 && /^(from_lookup\/not_found|to\/conflict)/.test(why)) return;
  throw new Error('copy failed: ' + r.status + ' ' + why.slice(0, 80));
}

// 옛 폴더 meta 에 '옮겨 감' 표시 — 내용은 그대로 두고 dataVersion 만 올린다(옛 앱의 markOutdated 가 이것을 본다)
async function markOldRootMoved() {
  const path = OLD_DBX_ROOT + '/sync/meta.json';
  for (let i = 0; i < 3; i++) {
    const cur = await dbxGet(path);
    if (!cur) return;   // 옛 폴더가 없다
    let meta;
    try { meta = JSON.parse(cur.text); } catch { return; }
    if (meta.movedTo) return;   // 이미 달았다
    meta.dataVersion = SPLIT_DATA_VERSION + 1;
    meta.movedTo = DBX_ROOT;
    meta.movedAt = Date.now();
    const r = await dbxPut(path, canon(meta), { '.tag': 'update', update: cur.rev });
    if (!r.conflict) return;
  }
  throw new Error('old meta busy');
}

// 옛 한 파일에 '옮겨 감(dataVersion 4)' 표시를 단다. 내용은 지금 이 기기의 전체(비상용 사본)로 둔다.
// 옛 앱은 이 표시를 보면 올리기를 멈추고 새로고침해 새 앱으로 바뀐다.
// 옮기는 사이 옛 앱이 옛 파일에 올린 것이 있으면 먼저 받아 합치고(→ 글 단위로 올리고) 얼린다.
async function freezeLegacy() {
  const done = () => {
    store.setItem('split_frozen', '1');
    if (!store.getItem('split_frozen_at')) store.setItem('split_frozen_at', String(Date.now()));
  };
  for (let i = 0; i < 3; i++) {
    const meta = await dbxGetMetadata();
    if (!meta) { done(); return; }   // 옛 파일이 없다(처음부터 새 방식)
    if (meta.rev !== getRev()) {
      const cur = await dbxGet(DROPBOX_FILE);
      if (!cur) { done(); return; }
      let obj;
      try { obj = JSON.parse(cur.text); } catch { return; }
      if ((obj.dataVersion || 0) >= SPLIT_DATA_VERSION) { done(); return; }   // 이미 얼렸다
      await legacyPullAndMerge();
      await splitPush(false, true);
    }
    const payload = backupPayload();
    payload.memos = syncableMemos();
    payload.dataVersion = SPLIT_DATA_VERSION;
    payload.movedTo = 'sync';
    payload.movedAt = Date.now();
    const r = await dbxPut(DROPBOX_FILE, JSON.stringify(payload), { '.tag': 'update', update: getRev() });
    if (!r.conflict) { setRev(r.rev); done(); return; }
  }
}

// ── 백업 = Dropbox 서버 안에서 sync/ 폴더를 통째로 복사 (휴대폰 데이터를 쓰지 않는다) ──
async function splitBackup(name) {
  // 백업 폴더가 아직 없으면 먼저 만든다(이미 있으면 409 — 괜찮다)
  const mk = await dbxRpc('files/create_folder_v2', { path: BACKUP_DIR, autorename: false });
  if (!mk.ok && mk.status !== 409) throw new Error('backup folder failed: ' + mk.status);
  const r = await dbxRpc('files/copy_v2', { from_path: SPLIT_DIR, to_path: BACKUP_DIR + '/' + name, autorename: false });
  if (!r.ok) throw new Error('backup copy failed: ' + r.status + ' ' + JSON.stringify(r.data || '').slice(0, 120));
}
