"use strict";

const path = require("path");
const fs = require("fs");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

function loadConfig() {
  const file = path.join(__dirname, "..", "data", "config.json");
  const base = { domain: "www.yuketang.cn", port: 8500, debugPort: 9222, xtbz: "ykt", onlyCurrentTerm: true };
  try {
    return Object.assign(base, JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (e) {
    return base;
  }
}

function saveConfig(cfg) {
  const dir = path.join(__dirname, "..", "data");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
}

// 时间戳 -> "YYYY-MM-DD HH:mm"（本地时区，Asia/Shanghai）
function fmtLocal(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 会话头：csrftoken + sessionid；可选 university-id / uv-id
function headers(domain, session, opts = {}) {
  const cookie = ["csrftoken=" + (session.csrftoken || ""), "sessionid=" + (session.sessionid || "")]
    .filter((x) => !x.endsWith("="))
    .join("; ");
  const h = {
    Cookie: cookie,
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: opts.referer || `https://${domain}/`,
    xtbz: opts.xtbz || "ykt",
  };
  const uv = opts.uvId || session.universityId || "";
  if (uv) {
    h["university-id"] = String(opts.universityId || uv);
    h["uv-id"] = String(uv);
  }
  if (opts.extra) Object.assign(h, opts.extra);
  return h;
}

async function request(method, url, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: opts.headers || {},
      body: opts.body,
      redirect: "follow",
    });
  } catch (e) {
    const reason = e && e.cause && e.cause.message ? e.cause.message : "";
    throw new Error(`网络请求失败：${(e && e.message) || "fetch failed"}${reason ? "（" + reason + "）" : ""}`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {}
  return { status: res.status, json, text };
}

async function getUserInfo(domain, session) {
  const r = await request("GET", `https://${domain}/api/v3/user/basic-info`, {
    headers: headers(domain, session),
  });
  if (r.status !== 200 || !r.json || r.json.code !== 0) {
    throw new Error("用户信息请求失败：" + ((r.json && (r.json.msg || r.json.error)) || r.status));
  }
  return r.json.data;
}

// 课程列表（含历史学期）。返回 classroom_id / course_id / 名称 / 教师 / 学期 / 封面
async function getCourses(domain, session) {
  const r = await request("GET", `https://${domain}/v2/api/web/courses/list?identity=2`, {
    headers: headers(domain, session),
  });
  if (r.status !== 200 || !r.json || !r.json.data) throw new Error("课程列表请求失败");
  const list = r.json.data.list || [];
  return list.map((c) => ({
    classroom_id: String(c.classroom_id),
    course_id: String(c.course_id || (c.course && c.course.id) || ""),
    name: (c.course && c.course.name) || c.name || "",
    teacher: (c.teacher && c.teacher.name) || "",
    term: c.term,
    course_number: (c.course && c.course.course_number) || "",
    cover: (c.course && c.course.cover) || "",
  }));
}

// 班级信息：course_sign / sku_id / uv_id / course_id
async function getClassroomInfo(domain, session, classroomId) {
  const r = await request("GET", `https://${domain}/v2/api/web/classrooms/${classroomId}?role=5`, {
    headers: headers(domain, session),
  });
  if (r.status !== 200 || !r.json || !r.json.data) throw new Error("班级信息请求失败");
  const d = r.json.data;
  return {
    classroomId: String(d.id),
    courseId: String(d.course_id || ""),
    courseName: d.course_name || "",
    courseSign: d.course_sign || "",
    skuId: d.free_sku_id != null ? String(d.free_sku_id) : "",
    uvId: d.uv_id != null ? String(d.uv_id) : "",
    platform: d.platform,
    teacherName: d.teacher_name || "",
    classStart: d.class_start,
    classEnd: d.class_end,
  };
}

// 待办列表里的作业（type=7 才是课后作业；8 是授课等，需过滤）
async function getTodoHomeworks(domain, session, classroomId, skuId, uvId) {
  if (!skuId) return [];
  const r = await request(
    "GET",
    `https://${domain}/c27/online_courseware/course/classroom/${classroomId}/${skuId}/todo_list/?client_type=h5&classroom_id=${classroomId}`,
    { headers: headers(domain, session, { universityId: uvId, uvId, referer: `https://${domain}/m/v2/` }) }
  );
  if (r.status !== 200 || !r.json || !r.json.data) return [];
  return (r.json.data.result || [])
    .filter((t) => String(t.type) === "7")
    .map((t) => {
      let quizId = String(t.leaf_type_id || "");
      if (!quizId && t.link_url) {
        const m = String(t.link_url).match(/\/(\d+)\/?\?/);
        if (m) quizId = m[1];
      }
      return {
        quizId,
        leafId: String(t.leaf_id || ""),
        title: t.name || "未命名作业",
        deadline: t.score_deadline || null,
        deadlineTs: t.score_deadline_ts || 0,
        deadlineLeft: t.score_deadline_left || "",
        expired: !!t.is_expired,
        publishTime: t.publish_time || "",
        publishTs: t.publish_time_ts || 0,
        type: String(t.type || "7"),
        kind: "card",
        linkUrl: t.link_url || "",
        status: t.is_expired ? "expired" : "pending",
      };
    });
}

// 章节树里的作业叶子：7=卡片作业、9=试卷作业；完成状态由 schedule 补充
async function getChapterHomeworks(domain, session, classroomId, sign, uvId) {
  if (!sign) return [];
  const url =
    `https://${domain}/mooc-api/v1/lms/learn/course/chapter?cid=${classroomId}&classroom_id=${classroomId}` +
    `&sign=${encodeURIComponent(sign)}&show_unpublished=false&query=&leaf_type=`;
  const r = await request("GET", url, {
    headers: headers(domain, session, { universityId: uvId, uvId, referer: `https://${domain}/m/v2/` }),
  });
  if (r.status !== 200 || !r.json || !r.json.data || !r.json.data.course_chapter) return [];
  const out = [];
  for (const ch of r.json.data.course_chapter) {
    for (const sec of ch.section_leaf_list || []) {
      const leaves = sec.leaf_list || (sec.id ? [sec] : []);
      for (const leaf of leaves) {
        if (leaf.leaf_type !== 7 && leaf.leaf_type !== 9) continue;
        out.push({
          leafId: String(leaf.id || ""),
          leafinfoId: String(leaf.leafinfo_id || ""),
          title: leaf.name || "未命名作业",
          deadline: fmtLocal(leaf.score_deadline),
          deadlineTs: leaf.score_deadline || 0,
          startTs: leaf.start_time || 0,
          isScore: !!leaf.is_score,
          kind: leaf.leaf_type === 7 ? "card" : "quiz",
        });
      }
    }
  }
  return out;
}

// 各叶子完成状态与得分
async function getLeafSchedules(domain, session, classroomId, sign, uvId) {
  if (!sign) return {};
  const url =
    `https://${domain}/mooc-api/v1/lms/learn/course/schedule?cid=${classroomId}&sign=${encodeURIComponent(sign)}` +
    `&classroom_id=${classroomId}&is_h5=true`;
  const r = await request("GET", url, {
    headers: headers(domain, session, { universityId: uvId, uvId, referer: `https://${domain}/m/v2/` }),
  });
  if (r.status !== 200 || !r.json || !r.json.data) return {};
  return r.json.data.leaf_schedules || {};
}

// leaf_id -> 试卷 id（quiz/courseware id）
async function getLeafQuizId(domain, session, classroomId, leafId, uvId) {
  const url =
    `https://${domain}/mooc-api/v1/lms/learn/leaf_info/${classroomId}/${leafId}/` +
    `?term=latest&uv_id=${uvId}&classroom_id=${classroomId}`;
  const r = await request("GET", url, {
    headers: headers(domain, session, { universityId: uvId, uvId, referer: `https://${domain}/m/v2/` }),
  });
  if (r.status !== 200 || !r.json || !r.json.data || !r.json.data.content_info) return "";
  return String(r.json.data.content_info.leaf_type_id || "");
}

// 课堂活动：type=4 试卷/作业、type=5 考试，含 courseware_id（即试卷 id）
async function getQuizActivities(domain, session, courseId, classroomId, uvId) {
  if (!courseId) return [];
  const url = `https://${domain}/v/course_meta/classroom_logs?course_id=${courseId}&classroom_id=${classroomId}&activity_type=-1`;
  const r = await request("GET", url, {
    headers: headers(domain, session, { universityId: uvId, uvId, referer: `https://${domain}/m/v2/` }),
  });
  if (r.status !== 200 || !r.json || !r.json.data || !Array.isArray(r.json.data.activities)) return [];
  const flat = r.json.data.activities.flat();
  return flat
    .filter((a) => a.type === 4 || a.type === 5)
    .map((a) => ({
      quizId: String(a.courseware_id || ""),
      activityId: String(a.id || ""),
      title: a.title || "",
      kind: a.type === 5 ? "exam" : "homework",
      createTs: a.create_time || 0,
    }));
}

// 学习卡片（课后作业）元信息：标题、截止时间、题目列表、完成状态
async function getCardMeta(domain, session, cardId) {
  const r = await request(
    "GET",
    `https://${domain}/v/cards/learning_cards_detail/${cardId}?_date=${Date.now()}`,
    {
      headers: headers(domain, session, {
        referer: `https://${domain}/v/index/course/normalcourse/learning_cards_detail/${cardId}`,
      }),
    }
  );
  if (r.status !== 200 || !r.json || !r.json.data) throw new Error("学习卡片请求失败（HTTP " + r.status + "）");
  return r.json.data;
}

// 卡片正文：Slides 数组（含文本、图片、内嵌题目）
async function getCardsInfo(domain, session, cardId) {
  const r = await request("GET", `https://${domain}/v/cards/cards_info/${cardId}/`, {
    headers: headers(domain, session, {
      referer: `https://${domain}/v/index/course/normalcourse/learning_cards_detail/${cardId}`,
      extra: { "X-Client": "h5" },
    }),
  });
  if (r.status !== 200 || !r.json || !r.json.data || !r.json.data.cardData) {
    const err = new Error("cards_info 解析失败");
    err.detail = { status: r.status, head: String(r.text || "").slice(0, 200), hasJson: !!r.json };
    throw err;
  }
  return r.json.data.cardData;
}

function shapeText(shape) {
  const parts = [];
  for (const p of shape.Paragraphs || []) {
    for (const line of p.Lines || []) {
      for (const t of line.Texts || []) {
        if (t.Text) parts.push(t.Text);
      }
    }
  }
  return parts.join("\n");
}

function bodyText(bodys) {
  const parts = [];
  for (const b of bodys || []) {
    const t = shapeText(b);
    if (t) parts.push(t);
  }
  return parts.join("\n");
}

// 单题详情：题干 / 选项 / 分数 / 配图
async function getProblemDetail(domain, session, problemId) {
  const r = await request("GET", `https://${domain}/v/cards/problem_detail/${problemId}/`, {
    headers: headers(domain, session, { referer: `https://${domain}/v/cards/` }),
  });
  if (r.status !== 200 || !r.json || !r.json.data || !r.json.data.problem_content) return null;
  return r.json.data.problem_content;
}

function normalizeProblem(p, index) {
  const options = Array.isArray(p.options) ? p.options : Array.isArray(p.Options) ? p.Options : [];
  const images = [];
  for (const key of ["url", "URL", "img", "image"]) {
    if (p[key]) images.push(String(p[key]));
  }
  if (Array.isArray(p.images)) images.push(...p.images.map(String));
  return {
    index: index + 1,
    problemId: String(p.problem_id ?? p.ProblemID ?? p.id ?? ""),
    type: p.type ?? p.Type ?? p.problem_type ?? "",
    content: p.content ?? p.Content ?? p.title ?? "",
    score: p.score ?? p.Score ?? null,
    images,
    options: options.map((o) => ({
      key: o.key ?? o.option_id ?? o.Key ?? "",
      text: o.content ?? o.text ?? o.value ?? o,
    })),
  };
}

// 解析旧版试卷页 /v/quiz/quiz_info/{id}/ 里内嵌的 base64 试卷数据
function parseQuizPage(html) {
  const grabVar = (name) => {
    const re = new RegExp("var\\s+" + name + "\\s*=\\s*(?:[\"']([^\"']*)[\"']|([^;\\n]+));");
    const m = html.match(re);
    if (!m) return "";
    return (m[1] !== undefined ? m[1] : m[2] || "").trim();
  };
  const quizId = grabVar("quizID");
  const showAnswer = grabVar("showAnswer").toLowerCase() === "true";
  const deadline = grabVar("deadline");
  const dataB64 = grabVar("quizData");

  let paper = null;
  if (dataB64) {
    try {
      paper = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8"));
    } catch (e) {}
  }
  const slides = [];
  if (paper && Array.isArray(paper.Slides)) {
    paper.Slides.forEach((s, i) => {
      const images = [];
      const texts = [];
      for (const shape of s.Shapes || []) {
        if (shape.URL) images.push(String(shape.URL));
        const t = shapeText(shape);
        if (t) texts.push(t);
      }
      const p = s.Problem || {};
      const submittedPics = (p.Result && p.Result.Answer && Array.isArray(p.Result.Answer.pics)
        ? p.Result.Answer.pics.map((x) => x && x.pic).filter(Boolean)
        : []);
      slides.push({
        page: i + 1,
        text: texts.join("\n"),
        images,
        problem: {
          index: i + 1,
          problemId: String(p.ProblemID || ""),
          type: p.Type || "",
          score: p.Score != null ? p.Score : null,
          answer: p.Answer != null ? String(p.Answer) : "",
          submittedImages: submittedPics,
        },
      });
    });
  }
  return {
    kind: "quiz",
    quizId: quizId || "",
    title: (paper && paper.Title) || "",
    deadline,
    showAnswer,
    slideCount: slides.length,
    slides,
  };
}

// 试卷作业详情（章节 leaf_type=9）
async function getQuizDetail(domain, session, quizId) {
  const r = await request("GET", `https://${domain}/v/quiz/quiz_info/${quizId}/?pageIndex=1`, {
    headers: headers(domain, session, { extra: { "X-Client": "h5" } }),
  });
  if (r.status !== 200 || !r.text) throw new Error("试卷请求失败（HTTP " + r.status + "）");
  const parsed = parseQuizPage(r.text);
  parsed.officialUrl = `https://${domain}/v/quiz/quiz_info/${encodeURIComponent(quizId)}/?pageIndex=1`;
  parsed.proxyUrl = `/v/quiz/quiz_info/${encodeURIComponent(quizId)}/?pageIndex=1`;
  return parsed;
}

// 作业详情：元信息 + 卡片正文（题目以图片形式呈现）
async function getCardDetail(domain, session, cardId) {
  const meta = await getCardMeta(domain, session, cardId);
  const cards = meta.cards || {};
  let slides = [];
  let cardsInfoError = "";
  if (cards.id) {
    try {
      const info = await getCardsInfo(domain, session, cards.id);
      slides = (info.Slides || []).map((s, i) => {
        const images = [];
        if (s.Cover) images.push(String(s.Cover));
        let text = "";
        for (const shape of s.Shapes || []) {
          if (shape.URL) images.push(String(shape.URL));
          const t = shapeText(shape);
          if (t) text += (text ? "\n" : "") + t;
        }
        return {
          page: s.PageIndex != null ? s.PageIndex : i + 1,
          text,
          images,
          problem: s.Problem ? normalizeProblem(s.Problem, 0) : null,
        };
      });
    } catch (e) {
      cardsInfoError = e.message + " | " + JSON.stringify(e.detail || {});
    }
  }
  const rawProblems = meta.problems || [];
  const problems = await Promise.all(
    rawProblems.map(async (p, i) => {
      const problemId = String(p.problem_id ?? p.problemId ?? p.id ?? p.ProblemID ?? "");
      if (!problemId) return normalizeProblem(p, i);
      const detail = await getProblemDetail(domain, session, problemId);
      if (!detail) return normalizeProblem(p, i);
      const options = (detail.Bullets || []).map((b) => ({
        key: b.Label || "",
        text: bodyText(b.Contents || []),
      }));
      return {
        index: detail.ProblemIndex != null ? detail.ProblemIndex : i + 1,
        problemId,
        type: detail.Type || detail.ProblemType || "",
        content: bodyText(detail.ProblemBodys || []),
        score: detail.Score != null ? detail.Score : null,
        images: detail.Cover ? [String(detail.Cover)] : [],
        options,
      };
    })
  );
  return {
    cardId: String(cardId),
    title: cards.title || "",
    cover: cards.cover || "",
    deadline: meta.deadline || "",
    done: !!(meta.cards_view && meta.cards_view.done),
    problemsTotalScore: meta.problems_total_score != null ? meta.problems_total_score : null,
    problemCount: problems.length,
    problems,
    slides,
    cardsInfoError,
    officialUrl: `https://${domain}/v/index/course/normalcourse/learning_cards_detail/${encodeURIComponent(cardId)}`,
    proxyUrl: `/v/index/course/normalcourse/learning_cards_detail/${encodeURIComponent(cardId)}`,
  };
}

module.exports = {
  getChapterHomeworks,
  getCardDetail,
  getClassroomInfo,
  getCourses,
  getLeafQuizId,
  getLeafSchedules,
  getQuizDetail,
  getQuizActivities,
  getTodoHomeworks,
  getUserInfo,
  headers,
  loadConfig,
  normalizeProblem,
  parseQuizPage,
  request,
  saveConfig,
};
