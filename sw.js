// v2: 예전 버전은 오래된 캐시(matchday-v1)를 절대 안 지워서, 기기마다
// (특히 PWA로 "홈 화면에 추가"한 휴대폰에서) 예전 페이지가 계속 남아있는
// 문제가 있었어요. 이제 새 서비스워커가 활성화될 때 이름이 다른(예전) 캐시를
// 전부 지워서, 새로 배포한 내용이 모든 기기에 제대로 반영되게 했어요.
const CACHE = "matchday-v2";
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(["./"])).catch(() => {})
  );
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
