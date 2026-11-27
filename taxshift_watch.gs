// TaxShift 자동 흐름 v4 (구글 Apps Script)
// 개정 감지 -> 변경점 카드 -> 문제 생성(4지선다·O/X) -> 3단계 검증 -> 결과 저장 -> 풀이 화면이 주소로 불러감
// 하루 한 번(트리거) 4개 법령의 최근 공포일자를 확인하고, 새 개정이 있으면 위 과정을 자동으로 실행합니다.
//
// 키는 코드에 적지 않습니다. 프로젝트 설정(톱니바퀴) > 스크립트 속성에 아래 3개를 직접 입력하세요.
//   OC       : 법제처 OC 키
//   API_KEY  : Anthropic API 키
//   MAIL_TO  : 알림 받을 이메일
//
// 한계: 법령 전체의 시행일 하나만 기록합니다(조문별 부분 시행은 구분하지 않음). 전문가 검수는 거치지 않았습니다.
//       생성·검증은 AI가 하며, 통과는 법적 해석의 정확성을 보장하지 않습니다.

const MODEL = "claude-sonnet-5-5";
const LAWS = ["법인세법", "소득세법", "부가가치세법", "국세기본법"];
const CARDS_PER_LAW = 2;              // 법령당 카드·문제 수 (실행 시간 제한 때문에 Colab(3개)보다 적게)
const TIME_BUDGET_MS = 270000;        // 앱스 스크립트 1회 실행 제한(6분)보다 일찍 멈춤
const FILE_NAME = "taxshift_run.json";

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ""; }

// ---------------- 법제처 ----------------
function lawGet_(endpoint, params) {
  const q = Object.keys(params).concat(["OC", "type"]).map(function (k) {
    const v = k === "OC" ? prop_("OC") : (k === "type" ? "XML" : params[k]);
    return k + "=" + encodeURIComponent(v);
  }).join("&");
  let last = "";
  const bases = ["https://www.law.go.kr/DRF/", "http://www.law.go.kr/DRF/"];
  for (let i = 0; i < bases.length; i++) {
    try {
      const r = UrlFetchApp.fetch(bases[i] + endpoint + "?" + q, { muteHttpExceptions: true });
      if (r.getResponseCode() === 200 && r.getContentText().trim()) return r.getContentText();
      last = "HTTP " + r.getResponseCode();
    } catch (e) { last = String(e); }
  }
  throw new Error("법제처 호출 실패: " + last);
}

function allElements_(el, out) {
  out.push(el);
  el.getChildren().forEach(function (c) { allElements_(c, out); });
  return out;
}

function latestRevision_(name) {
  const root = XmlService.parse(lawGet_("lawSearch.do", { target: "oldAndNew", query: name, display: 20 })).getRootElement();
  let best = null;
  allElements_(root, []).forEach(function (el) {
    const kids = {};
    el.getChildren().forEach(function (c) {
      if (c.getChildren().length === 0) kids[c.getName()] = c.getText().trim();
    });
    if (kids["신구법일련번호"] && kids["신구법명"] === name && kids["공포일자"]) {
      const cand = { pub: kids["공포일자"], mst: kids["신구법일련번호"], kind: kids["제개정구분명"] || "", eff: kids["시행일자"] || "" };
      if (!best || cand.pub > best.pub) best = cand;
    }
  });
  return best;
}

function clauseTexts_(root, tag) {
  const holder = allElements_(root, []).filter(function (e) { return e.getName() === tag; })[0];
  if (!holder) return [];
  return allElements_(holder, []).filter(function (e) { return e.getName() === "조문"; })
    .map(function (e) { return e.getValue().trim(); });
}

function clean_(s) { return (s || "").replace(/<\/?P>/g, ""); }
function norm_(s) { return clean_(s).normalize("NFKC").replace(/\s+/g, ""); }

// 부처 명칭만 바뀐 조문(예: 기획재정부 -> 재정경제부)은 학습 가치가 낮아 제외
const RENAMES = [["기획재정부", "재정경제부"]];
function renameOnly_(oldT, newT) {
  let a = norm_(oldT);
  RENAMES.forEach(function (p) { a = a.split(norm_(p[0])).join(norm_(p[1])); });
  return a === norm_(newT);
}

