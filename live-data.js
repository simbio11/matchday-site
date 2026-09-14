// ===================================================================
// MATCHDAY 실시간 데이터 연동 스크립트
// ===================================================================
// 이 파일은 index.html에는 포함돼 있지 않아요. 외부 호스팅(GitHub Pages /
// Vercel / Netlify)에 배포한 뒤, index.html의 메인 <script> 태그 "앞"에
//   <script src="live-data.js"></script>
// 를 추가하면 동작해요. (Claude 아티팩트 안에서는 외부 API 호출이 막혀 있어서
// 동작하지 않아요 — 반드시 외부 배포 후 사용하세요.)
//
// 이 스크립트가 하는 일:
//   1) Cloudflare Worker 프록시(worker.js를 배포한 주소)를 통해
//      api-sports.io의 축구/야구/농구/배구/격투기 데이터를 가져와요.
//   2) F1은 키가 필요 없는 OpenF1(api.openf1.org)에서 "직접" 가져와요 (프록시 불필요).
//   3) 가져온 데이터를 index.html이 이해하는 MATCHES 형식으로 변환해서
//      window.MATCHDAY.setSportMatches(sport, matches) 로 화면에 반영해요.
//
// ⚠️ 정직하게 말씀드리면: api-sports.io(축구/야구/농구/배구/격투기) 응답의
// 필드 이름(예: fixture.status.short, teams.home.name 등)은 이 API 계열의
// 공개 문서에 널리 알려진 "일반적인" 구조를 기준으로 작성했어요. 실제 키로
// 호출해본 게 아니라서 100% 정확하다고 보장은 못 드려요. 아래 각 map* 함수
// 안에 console.log(raw)를 넣어뒀으니, 실제로 연동하실 때 브라우저 콘솔에서
// 실제 응답 구조를 확인하고 다른 점이 있으면 알려주시면 바로 고쳐드릴게요.
// (OpenF1의 /meetings, /sessions, /session_result, /drivers 필드는
// openf1.org 공식 문서에서 직접 확인한 필드예요.)
// ===================================================================

