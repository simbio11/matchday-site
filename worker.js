// MATCHDAY API proxy — Cloudflare Worker
// -----------------------------------------------------------------
// 이 파일은 api-sports.io(축구/야구/농구/배구/격투기)의 API 키를 브라우저에
// 노출시키지 않기 위한 프록시 서버예요. Cloudflare Workers 무료 플랜에
// 그대로 배포하면 돼요 (하루 10만 요청까지 무료, 카드 필요 없음).
//
// 동작 방식:
//   브라우저 → 이 Worker (키 없음) → api-sports.io (키는 여기서만 붙음)
// 응답은 엣지에서 15분간 캐시돼서, 방문자가 아무리 많아도 실제 상위 API
// 호출 횟수는 "15분에 한 번"으로 제한돼요 → 무료 티어(하루 100건) 안에서
// 충분히 운영 가능해요.
//
// ===== 배포 방법 (Cloudflare 대시보드, CLI 없이) =====
// 1. https://dash.cloudflare.com 무료 가입 (카드 불필요)
// 2. 좌측 메뉴 Workers & Pages → Create → Create Worker
// 3. 이름을 정하고 생성 → "Edit code" 들어가서 이 파일 내용을 전부 붙여넣기 → Deploy
// 4. Worker의 Settings → Variables and Secrets → Add
//      이름: API_SPORTS_KEY
//      값:   (api-sports.io 대시보드에서 발급받은 본인 API 키)
//      Type을 반드시 "Secret"으로 설정 (Text 아님) → 저장 후 재배포
// 5. 배포되면 https://<worker이름>.<계정서브도메인>.workers.dev 형태의 URL이 생겨요.
//    이 URL을 live-data.js 맨 위 WORKER_BASE 값에 넣어주세요.
//
// ===== 사용 가능한 경로 (프론트에서 이렇게 호출) =====
//   /api/football/<api-football 경로>      예) /api/football/fixtures?date=2026-09-14&league=292&season=2026
//   /api/baseball/<api-baseball 경로>      예) /api/baseball/games?date=2026-09-14&league=1&season=2026
//   /api/basketball/<api-basketball 경로>  예) /api/basketball/games?date=2026-09-14&league=2
//   /api/volleyball/<api-volleyball 경로>  예) /api/volleyball/games?date=2026-09-14
//   /api/mma/<api-mma 경로>                예) /api/mma/fights?date=2026-09-14
//
// league id(리그 번호)는 스포츠마다 다르고, api-sports.io 가입 후
// "Leagues" 엔드포인트로 "Korea"를 검색하면 K리그1/KBO/KBL/V리그의 정확한
// 번호를 확인할 수 있어요 (여기서는 임의로 추정한 번호를 넣지 않았어요 —
// 실제로 틀린 번호를 넣으면 엉뚱한 데이터가 나오기 때문에, 가입 후 직접
// 확인하시는 걸 권장드려요. 확인해서 알려주시면 코드에 반영해드릴게요).

const UPSTREAM_HOSTS = {
  football: "v3.football.api-sports.io",
  baseball: "v1.baseball.api-sports.io",
  basketball: "v1.basketball.api-sports.io",
  volleyball: "v1.volleyball.api-sports.io",
  mma: "v1.mma.api-sports.io"
};

const CACHE_TTL_SECONDS = 900; // 15분

// 이 프록시를 호출할 수 있는 곳을 우리 사이트로만 제한해요.
// 배포한 사이트 주소로 바꿔주세요 (GitHub Pages/Vercel/Netlify 주소).
// 개발 중에는 "*"로 열어두고, 배포 후 실제 주소로 좁혀주세요.
const ALLOWED_ORIGIN = "*";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const match = url.pathname.match(/^\/api\/([a-z]+)\/(.*)$/);
    if (!match) {
      return new Response(JSON.stringify({ error: "not_found", hint: "/api/<sport>/<path> 형태로 호출하세요" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    const sport = match[1];
    const path = match[2];
    const host = UPSTREAM_HOSTS[sport];
    if (!host) {
      return new Response(JSON.stringify({ error: "unknown_sport", allowed: Object.keys(UPSTREAM_HOSTS) }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    if (!env.API_SPORTS_KEY) {
      return new Response(JSON.stringify({ error: "missing_api_key", hint: "Worker Settings → Variables and Secrets에 API_SPORTS_KEY를 추가하세요" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    const upstreamUrl = `https://${host}/${path}${url.search}`;

    // Cloudflare 엣지 캐시 — 동일 요청은 15분 동안 재사용돼요.
    const cache = caches.default;
    const cacheKey = new Request(upstreamUrl, request);
    let response = await cache.match(cacheKey);

    if (!response) {
      const upstreamRes = await fetch(upstreamUrl, {
        headers: { "x-apisports-key": env.API_SPORTS_KEY }
      });
      const body = await upstreamRes.text();
      response = new Response(body, {
        status: upstreamRes.status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`
        }
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    const finalHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([k, v]) => finalHeaders.set(k, v));
    return new Response(response.body, { status: response.status, headers: finalHeaders });
  }
};