// 바뀐 조문 중 카드로 만들 후보 (원문은 <P> 표시를 그대로 유지)
function changedClauses_(mst) {
  const root = XmlService.parse(lawGet_("lawService.do", { target: "oldAndNew", MST: mst })).getRootElement();
  const olds = clauseTexts_(root, "구조문목록"), news = clauseTexts_(root, "신조문목록");
  const out = [];
  for (let i = 0; i < Math.min(olds.length, news.length); i++) {
    const a = norm_(olds[i]), b = norm_(news[i]);
    if (a === b) continue;
    if (news[i].indexOf("현행과 같음") >= 0 || olds[i].indexOf("현행과 같음") >= 0) continue;
    if (news[i].length < 40 || news[i].length > 1500) continue;
    if (a.indexOf("신설") >= 0 && a.length < 12) continue;
    if (renameOnly_(olds[i], news[i])) continue;
    out.push({ old: olds[i], nw: news[i] });
  }
  return out;
}

// ---------------- Claude ----------------
function claude_(prompt, maxTokens) {
  const r = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": prop_("API_KEY"), "anthropic-version": "2023-06-01" },
    payload: JSON.stringify({ model: MODEL, max_tokens: maxTokens || 2000, messages: [{ role: "user", content: prompt }] }),
    muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) throw new Error("Claude 호출 실패 HTTP " + r.getResponseCode() + " " + r.getContentText().slice(0, 150));
  return JSON.parse(r.getContentText()).content.filter(function (b) { return b.type === "text"; })
    .map(function (b) { return b.text; }).join("");
}

function json_(t) { return JSON.parse(t.match(/\{[\s\S]*\}/)[0]); }

// 1) 변경점 카드
function summarize_(law, old, nw) {
  return json_(claude_(law + "의 개정 전 조문과 개정 후 조문을 비교해 수험생용 변경점 요약을 만드세요. 두 조문에 없는 내용은 쓰지 마세요.\n" +
    "조문 번호(제N조, 제N항)는 아래 두 조문에 글자 그대로 적힌 것만 쓰고, 적혀 있지 않으면 번호를 쓰지 마세요. JSON만 출력.\n" +
    '형식: {"headline":"한 줄 제목","changes":["바뀐 점 1","바뀐 점 2"],"easy":"쉬운 설명 2문장 이내"}\n\n[개정 전]\n' + old + "\n\n[개정 후]\n" + nw, 1500));
}

function badRefs_(old, nw, s) {
  const src = old + " " + nw;
  const text = [s.headline].concat(s.changes, [s.easy]).join(" ");
  const found = text.match(/제\d+조(?:의\d+)?/g) || [];
  return found.filter(function (f, i) { return found.indexOf(f) === i && src.indexOf(f) < 0; });
}

function makeCard_(law, old, nw) {
  let s = null, bad = [];
  for (let k = 0; k < 3; k++) {
    try { s = summarize_(law, old, nw); } catch (e) { continue; }
    bad = badRefs_(old, nw, s);
    if (!bad.length) break;
  }
  return { card: s, bad: bad };
}