(function () {
  "use strict";

  // ---------------- 설정 (여기를 채워주세요) ----------------

  // 1) worker.js를 Cloudflare Workers에 배포하면 생기는 주소로 바꿔주세요.
  //    예) "https://matchday-proxy.your-subdomain.workers.dev"
  var WORKER_BASE = "https://matchday-proxy.cmkschcmksch.workers.dev"; // 예: "https://matchday-proxy.xxxx.workers.dev"

  // 2) api-sports.io 가입 후 "Leagues" 검색으로 확인한 리그 번호를 넣어주세요.
  //    (id를 모르면 null로 두세요 — 그 종목은 자동으로 건너뛰고 예시 데이터가 유지돼요.)
  var LEAGUE_IDS = {
    kleague1: null,   // 축구 - K리그1
    kbo: null,        // 야구 - KBO
    kbl: null,         // 농구 - KBL
    vleague: null      // 배구 - V리그(남/여 따로 있으면 둘 다 필요할 수 있어요)
  };

  var SEASON = 2026;

  // 조회할 날짜 범위 (오늘 기준 ±N일). 너무 크게 잡으면 캐시가 자주 갱신되지 않을 수 있어요.
  var DAYS_BEFORE = 2;
  var DAYS_AFTER = 5;

  // ---------------- 공용 유틸 ----------------

  function pad2(n) { return String(n).padStart(2, "0"); }

  function isoDate(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function dateRange() {
    var out = [];
    var base = new Date();
    for (var i = -DAYS_BEFORE; i <= DAYS_AFTER; i++) {
      var d = new Date(base);
      d.setDate(d.getDate() + i);
      out.push(isoDate(d));
    }
    return out;
  }

  // 후보 경로들을 순서대로 시도해서 처음 발견되는 값을 반환해요.
  // (api-sports.io 응답 구조가 예상과 다를 때를 대비한 방어적 코드예요.)
  function pick(obj, paths, fallback) {
    for (var i = 0; i < paths.length; i++) {
      var parts = paths[i].split(".");
      var cur = obj;
      var ok = true;
      for (var j = 0; j < parts.length; j++) {
        if (cur == null || typeof cur !== "object" || !(parts[j] in cur)) { ok = false; break; }
        cur = cur[parts[j]];
      }
      if (ok && cur !== undefined && cur !== null) return cur;
    }
    return fallback;
  }

  function proxyFetch(sport, path, params) {
    if (!WORKER_BASE) {
      console.warn("[live-data] WORKER_BASE가 설정되지 않아 " + sport + " 데이터를 건너뜁니다. live-data.js 상단을 채워주세요.");
      return Promise.resolve(null);
    }
    var qs = new URLSearchParams(params || {}).toString();
    var url = WORKER_BASE.replace(/\/$/, "") + "/api/" + sport + "/" + path + (qs ? "?" + qs : "");
    return fetch(url)
      .then(function (res) { return res.json(); })
      .catch(function (e) {
        console.warn("[live-data] " + sport + " 요청 실패", e);
        return null;
      });
  }

  // ---------------- 상태 매핑 (best-effort, 실제 응답으로 검증 필요) ----------------

  // 축구(api-football) status.short 코드: NS(예정), 1H/2H/HT/ET/BT/P/LIVE(진행중),
  // FT/AET/PEN(종료). 공개 문서 기준 — 다른 코드가 오면 "scheduled"로 처리해요.
  var LIVE_CODES = ["1H", "2H", "HT", "ET", "BT", "P", "LIVE", "INT"];
  var FINISHED_CODES = ["FT", "AET", "PEN", "AWD", "WO", "CANC", "PST", "ABD"];

  function mapStatus(code) {
    if (!code) return "scheduled";
    code = String(code).toUpperCase();
    if (FINISHED_CODES.indexOf(code) !== -1) return "finished";
    if (LIVE_CODES.indexOf(code) !== -1) return "live";
    return "scheduled";
  }

  // ---------------- 종목별 매퍼 ----------------

  function mapFootballFixture(raw, leagueLabel) {
    console.log("[live-data] football raw sample", raw);
    var statusCode = pick(raw, ["fixture.status.short", "status.short"], "NS");
    var homeGoals = pick(raw, ["goals.home"], null);
    var awayGoals = pick(raw, ["goals.away"], null);
    return {
      id: "live-fb-" + pick(raw, ["fixture.id", "id"], Math.random()),
      date: (pick(raw, ["fixture.date", "date"], "") + "").slice(0, 10),
      time: (pick(raw, ["fixture.date", "date"], "") + "").slice(11, 16),
      sport: "soccer",
      league: leagueLabel,
      venue: pick(raw, ["fixture.venue.name", "venue.name"], ""),
      home: pick(raw, ["teams.home.name"], "홈팀"),
      away: pick(raw, ["teams.away.name"], "원정팀"),
      status: mapStatus(statusCode),
      homeScore: homeGoals != null ? Number(homeGoals) : undefined,
      awayScore: awayGoals != null ? Number(awayGoals) : undefined
    };
  }

  function mapGenericGame(raw, sport, leagueLabel, scorePath) {
    console.log("[live-data] " + sport + " raw sample", raw);
    var statusCode = pick(raw, ["status.short", "status"], "NS");
    var homeScore = pick(raw, scorePath.home, null);
    var awayScore = pick(raw, scorePath.away, null);
    var dateStr = pick(raw, ["date", "fixture.date"], "");
    return {
      id: "live-" + sport.slice(0, 2) + "-" + pick(raw, ["id"], Math.random()),
      date: (dateStr + "").slice(0, 10),
      time: pick(raw, ["time"], (dateStr + "").slice(11, 16)),
      sport: sport,
      league: leagueLabel,
      venue: pick(raw, ["venue", "arena.name"], ""),
      home: pick(raw, ["teams.home.name"], "홈팀"),
      away: pick(raw, ["teams.away.name"], "원정팀"),
      status: mapStatus(statusCode),
      homeScore: homeScore != null ? Number(homeScore) : undefined,
      awayScore: awayScore != null ? Number(awayScore) : undefined
    };
  }

  // ---------------- 축구: K리그1 ----------------

  function loadFootball() {
    if (!LEAGUE_IDS.kleague1) {
      console.info("[live-data] LEAGUE_IDS.kleague1이 비어 있어 축구는 예시 데이터를 유지합니다.");
      return;
    }
    var dates = dateRange();
    Promise.all(dates.map(function (d) {
      return proxyFetch("football", "fixtures", { date: d, league: LEAGUE_IDS.kleague1, season: SEASON });
    })).then(function (results) {
      var matches = [];
      results.forEach(function (r) {
        if (!r || !Array.isArray(r.response)) return;
        r.response.forEach(function (raw) {
          matches.push(mapFootballFixture(raw, "K리그1"));
        });
      });
      if (matches.length) window.MATCHDAY.setSportMatches("soccer", matches);
    });
  }

  // ---------------- 야구: KBO ----------------

  function loadBaseball() {
    if (!LEAGUE_IDS.kbo) {
      console.info("[live-data] LEAGUE_IDS.kbo가 비어 있어 야구는 예시 데이터를 유지합니다.");
      return;
    }
    var dates = dateRange();
    Promise.all(dates.map(function (d) {
      return proxyFetch("baseball", "games", { date: d, league: LEAGUE_IDS.kbo, season: SEASON });
    })).then(function (results) {
      var matches = [];
      results.forEach(function (r) {
        if (!r || !Array.isArray(r.response)) return;
        r.response.forEach(function (raw) {
          matches.push(mapGenericGame(raw, "baseball", "KBO", {
            home: ["scores.home.total", "scores.home"],
            away: ["scores.away.total", "scores.away"]
          }));
        });
      });
      if (matches.length) window.MATCHDAY.setSportMatches("baseball", matches);
    });
  }

  // ---------------- 농구: KBL ----------------

  function loadBasketball() {
    if (!LEAGUE_IDS.kbl) {
      console.info("[live-data] LEAGUE_IDS.kbl이 비어 있어 농구는 예시 데이터를 유지합니다.");
      return;
    }
    var dates = dateRange();
    Promise.all(dates.map(function (d) {
      return proxyFetch("basketball", "games", { date: d, league: LEAGUE_IDS.kbl, season: SEASON });
    })).then(function (results) {
      var matches = [];
      results.forEach(function (r) {
        if (!r || !Array.isArray(r.response)) return;
        r.response.forEach(function (raw) {
          matches.push(mapGenericGame(raw, "basketball", "KBL", {
            home: ["scores.home.total", "scores.home"],
            away: ["scores.away.total", "scores.away"]
          }));
        });
      });
      if (matches.length) window.MATCHDAY.setSportMatches("basketball", matches);
    });
  }

  // ---------------- 배구: V리그 ----------------

  function loadVolleyball() {
    if (!LEAGUE_IDS.vleague) {
      console.info("[live-data] LEAGUE_IDS.vleague가 비어 있어 배구는 예시 데이터를 유지합니다.");
      return;
    }
    var dates = dateRange();
    Promise.all(dates.map(function (d) {
      return proxyFetch("volleyball", "games", { date: d, league: LEAGUE_IDS.vleague, season: SEASON });
    })).then(function (results) {
      var matches = [];
      results.forEach(function (r) {
        if (!r || !Array.isArray(r.response)) return;
        r.response.forEach(function (raw) {
          matches.push(mapGenericGame(raw, "volleyball", "V리그", {
            home: ["scores.home.total", "scores.home"],
            away: ["scores.away.total", "scores.away"]
          }));
        });
      });
      if (matches.length) window.MATCHDAY.setSportMatches("volleyball", matches);
    });
  }

  // ---------------- F1: OpenF1 (키 불필요, 프록시 불필요) ----------------
  // openf1.org 공식 문서 기준 필드명 사용 (meetings/sessions/session_result/drivers).

  var OPENF1_BASE = "https://api.openf1.org/v1";

  function openf1(path, params) {
    var qs = new URLSearchParams(params || {}).toString();
    return fetch(OPENF1_BASE + path + (qs ? "?" + qs : ""))
      .then(function (res) { return res.json(); })
      .catch(function (e) {
        console.warn("[live-data] OpenF1 요청 실패", e);
        return [];
      });
  }

  function loadF1() {
    openf1("/sessions", { year: new Date().getFullYear() }).then(function (sessions) {
      if (!Array.isArray(sessions) || !sessions.length) return;
      console.log("[live-data] openf1 sessions raw sample", sessions[0]);

      var now = Date.now();
      var windowStart = now - DAYS_BEFORE * 86400000;
      var windowEnd = now + DAYS_AFTER * 86400000;

      var relevant = sessions.filter(function (s) {
        var t = new Date(s.date_start).getTime();
        return t >= windowStart && t <= windowEnd;
      });

      Promise.all(relevant.map(function (s) {
        var status = "scheduled";
        var startT = new Date(s.date_start).getTime();
        var endT = new Date(s.date_end).getTime();
        if (now >= startT && now <= endT) status = "live";
        else if (now > endT) status = "finished";

        if (status !== "finished") {
          return Promise.resolve({
            id: "live-f1-" + s.session_key,
            date: (s.date_start || "").slice(0, 10),
            time: (s.date_start || "").slice(11, 16),
            sport: "motorsport",
            league: "F1",
            venue: s.circuit_short_name || s.location || "",
            home: s.meeting_key ? (s.session_name || "세션") : "F1",
            away: s.circuit_short_name || s.location || "",
            status: status
          });
        }

        // 종료된 세션은 session_result + drivers로 상위 2명을 찾아 home/away에 넣어요
        // (매치데이 사이트의 모터스포츠 표기 방식에 맞춘 것으로, 실제 "대결"은 아니에요).
        return Promise.all([
          openf1("/session_result", { session_key: s.session_key }),
          openf1("/drivers", { session_key: s.session_key })
        ]).then(function (r) {
          var results = r[0] || [], drivers = r[1] || [];
          console.log("[live-data] openf1 session_result raw sample", results[0]);
          results.sort(function (a, b) { return (a.position || 99) - (b.position || 99); });
          function nameFor(driverNumber) {
            var d = drivers.filter(function (x) { return x.driver_number === driverNumber; })[0];
            return d ? d.full_name : ("#" + driverNumber);
          }
          var top1 = results[0], top2 = results[1];
          return {
            id: "live-f1-" + s.session_key,
            date: (s.date_start || "").slice(0, 10),
            time: (s.date_start || "").slice(11, 16),
            sport: "motorsport",
            league: "F1",
            venue: s.circuit_short_name || s.location || "",
            home: top1 ? nameFor(top1.driver_number) : "F1",
            away: top2 ? nameFor(top2.driver_number) : (s.session_name || ""),
            status: "finished",
            homeScore: top1 ? top1.position : undefined,
            awayScore: top2 ? top2.position : undefined
          };
        });
      })).then(function (matches) {
        if (matches.length) window.MATCHDAY.setSportMatches("motorsport", matches.filter(Boolean));
      });
    });
  }

  // ---------------- 시작 ----------------

  window.addEventListener("load", function () {
    if (!window.MATCHDAY || typeof window.MATCHDAY.setSportMatches !== "function") {
      console.warn("[live-data] window.MATCHDAY 훅을 찾을 수 없어요. index.html이 먼저 로드됐는지 확인해주세요.");
      return;
    }
    loadFootball();
    loadBaseball();
    loadBasketball();
    loadVolleyball();
    loadF1(); // 키 불필요 — WORKER_BASE 설정과 무관하게 항상 시도해요.
    // UFC/격투기(MMA)는 필요하시면 이어서 추가해드릴게요 (league/organization
    // 파라미터 이름을 api-sports.io MMA 문서에서 먼저 확인해야 정확히 짤 수 있어요).
  });
})();
