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
  var SPORTSDB_KEY = "123";
  var SPORTSDB_BASE = "https://www.thesportsdb.com/api/v1/json/" + SPORTSDB_KEY;

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
    baseball: [ { id: 4830, label: "KBO" } ],
    basketball: [ { id: 5124, label: "KBL" } ],
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

  function loadSportFromSportsDb(matchdaySport) {
    var leagues = (LEAGUES[matchdaySport] || []).filter(function (lg) { return lg && lg.id; });
    if (!leagues.length) {
      console.info("[live-data] LEAGUES." + matchdaySport + "이 비어 있어 이 종목은 예시 데이터를 유지합니다.");
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
      else console.info("[live-data] " + matchdaySport + ": TheSportsDB에서 가져온 경기가 없어요 (예시 데이터 유지).");
    });
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

        // 종료된 세션은 session_result + drivers로 전체 완주 순위표(raceResults)를
        // 만들어요. home/away/homeScore/awayScore는 목록/캘린더 화면에서 쓰는
        // 예전 방식(상위 2명) 그대로 남겨두지만, 상세 화면은 이제 raceResults를
        // 우선 사용해서 실제 순위표 형태로 보여줘요 (renderPreviewFor 참고).
        return Promise.all([
          openf1("/session_result", { session_key: s.session_key }),
          openf1("/drivers", { session_key: s.session_key })
        ]).then(function (r) {
          var results = r[0] || [], drivers = r[1] || [];
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
