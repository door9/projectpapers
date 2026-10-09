const CACHE_NAME = 'memo-v160';
// 경로는 이 파일(sw.js) 자리 기준 — door9.github.io/projectpapers/ 에서도, 주소 맨 앞(/)에 둔 Cloudflare 에서도 같이 쓴다
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'sync-split.js',
  'manifest.json',
  'favicon.svg',
  'icon-192.png',
  'icon-512.png',
];

// 서버가 다른 주소로 돌려서 받은 답(redirect)은 깨끗한 사본으로 바꿔 저장한다.
// Cloudflare 는 /index.html 을 / 로 돌린다(307). 돌려받은 답을 그대로 저장했다가 화면 열기에 쓰면
// 크롬이 거부해 앱이 안 열린다(오프라인 포함). GitHub Pages 에서는 돌려받는 일이 없어 그대로 저장된다
async function clean(res) {
  if (!res || !res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

// 설치할 때는 서버에서 새로 받는다 — 브라우저 HTTP 캐시(GitHub Pages 10분)에 남은 옛 파일이 구워지지 않게.
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) =>
      Promise.all(ASSETS.map((u) =>
        fetch(new Request(u, { cache: 'reload' })).then(async (r) => {
          if (!r.ok) throw new Error(`${u} ${r.status}`);
          return c.put(u, await clean(r));
        })
      ))
    )
  );
  self.skipWaiting();
});

// 옛 캐시 정리는 **메모앱 것(memo-*)만**. door9.github.io 주소를 PROJ210 등 다른 앱과 함께 쓰므로,
// 이름으로 가리지 않고 지우면 서로의 오프라인 사본을 지운다(PC에서 오프라인 실행이 안 되던 원인).
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n.startsWith('memo-') && n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('api.dropboxapi.com') || e.request.url.includes('content.dropboxapi.com')) {
    return;
  }
  const isPage = e.request.mode === 'navigate';
  const sameOrigin = new URL(e.request.url).origin === location.origin;
  // 앱이 로그인 만료를 알아보려고 sw.js 를 직접 물어볼 때는 끼어들지 않는다(저장본으로 답하면 만료를 못 알아본다)
  if (sameOrigin && new URL(e.request.url).pathname === location.pathname) return;
  // 다시 로그인(?login=1)은 저장본을 건너뛰고 서버로 간다 — 잠금(Cloudflare Access)이 로그인 화면으로 보낸다
  if (isPage && new URL(e.request.url).searchParams.has('login')) {
    e.respondWith(fetch(e.request).catch(async () => clean((await caches.match('./')) || (await caches.match('index.html')))));
    return;
  }
  // 네트워크 우선 — 단, 통신이 느리면(지하철 등) 4초 뒤 저장해 둔 사본으로 연다.
  // 예전엔 느린 통신에서 연결이 끊길 때까지 하얀 화면으로 기다렸다.
  // 앱 파일은 브라우저 HTTP 캐시(GitHub Pages 10분)를 건너뛰고 서버에 바뀌었는지 묻는다 —
  // 안 그러면 새 버전으로 다시 열어도 10분 동안 옛 app.js 가 실행될 수 있다.
  // 잠금(Cloudflare Access) 로그인이 만료되면 서버가 로그인 화면으로 돌린다 — 통신이 안 될 때처럼 저장본으로 연다
  // (앱이 '다시 로그인' 안내를 띄운다). 저장본이 없을 때만 로그인 화면으로 보낸다
  let walled = null;
  const net = fetch(sameOrigin && !isPage ? new Request(e.request, { cache: 'no-cache' }) : e.request).then((res) => {
    if (sameOrigin && (res.type === 'opaqueredirect' || res.type === 'opaque')) { walled = res; throw new Error('login'); }
    if (res.ok && new URL(e.request.url).origin === location.origin) {
      const clone = res.clone();
      caches.open(CACHE_NAME).then(async (c) => c.put(e.request, await clean(clone)));
    }
    return res;
  });
  net.catch(() => {});
  // 화면(페이지)에는 돌려받은 답을 주지 않는다(혹시 저장돼 있으면 깨끗한 사본으로 바꿔서)
  const cached = async () => {
    const hit = await caches.match(e.request, { ignoreSearch: isPage });
    if (hit) return isPage ? clean(hit) : hit;
    // 새 창(?memo=…)처럼 주소 뒤가 달라도 앱 화면을 띄운다
    if (isPage) return clean((await caches.match('./')) || (await caches.match('index.html')));
    return null;
  };
  e.respondWith((async () => {
    try {
      return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000))]);
    } catch {
      const hit = await cached();
      if (hit) return hit;
      try { return await net; } catch { return walled || Response.error(); }   // 사본이 없으면 끝까지 기다린다
    }
  })());
});
