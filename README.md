# MATCHDAY — 무료 호스팅 + 실시간 데이터 연동 가이드

이 폴더에는 매치데이 사이트 전체 파일이 들어 있어요 (`index.html`, `manifest.json`, `sw.js`, 아이콘, `worker.js`, `live-data.js`). Claude 아티팩트와 달리, 외부로 배포하면 브라우저에서 실제 API를 직접 호출할 수 있어서 진짜 실시간 데이터 연동이 가능해져요.

## 1. 사이트 배포 — GitHub Pages (무료, 추천)

1. github.com 에서 새 저장소(repository)를 만들어요. (Public으로)
2. 이 폴더의 파일을 그대로 저장소에 업로드해요: `index.html`, `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`. (`live-data.js`를 실제로 사용할 준비가 되면 이것도 함께 업로드하고, index.html에 연결하는 방법은 4번 참고)
3. 저장소 `Settings → Pages`에서 Source를 `main` 브랜치, 루트(`/`)로 설정하고 저장해요.
4. 1~2분 후 `https://<사용자아이디>.github.io/<저장소이름>/` 주소로 사이트가 열려요.
5. 모바일에서 그 주소로 접속 후 "홈 화면에 추가"를 누르면 앱처럼 설치돼요.

Vercel이나 Netlify에 가입해서 이 폴더를 드래그 앤 드롭해도 동일하게 무료로 배포할 수 있어요.

## 2. 실시간 데이터 연동 — 전체 구조

```
브라우저(사이트) ──▶ Cloudflare Worker(프록시, worker.js) ──▶ api-sports.io (축구/야구/농구/배구/격투기)
              └──▶ OpenF1 (F1, 키 불필요, 프록시 없이 직접 호출)
```

api-sports.io는 API 키를 요구하는데, 이 키를 index.html 안에 그대로 넣으면 누구나 브라우저 개발자도구로 훔쳐볼 수 있어요. 그래서 `worker.js`(Cloudflare Workers, 무료)가 키를 안전하게 숨기는 중계 서버 역할을 해요. F1 데이터(OpenF1)는 애초에 키가 필요 없어서 프록시 없이 바로 호출해요.

### 2-1. api-sports.io 키 발급

1. https://dashboard.api-football.com (또는 api-sports.io) 무료 가입 → 대시보드에서 API 키 확인.
   - 축구/야구/농구/배구/격투기(MMA)가 한 계정, 한 키로 공용이에요 (스포츠별로 별도 구독/플랜 선택은 필요할 수 있어요).
   - 무료 티어: API당 하루 100건 요청. 이 사이트는 15분 캐시를 쓰기 때문에 방문자가 많아도 실제 상위 API 호출은 하루 100건 안쪽으로 충분히 유지돼요.
2. **리그 번호(league id) 확인**: 각 스포츠 API의 "Leagues" 엔드포인트에서 국가를 "Korea"로 검색하면 K리그1 / KBO / KBL / V리그의 정확한 번호가 나와요. (임의로 추정한 번호를 코드에 넣지 않았어요 — 잘못된 번호를 넣으면 엉뚱한 데이터가 나오기 때문에, 직접 확인하시거나 확인해서 알려주시면 제가 코드에 반영해드릴게요.)

### 2-2. Cloudflare Worker 배포 (worker.js)

1. https://dash.cloudflare.com 무료 가입 (카드 불필요)
2. 좌측 메뉴 `Workers & Pages` → `Create` → `Create Worker`
3. 이름을 정하고 생성 → `Edit code` 들어가서 `worker.js` 내용을 전부 붙여넣기 → `Deploy`
4. Worker의 `Settings → Variables and Secrets → Add`
   - 이름: `API_SPORTS_KEY`
   - 값: 2-1에서 발급받은 API 키
   - Type을 반드시 **Secret**으로 설정 (Text 아님) → 저장 후 재배포
5. 배포되면 `https://<worker이름>.<계정서브도메인>.workers.dev` 형태의 주소가 생겨요.
6. `worker.js` 안의 `ALLOWED_ORIGIN = "*"`를 배포한 사이트 주소(예: `https://내아이디.github.io`)로 좁혀주면 더 안전해요.

### 2-3. live-data.js 설정

1. `live-data.js` 파일 상단의 `WORKER_BASE`에 5번에서 받은 Worker 주소를 넣어요.
2. `LEAGUE_IDS`에 2-1에서 확인한 리그 번호를 넣어요. (모르는 종목은 `null`로 두면 그 종목만 예시 데이터로 유지되고 나머지는 정상 동작해요.)
3. `index.html`의 메인 `<script>` 태그 **바로 앞**에 아래를 추가해요.
   ```html
   <script src="live-data.js"></script>
   ```
4. 배포 후 사이트를 열고 브라우저 개발자도구(콘솔)를 확인하세요. 각 종목의 실제 API 응답이 `console.log`로 찍히도록 해뒀어요 — 필드 구조가 예상과 다르면 알려주시면 매핑 코드를 바로 고쳐드릴게요.

### 2-4. F1은 별도 설정 없이 자동 동작

F1은 OpenF1(api.openf1.org)을 키 없이 직접 호출해서, `WORKER_BASE`나 `LEAGUE_IDS` 설정과 무관하게 `live-data.js`만 연결하면 바로 동작해요.

### 2-5. 정확도에 대한 솔직한 안내

- `worker.js`와 `live-data.js`의 api-sports.io 관련 코드는 이 API 계열의 널리 알려진 공개 문서 구조를 기준으로 작성했고, 실제 키로 직접 호출해서 검증한 건 아니에요. 필드 이름이 다르면 콘솔 로그를 보고 함께 고치면 돼요.
- OpenF1(F1) 쪽 필드명(`meeting_name`, `session_name`, `date_start`, `session_result`, `drivers` 등)은 공식 문서에서 직접 확인한 내용이에요.
- UFC/격투기(MMA)는 이번 라운드에서 자동 연동을 넣지 않았어요 — api-sports.io MMA API의 정확한 파라미터를 확인한 뒤 이어서 추가해드릴게요.
- e스포츠(LCK 등)는 api-sports.io에 해당 상품이 없어서 이번 라운드에서는 제외했어요.

## 3. 지금 이대로도 동작해요

`live-data.js`를 연결하지 않으면 지금처럼 예시 데이터로 정상 작동하는 사이트예요. 준비되는 대로 하나씩 연동하면 되고, 언제든 이어서 요청해주시면 다음 단계(격투기/e스포츠 연동, 정확한 응답 구조 반영 등)를 진행해드릴게요.
