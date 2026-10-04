const CACHE_NAME = 'memo-v153';
const ASSETS = [
  '/project-papers/',
  '/project-papers/index.html',
  '/project-papers/style.css',
  '/project-papers/app.js',
  '/project-papers/sync-split.js',
  '/project-papers/manifest.json',
  '/project-papers/favicon.svg',
  '/project-papers/icon-192.png',
  '/project-papers/icon-512.png',
];

// 설치할 때는 서버에서 새로 받는다 — 브라우저 HTTP 캐시(GitHub Pages 10분)에 남은 옛 파일이 구워지지 않게.
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) =>
      Promise.all(ASSETS.map((u) =>
        fetch(new Request(u, { cache: 'reload' })).then((r) => {
          if (!r.ok) throw new Error(`${u} ${r.status}`);
          return c.put(u, r);
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
  // 네트워크 우선 — 단, 통신이 느리면(지하철 등) 4초 뒤 저장해 둔 사본으로 연다.
  // 예전엔 느린 통신에서 연결이 끊길 때까지 하얀 화면으로 기다렸다.
  // 앱 파일은 브라우저 HTTP 캐시(GitHub Pages 10분)를 건너뛰고 서버에 바뀌었는지 묻는다 —
  // 안 그러면 새 버전으로 다시 열어도 10분 동안 옛 app.js 가 실행될 수 있다.
  const net = fetch(sameOrigin && !isPage ? new Request(e.request, { cache: 'no-cache' }) : e.request).then((res) => {
    if (res.ok && new URL(e.request.url).origin === location.origin) {
      const clone = res.clone();
      caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
    }
    return res;
  });
  net.catch(() => {});
  const cached = async () => {
    const hit = await caches.match(e.request, { ignoreSearch: isPage });
    if (hit) return hit;
    // 새 창(?memo=…)처럼 주소 뒤가 달라도 앱 화면을 띄운다
    if (isPage) return (await caches.match('/project-papers/')) || (await caches.match('/project-papers/index.html'));
    return null;
  };
  e.respondWith((async () => {
    try {
      return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000))]);
    } catch {
      const hit = await cached();
      if (hit) return hit;
      try { return await net; } catch { return Response.error(); }   // 사본이 없으면 끝까지 기다린다
    }
  })());
});
