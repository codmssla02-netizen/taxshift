# TaxShift 통합 실행 (v6: v5 + O/X 문제 유형 추가): 오늘 기준 개정 감지 -> 변경점 카드 -> 문제 생성 -> 3단계 검증 -> (시험일 필터) -> (이메일)
# Colab 새 셀에 통째로 붙여넣고 실행하세요. 키는 입력창에 직접 입력합니다.
import re, json, random, unicodedata, getpass, requests, time
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from collections import Counter
import xml.etree.ElementTree as ET

OC = getpass.getpass("법제처 OC 키: ").strip()
API_KEY = getpass.getpass("Anthropic API 키: ").strip()
EXAM = input("시험 기준일 (예: 2026-12-01, 적용하지 않으려면 엔터): ").strip()
MAIL_TO = input("알림 받을 이메일 (보내지 않으려면 엔터): ").strip()
if MAIL_TO:
    MAIL_PW = getpass.getpass("Gmail 앱 비밀번호(16자리): ").replace(" ", "").strip()

MODEL = "claude-sonnet-5-5"
LAWS = ["법인세법", "소득세법", "부가가치세법", "국세기본법"]
LOOKBACK_DAYS = 400      # 오늘 기준 최근 며칠 안에 공포된 개정을 찾을지 (시연에 법인세법 등을 넣으려면 400)
CARDS_PER_LAW = 3        # 법령당 카드·문제 수


def law_call(endpoint, **params):
    params.update(OC=OC, type="XML")
    last = None
    for base in ["https://www.law.go.kr/DRF/", "http://www.law.go.kr/DRF/"]:
        try:
            r = requests.get(base + endpoint, params=params, timeout=30)
            r.encoding = "utf-8"
            if r.status_code == 200 and r.text.strip():
                return r.text
            last = f"HTTP {r.status_code}"
        except Exception as e:
            last = repr(e)
    raise RuntimeError(last)


def norm(s): return re.sub(r"\s+", "", unicodedata.normalize("NFKC", s or ""))
def clean(s): return re.sub(r"</?P>", "", s or "")
def ymd(s): return datetime.strptime(s, "%Y%m%d").date()
def show(s, n=100):
    s = clean(s)
    return s if len(s) <= n else s[:n] + "…"


def latest_revision(name):
    root = ET.fromstring(law_call("lawSearch.do", target="oldAndNew", query=name, display=20))
    best = None
    for el in root.iter():
        kids = {c.tag: (c.text or "").strip() for c in el if len(c) == 0}
        if "신구법일련번호" in kids and kids.get("신구법명") == name and kids.get("공포일자"):
            cand = (kids["공포일자"], kids["신구법일련번호"], kids.get("제개정구분명", ""), kids.get("시행일자", ""))
            if best is None or cand[0] > best[0]:
                best = cand
    return best


def clauses(root, tag):
    for el in root.iter():
        if el.tag == tag:
            return ["".join(c.itertext()).strip() for c in el.iter() if c.tag == "조문"]
    return []


RENAMES = [("기획재정부", "재정경제부")]   # 부처 명칭 변경만으로 바뀐 조문은 학습 가치가 낮아 제외


def rename_only(old, new):
    a = norm(clean(old))
    for x, y in RENAMES:
        a = a.replace(norm(x), norm(y))
    return a == norm(clean(new))


def changed_clauses(mst, min_len=40):
    root = ET.fromstring(law_call("lawService.do", target="oldAndNew", MST=mst))
    old, new = clauses(root, "구조문목록"), clauses(root, "신조문목록")
    out = []
    for o, n in zip(old, new):
        a, b = norm(clean(o)), norm(clean(n))
        if a == b or not (min_len <= len(n) <= 1500):
            continue
        if "현행과 같음" in o or "현행과 같음" in n:
            continue                                  # 바뀌지 않은 부분이 섞인 조문 제외
        if rename_only(o, n):
            continue                                  # 부처 명칭만 바뀐 조문 제외
        if "신설" in a and len(a) < 12:
            continue                                  # 신설 조문(개정 전이 <신 설>뿐) 제외
        out.append((o, n))
    return out


def claude(prompt, max_tokens=4000):
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={"model": MODEL, "max_tokens": max_tokens, "messages": [{"role": "user", "content": prompt}]},
        timeout=120,
    )
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
    return "".join(b.get("text", "") for b in r.json()["content"] if b.get("type") == "text")


def parse_json(text):
    return json.loads(re.search(r"\{.*\}", text, re.S).group(0))


