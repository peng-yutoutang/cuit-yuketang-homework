"use strict";

const state = {
  status: null,
  courses: [],
  semesters: [],
  semester: null,
  homeworks: [], // 展开为 {courseName, teacher, ...item}
  filterCourse: "all",
  filterStatus: "all",
  sort: "deadline",
  paper: null,
  paperMeta: null,
  iframeOpen: false,
  iframeWide: true,
};

const $ = (sel) => document.querySelector(sel);

function toast(msg) {
  let el = $(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

function show(sel) {
  for (const s of ["#loginNotice", "#dashboard", "#paperView", "#settingsView"]) {
    $(s).classList.toggle("hidden", s !== sel);
  }
}

function renderUser() {
  const chip = $("#userChip");
  const user = state.status && state.status.user;
  if (user && user.name) {
    const img = user.avatar ? `<img src="${escapeAttr(user.avatar)}" alt="" />` : "";
    const school = user.school ? `<span class="school">${escapeHtml(user.school)}</span>` : "";
    chip.innerHTML = `${img}<span class="uname">${escapeHtml(user.name)}</span>${school}`;
  } else {
    chip.textContent = "未登录";
  }
}

async function refreshHomeworks() {
  if (!state.status || !state.status.loggedIn) return;
  const semesterCourses = state.courses.filter((c) => Number(c.term || 0) === Number(state.semester));
  const list = [];
  for (const c of semesterCourses) {
    try {
      const result = await api(`/api/courses/${encodeURIComponent(c.classroom_id)}/homeworks`);
      for (const it of result.items || []) {
        list.push(Object.assign({}, it, { courseId: c.classroom_id, courseName: c.name, teacher: c.teacher }));
      }
    } catch (e) {
      console.warn("拉取作业失败", c.name, e.message);
    }
  }
  state.homeworks = list;
  renderDashboard();
}

function semesterCourses() {
  return state.courses.filter((c) => Number(c.term || 0) === Number(state.semester));
}

const TYPE_LABELS = {
  ShortAnswer: "简答题",
  SingleChoice: "单选题",
  MultiChoice: "多选题",
  FillBlank: "填空题",
  Vote: "投票题",
};

function imgUrl(u) {
  if (!u) return "";
  const s = String(u);
  if (/^(data:|blob:|https?:\/\/thirdwx\.qlogo\.cn)/.test(s)) return s;
  return "/img/?u=" + encodeURIComponent(s);
}

function statusInfo(hw) {
  const now = Date.now();
  if (hw.status === "done") return { kind: "done", label: "已完成" + (hw.score != null ? ` · ${hw.score}分` : "") };
  if (hw.status === "expired") return { kind: "overdue", label: "已逾期" };
  if (hw.deadlineTs && hw.deadlineTs < now) return { kind: "overdue", label: "已逾期" };
  return { kind: "pending", label: "待完成" };
}

function renderStats() {
  const now = Date.now();
  const pending = state.homeworks.filter(
    (h) => ["pending", "exam", "unknown"].includes(h.status) && !(h.deadlineTs && h.deadlineTs < now)
  );
  const dueSoon = pending.filter(
    (h) => h.deadlineTs && h.deadlineTs > now && h.deadlineTs - now < 3 * 24 * 3600 * 1000
  );
  const overdue = state.homeworks.filter(
    (h) => h.status === "expired" || (h.deadlineTs && h.deadlineTs < now && h.status === "pending")
  );
  $("#stats").innerHTML = `
    <div class="stat-card"><div class="num">${pending.length}</div><div class="label">待完成</div></div>
    <div class="stat-card"><div class="num">${dueSoon.length}</div><div class="label">3 天内截止</div></div>
    <div class="stat-card"><div class="num">${overdue.length}</div><div class="label">已逾期</div></div>
    <div class="stat-card"><div class="num">${semesterCourses().length}</div><div class="label">课程数</div></div>
  `;
}

function renderFilters() {
  const courses = [{ id: "all", name: "全部课程" }, ...semesterCourses().map((c) => ({ id: c.classroom_id, name: c.name }))];
  $("#courseFilters").innerHTML = courses
    .map(
      (c) =>
        `<button class="chip ${state.filterCourse === c.id ? "active" : ""}" data-course="${escapeAttr(c.id)}">${escapeHtml(c.name)}</button>`
    )
    .join("");
  for (const btn of document.querySelectorAll("#courseFilters .chip")) {
    btn.onclick = () => {
      state.filterCourse = btn.dataset.course;
      renderFilters();
      renderList();
    };
  }
}

function renderSemesters() {
  if (!state.semesters.length) {
    $("#semesterFilters").innerHTML = "";
    return;
  }
  $("#semesterFilters").innerHTML = state.semesters
    .map(
      (s) =>
        `<button class="chip ${Number(state.semester) === Number(s.term) ? "active" : ""}" data-term="${escapeAttr(s.term)}">${escapeHtml(s.label)}（${s.count}门）</button>`
    )
    .join("");
  for (const btn of document.querySelectorAll("#semesterFilters .chip")) {
    btn.onclick = () => {
      state.semester = Number(btn.dataset.term);
      state.filterCourse = "all";
      renderSemesters();
      refreshHomeworks();
    };
  }
}

function renderStatusFilters() {
  const options = [
    { id: "all", name: "全部" },
    { id: "pending", name: "待完成" },
    { id: "overdue", name: "已逾期" },
    { id: "done", name: "已完成" },
  ];
  $("#statusFilters").innerHTML = options
    .map(
      (o) =>
        `<button class="chip ${state.filterStatus === o.id ? "active" : ""}" data-status="${o.id}">${o.name}</button>`
    )
    .join("");
  for (const btn of document.querySelectorAll("#statusFilters .chip")) {
    btn.onclick = () => {
      state.filterStatus = btn.dataset.status;
      renderStatusFilters();
      renderList();
    };
  }
}

function matchStatus(hw, filter) {
  const now = Date.now();
  const info = statusInfo(hw);
  if (filter === "all") return true;
  if (filter === "pending") return info.kind === "pending";
  if (filter === "overdue") return info.kind === "overdue";
  if (filter === "done") return info.kind === "done";
  return true;
}

function renderList() {
  let items = state.homeworks.filter(
    (h) =>
      (state.filterCourse === "all" || h.courseId === state.filterCourse) &&
      matchStatus(h, state.filterStatus)
  );
  items.sort((a, b) => {
    if (state.sort === "publish") {
      const pa = a.publishTs || 0;
      const pb = b.publishTs || 0;
      if (pa !== pb) return pb - pa;
    } else if (state.sort === "score") {
      const sa = a.score != null ? a.score : -1;
      const sb = b.score != null ? b.score : -1;
      if (sa !== sb) return sb - sa;
    }
    const da = a.deadlineTs || Infinity;
    const db = b.deadlineTs || Infinity;
    if (da !== db) return da - db;
    return String(a.title).localeCompare(String(b.title), "zh-CN");
  });
  if (!items.length) {
    $("#homeworkList").innerHTML = `<div class="notice"><p>当前课程暂无作业或试卷，点击右上角“刷新”重新获取。</p></div>`;
    return;
  }
  $("#homeworkList").innerHTML = items
    .map((h) => {
      const s = statusInfo(h);
      const deadline = h.deadline
        ? h.deadline
        : h.deadlineTs
          ? new Date(h.deadlineTs).toLocaleString("zh-CN")
          : "无截止时间";
      const left = h.deadlineLeft ? ` · ${escapeHtml(h.deadlineLeft)}` : "";
      return `
        <div class="hw-card" data-id="${escapeAttr(h.id)}" data-course="${escapeAttr(h.courseId)}">
          <div class="main">
            <h3>${escapeHtml(h.title)}</h3>
            <div class="meta">${escapeHtml(h.courseName)}${h.teacher ? " · " + escapeHtml(h.teacher) : ""}</div>
            <div class="meta">截止 ${escapeHtml(deadline)}${left}</div>
          </div>
          <span class="badge ${s.kind}">${escapeHtml(s.label)}</span>
        </div>`;
    })
    .join("");
  for (const card of document.querySelectorAll("#homeworkList .hw-card")) {
    card.onclick = () => openPaper(card.dataset.id, card.dataset.course);
  }
}

function renderDashboard() {
  renderStats();
  renderSemesters();
  renderStatusFilters();
  renderFilters();
  renderList();
}

async function openPaper(id, courseId) {
  const meta = state.homeworks.find((h) => h.id === id);
  state.paperMeta = meta;
  state.paper = null;
  state.iframeOpen = true; // 打开作业即直接进入官方作答页
  $("#paperContent").innerHTML = `<div class="notice"><p>正在加载作业…</p></div>`;
  show("#paperView");
  try {
    const kind = meta && meta.kind ? meta.kind : "card";
    state.paper = await api(`/api/homeworks/${encodeURIComponent(id)}?kind=${encodeURIComponent(kind)}`);
    renderPaper();
  } catch (e) {
    $("#paperContent").innerHTML = `<div class="notice"><p>加载失败：${escapeHtml(e.message)}</p></div>`;
  }
}

function renderPaper() {
  const paper = state.paper;
  const meta = state.paperMeta || {};
  const slides = paper && Array.isArray(paper.slides) ? paper.slides : [];
  const problems = paper && Array.isArray(paper.problems) ? paper.problems : [];
  if (!paper || (!slides.length && !problems.length)) {
    state.iframeOpen = true;
    $("#paperContent").innerHTML = `
      <div class="paper-header">
        <h2>${escapeHtml(paper && paper.title ? paper.title : meta.title || "作业")}</h2>
        <div class="meta">${escapeHtml(meta.courseName || "")}${paper && paper.deadline ? " · 截止 " + escapeHtml(paper.deadline) : ""}</div>
      </div>
      ${answerActions(paper)}
      ${iframeBox(paper)}`;
    return;
  }

  const slidesHtml = slides
    .map((s) => {
      const imgs = (s.images || []).map((u) => `<img class="q-img" src="${escapeAttr(imgUrl(u))}" alt="课件内容" loading="lazy" />`).join("");
      const text = s.text ? `<div class="slide-text">${escapeHtml(s.text).replace(/\n/g, "<br/>")}</div>` : "";
      let problemInfo = "";
      if (s.problem) {
        const typeLabel = TYPE_LABELS[s.problem.type] || s.problem.type || "题目";
        const submitted = (s.problem.submittedImages || [])
          .map((u) => `<img class="q-img" src="${escapeAttr(imgUrl(u))}" alt="已提交图片" loading="lazy" />`)
          .join("");
        problemInfo = `
          <div class="q-title" style="margin-top:10px">
            <span class="q-no">${s.problem.index}.</span>
            <span class="q-type">${escapeHtml(typeLabel)}</span>
            <span class="q-score">${s.problem.score != null ? escapeHtml(s.problem.score) + " 分" : ""}</span>
          </div>${submitted}`;
      }
      return `<div class="question slide"><div class="q-title"><span class="q-no">第 ${s.page} 页</span></div>${imgs}${text}${problemInfo}</div>`;
    })
    .join("");

  const problemsHtml = problems
    .map((p) => {
      const typeLabel = TYPE_LABELS[p.type] || p.type || "题目";
      const images = (p.images || [])
        .map((u) => `<img class="q-img" src="${escapeAttr(imgUrl(u))}" alt="题目图片" loading="lazy" />`)
        .join("");
      const content = p.content ? `<div class="q-content">${escapeHtml(p.content).replace(/\n/g, "<br/>")}</div>` : "";
      const options = (p.options || [])
        .map((o) => `<div class="opt"><span class="opt-key">${escapeHtml(o.key)}</span><span>${escapeHtml(String(o.text))}</span></div>`)
        .join("");
      const optionsHtml = options ? `<div class="options">${options}</div>` : "";
      return `
        <div class="question">
          <div class="q-title"><span class="q-no">${p.index}.</span><span class="q-type">${escapeHtml(typeLabel)}</span><span class="q-score">${p.score != null ? escapeHtml(p.score) + " 分" : ""}</span></div>
          ${content}
          ${images}
          ${optionsHtml}
        </div>`;
    })
    .join("");

  $("#paperContent").innerHTML = `
    <div class="paper-header">
      <h2>${escapeHtml(paper.title || meta.title || "作业")}</h2>
      <div class="meta">
        ${escapeHtml(meta.courseName || "")}
        ${paper.deadline ? " · 截止 " + escapeHtml(paper.deadline) : ""}
        ${paper.showAnswer ? " · 已批改" : paper.done ? " · 已完成" : " · 待完成"}
      </div>
    </div>
    ${iframeBox(paper)}
    <div class="preview-title">题目预览</div>
    <div class="paper-body">${problemsHtml}${slidesHtml}</div>
    ${answerActions(paper)}`;

  bindPaperButtons();
}

function answerActions(paper) {
  const officialUrl = paper && paper.officialUrl ? paper.officialUrl : "";
  return `
    <div class="paper-actions">
      <button class="btn ghost" id="toggleIframeBtn">${state.iframeOpen ? "收起官方作答页" : "在面板中作答"}</button>
      <button class="btn ghost" id="openChromeBtn">在雨课堂窗口作答</button>
      <a class="btn ghost link" href="${escapeAttr(officialUrl)}" target="_blank" rel="noopener">浏览器新标签打开</a>
    </div>`;
}

function iframeBox(paper) {
  if (!state.iframeOpen || !paper || !paper.proxyUrl) return "";
  return `
    <div class="iframe-wrap ${state.iframeWide ? "wide" : "narrow"}">
      <div class="iframe-head">
        <span>在线作答（与官网一致，作答后直接提交到雨课堂）</span>
        <span class="iframe-tools">
          <button class="btn ghost small" id="iframeSizeBtn">${state.iframeWide ? "切换手机尺寸" : "切换宽屏"}</button>
          <button class="btn ghost small" id="iframeCloseBtn">收起</button>
        </span>
      </div>
      <div class="iframe-box"><iframe id="quizFrame" src="${escapeAttr(paper.proxyUrl)}" title="雨课堂作答"></iframe></div>
    </div>`;
}

function bindPaperButtons() {
  const toggle = $("#toggleIframeBtn");
  if (toggle) {
    toggle.onclick = () => {
      state.iframeOpen = !state.iframeOpen;
      renderPaper();
      if (state.iframeOpen) toast("官方作答页已内嵌，登录态由本地服务转发");
    };
  }
  const iframeClose = $("#iframeCloseBtn");
  if (iframeClose) {
    iframeClose.onclick = () => {
      state.iframeOpen = false;
      renderPaper();
    };
  }
  const iframeSize = $("#iframeSizeBtn");
  if (iframeSize) {
    iframeSize.onclick = () => {
      state.iframeWide = !state.iframeWide;
      renderPaper();
    };
  }
  const openChrome = $("#openChromeBtn");
  if (openChrome) {
    openChrome.onclick = async () => {
      const m = (state.paper && state.paper.proxyUrl ? state.paper.proxyUrl : "").match(/(?:learning_cards_detail|quiz_info)\/(\d+)/);
      if (!m) return toast("未找到作业 id");
      const kind = (state.paperMeta && state.paperMeta.kind) || "card";
      try {
        await api(`/api/homeworks/${encodeURIComponent(m[1])}/open?kind=${encodeURIComponent(kind)}`, { method: "POST" });
        toast("已在雨课堂窗口打开，请在那边作答");
      } catch (e) {
        toast("打开失败：" + e.message);
      }
    };
  }
}

function setRefreshing(on) {
  for (const sel of ["#refreshBtn", "#refreshLoginBtn"]) {
    const btn = $(sel);
    if (!btn) continue;
    btn.disabled = on;
    btn.classList.toggle("loading", on);
  }
}

let refreshPromise = null;
async function refreshAll() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    setRefreshing(true);
    try {
      state.status = await api("/api/status");
      renderUser();
      if (state.status.loggedIn) {
        show("#dashboard");
        const data = await api("/api/courses");
        state.courses = data.courses || [];
        state.semesters = data.semesters || [];
        if (!state.semester || !state.semesters.some((s) => Number(s.term) === Number(state.semester))) {
          state.semester = state.semesters.length ? Number(state.semesters[0].term) : null;
        }
        await refreshHomeworks();
      } else {
        state.courses = [];
        state.semesters = [];
        state.homeworks = [];
        show("#loginNotice");
      }
    } catch (e) {
      state.status = null;
      renderUser();
      state.courses = [];
      state.semesters = [];
      state.homeworks = [];
      show("#loginNotice");
      toast("连接服务失败：" + e.message);
    } finally {
      setRefreshing(false);
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

let focusCheckTimer = null;
function scheduleStatusCheck() {
  clearTimeout(focusCheckTimer);
  focusCheckTimer = setTimeout(checkStatusOnFocus, 600);
}

// 页面重新获得焦点（比如从雨课堂标签页切回）时，重新校验登录状态，
// 退出登录后不再残留个人信息，重新登录后会自动加载数据。
async function checkStatusOnFocus() {
  try {
    const status = await api("/api/status");
    const wasLoggedIn = !!(state.status && state.status.loggedIn);
    state.status = status;
    renderUser();
    if (!status.loggedIn) {
      if (wasLoggedIn) {
        state.courses = [];
        state.semesters = [];
        state.homeworks = [];
        show("#loginNotice");
      }
    } else if (!wasLoggedIn) {
      await refreshAll();
    }
  } catch (e) {
    /* 静默处理，避免切回窗口时打扰 */
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function bind() {
  $("#refreshBtn").onclick = () => {
    refreshAll().then(() => toast("已刷新"));
  };
  $("#sortSelect").onchange = (e) => {
    state.sort = e.target.value;
    renderList();
  };
  $("#refreshLoginBtn").onclick = () => refreshAll();
  $("#openLoginBtn").onclick = () => api("/api/login/open", { method: "POST" }).then(() => toast("已重新打开登录页"));
  $("#backBtn").onclick = () => show("#dashboard");
  $("#settingsBtn").onclick = () => {
    api("/api/settings")
      .then((cfg) => {
        $("#domainSelect").value = cfg.domain || "www.yuketang.cn";
        show("#settingsView");
      })
      .catch(() => show("#settingsView"));
  };
  $("#closeSettingsBtn").onclick = () => (state.status && state.status.loggedIn ? show("#dashboard") : show("#loginNotice"));
  $("#saveSettingsBtn").onclick = async () => {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ domain: $("#domainSelect").value }),
    });
    toast("已保存，请刷新");
    refreshAll();
  };
}

bind();
refreshAll();

window.addEventListener("focus", scheduleStatusCheck);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleStatusCheck();
});
