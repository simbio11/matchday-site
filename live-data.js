// ===================================================================
// MATCHDAY 실시간 데이터 연동 스크립트
// ===================================================================
// 이 파일은 index.html에는 포함돼 있지 않아요. 외부 호스팅(GitHub Pages /
// Vercel / Netlify)에 배포한 뒤, index.html의 메인 <script> 태그 "앞"에
//   <script src="live-data.js"></script>
// 를 추가하면 동작해요. (Claude 아티팩트 안에서는 외부 API 호출이 막혀 있어서
// 동작하지 않아요 — 반드시 외부 배포 후 사용하세요.)
//
// 이 스크립트가 하는 일 (2번째 개편):
//   1) 축구(K리그1)/야구(KBO)/농구(KBL)/배구(V리그)는 TheSportsDB의 무료 공개
//      키("123", 회원가입도 필요 없어요)를 브라우저에서 "직접" 호출해요.
//      api-sports.io 무료 플랜은 실제로 테스트해보니 "현재 시즌 데이터는
//      무료로 접근 불가"(2022~2024년 과거 시즌만 허용)라는 게 확인돼서,
//      TheSportsDB로 통째로 옮겼어요. 이러면 Vercel 프록시(vercel-proxy 폴더,
//      이 저장소엔 남아있지만 이제 이 4개 종목에는 쓰이지 않아요)나 키를
//      숨길 필요 자체가 없어져요 — TheSportsDB의 "123"은 원래 공개용 테스트
//      키라 숨길 필요가 없는 값이에요.
//   2) F1은 키가 필요 없는 OpenF1(api.openf1.org)에서 "직접" 가져와요.
//   3) 가져온 데이터를 index.html이 이해하는 MATCHES 형식으로 변환해서
//      window.MATCHDAY.setSportMatches(sport, matches) 로 화면에 반영해요.
//
// ⚠️ 정직하게 말씀드리면: TheSportsDB의 K리그1(4689)/KBO(4830)/KBL(5124)/
// V리그 남(5757)·여(5756) 리그 번호와 필드 이름(strHomeTeam, dateEvent,
// strStatus 등)은 실제로 그 리그 id로 호출해서 2026년 현재 시즌 경기가
// 나오는 걸 직접 확인했어요. 다만 라이브 진행 중 상태 표기(strStatus 값)는
// 축구/야구/농구/배구가 서로 다를 수 있어서 100% 검증은 못 했어요 — 콘솔에
// raw sample을 찍어뒀으니 이상하면 알려주세요.
// OpenF1(F1)의 /meetings, /sessions, /session_result, /drivers 필드는
// openf1.org 공식 문서에서 직접 확인한 필드예요.
// ===================================================================