def summarize(law, old, new):
    p = f"""{law}의 개정 전 조문과 개정 후 조문을 비교해 수험생용 변경점 요약을 만드세요. 두 조문에 없는 내용은 쓰지 마세요.
조문 번호(제N조, 제N항)는 아래 두 조문에 글자 그대로 적힌 것만 쓰고, 적혀 있지 않으면 번호를 쓰지 마세요. JSON만 출력.
형식: {{"headline":"한 줄 제목","changes":["바뀐 점 1","바뀐 점 2"],"easy":"쉬운 설명 2문장 이내"}}

[개정 전]
{old}

[개정 후]
{new}"""
    return parse_json(claude(p))


def bad_refs(old, new, s):
    src = old + " " + new
    text = " ".join([s["headline"]] + s["changes"] + [s["easy"]])
    return sorted(f for f in set(re.findall(r"제\d+조(?:의\d+)?", text)) if f not in src)


def make_card(law, old, new):
    s, bad = None, []
    for _ in range(3):
        try:
            s = summarize(law, old, new)
        except Exception:
            continue
        bad = bad_refs(old, new, s)
        if not bad:
            break
    return s, bad


def generate_changed(law, old, new):
    p = f"""{law}의 개정 전 조문과 개정 후 조문입니다. 두 조문에서 '바뀐 부분'(개정 후 조문의 <P>~</P> 표시)을 이해했는지 묻는 4지선다 문제를 1개 만드세요.

반드시 지킬 규칙:
1. 정답은 개정 후 조문의 문구를 그대로, 또는 거의 그대로 옮긴 내용이어야 합니다. 조문에 직접 적혀 있지 않은 해석이나 일반화(예: '~에 한정되지 않는다', '~도 포함된다', '~와 관계없이')를 정답으로 삼지 마세요.
2. 바뀐 부분(<P> 표시 부분)을 직접 묻고, 조문 번호·항 번호를 맞히는 문제는 만들지 마세요.
3. '(현행과 같음)'이라고 적힌 부분이나 바뀌지 않은 내용은 문제로 만들지 마세요.
4. 오답 보기 중 하나는 개정 전 문구를 그대로 쓰세요(개정을 모르는 수험생이 고르는 함정). 나머지 오답은 조문 문구를 일부만 바꿔 만드세요.
5. 문제문은 조문을 보지 않아도 이해되는 완결된 문장으로 쓰고 '제시된 조문' 같은 표현은 금지입니다.
JSON만 출력. 형식: {{"question":"...","choices":["...","...","...","..."],"answer_index":0~3,"evidence":"개정 후 조문에서 그대로 복사한 근거 문장"}}
evidence는 개정 후 조문의 문장을 한 글자도 바꾸지 말고 복사하세요.

[개정 전]
{old}

[개정 후]
{new}"""
    q = parse_json(claude(p))
    correct = q["choices"][q["answer_index"]]
    random.shuffle(q["choices"])
    q["answer_index"] = q["choices"].index(correct)
    return q


def generate_ox(law, old, new):
    target = random.choice(["O", "X"])             # 정답(O/X)은 AI가 아니라 코드가 먼저 정합니다
    if target == "O":
        rule = "서술은 개정 후 조문의 바뀐 부분(<P>~</P>)을 그대로 또는 거의 그대로 옮겨, 개정 후 규정에 비추어 '옳은' 서술로 쓰세요."
    else:
        rule = "서술은 개정 후 조문의 바뀐 부분(<P>~</P>)을 개정 전 문구(또는 조문과 다른 값)로 바꿔, 개정 후 규정에 비추어 '틀린' 서술로 쓰세요."
    p = f"""{law}의 개정 전 조문과 개정 후 조문입니다. 개정으로 바뀐 부분을 이해했는지 묻는 O/X 문제의 '서술문' 1개를 만드세요.

규칙:
1. {rule}
2. 서술문은 조문을 보지 않아도 이해되는 완결된 한 문장으로 쓰고, '제시된 조문' 같은 표현은 금지입니다.
3. 조문 번호·항 번호를 맞히는 서술이나, '(현행과 같음)' 등 바뀌지 않은 내용은 쓰지 마세요.
4. 조문에 직접 적혀 있지 않은 해석이나 일반화는 쓰지 마세요.
JSON만 출력. 형식: {{"statement":"...","evidence":"개정 후 조문에서 이 서술의 맞고 틀림을 판단할 수 있는 문장을 한 글자도 바꾸지 말고 복사"}}

[개정 전]
{old}

[개정 후]
{new}"""
    d = parse_json(claude(p))
    return {
        "question": f"{law} 개정 후 규정에 비추어 다음 서술이 옳으면 O, 틀리면 X를 고르시오. 서술: {d['statement']}",
        "choices": ["O", "X"],
        "answer_index": 0 if target == "O" else 1,
        "evidence": d["evidence"],
    }