function shuffle_(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// 2) 문제 생성
function genChanged_(law, old, nw) {
  const p = law + "의 개정 전 조문과 개정 후 조문입니다. 두 조문에서 '바뀐 부분'(개정 후 조문의 <P>~</P> 표시)을 이해했는지 묻는 4지선다 문제를 1개 만드세요.\n\n" +
    "반드시 지킬 규칙:\n" +
    "1. 정답은 개정 후 조문의 문구를 그대로, 또는 거의 그대로 옮긴 내용이어야 합니다. 조문에 직접 적혀 있지 않은 해석이나 일반화(예: '~에 한정되지 않는다', '~도 포함된다', '~와 관계없이')를 정답으로 삼지 마세요.\n" +
    "2. 바뀐 부분(<P> 표시 부분)을 직접 묻고, 조문 번호·항 번호를 맞히는 문제는 만들지 마세요.\n" +
    "3. '(현행과 같음)'이라고 적힌 부분이나 바뀌지 않은 내용은 문제로 만들지 마세요.\n" +
    "4. 오답 보기 중 하나는 개정 전 문구를 그대로 쓰세요(개정을 모르는 수험생이 고르는 함정). 나머지 오답은 조문 문구를 일부만 바꿔 만드세요.\n" +
    "5. 문제문은 조문을 보지 않아도 이해되는 완결된 문장으로 쓰고 '제시된 조문' 같은 표현은 금지입니다.\n" +
    'JSON만 출력. 형식: {"question":"...","choices":["...","...","...","..."],"answer_index":0~3,"evidence":"개정 후 조문에서 그대로 복사한 근거 문장"}\n' +
    "evidence는 개정 후 조문의 문장을 한 글자도 바꾸지 말고 복사하세요.\n\n[개정 전]\n" + old + "\n\n[개정 후]\n" + nw;
  const q = json_(claude_(p, 2500));
  const correct = q.choices[q.answer_index];
  shuffle_(q.choices);
  q.answer_index = q.choices.indexOf(correct);
  return q;
}

function genOx_(law, old, nw) {
  const target = Math.random() < 0.5 ? "O" : "X";      // 정답(O/X)은 AI가 아니라 코드가 먼저 정합니다
  const rule = target === "O"
    ? "서술은 개정 후 조문의 바뀐 부분(<P>~</P>)을 그대로 또는 거의 그대로 옮겨, 개정 후 규정에 비추어 '옳은' 서술로 쓰세요."
    : "서술은 개정 후 조문의 바뀐 부분(<P>~</P>)을 개정 전 문구(또는 조문과 다른 값)로 바꿔, 개정 후 규정에 비추어 '틀린' 서술로 쓰세요.";
  const p = law + "의 개정 전 조문과 개정 후 조문입니다. 개정으로 바뀐 부분을 이해했는지 묻는 O/X 문제의 '서술문' 1개를 만드세요.\n\n규칙:\n" +
    "1. " + rule + "\n" +
    "2. 서술문은 조문을 보지 않아도 이해되는 완결된 한 문장으로 쓰고, '제시된 조문' 같은 표현은 금지입니다.\n" +
    "3. 조문 번호·항 번호를 맞히는 서술이나, '(현행과 같음)' 등 바뀌지 않은 내용은 쓰지 마세요.\n" +
    "4. 조문에 직접 적혀 있지 않은 해석이나 일반화는 쓰지 마세요.\n" +
    'JSON만 출력. 형식: {"statement":"...","evidence":"개정 후 조문에서 이 서술의 맞고 틀림을 판단할 수 있는 문장을 한 글자도 바꾸지 말고 복사"}\n\n[개정 전]\n' + old + "\n\n[개정 후]\n" + nw;
  const d = json_(claude_(p, 1500));
  return {
    question: law + " 개정 후 규정에 비추어 다음 서술이 옳으면 O, 틀리면 X를 고르시오. 서술: " + d.statement,
    choices: ["O", "X"],
    answer_index: target === "O" ? 0 : 1,
    evidence: d.evidence
  };
}

// 3) 3단계 검증: (1) 근거 문장 일치 (2) 조문만 보고 다시 풀기 (3) AI 심사(직접성·변경점)
function resolve_(nw, q) {
  const p = "아래 조문만 보고 문제의 정답 번호를 고르세요(번호는 0부터 시작). JSON만 출력: {\"answer_index\":번호}\n\n[조문]\n" + clean_(nw) +
    "\n\n[문제]\n" + q.question + "\n" + q.choices.map(function (c, i) { return i + ". " + c; }).join("\n");
  return json_(claude_(p, 500)).answer_index;
}

function verify_(nw, q) {
  if (!q.evidence || norm_(nw).indexOf(norm_(q.evidence)) < 0) return { ok: false, why: "근거 문장이 조문에 없음" };
  if (resolve_(nw, q) !== q.answer_index) return { ok: false, why: "재풀이 답이 출제 정답과 다름" };
  return { ok: true, why: "근거 일치 + 재풀이 일치" };
}

function judge_(old, nw, q) {
  const p = "당신은 세법 시험 문제 검토자입니다. 아래 개정 전·후 조문과 문제를 보고 두 가지를 판정하세요. JSON만 출력.\n" +
    "1) direct: 정답이 개정 후 조문의 문구에서 추가 해석이나 추론 없이 직접 확인되면 true, 조문에 직접 적혀 있지 않은 해석·추론이 정답에 들어 있으면 false.\n" +
    "2) tests_change: 문제가 개정으로 바뀐 내용(무엇이 어떻게 달라졌는지)을 묻고 있으면 true, 조문 번호·항 번호 같은 단순 암기를 묻거나 바뀐 내용과 무관하면 false.\n" +
    '형식: {"direct":true/false,"tests_change":true/false,"reason":"한 문장"}\n\n[개정 전]\n' + clean_(old) + "\n\n[개정 후]\n" + clean_(nw) +
    "\n\n[문제]\n" + q.question + "\n" + q.choices.map(function (c, i) { return (i + 1) + ". " + c; }).join("\n") + "\n정답: " + (q.answer_index + 1) + "번";
  return json_(claude_(p, 800));
}

function oneQuestion_(gen, law, old, nw) {
  const o = { q: null, 단계: "오류", 사유: "" };
  try {
    for (let k = 0; k < 2; k++) {                       // 응답 형식 오류만 재시도
      try { o.q = gen(law, old, nw); break; } catch (e) { o.사유 = String(e).slice(0, 80); }
    }
    if (!o.q) return o;
    const v = verify_(nw, o.q);
    if (!v.ok) { o.단계 = "폐기"; o.사유 = v.why; return o; }
    const j = judge_(old, nw, o.q);
    o.단계 = (j.direct && j.tests_change) ? "통과" : "검수 필요";
    o.사유 = j.reason || "";
  } catch (e) { o.사유 = String(e).slice(0, 80); }
  return o;
}

function buildOne_(law, rev, pair) {
  const mc = oneQuestion_(genChanged_, law, pair.old, pair.nw);
  const ox = oneQuestion_(genOx_, law, pair.old, pair.nw);
  let card = null, bad = [];
  try { const c = makeCard_(law, pair.old, pair.nw); card = c.card; bad = c.bad; } catch (e) {}
  return {
    "법령": law, "공포": fmt_(rev.pub), "시행": fmt_(rev.eff), "구분": rev.kind,
    "카드": card, "경고": bad, "q": mc.q, "단계": mc.단계, "사유": mc.사유,
    "old": pair.old, "new": pair.nw,
    "ox": { q: ox.q, "단계": ox.단계, "사유": ox.사유 }
  };
}

// ---------------- 결과 저장 / 제공 ----------------
function fmt_(d) { return d && d.length === 8 ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6) : (d || ""); }

