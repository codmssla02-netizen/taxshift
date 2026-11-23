// TaxShift 정기 개정 감시 v3 (구글 Apps Script): v2 + 부처 명칭만 바뀐 조문은 카드에서 제외하고 '학습 영향 낮음'으로 표시
// 하루 한 번 4개 법령의 최근 공포일자를 확인하고, 새 개정이 있으면 변경점 카드(AI 요약)와 함께 이메일로 알립니다.
// 문제 생성과 검증은 이 스크립트에 없고 Colab에서 수동으로 합니다.

const OC = "여기에_법제처_OC키";
const MAIL_TO = "여기에_받을_이메일";
const API_KEY = "";                       // Anthropic API 키 (비워 두면 카드 없이 알림만 보냅니다)
const MODEL = "claude-sonnet-5-5";
const LAWS = ["법인세법", "소득세법", "부가가치세법", "국세기본법"];
const CARDS_PER_LAW = 2;

function lawGet_(endpoint, params) {
  const q = Object.keys(params).concat(["OC", "type"]).map(function (k) {
    const v = k === "OC" ? OC : (k === "type" ? "XML" : params[k]);
    return k + "=" + encodeURIComponent(v);
  }).join("&");
  let last = "";
  const bases = ["https://www.law.go.kr/DRF/", "http://www.law.go.kr/DRF/"];
  for (let i = 0; i < bases.length; i++) {
    try {
      const r = UrlFetchApp.fetch(bases[i] + endpoint + "?" + q, { muteHttpExceptions: true });
      if (r.getResponseCode() === 200 && r.getContentText().trim()) return r.getContentText();
      last = "HTTP " + r.getResponseCode();
    } catch (e) {
      last = String(e);
    }
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

function clean_(s) { return s.replace(/<\/?P>/g, ""); }
function norm_(s) { return clean_(s).normalize("NFKC").replace(/\s+/g, ""); }

// 부처 명칭만 바뀐 조문(예: 기획재정부 -> 재정경제부)은 학습 가치가 낮아 카드 후보에서 뺍니다
const RENAMES = [["기획재정부", "재정경제부"]];
function renameOnly_(oldT, newT) {
  let a = norm_(oldT);
  RENAMES.forEach(function (p) { a = a.split(norm_(p[0])).join(norm_(p[1])); });
  return a === norm_(newT);
}

// 바뀐 조문 중 카드로 만들 후보: 글자가 달라졌고, "현행과 같음"이 없고, 신설(개정 전이 <신 설>뿐)이 아니고, 너무 짧지 않은 것
function changedClauses_(mst) {
  const root = XmlService.parse(lawGet_("lawService.do", { target: "oldAndNew", MST: mst })).getRootElement();
  const olds = clauseTexts_(root, "구조문목록"), news = clauseTexts_(root, "신조문목록");
  const out = [];
  let renamed = 0;
  for (let i = 0; i < Math.min(olds.length, news.length); i++) {
    const a = norm_(olds[i]), b = norm_(news[i]);
    if (a === b) continue;
    if (news[i].indexOf("현행과 같음") >= 0 || olds[i].indexOf("현행과 같음") >= 0) continue;
    if (b.length < 40 || b.length > 1500) continue;
    if (a.indexOf("신설") >= 0 && a.length < 12) continue;
    if (renameOnly_(olds[i], news[i])) { renamed++; continue; }
    out.push({ old: clean_(olds[i]), nw: clean_(news[i]) });
  }
  out.renamed = renamed;
  return out;
}

function claude_(prompt) {
  const r = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    payload: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
    muteHttpExceptions: true
  });
  if (r.getResponseCode() !== 200) throw new Error("Claude 호출 실패 HTTP " + r.getResponseCode() + " " + r.getContentText().slice(0, 150));
  return JSON.parse(r.getContentText()).content.filter(function (b) { return b.type === "text"; })
    .map(function (b) { return b.text; }).join("");
}

function summarize_(law, old, nw) {
  const p = law + "의 개정 전 조문과 개정 후 조문을 비교해 수험생용 변경점 요약을 만드세요. 두 조문에 없는 내용은 쓰지 마세요.\n" +
    "조문 번호(제N조, 제N항)는 아래 두 조문에 글자 그대로 적힌 것만 쓰고, 적혀 있지 않으면 번호를 쓰지 마세요. JSON만 출력.\n" +
    '형식: {"headline":"한 줄 제목","changes":["바뀐 점 1","바뀐 점 2"],"easy":"쉬운 설명 2문장 이내"}\n\n[개정 전]\n' + old + "\n\n[개정 후]\n" + nw;
  const t = claude_(p);
  return JSON.parse(t.match(/\{[\s\S]*\}/)[0]);
}