def resolve(new, q):
    p = f"""아래 조문만 보고 문제의 정답 번호를 고르세요(번호는 0부터 시작). JSON만 출력: {{"answer_index":번호}}

[조문]
{new}

[문제]
{q['question']}
""" + "\n".join(f"{i}. {c}" for i, c in enumerate(q["choices"]))
    return parse_json(claude(p))["answer_index"]


def verify(new, q):
    if not q.get("evidence") or norm(clean(q["evidence"])) not in norm(clean(new)):
        return False, "근거 문장이 조문에 없음"
    if resolve(clean(new), q) != q["answer_index"]:
        return False, "재풀이 답이 출제 정답과 다름"
    return True, "근거 일치 + 재풀이 일치"


def judge(old, new, q):
    p = f"""당신은 세법 시험 문제 검토자입니다. 아래 개정 전·후 조문과 문제를 보고 두 가지를 판정하세요. JSON만 출력.
1) direct: 정답이 개정 후 조문의 문구에서 추가 해석이나 추론 없이 직접 확인되면 true, 조문에 직접 적혀 있지 않은 해석·추론이 정답에 들어 있으면 false.
2) tests_change: 문제가 개정으로 바뀐 내용(무엇이 어떻게 달라졌는지)을 묻고 있으면 true, 조문 번호·항 번호 같은 단순 암기를 묻거나 바뀐 내용과 무관하면 false.
형식: {{"direct":true/false,"tests_change":true/false,"reason":"한 문장"}}

[개정 전]
{clean(old)}

[개정 후]
{clean(new)}

[문제]
{q['question']}
""" + "\n".join(f"{i + 1}. {c}" for i, c in enumerate(q["choices"])) + f"\n정답: {q['answer_index'] + 1}번"
    return parse_json(claude(p, 1000))


def work_mc(job):
    law, old, new = job
    r = {"법령": law, "old": old, "new": new, "카드": None, "경고": [], "q": None, "단계": "오류", "사유": ""}
    try:
        r["카드"], r["경고"] = make_card(law, old, new)
        for _ in range(2):                            # 응답 형식 오류만 재시도
            try:
                r["q"] = generate_changed(law, old, new)
                break
            except Exception as e:
                r["사유"] = repr(e)[:80]
        if not r["q"]:
            return r
        ok, why = verify(new, r["q"])
        if not ok:
            r["단계"], r["사유"] = "폐기", why
            return r
        j = judge(old, new, r["q"])
        r["판정"] = j
        r["단계"] = "통과" if (j.get("direct") and j.get("tests_change")) else "검수 필요"
        r["사유"] = j.get("reason", "")
    except Exception as e:
        r["사유"] = repr(e)[:80]
    return r


def work(job):
    law, old, new = job
    r = work_mc(job)
    r["ox"] = work_ox(law, old, new)              # 4지선다 결과와 상관없이 O/X도 따로 만듭니다
    return r


def work_ox(law, old, new):
    o = {"q": None, "단계": "오류", "사유": ""}
    try:
        for _ in range(2):                            # 응답 형식 오류만 재시도
            try:
                o["q"] = generate_ox(law, old, new)
                break
            except Exception as e:
                o["사유"] = repr(e)[:80]
        if not o["q"]:
            return o
        ok, why = verify(new, o["q"])
        if not ok:
            o["단계"], o["사유"] = "폐기", why
            return o
        j = judge(old, new, o["q"])
        o["단계"] = "통과" if (j.get("direct") and j.get("tests_change")) else "검수 필요"
        o["사유"] = j.get("reason", "")
    except Exception as e:
        o["사유"] = repr(e)[:80]
    return o


# ================= 실행 =================
TODAY = datetime.now(timezone(timedelta(hours=9))).date()
SINCE = TODAY - timedelta(days=LOOKBACK_DAYS)
print(f"[1] 개정 감지 (기준일 {TODAY}, 최근 {LOOKBACK_DAYS}일 내 공포 개정: {SINCE} 이후)")
detected = []
for name in LAWS:
    cur = latest_revision(name)
    if cur is None:
        print(f"  - {name}: 개정 이력을 찾지 못함")
        continue
    pub = ymd(cur[0])
    eff = ymd(cur[3]) if cur[3] else None
    status = "시행일 정보 없음" if eff is None else (f"시행 예정 ({eff})" if eff > TODAY else f"시행 중 ({eff}부터)")
    if pub >= SINCE:
        print(f"  - {name}: 개정 감지! 공포 {pub} ({(TODAY - pub).days}일 전, {cur[2]}) · {status}")
        detected.append((name, cur, status, eff))
    else:
        print(f"  - {name}: 최근 {LOOKBACK_DAYS}일 내 개정 없음 (최근 공포 {pub}, {status})")

