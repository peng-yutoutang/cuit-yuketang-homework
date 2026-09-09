"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const cdp = require("./lib/cdp");
const ykt = require("./lib/yuketang");

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, "chrome-profile");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");

let cfg = ykt.loadConfig();
let browser = null; // CDPClient attached to browser target
let pageClient = null; // CDPClient attached to a yuketang page target
let captureEnabled = false; // 抓包默认关闭，仅在需要调试时通过 /api/capture/toggle 开启
let captured = []; // recent network records

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function semesterLabel(term) {
  const t = Number(term);
  if (!t) return "其他学期";
  const year = Math.floor(t / 100);
  const half = t % 100;
  return `${year}–${year + 1}学年 · 第${half}学期`;
}

function json(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  if (rel.includes("..")) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  let file = path.join(PUBLIC_DIR, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    file = path.join(PUBLIC_DIR, "index.html");
  }
  const ext = path.extname(file).toLowerCase();
  const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
  if (ext === ".html" || ext === ".js" || ext === ".css") headers["Cache-Control"] = "no-cache";
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// Browser / CDP
// ---------------------------------------------------------------------------

async function browserInfo() {
  return await cdp.debugEndpoints(cfg.debugPort);
}

async function getPageTarget() {
  const pages = await cdp.listPages(cfg.debugPort);
  return pages.find((p) => p.type === "page" && p.url && p.url.startsWith("https://" + cfg.domain)) || null;
}

// 调试类操作每次都精确绑定到雨课堂标签页，避免串到其它标签。
async function withYuketangPage(fn) {
  const target = await getPageTarget();
  if (!target) {
    if (browser && !browser.closed) {
      const created = await browser.send("Target.createTarget", { url: `https://${cfg.domain}/m/v2` });
      await new Promise((r) => setTimeout(r, 1500));
      const pages = await cdp.listPages(cfg.debugPort);
      const fresh = pages.find((p) => p.id === created.targetId);
      if (fresh) {
        const client = await cdp.CDPClient.connect(fresh.webSocketDebuggerUrl);
        try {
          return await fn(client);
        } finally {
          client.close();
        }
      }
    }
    throw new Error("未找到雨课堂页面");
  }
  const client = await cdp.CDPClient.connect(target.webSocketDebuggerUrl);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

async function attachPage() {
  const target = await getPageTarget();
  if (!target) {
    if (browser && !browser.closed) {
      try {
        const created = await browser.send("Target.createTarget", { url: `https://${cfg.domain}/web` });
        await new Promise((r) => setTimeout(r, 1500));
        const pages = await cdp.listPages(cfg.debugPort);
        const fresh = pages.find((p) => p.id === created.targetId);
        if (fresh) {
          pageClient = await cdp.CDPClient.connect(fresh.webSocketDebuggerUrl);
          await pageClient.send("Network.enable");
          wirePageEvents();
          return pageClient;
        }
      } catch (e) {
        console.warn("[警告] 新建页面目标失败：", e.message);
      }
    }
    return null;
  }
  if (pageClient) {
    pageClient.close();
    pageClient = null;
  }
  pageClient = await cdp.CDPClient.connect(target.webSocketDebuggerUrl);
  await pageClient.send("Network.enable");
  wirePageEvents();
  return pageClient;
}

function isDashboardUrl(url) {
  return (
    url === `http://127.0.0.1:${cfg.port}` ||
    url.startsWith(`http://127.0.0.1:${cfg.port}/`) ||
    url === `http://localhost:${cfg.port}` ||
    url.startsWith(`http://localhost:${cfg.port}/`)
  );
}

async function ensureDashboardTab() {
  if (!browser || browser.closed) {
    const info = await cdp.debugEndpoints(cfg.debugPort);
    if (!info) return null;
    browser = await cdp.CDPClient.connect(info.webSocketDebuggerUrl);
  }
  const pages = await cdp.listPages(cfg.debugPort);
  let tab = pages.find((p) => p.type === "page" && isDashboardUrl(p.url));
  if (tab) return tab;
  const created = await browser.send("Target.createTarget", { url: `http://127.0.0.1:${cfg.port}` });
  await new Promise((r) => setTimeout(r, 800));
  const refreshed = await cdp.listPages(cfg.debugPort);
  return refreshed.find((p) => p.id === created.targetId) || null;
}

// 统一由本服务管理浏览器：只启动或复用一次，并在同一个窗口里
// 保证同时存在“雨课堂登录页”和“作业面板”两个标签页，避免弹出多个浏览器窗口。
async function ensureBrowserAndTabs() {
  if (!(await cdp.debugEndpoints(cfg.debugPort))) {
    await cdp.ensureBrowser(cfg.debugPort, PROFILE_DIR, `https://${cfg.domain}/web`);
  }
  const info = await cdp.debugEndpoints(cfg.debugPort);
  if (!info) throw new Error("无法连接浏览器调试通道");
  if (!browser || browser.closed) {
    browser = await cdp.CDPClient.connect(info.webSocketDebuggerUrl);
  }
  await attachPage().catch(() => {});
  const panelTab = await ensureDashboardTab();

  // 已登录时把作业面板置前；未登录时把雨课堂登录页置前，方便扫码。
  const pages = await cdp.listPages(cfg.debugPort);
  const loginTab = pages.find((p) => p.type === "page" && p.url && p.url.startsWith(`https://${cfg.domain}`));
  let focus = null;
  try {
    const session = await getSession();
    focus = sessionLoggedIn(session) ? panelTab : loginTab;
  } catch (e) {
    focus = loginTab || panelTab;
  }
  if (focus) {
    try {
      await browser.send("Target.activateTarget", { targetId: focus.id });
    } catch (e) {}
  }
  return true;
}

async function getSessionCookies() {
  if (browser && !browser.closed) {
    try {
      const r = await browser.send("Network.getCookies", { urls: [`https://${cfg.domain}/`] });
      return r.cookies || [];
    } catch (e) {
      /* 浏览器级读取失败则回退到页面级 */
    }
  }
  const client = pageClient && !pageClient.closed ? pageClient : await attachPage();
  if (!client) return [];
  const r = await client.send("Network.getCookies", { urls: [`https://${cfg.domain}/`] });
  return r.cookies || [];
}

function wirePageEvents() {
  if (!pageClient) return;
  pageClient.on("Network.requestWillBeSent", recordNetwork);
  pageClient.on("Network.responseReceived", recordResponse);
  pageClient.on("Network.loadingFinished", recordBody);
}

async function getSession() {
  let cookies = await getSessionCookies();
  if (!cookies.length && !(await cdp.debugEndpoints(cfg.debugPort))) {
    // 登录窗口被关闭时自动重新拉起（登录状态保存在独立配置里）
    try {
      await cdp.ensureBrowser(cfg.debugPort, PROFILE_DIR, `https://${cfg.domain}/m/v2`);
      cookies = await getSessionCookies();
    } catch (e) {}
  }
  const pick = (name) => {
    const c = cookies.find((x) => x.name === name);
    return c ? c.value : "";
  };
  return {
    sessionid: pick("sessionid"),
    csrftoken: pick("csrftoken"),
    universityId: pick("university_id"),
  };
}

function sessionLoggedIn(session) {
  return !!session.sessionid;
}

function recordNetwork(params) {
  if (!captureEnabled) return;
  const entry = {
    t: Date.now(),
    method: params.request ? params.request.method : "",
    url: params.request ? params.request.url : "",
    headers: params.request ? params.request.headers : {},
    postData: params.request && params.request.postData ? params.request.postData.slice(0, 5000) : "",
    requestId: params.requestId,
  };
  captured.push(entry);
  if (captured.length > 100) captured.splice(0, captured.length - 100);
}

function recordResponse(params) {
  const entry = captured.find((e) => e.requestId === params.requestId);
  if (entry) entry.status = params.response && params.response.status;
}

function recordBody(params) {
  const entry = captured.find((e) => e.requestId === params.requestId);
  if (!entry) return;
  if (!pageClient || pageClient.closed) return;
  pageClient
    .send("Network.getResponseBody", { requestId: params.requestId })
    .then((r) => {
      entry.body = (r.base64Encoded ? "[base64] " : "") + String(r.body || "").slice(0, 10000);
    })
    .catch(() => {
      entry.body = "";
    });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleApi(req, res, urlPath, method) {
  if (method === "GET" && urlPath === "/api/status") {
    let status = { domain: cfg.domain, browserConnected: false, loggedIn: false, user: null };
    try {
      const info = await browserInfo();
      status.browserConnected = !!info;
      const session = await getSession();
      if (sessionLoggedIn(session)) {
        try {
          status.user = await ykt.getUserInfo(cfg.domain, session);
          status.loggedIn = !!status.user;
        } catch (e) {
          status.loggedIn = false;
          status.error = e.message;
        }
      }
    } catch (e) {
      status.error = e.message;
      if (e && e.cause && e.cause.message) status.error += "（" + e.cause.message + "）";
    }
    return json(res, 200, status);
  }

  if (method === "GET" && urlPath === "/api/courses") {
    const session = await getSession();
    if (!sessionLoggedIn(session)) return json(res, 401, { error: "未登录" });
    try {
      const courses = await ykt.getCourses(cfg.domain, session);
      const termMap = new Map();
      for (const c of courses) {
        const key = String(c.term || 0);
        if (!termMap.has(key)) termMap.set(key, []);
        termMap.get(key).push(c);
      }
      const semesters = [...termMap.entries()]
        .map(([term, list]) => ({ term: Number(term), label: semesterLabel(term), count: list.length }))
        .sort((a, b) => b.term - a.term);
      return json(res, 200, { courses, semesters });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  const m = urlPath.match(/^\/api\/courses\/([^/]+)\/homeworks$/);
  if (method === "GET" && m) {
    const session = await getSession();
    if (!sessionLoggedIn(session)) return json(res, 401, { error: "未登录" });
    const classroomId = m[1];
    try {
      const info = await ykt.getClassroomInfo(cfg.domain, session, classroomId);
      const [todo, chapters, schedules] = await Promise.all([
        ykt.getTodoHomeworks(cfg.domain, session, classroomId, info.skuId, info.uvId),
        ykt.getChapterHomeworks(cfg.domain, session, classroomId, info.courseSign, info.uvId),
        ykt.getLeafSchedules(cfg.domain, session, classroomId, info.courseSign, info.uvId),
      ]);

      // 章节作业需要把 leaf_id 解析为真实内容 id（卡片/试卷）
      const chaptersResolved = await Promise.all(
        chapters.map(async (c) => {
          let quizId = c.quizId || "";
          if (!quizId && c.leafId) {
            try {
              quizId = await ykt.getLeafQuizId(cfg.domain, session, classroomId, c.leafId, info.uvId);
            } catch (e) {}
          }
          return Object.assign({}, c, { quizId });
        })
      );

      const isDone = (sch) =>
        sch &&
        typeof sch === "object" &&
        (sch.status === 5 ||
          (Number(sch.total) > 0 && Number(sch.done) >= 0 && Number(sch.done) >= Number(sch.total)));

      const map = new Map();
      const keyOf = (it) => (it.quizId ? "q:" + it.quizId : "l:" + it.leafId);

      // 1) 章节数据优先：完成状态与得分以 schedule 为准
      for (const c of chaptersResolved) {
        const sch = schedules[c.leafId];
        const done = isDone(sch);
        const deadlineTs = c.deadlineTs || 0;
        const expired = !done && deadlineTs > 0 && deadlineTs < Date.now();
        map.set(keyOf(c), {
          id: c.quizId || c.leafId,
          quizId: c.quizId || "",
          leafId: c.leafId || "",
          title: c.title,
          deadline: c.deadline || null,
          deadlineTs,
          deadlineLeft: "",
          expired,
          status: done ? "done" : expired ? "expired" : "pending",
          score: done && sch && sch.score != null ? sch.score : null,
          kind: c.kind || "quiz",
          publishTs: c.startTs || 0,
        });
      }

      // 2) 待办列表补充未在章节中的作业，或为已有条目补截止时间/剩余提示
      for (const t of todo) {
        const key = keyOf(t);
        const existing = map.get(key);
        if (existing) {
          if (!existing.deadlineTs && t.deadlineTs) existing.deadlineTs = t.deadlineTs;
          if (!existing.deadline && t.deadline) existing.deadline = t.deadline;
          existing.deadlineLeft = existing.deadlineLeft || t.deadlineLeft || "";
          if (existing.status !== "done" && t.expired) existing.expired = true;
        } else {
          map.set(key, {
            id: t.quizId || t.leafId,
            quizId: t.quizId || "",
            leafId: t.leafId || "",
            title: t.title,
            deadline: t.deadline || null,
            deadlineTs: t.deadlineTs || 0,
            deadlineLeft: t.deadlineLeft || "",
            expired: !!t.expired,
            status: t.status,
            score: null,
            kind: t.kind || "card",
            publishTs: t.publishTs || 0,
          });
        }
      }

      const items = [...map.values()];
      items.sort((a, b) => (a.deadlineTs || Infinity) - (b.deadlineTs || Infinity));

      return json(res, 200, {
        course: { classroomId, name: info.courseName, teacher: info.teacherName },
        items,
      });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  const m2 = urlPath.match(/^\/api\/homeworks\/([^/]+)$/);
  if (method === "GET" && m2) {
    const session = await getSession();
    if (!sessionLoggedIn(session)) return json(res, 401, { error: "未登录" });
    const kind = new URL(req.url, "http://localhost").searchParams.get("kind") || "card";
    try {
      const paper =
        kind === "quiz"
          ? await ykt.getQuizDetail(cfg.domain, session, m2[1])
          : await ykt.getCardDetail(cfg.domain, session, m2[1]);
      return json(res, 200, paper);
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  // 在专属浏览器窗口中打开官方作答页
  const m3 = urlPath.match(/^\/api\/homeworks\/([^/]+)\/open$/);
  if (method === "POST" && m3) {
    try {
      const kind = new URL(req.url, "http://localhost").searchParams.get("kind") || "card";
      if (!(await cdp.debugEndpoints(cfg.debugPort))) {
        await cdp.ensureBrowser(cfg.debugPort, PROFILE_DIR, `https://${cfg.domain}/m/v2`);
      }
      const target = await getPageTarget();
      if (!target) return json(res, 502, { error: "未找到已登录的雨课堂页面" });
      const client = pageClient || (await attachPage());
      if (!client) return json(res, 502, { error: "无法连接浏览器调试通道" });
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
      });
      await client.send("Emulation.setUserAgentOverride", {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.30(0x18001e30) NetType/WIFI Language/zh_CN",
      });
      const url =
        kind === "quiz"
          ? `https://${cfg.domain}/v/quiz/quiz_info/${encodeURIComponent(m3[1])}/?pageIndex=1`
          : `https://${cfg.domain}/v/index/course/normalcourse/learning_cards_detail/${encodeURIComponent(m3[1])}`;
      await client.send("Page.navigate", { url });
      await client.send("Page.bringToFront");
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  if (method === "GET" && urlPath === "/api/capture") {
    return json(res, 200, { enabled: captureEnabled, entries: captured.slice(-100).reverse() });
  }

  if (method === "POST" && urlPath === "/api/capture/toggle") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body || "{}");
      captureEnabled = !!parsed.enabled;
    } catch (e) {}
    return json(res, 200, { enabled: captureEnabled });
  }

  if (method === "GET" && urlPath === "/api/settings") {
    return json(res, 200, cfg);
  }

  if (method === "POST" && urlPath === "/api/settings") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const patch = JSON.parse(body || "{}");
      if (patch.domain && /^[a-z0-9.-]+$/.test(patch.domain)) cfg.domain = patch.domain;
      if (typeof patch.onlyCurrentTerm === "boolean") cfg.onlyCurrentTerm = patch.onlyCurrentTerm;
      ykt.saveConfig(cfg);
      pageClient = null; // 域名变化后重新找页面目标
      return json(res, 200, cfg);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (method === "POST" && urlPath === "/api/login/open") {
    try {
      if (!(await cdp.debugEndpoints(cfg.debugPort))) {
        await cdp.ensureBrowser(cfg.debugPort, PROFILE_DIR, `https://${cfg.domain}/web`);
      }
      const target = await getPageTarget();
      if (target && pageClient) {
        await pageClient.send("Page.navigate", { url: `https://${cfg.domain}/web` });
      }
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  // 供 start.bat 在服务已运行时复用：确保同一个浏览器窗口里存在两个标签页
  if (method === "POST" && urlPath === "/api/browser/open") {
    try {
      await ensureBrowserAndTabs();
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  if (method === "GET" && urlPath === "/api/debug/pages") {
    try {
      const pages = await cdp.listPages(cfg.debugPort);
      return json(res, 200, { pages });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  if (method === "POST" && urlPath === "/api/debug/navigate") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let url;
    try {
      url = JSON.parse(body || "{}").url;
    } catch (e) {
      return json(res, 400, { error: "bad body" });
    }
    if (!url || !/^https:\/\/[a-z0-9.-]+(\.yuketang\.cn|xuetangx\.com)\//.test(url)) {
      return json(res, 400, { error: "仅允许导航到雨课堂域名" });
    }
    try {
      await withYuketangPage(async (client) => {
        await client.send("Page.navigate", { url });
      });
      return json(res, 200, { ok: true, url });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  if (method === "POST" && urlPath === "/api/debug/eval") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let expression;
    try {
      expression = JSON.parse(body || "{}").expression;
    } catch (e) {
      return json(res, 400, { error: "bad body" });
    }
    if (!expression || typeof expression !== "string" || expression.length > 20000) {
      return json(res, 400, { error: "expression 缺失或过长" });
    }
    try {
      const result = await withYuketangPage(async (client) => {
        return await client.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
      });
      if (result.exceptionDetails) {
        return json(res, 200, {
          ok: false,
          error: (result.exceptionDetails.exception && result.exceptionDetails.exception.description) || "执行异常",
        });
      }
      return json(res, 200, { ok: true, value: result.result ? result.result.value : null });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  if (method === "POST" && urlPath === "/api/debug/cdp") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let methodName, params;
    try {
      const parsed = JSON.parse(body || "{}");
      methodName = parsed.method;
      params = parsed.params || {};
    } catch (e) {
      return json(res, 400, { error: "bad body" });
    }
    if (!methodName || !/^[A-Za-z]+(\.[A-Za-z]+)+$/.test(methodName)) {
      return json(res, 400, { error: "非法 CDP 方法名" });
    }
    try {
      const result = await withYuketangPage(async (client) => {
        return await client.send(methodName, params);
      });
      return json(res, 200, { ok: true, result });
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  return false; // 不是本面板的接口，交给透明代理转发给雨课堂
}

const LOCAL_FILES = new Set(["/", "/index.html", "/app.js", "/style.css", "/favicon.ico"]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const method = (req.method || "GET").toUpperCase();
  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url.pathname, method);
      if (handled) return;
    }
    if (url.pathname === "/img/") {
      return await handleImg(res, url);
    }
    if (LOCAL_FILES.has(url.pathname)) {
      return serveStatic(req, res);
    }
    // 其余路径（含 /proxy/* 与内嵌官方页所需的 /v/、/c27/、/api/v3/ 等）都转发到雨课堂
    return await handleProxy(req, res, url);
  } catch (e) {
    if (!res.headersSent) return json(res, 500, { error: e.message });
    res.destroy();
  }
});

// 图片代理：题目/课件图片 CDN 有防盗链（校验 Referer），由本地服务代取。
const IMG_HOST_RE =
  /^https?:\/\/(qn-sfe\.yuketang\.cn|rain-public-qn\.yuketang\.cn|qn-sx\.yuketang\.cn|qn-next\.xuetangx\.com|sfe\.ykt\.io|thirdwx\.qlogo\.cn|storagecdn\.xuetangx\.com|fe-static-yuketang\.yuketang\.cn)\//;

// 内嵌官方作答页时，页面文档源是本地面板（127.0.0.1），题目图片直接请求 CDN 会
// 因 Referer 校验失败返回 403（text/html），浏览器随后以 ERR_BLOCKED_BY_ORB 拦截，
// 表现为“只能看到选项、看不到题干”。这里把响应里的 CDN 图片 URL 改写成本地 /img/
// 代理地址，与下方题面预览使用同一套取图逻辑。
// 只改写有 Referer 防盗链校验的图片 CDN；fe-static（页面脚本/样式）与微信头像域名直连正常，无需处理。
const IMG_HOST_SRC =
  "(?:qn-sfe\\.yuketang\\.cn|rain-public-qn\\.yuketang\\.cn|qn-sx\\.yuketang\\.cn|qn-next\\.xuetangx\\.com|sfe\\.ykt\\.io|storagecdn\\.xuetangx\\.com)";

function rewriteImgUrls(text) {
  if (!text || typeof text !== "string") return text;
  const re = new RegExp("https?://" + IMG_HOST_SRC + "/[^\\s\"'<>\\\\]+", "g");
  return text.replace(re, (u) => "/img/?u=" + encodeURIComponent(u));
}

// 试卷页把题目数据以 base64 内嵌在 HTML 里，需解码后改写其中的图片 URL 再编码回去。
function rewriteQuizData(html) {
  if (!html || typeof html !== "string") return html;
  return html.replace(/(var\s+quizData\s*=\s*)(["'])([A-Za-z0-9+/=]+)(\2)/, (whole, prefix, quote, b64) => {
    try {
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      const fixed = rewriteImgUrls(decoded);
      if (fixed === decoded) return whole;
      return prefix + quote + Buffer.from(fixed, "utf8").toString("base64") + quote;
    } catch (e) {
      return whole;
    }
  });
}

async function handleImg(res, url) {
  const raw = url.searchParams.get("u") || "";
  if (!IMG_HOST_RE.test(raw)) {
    return json(res, 400, { error: "非法的图片地址" });
  }
  const target = raw.startsWith("http://") ? "https://" + raw.slice(7) : raw;
  try {
    const ua = (ykt.headers(cfg.domain, {}) || {})["User-Agent"] || "";
    const upstream = await fetch(target, {
      headers: {
        Referer: `https://${cfg.domain}/`,
        "User-Agent": ua,
      },
      redirect: "follow",
    });
    if (!upstream.ok) {
      res.writeHead(upstream.status);
      return res.end();
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      "Content-Type": upstream.headers.get("content-type") || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(buf);
  } catch (e) {
    if (!res.headersSent) return json(res, 502, { error: "图片获取失败：" + e.message });
    res.destroy();
  }
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error("[错误] 端口 %s 已被占用。请先运行 stop.bat 或结束已有的 node server.js 进程。", cfg.port);
  } else {
    console.error("[错误] 服务器异常：", e.message);
  }
  process.exit(1);
});

// 透明反向代理：把官方雨课堂页面/接口嵌进本地面板，由服务端代带登录 cookie。
async function handleProxy(req, res, url) {
  let upstreamPath = url.pathname;
  if (upstreamPath.startsWith("/proxy/")) upstreamPath = upstreamPath.slice("/proxy".length);
  upstreamPath += url.search;
  if (/^https?:\/\//i.test(upstreamPath) || upstreamPath.includes("..")) {
    return json(res, 400, { error: "非法代理路径" });
  }
  const session = await getSession();
  if (!sessionLoggedIn(session)) {
    return json(res, 401, { error: "未登录" });
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  // 透传页面自身发来的业务请求头（xtbz / X-Client / university-id 等），
  // 再覆盖为本地服务持有的登录 Cookie。
  const skip = new Set(["host", "cookie", "content-length", "connection", "accept-encoding", "if-none-match", "if-modified-since", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"]);
  const fwdHeaders = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (skip.has(String(k).toLowerCase())) continue;
    fwdHeaders[k] = v;
  }
  fwdHeaders["Cookie"] = `csrftoken=${session.csrftoken}; sessionid=${session.sessionid}`;
  fwdHeaders["X-CSRFToken"] = session.csrftoken || "";
  fwdHeaders["Origin"] = `https://${cfg.domain}`;
  fwdHeaders["Referer"] = `https://${cfg.domain}/`;
  fwdHeaders["User-Agent"] = (ykt.headers(cfg.domain, {}) || {})["User-Agent"] || fwdHeaders["user-agent"] || "";

  try {
    const upstream = await fetch(`https://${cfg.domain}${upstreamPath}`, {
      method: req.method,
      headers: fwdHeaders,
      body: body.length ? body : undefined,
      redirect: "follow",
    });
    let buf = Buffer.from(await upstream.arrayBuffer());
    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    const ctLower = ct.toLowerCase();
    // 作答页还会经由本代理加载自身的 CSS / JS 静态资源，其中也可能内嵌 CDN 图片
    // URL（如 background:url(...) 或模板里的 src），因此对所有文本型响应统一改写。
    const isText =
      ctLower.includes("html") ||
      ctLower.includes("json") ||
      ctLower.includes("css") ||
      ctLower.includes("javascript") ||
      ctLower.includes("xml") ||
      ctLower.startsWith("text/");
    if (isText) {
      buf = Buffer.from(rewriteQuizData(rewriteImgUrls(buf.toString("utf8"))), "utf8");
    }
    res.writeHead(upstream.status, { "Content-Type": ct });
    res.end(buf);
  } catch (e) {
    if (!res.headersSent) return json(res, 502, { error: "代理失败：" + e.message });
    res.destroy();
  }
}

async function start() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // 先监听本地端口，再拉起浏览器，保证“作业面板”标签页能正常加载。
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, "127.0.0.1", () => {
      console.log(`[启动] 雨课堂作业面板: http://127.0.0.1:${cfg.port}`);
      resolve();
    });
  });

  try {
    await ensureBrowserAndTabs();
    const info = await cdp.debugEndpoints(cfg.debugPort);
    console.log(
      "[启动] 浏览器已就绪：%s（一个窗口、两个标签页：雨课堂 + 作业面板）",
      (info && info.Browser) || "未知内核"
    );
  } catch (e) {
    console.warn("[警告] 浏览器未就绪：", e.message);
  }
}

process.on("SIGINT", () => {
  if (browser) browser.close();
  if (pageClient) pageClient.close();
  process.exit(0);
});

process.on("uncaughtException", (e) => {
  console.error("[错误] 未捕获异常：", e && e.stack ? e.stack : e);
});

process.on("unhandledRejection", (e) => {
  console.error("[错误] 未处理拒绝：", e && e.stack ? e.stack : e);
});

start();