function badRefs_(old, nw, s) {
  const src = old + " " + nw;
  const text = [s.headline].concat(s.changes, [s.easy]).join(" ");
  const found = text.match(/제\d+조(?:의\d+)?/g) || [];
  return found.filter(function (f, i) { return found.indexOf(f) === i && src.indexOf(f) < 0; });
}

function cardText_(law, pair) {
  let s = null, bad = [];
  for (let k = 0; k < 3; k++) {
    try { s = summarize_(law, pair.old, pair.nw); } catch (e) { continue; }
    bad = badRefs_(pair.old, pair.nw, s);
    if (!bad.length) break;
  }
  if (!s) return "    (카드 생성 실패)";
  return "  ▶ " + s.headline + "\n" + s.changes.map(function (c) { return "    · " + c; }).join("\n") +
    "\n    쉬운 설명: " + s.easy +
    (bad.length ? "\n    ⚠ 요약에 원문에 없는 조문 번호가 있습니다: " + bad.join(", ") + " (원문 확인 필요)" : "") +
    "\n    원문(개정 후): " + pair.nw.replace(/\s+/g, " ").slice(0, 200) + "...";
}

function fmt_(d) { return d && d.length === 8 ? d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6) : d; }

function run_(demo) {
  const store = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd");
  const lines = [];
  let changed = false, first = false;
  LAWS.forEach(function (name) {
    let cur;
    try { cur = latestRevision_(name); } catch (e) { lines.push(name + ": 조회 실패 (" + e.message + ")"); return; }
    if (!cur) { lines.push(name + ": 개정 이력을 찾지 못함"); return; }
    const prev = store.getProperty("pub_" + name);
    if (!prev) {
      first = true;
      lines.push(name + ": 기준 기록 저장 (최근 공포 " + fmt_(cur.pub) + ", 시행 " + fmt_(cur.eff) + ")");
    } else if (prev !== cur.pub) {
      changed = true;
      let head = name + ": 개정 감지! " + fmt_(prev) + " → " + fmt_(cur.pub) + " (" + cur.kind + "), 시행 " + fmt_(cur.eff);
      try {
        const cands = changedClauses_(cur.mst);
        head += ", 카드 후보 조문 " + cands.length + "개";
        if (cands.renamed) head += " (부처 명칭만 바뀐 조문 " + cands.renamed + "개는 학습 영향이 낮아 제외)";
        if (API_KEY && cands.length) {
          head += "\n" + cands.slice(0, CARDS_PER_LAW).map(function (c) { return cardText_(name, c); }).join("\n");
        } else if (!API_KEY) {
          head += "\n    (API 키가 없어 카드는 만들지 않았습니다)";
        }
      } catch (e) { head += " (조문 조회 실패: " + e.message + ")"; }
      lines.push(head);
    } else {
      lines.push(name + ": 변화 없음 (최근 공포 " + fmt_(cur.pub) + ")");
    }
    store.setProperty("pub_" + name, cur.pub);
  });
  Logger.log(lines.join("\n"));
  if (first || changed) {
    const pre = demo ? "[시연] 법인세법의 저장 기록을 과거로 되돌려 실행했습니다. 실제로 새 개정이 생긴 것은 아닙니다.\n\n" : "";
    const subject = "[TaxShift] " + today + (changed ? " 개정 감지" : " 감시 시작(기준 기록 저장)");
    MailApp.sendEmail(MAIL_TO, subject, pre + lines.join("\n\n") +
      "\n\n※ 요약은 AI가 만든 것이므로 반드시 원문 조문과 함께 확인하세요. 이 알림은 공포일자 변화를 기준으로 합니다.");
  }
}

function checkLaws() { run_(false); }

function demoRollback() {
  PropertiesService.getScriptProperties().setProperty("pub_법인세법", "20200101");
  run_(true);
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "checkLaws") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("checkLaws").timeBased().everyDays(1).atHour(8).create();
  Logger.log("매일 오전 8시 자동 실행을 등록했습니다.");
}