function loadStore_() {
  const id = prop_("FILE_ID");
  if (id) {
    try { return JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString("utf-8")); } catch (e) {}
  }
  return { generated: "", results: [] };
}

function saveStore_(store) {
  store.generated = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm");
  const body = JSON.stringify(store);
  const id = prop_("FILE_ID");
  if (id) {
    try { DriveApp.getFileById(id).setContent(body); return; } catch (e) {}
  }
  const f = DriveApp.createFile(FILE_NAME, body, "application/json");
  PropertiesService.getScriptProperties().setProperty("FILE_ID", f.getId());
}

// 한 법령의 최신 개정을 처리해 저장소의 그 법령 항목을 교체합니다
function buildLaw_(name, rev, store) {
  const cands = changedClauses_(rev.mst).slice(0, CARDS_PER_LAW);
  const fresh = cands.map(function (c) { return buildOne_(name, rev, c); });
  store.results = store.results.filter(function (r) { return r["법령"] !== name; }).concat(fresh);
  store.pubs = store.pubs || {};
  store.pubs[name] = rev.pub;
  return fresh.length;
}

// 풀이 화면이 이 주소(웹 앱)를 불러갑니다
function doGet() {
  return ContentService.createTextOutput(JSON.stringify(loadStore_())).setMimeType(ContentService.MimeType.JSON);
}