if EXAM:
    ex = ymd(EXAM.replace("-", ""))
    kept = []
    print(f"\n[2] 시험 기준일 {ex} 필터 (법령 전체 시행일 비교)")
    for d in detected:
        if d[3] is not None and d[3] <= ex:
            print(f"  ✔ {d[0]}: 시행일 {d[3]} ≤ 시험일 → 출제 대상")
            kept.append(d)
        else:
            print(f"  ✘ {d[0]}: 시행일 {d[3]} > 시험일(또는 정보 없음) → 제외")
    detected = kept

jobs = []
for name, cur, status, eff in detected:
    cs = changed_clauses(cur[1])
    print(f"\n  {name}: 카드·문제 후보 조문 {len(cs)}개 → {min(CARDS_PER_LAW, len(cs))}개 사용")
    jobs += [(name, o, n) for o, n in cs[:CARDS_PER_LAW]]

if not jobs:
    print("\n오늘 기준 출제 대상 개정이 없습니다. (최근 일수를 늘리려면 LOOKBACK_DAYS를 바꾸세요)")
    results = []
else:
    print(f"\n[3] 카드 {len(jobs)}개 생성·문제 생성·3단계 검증 중... (1분 안팎)")
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=4) as ex_:
        results = list(ex_.map(work, jobs))
    print(f"    완료 ({int(time.time() - t0)}초)")

lines = []
def p(s=""):
    print(s); lines.append(s)

for i, r in enumerate(results, 1):
    p("\n" + "=" * 60)
    p(f"[{i}] ({r['법령']}) 결과: {r['단계']}" + (f" - {r['사유']}" if r["단계"] != "통과" else ""))
    c = r["카드"]
    if c:
        p(f"  ▶ 변경점 카드: {c['headline']}")
        for t in c["changes"]:
            p(f"    · {t}")
        p(f"    쉬운 설명: {c['easy']}")
        if r["경고"]:
            p(f"    ⚠ 원문에 없는 조문 번호: {', '.join(r['경고'])} (원문 확인 필요)")
    if r["q"]:
        q = r["q"]
        p(f"  ▶ 문제: {q['question']}")
        for k, ch in enumerate(q["choices"]):
            p(f"    {k + 1}. {ch}")
        p(f"    정답 {q['answer_index'] + 1}번 | 근거: \"{show(q['evidence'], 80)}\"")
    ox = r.get("ox") or {}
    if ox.get("q"):
        q = ox["q"]
        p(f"  ▶ O/X 문제 [{ox['단계']}]: {q['question']}")
        p(f"    정답 {'O' if q['answer_index'] == 0 else 'X'} | 근거: \"{show(q['evidence'], 80)}\"" + (f" | {ox['사유']}" if ox["단계"] != "통과" else ""))

if results:
    n = len(results)
    c = Counter(r["단계"] for r in results)
    p("\n" + "=" * 60)
    p(f"[요약] 생성 {n}개 → 1·2단계(근거·재풀이) 통과 {c['통과'] + c['검수 필요']}개 → 3단계까지 통과 {c['통과']}개")
    p(f"       폐기 {c['폐기']}개, 검수 필요 {c['검수 필요']}개, 오류 {c['오류']}개")
    co = Counter((r.get("ox") or {}).get("단계", "오류") for r in results)
    p(f"[O/X] 생성 {n}개 → 1·2단계 통과 {co['통과'] + co['검수 필요']}개 → 3단계까지 통과 {co['통과']}개 (폐기 {co['폐기']}, 검수 필요 {co['검수 필요']}, 오류 {co['오류']})")
    p("※ 요약·문제는 AI가 만든 것이며, 통과는 법적 해석의 정확성을 보장하지 않습니다. 원문 조문과 함께 확인하세요.")
    json.dump([{k: v for k, v in r.items() if k in ("법령", "카드", "경고", "q", "단계", "사유", "old", "new", "ox")} for r in results],
              open("taxshift_run.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)

if results and MAIL_TO:
    import smtplib
    from email.message import EmailMessage
    msg = EmailMessage()
    msg["Subject"] = f"[TaxShift] {TODAY} 기준 개정 감지: " + ", ".join(sorted({d[0] for d in detected}))
    msg["From"] = msg["To"] = MAIL_TO
    msg.set_content(f"TaxShift가 {TODAY} 기준 최근 {LOOKBACK_DAYS}일 내 공포된 개정을 감지했습니다.\n" + "\n".join(lines))
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as smtp:
            smtp.login(MAIL_TO, MAIL_PW)
            smtp.send_message(msg)
        print(f"\n[알림] 결과를 {MAIL_TO}로 보냈습니다.")
    except Exception as e:
        print(f"\n[알림] 이메일 발송 실패: {e!r}")