(function () {
  "use strict";

  // ---------------- 설정 ----------------

  // TheSportsDB 무료 공개 테스트 키예요(회원가입 불필요, 공식 문서에 명시된 값이라
  // 숨길 필요가 없어요). 분당 30회 제한이 있어서 너무 자주 새로고침하면 막힐 수 있어요.
  // ⚠️ 이 줄은 "123"이라는 짧은 값 그대로 둬야 해요! Vercel 주소를 넣는 곳이
  // 아니에요 — Vercel 주소는 훨씬 아래에 있는 ESPORTS_WORKER_BASE에 넣어주세요.
  var SPORTSDB_KEY = "123";
  var SPORTSDB_BASE = "https://www.thesportsdb.com/api/v1/json/" + SPORTSDB_KEY;
  if (SPORTSDB_KEY.indexOf("http") !== -1) {
    console.error("[live-data] SPORTSDB_KEY에 주소(URL)가 들어가 있어요! 이 값은 \"123\" 그대로 둬야 해요. " +
      "Vercel 주소는 이 파일 아래쪽 ESPORTS_WORKER_BASE 줄에 넣어주세요.");
  }

  // 종목별로 여러 리그를 넣을 수 있어요. 전부 실제 id로 호출해서 2026년 현재
  // 시즌 경기가 나오는 걸 확인한 번호예요.
  // 축구는 K리그1에 이어 해외 리그(EPL)도 같이 가져와요. EPL id(4328)는
  // TheSportsDB에서 실제로 호출해서 2026년 현재 시즌 경기가 나오는 걸
  // 확인한 번호예요. 다만 TheSportsDB 쪽 팀 소속 정보가 가끔 최신이 아닐 수
  // 있어요(예: 승격/강등 직후) — 콘솔의 raw sample로 이상 여부를 확인해주세요.
  var LEAGUES = {
    soccer: [
      { id: 4689, label: "K리그1" },
      { id: 4328, label: "EPL" }
    ],
    baseball: [{ id: 4830, label: "KBO" }],
    basketball: [{ id: 5124, label: "KBL" }],
    volleyball: [
      { id: 5757, label: "V리그(남)" },
      { id: 5756, label: "V리그(여)" }
    ]
  };

  // F1: 오늘로부터 이 범위(일) 안에 있는 세션만 화면에 반영해요.
  var DAYS_BEFORE = 14;
  var DAYS_AFTER = 21;

  // (참고) 예전엔 api-sports.io + Vercel 프록시(vercel-proxy 폴더)를 썼는데,
  // 무료 플랜이 "현재 시즌 데이터 접근 불가"(2022~2024년 과거 시즌만 허용)라서
  // 못 쓰게 됐어요. UFC/격투기(MMA)를 나중에 붙일 때 유료로 전환하면 그 프록시를
  // 다시 쓸 수 있어서 코드는 남겨뒀어요 — 지금은 아래 WORKER_BASE가 비어 있으면
  // 그냥 조용히 건너뛰어요.
  var WORKER_BASE = "";

  // e스포츠(LCK)는 PandaScore API를 쓰는데, PandaScore는 브라우저 직접 호출을
  // 막아놔서(CORS 미지원 + 키를 클라이언트에 노출하면 안 됨) vercel-proxy 폴더의
  // /api/esports/... 프록시를 거쳐서 불러와요. 아래에 Vercel 배포 주소를 넣어야
  // 동작해요 (예: "https://matchdayvercel.vercel.app"). 비어있으면 조용히 건너뛰고
  // 예시 데이터가 그대로 유지돼요.
  var ESPORTS_WORKER_BASE = "https://matchdayvercel.vercel.app";

  function proxyFetch(sport, path, params) {
    if (!WORKER_BASE) return Promise.resolve(null);
    var qs = new URLSearchParams(params || {}).toString();
    var url = WORKER_BASE.replace(/\/$/, "") + "/api/" + sport + "/" + path + (qs ? "?" + qs : "");
    return fetch(url)
      .then(function (res) { return res.json(); })
      .catch(function (e) {
        console.warn("[live-data] " + sport + " 요청 실패", e);
        return null;
      });
  }

  // ---------------- TheSportsDB 유틸 ----------------

  function sportsdbFetch(path, params) {
    var qs = new URLSearchParams(params || {}).toString();
    var url = SPORTSDB_BASE + path + (qs ? "?" + qs : "");
    return fetch(url)
      .then(function (res) { return res.json(); })
      .catch(function (e) {
        console.warn("[live-data] TheSportsDB 요청 실패 (" + url + ")", e);
        return null;
      });
  }

  // TheSportsDB는 날짜(dateEvent)/시간(strTime)을 UTC 기준으로 줘요. 사이트는
  // 한국시간(KST, UTC+9) 표기를 쓰니 여기서 변환해요. strTimestamp(UTC ISO
  // 문자열)가 있으면 그걸 우선 쓰고, 없으면 dateEvent+strTime을 UTC로 간주해요.
  function toKst(dateEvent, strTime, strTimestamp) {
    var utcDate;
    if (strTimestamp) {
      utcDate = new Date(strTimestamp.replace(" ", "T") + (strTimestamp.indexOf("Z") === -1 ? "Z" : ""));
    } else if (dateEvent) {
      utcDate = new Date(dateEvent + "T" + (strTime || "00:00:00") + "Z");
    } else {
      return { date: "", time: "" };
    }
    if (isNaN(utcDate.getTime())) return { date: dateEvent || "", time: (strTime || "").slice(0, 5) };
    var kst = new Date(utcDate.getTime() + 9 * 3600000);
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return {
      date: kst.getUTCFullYear() + "-" + pad(kst.getUTCMonth() + 1) + "-" + pad(kst.getUTCDate()),
      time: pad(kst.getUTCHours()) + ":" + pad(kst.getUTCMinutes())
    };
  }

  // TheSportsDB의 strStatus는 종목/리그마다 표기가 조금씩 달라요(best-effort).
  var SPORTSDB_LIVE_HINTS = ["1H", "2H", "LIVE", "IN PROGRESS", "HT", "Q1", "Q2", "Q3", "Q4"];
  var SPORTSDB_FINISHED_HINTS = ["FT", "MATCH FINISHED", "FINISHED", "AOT", "AET", "FT-PEN"];

  function mapSportsDbStatus(raw) {
    var status = (raw.strStatus || "").toUpperCase().trim();
    var hasScore = raw.intHomeScore !== null && raw.intHomeScore !== undefined &&
      raw.intAwayScore !== null && raw.intAwayScore !== undefined;
    if (SPORTSDB_FINISHED_HINTS.indexOf(status) !== -1) return "finished";
    if (SPORTSDB_LIVE_HINTS.indexOf(status) !== -1) return "live";
    if (status === "" && hasScore) return "finished"; // 지난 경기 조회는 보통 상태값이 비어있어요
    if (status === "NS" || status === "") return "scheduled";
    return "scheduled";
  }

  function mapSportsDbEvent(raw, matchdaySport, label) {
    console.log("[live-data] " + matchdaySport + " (TheSportsDB) raw sample", raw);
    var kst = toKst(raw.dateEvent, raw.strTime, raw.strTimestamp);
    var homeScore = raw.intHomeScore !== null && raw.intHomeScore !== undefined ? Number(raw.intHomeScore) : undefined;
    var awayScore = raw.intAwayScore !== null && raw.intAwayScore !== undefined ? Number(raw.intAwayScore) : undefined;
    return {
      id: "live-sdb-" + raw.idEvent,
      date: kst.date,
      time: kst.time,
      sport: matchdaySport,
      league: label,
      venue: raw.strVenue || "",
      home: raw.strHomeTeam || "홈팀",
      away: raw.strAwayTeam || "원정팀",
      status: mapSportsDbStatus(raw),
      homeScore: homeScore,
      awayScore: awayScore
    };
  }

  // ---------------- 공용: 종목 하나를 (여러 리그 포함해서) 불러오기 ----------------
  // TheSportsDB는 날짜별로 반복 조회할 필요 없이, 리그당 "다음 경기들"과
  // "지난 경기들"을 한 번씩만 불러오면 돼요 (요청 횟수가 훨씬 적어요).

  function markLoadDone(sport) {
    // index.html의 화면이 "불러오는 중…" 표시를 언제까지나 띄워두지 않도록,
    // 이 종목에 대한 시도가 끝났다는 걸(성공이든 실패든) 알려줘요.
    if (window.MATCHDAY && typeof window.MATCHDAY.setLoading === "function") {
      window.MATCHDAY.setLoading(sport, false);
    }
  }

  function loadSportFromSportsDb(matchdaySport) {
    var leagues = (LEAGUES[matchdaySport] || []).filter(function (lg) { return lg && lg.id; });
    if (!leagues.length) {
      console.info("[live-data] LEAGUES." + matchdaySport + "이 비어 있어 이 종목은 건너뜁니다.");
      markLoadDone(matchdaySport);
      return;
    }
    var calls = [];
    leagues.forEach(function (lg) {
      calls.push(sportsdbFetch("/eventsnextleague.php", { id: lg.id }).then(function (r) { return { r: r, label: lg.label }; }));
      calls.push(sportsdbFetch("/eventspastleague.php", { id: lg.id }).then(function (r) { return { r: r, label: lg.label }; }));
    });
    Promise.all(calls).then(function (results) {
      var matches = [];
      var seen = {};
      results.forEach(function (item) {
        var events = item.r && Array.isArray(item.r.events) ? item.r.events : [];
        events.forEach(function (raw) {
          if (!raw || seen[raw.idEvent]) return;
          seen[raw.idEvent] = true;
          matches.push(mapSportsDbEvent(raw, matchdaySport, item.label));
        });
      });
      if (matches.length) window.MATCHDAY.setSportMatches(matchdaySport, matches);
      else console.info("[live-data] " + matchdaySport + ": TheSportsDB에서 가져온 경기가 없어요.");
      markLoadDone(matchdaySport);
    }).catch(function () { markLoadDone(matchdaySport); });
  }

  function loadFootball() { loadSportFromSportsDb("soccer"); }
  function loadBaseball() { loadSportFromSportsDb("baseball"); }
  function loadBasketball() { loadSportFromSportsDb("basketball"); }
  function loadVolleyball() { loadSportFromSportsDb("volleyball"); }

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
      if (!Array.isArray(sessions) || !sessions.length) { markLoadDone("motorsport"); return; }
      console.log("[live-data] openf1 sessions raw sample", sessions[0]);

      var now = Date.now();
      var windowStart = now - DAYS_BEFORE * 86400000;
      var windowEnd = now + DAYS_AFTER * 86400000;

      var relevant = sessions.filter(function (s) {
        var t = new Date(s.date_start).getTime();
        return t >= windowStart && t <= windowEnd;
      });

      // ⚠️ OpenF1은 무료지만 요청이 너무 몰리면 429(Too Many Requests)를 내요.
      // 예전엔 이 기간 안의 "끝난 세션"마다(연습주행/퀄리파잉/스프린트/본선까지
      // 전부) session_result+drivers를 동시에 한꺼번에 불러왔는데, 주말 하나에
      // 세션이 5~7개라 며칠만 겹쳐도 순식간에 요청이 20~30개씩 나가서 막혔어요.
      // 그래서 전체 완주 순위표는 "본선(Race)" 세션에만 만들고, 나머지(연습/퀄리)는
      // 그냥 "종료"로만 표시해요 — 실제로도 순위표가 의미 있는 건 본선이에요.
      var results0 = [];
      var toFetchDetail = [];
      relevant.forEach(function (s) {
        var status = "scheduled";
        var startT = new Date(s.date_start).getTime();
        var endT = new Date(s.date_end).getTime();
        if (now >= startT && now <= endT) status = "live";
        else if (now > endT) status = "finished";

        var isRace = (s.session_name || "").toLowerCase().indexOf("race") !== -1;
        if (status !== "finished" || !isRace) {
          results0.push(Promise.resolve({
            id: "live-f1-" + s.session_key,
            date: (s.date_start || "").slice(0, 10),
            time: (s.date_start || "").slice(11, 16),
            sport: "motorsport",
            league: "F1",
            venue: s.circuit_short_name || s.location || "",
            home: s.meeting_key ? (s.session_name || "세션") : "F1",
            away: s.circuit_short_name || s.location || "",
            status: status
          }));
        } else {
          toFetchDetail.push(s);
        }
      });

      // 본선 세션들은 동시에 다 쏘지 않고 하나씩 순서대로(약간의 간격을 두고)
      // 불러와서 요청이 한꺼번에 몰리지 않게 해요.
      function fetchRaceDetail(s) {
        return Promise.all([
          openf1("/session_result", { session_key: s.session_key }),
          openf1("/drivers", { session_key: s.session_key })
        ]).then(function (r) {
          // OpenF1이 요청 제한(429) 등으로 배열이 아닌 응답(에러 객체 등)을 줄 수도
          // 있어서, 배열인지 꼭 확인하고 아니면 빈 배열로 처리해요(그래야 아래
          // sort()가 죽지 않아요).
          var results = Array.isArray(r[0]) ? r[0] : [];
          var drivers = Array.isArray(r[1]) ? r[1] : [];
          console.log("[live-data] openf1 session_result raw sample", results[0]);
          results.sort(function (a, b) { return (a.position || 99) - (b.position || 99); });
          function teamFor(driverNumber) {
            var d = drivers.filter(function (x) { return x.driver_number === driverNumber; })[0];
            return d ? d.team_name : "";
          }
          function nameFor(driverNumber) {
            var d = drivers.filter(function (x) { return x.driver_number === driverNumber; })[0];
            return d ? d.full_name : ("#" + driverNumber);
          }
          var top1 = results[0], top2 = results[1];
          var raceResults = results.slice(0, 10).map(function (row, idx) {
            var gapText = "";
            if (idx === 0) gapText = "우승";
            else if (row.gap_to_leader !== undefined && row.gap_to_leader !== null) gapText = "+" + row.gap_to_leader;
            return {
              position: row.position || (idx + 1),
              name: nameFor(row.driver_number),
              team: teamFor(row.driver_number),
              gap: gapText
            };
          });
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
            awayScore: top2 ? top2.position : undefined,
            raceResults: raceResults
          };
        }).catch(function () { return null; });
      }

      // toFetchDetail(본선 세션들)을 하나씩, 300ms 간격을 두고 순서대로 불러와요.
      function runSequentially(list, idx, acc) {
        if (idx >= list.length) return Promise.resolve(acc);
        return fetchRaceDetail(list[idx]).then(function (r) {
          if (r) acc.push(r);
          return new Promise(function (resolve) { setTimeout(resolve, 300); }).then(function () {
            return runSequentially(list, idx + 1, acc);
          });
        });
      }

      Promise.all(results0).then(function (baseMatches) {
        return runSequentially(toFetchDetail, 0, []).then(function (raceMatches) {
          return baseMatches.concat(raceMatches);
        });
      }).then(function (matches) {
        if (matches.length) window.MATCHDAY.setSportMatches("motorsport", matches.filter(Boolean));
        else console.info("[live-data] motorsport: 이 기간엔 표시할 F1 세션이 없어요.");
        markLoadDone("motorsport");
      }).catch(function () { markLoadDone("motorsport"); });
    }).catch(function () { markLoadDone("motorsport"); });
  }

  // ---------------- e스포츠(LCK, PandaScore) ----------------

  function esportsFetch(path, params) {
    if (!ESPORTS_WORKER_BASE) return Promise.resolve(null);
    var qs = new URLSearchParams(params || {}).toString();
    var url = ESPORTS_WORKER_BASE.replace(/\/$/, "") + "/api/esports/" + path + (qs ? "?" + qs : "");
    return fetch(url)
      .then(function (res) { return res.json(); })
      .catch(function (e) {
        console.warn("[live-data] esports 요청 실패 (" + url + ")", e);
        return null;
      });
  }

  var ESPORTS_STATUS_MAP = { not_started: "scheduled", running: "live", finished: "finished", postponed: "scheduled", canceled: "finished" };

  function mapEsportsMatch(raw) {
    console.log("[live-data] esports (PandaScore) raw sample", raw);
    var kst = toKst(null, null, raw.begin_at || raw.scheduled_at);
    var opp = raw.opponents || [];
    var home = opp[0] && opp[0].opponent ? opp[0].opponent.name : "TBD";
    var away = opp[1] && opp[1].opponent ? opp[1].opponent.name : "TBD";
    var homeScore, awayScore;
    if (Array.isArray(raw.results) && raw.results.length >= 2 && opp[0] && opp[1]) {
      var homeId = opp[0].opponent && opp[0].opponent.id;
      var awayId = opp[1].opponent && opp[1].opponent.id;
      var homeRow = raw.results.filter(function (r) { return r.team_id === homeId; })[0];
      var awayRow = raw.results.filter(function (r) { return r.team_id === awayId; })[0];
      if (homeRow) homeScore = homeRow.score;
      if (awayRow) awayScore = awayRow.score;
    }
    return {
      id: "live-lck-" + raw.id,
      date: kst.date, time: kst.time,
      sport: "esports", league: "LCK",
      venue: (raw.league && raw.league.name) || "",
      home: home, away: away,
      status: ESPORTS_STATUS_MAP[raw.status] || "scheduled",
      homeScore: homeScore, awayScore: awayScore
    };
  }

  function loadEsports() {
    if (!ESPORTS_WORKER_BASE) {
      console.info("[live-data] esports: ESPORTS_WORKER_BASE가 비어 있어서 건너뛰어요.");
      markLoadDone("esports");
      return;
    }
    // LCK 리그 id를 먼저 찾아요 (하드코딩하지 않고 매번 이름으로 검색 — PandaScore
    // 쪽 id가 바뀌더라도 계속 정확하게 동작해요).
    esportsFetch("lol/leagues", { "search[name]": "LCK" }).then(function (leagues) {
      console.log("[live-data] esports LCK leagues raw sample", leagues);
      if (!Array.isArray(leagues) || !leagues.length) {
        console.info("[live-data] esports: LCK 리그를 못 찾았어요.");
        markLoadDone("esports");
        return;
      }
      var leagueId = leagues[0].id;
      var filterParams = { "filter[league_id]": leagueId, "per_page": 20 };
      Promise.all([
        esportsFetch("lol/matches/upcoming", filterParams),
        esportsFetch("lol/matches/past", filterParams),
        esportsFetch("lol/matches/running", filterParams)
      ]).then(function (results) {
        var matches = [];
        results.forEach(function (arr) {
          if (!Array.isArray(arr)) return;
          arr.forEach(function (raw) { matches.push(mapEsportsMatch(raw)); });
        });
        if (matches.length) window.MATCHDAY.setSportMatches("esports", matches);
        else console.info("[live-data] esports: LCK 경기를 못 가져왔어요.");
        markLoadDone("esports");
      }).catch(function () { markLoadDone("esports"); });
    }).catch(function () { markLoadDone("esports"); });
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
    loadEsports(); // ESPORTS_WORKER_BASE를 채워야 동작해요 (README 참고).
    // UFC/격투기(MMA)는 필요하시면 이어서 추가해드릴게요 (league/organization
    // 파라미터 이름을 api-sports.io MMA 문서에서 먼저 확인해야 정확히 짤 수 있어요).

    // 안전장치: 네트워크 문제 등으로 위 요청들이 끝까지 응답하지 않는 극단적인
    // 경우를 대비해서, 20초 뒤에는 화면의 "불러오는 중…" 표시가 무한정 남지
    // 않도록 강제로 정리해요.
    setTimeout(function () {
      ["soccer", "baseball", "basketball", "volleyball", "esports", "motorsport"].forEach(markLoadDone);
    }, 20000);
  });
})();