// ---------------- 실행 진입점 ----------------
// (처음 한 번) 4개 법령의 최신 개정으로 화면 데이터를 채웁니다. 시간이 모자라면 멈추니, "실행 완료"가 나올 때까지 다시 누르세요.
function seedAll() {
  const t0 = Date.now();
  const store = loadStore_();
  store.pubs = store.pubs || {};
  const log = [];
  for (let i = 0; i < LAWS.length; i++) {
    const name = LAWS[i];
    if (Date.now() - t0 > TIME_BUDGET_MS) { log.push("시간이 다 되어 멈춤: 같은 함수를 한 번 더 실행하세요"); break; }
    const rev = latestRevision_(name);
    if (!rev) { log.push(name + ": 개정 이력을 찾지 못함"); continue; }
    if (store.pubs[name] === rev.pub) { log.push(name + ": 이미 처리됨 (공포 " + fmt_(rev.pub) + ")"); continue; }
    try { log.push(name + ": 문제 " + buildLaw_(name, rev, store) + "건 처리 (공포 " + fmt_(rev.pub) + ", 시행 " + fmt_(rev.eff) + ")"); }
    catch (e) { log.push(name + ": 실패 (" + e.message + ")"); }
    PropertiesService.getScriptProperties().setProperty("pub_" + name, rev.pub);   // 감시 기준 기록도 함께 맞춤
    saveStore_(store);
  }
  Logger.log(log.join("\n"));
  if (log.every(function (l) { return l.indexOf("시간이 다 되어") < 0; })) Logger.log("실행 완료");
}

function runWatch_(demo) {
  const today = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd");
  const store = loadStore_();
  const lines = [];
  let changed = false;
  LAWS.forEach(function (name) {
    let cur;
    try { cur = latestRevision_(name); } catch (e) { lines.push(name + ": 조회 실패 (" + e.message + ")"); return; }
    if (!cur) { lines.push(name + ": 개정 이력을 찾지 못함"); return; }
    const prev = prop_("pub_" + name);
    if (!prev) {
      lines.push(name + ": 기준 기록 저장 (최근 공포 " + fmt_(cur.pub) + ", 시행 " + fmt_(cur.eff) + ")");
    } else if (prev !== cur.pub) {
      changed = true;
      let head = name + ": 개정 감지! " + fmt_(prev) + " → " + fmt_(cur.pub) + " (" + cur.kind + "), 시행 " + fmt_(cur.eff);
      try {
        const n = buildLaw_(name, cur, store);
        saveStore_(store);
        head += "\n    → 카드·문제 " + n + "건을 자동 생성·검증해 풀이 화면 데이터에 반영했습니다.";
      } catch (e) { head += "\n    (자동 생성 실패: " + e.message + ")"; }
      lines.push(head);
    } else {
      lines.push(name + ": 변화 없음 (최근 공포 " + fmt_(cur.pub) + ")");
    }
    PropertiesService.getScriptProperties().setProperty("pub_" + name, cur.pub);
  });
  Logger.log(lines.join("\n"));
  if (changed && prop_("MAIL_TO")) {
    const pre = demo ? "[시연] 저장 기록을 과거로 되돌려 실행했습니다. 실제로 새 개정이 생긴 것은 아닙니다.\n\n" : "";
    MailApp.sendEmail(prop_("MAIL_TO"), "[TaxShift] " + today + " 개정 감지", pre + lines.join("\n\n") +
      "\n\n※ 문제·요약은 AI가 만든 것이며 전문가 검수를 거치지 않았습니다. 시행일은 법령 전체 기준이며 조문별 부분 시행은 구분하지 않습니다. 원문 조문을 확인하세요.");
  }
}

function checkLaws() { runWatch_(false); }

// 시연: 법인세법 기록을 과거로 되돌려, 감지부터 화면 데이터 반영까지 한 번에 실행해 봅니다
function demoRollback() {
  PropertiesService.getScriptProperties().setProperty("pub_법인세법", "20200101");
  runWatch_(true);
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "checkLaws") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("checkLaws").timeBased().everyDays(1).atHour(8).create();
  Logger.log("매일 오전 8시 자동 실행을 등록했습니다.");
}
