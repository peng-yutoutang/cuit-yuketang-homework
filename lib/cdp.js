"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const LOCALAPPDATA = process.env.LOCALAPPDATA || "";

// Chromium 内核浏览器的常见安装位置。系统默认浏览器不可用时按此顺序回退；
// 默认浏览器优先可以覆盖 360、QQ、搜狗等其它 Chromium 内核浏览器。
const KNOWN_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  LOCALAPPDATA && path.join(LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  LOCALAPPDATA && path.join(LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
  LOCALAPPDATA && path.join(LOCALAPPDATA, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  LOCALAPPDATA && path.join(LOCALAPPDATA, "Programs", "Opera", "opera.exe"),
  LOCALAPPDATA && path.join(LOCALAPPDATA, "Vivaldi", "Application", "vivaldi.exe"),
].filter(Boolean);

// 不支持 Chrome 调试协议（CDP）的浏览器：即使被设为默认浏览器也跳过，
// 否则会打开用户日常使用的窗口，且本地服务无法读取登录 Cookie。
const NON_CDP_EXE = new Set(["firefox.exe", "librewolf.exe", "waterfox.exe", "iexplore.exe", "safari.exe"]);

function expandEnv(p) {
  return String(p || "").replace(/%([^%]+)%/g, (_, name) => process.env[name] || "");
}

function regQuery(key, valueName) {
  const args = valueName ? ["query", key, "/v", valueName] : ["query", key, "/ve"];
  try {
    return execFileSync("reg", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }) || "";
  } catch (e) {
    return "";
  }
}

function regValue(out, name) {
  if (!out) return "";
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith(name + " ")) {
      const parts = t.split(/\s+/);
      return parts.slice(2).join(" ");
    }
  }
  return "";
}

// 从注册表的默认命令中取出数据部分，兼容中英文系统的“（默认）/(Default)”显示差异。
function commandFromReg(out) {
  if (!out) return "";
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/(REG_SZ|REG_EXPAND_SZ)\s+(.+)$/);
    if (m) return m[2].trim();
  }
  return "";
}

function parseExeFromCommand(command) {
  if (!command) return "";
  const expanded = expandEnv(command.trim());
  const quoted = expanded.match(/^"([^"]+\.exe)"/i);
  if (quoted) return quoted[1];
  const bare = expanded.match(/^([^\s"]+\.exe)/i);
  return bare ? bare[1] : "";
}

// 读取 Windows 当前默认浏览器（http 协议关联），返回其可执行文件绝对路径。
function defaultBrowserExe() {
  try {
    const uc = regQuery(
      "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice",
      "ProgId"
    );
    const progId = regValue(uc, "ProgId");
    if (progId) {
      const exe = parseExeFromCommand(commandFromReg(regQuery(`HKCR\\${progId}\\shell\\open\\command`)));
      if (exe) return exe;
    }
  } catch (e) {
    /* 注册表读取失败时走回退候选列表 */
  }
  // 回退：机器级 http 协议默认命令（部分旧版 Windows / 精简系统）
  return parseExeFromCommand(commandFromReg(regQuery("HKLM\\SOFTWARE\\Classes\\http\\shell\\open\\command")));
}

function isUsableBrowser(exe) {
  if (!exe) return false;
  if (NON_CDP_EXE.has(path.basename(exe).toLowerCase())) return false;
  return fs.existsSync(exe);
}

// 候选顺序：系统默认浏览器优先，其次按常见安装位置回退。
function browserCandidates() {
  const seen = new Set();
  const out = [];
  for (const raw of [defaultBrowserExe(), ...KNOWN_CANDIDATES]) {
    const exe = expandEnv(raw);
    if (!exe) continue;
    const key = exe.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(exe);
  }
  return out;
}

function findBrowser() {
  return browserCandidates().find((exe) => isUsableBrowser(exe)) || null;
}

// 兼容旧函数名
function findChrome() {
  return findBrowser();
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body) });
        } catch (e) {
          reject(new Error("bad json from " + url + ": " + body.slice(0, 120)));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout " + url)));
    req.on("error", reject);
  });
}

function httpPutJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request(
      url,
      { method: "PUT", headers: { "Content-Type": "application/json", "Content-Length": data.length }, timeout: 3000 },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(text) });
          } catch (e) {
            reject(new Error("bad json from " + url));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout " + url)));
    req.on("error", reject);
    req.end(data);
  });
}

async function debugEndpoints(port) {
  try {
    const { json } = await httpGetJson(`http://127.0.0.1:${port}/json/version`);
    return json;
  } catch (e) {
    return null;
  }
}

async function listPages(port) {
  const { json } = await httpGetJson(`http://127.0.0.1:${port}/json/list`);
  return json || [];
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    } catch (e) {
      /* 进程可能已自行退出 */
    }
    resolve();
  });
}

// 启动单个候选浏览器并等待调试端口就绪；失败时结束该进程并返回失败。
function launchCandidate(exe, port, profileDir, startUrl) {
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    "--new-window",
    startUrl,
  ];
  const child = spawn(exe, args, { detached: true, stdio: "ignore" });
  let spawnError = null;
  child.on("error", (e) => {
    spawnError = e;
  });

  return new Promise(async (resolve) => {
    let info = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (spawnError) break;
      if (child.exitCode !== null) break; // 进程提前退出（如委托给已有实例）
      info = await debugEndpoints(port);
      if (info) break;
    }
    if (info) {
      child.unref();
      return resolve({ ok: true, info });
    }
    await killTree(child.pid);
    resolve({ ok: false });
  });
}

function ensureBrowser(port, profileDir, startUrl) {
  return new Promise(async (resolve, reject) => {
    const existing = await debugEndpoints(port);
    if (existing) return resolve({ launched: false, version: existing });

    fs.mkdirSync(profileDir, { recursive: true });
    for (const exe of browserCandidates()) {
      if (!isUsableBrowser(exe)) continue;
      const r = await launchCandidate(exe, port, profileDir, startUrl);
      if (r.ok) {
        console.log("[浏览器] 使用：" + exe);
        return resolve({ launched: true, version: r.info, browser: exe });
      }
    }
    reject(new Error("未找到可用的浏览器：系统默认浏览器与 Chrome/Edge 等候选浏览器均无法启动或建立调试连接"));
  });
}

// 兼容旧函数名，避免外部调用方失效。
function ensureChrome(port, profileDir, startUrl) {
  return ensureBrowser(port, profileDir, startUrl);
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    // 保持事件循环稳定：连接建立后的 error/close 不允许击穿进程。
    this.ws.addEventListener("error", () => {});
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  static connect(wsUrl) {
    const c = new CDPClient(wsUrl);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP connect timeout")), 8000);
      c.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(c);
      });
      c.ws.addEventListener("error", (e) => {
        clearTimeout(timer);
        reject(new Error("CDP connect error: " + (e.message || "unknown")));
      });
      c.ws.addEventListener("message", (ev) => c._handle(ev));
    });
  }

  _handle(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message + (msg.error.data ? " " + msg.error.data : "")));
      else resolve(msg.result);
    } else if (msg.method) {
      const list = this.listeners.get(msg.method) || [];
      for (const fn of list) {
        try {
          fn(msg.params);
        } catch (e) {
          /* listener error ignored */
        }
      }
    }
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    const list = this.listeners.get(method) || [];
    list.push(fn);
    this.listeners.set(method, list);
  }

  close() {
    try {
      this.ws.close();
    } catch (e) {}
  }
}

module.exports = {
  CDPClient,
  debugEndpoints,
  defaultBrowserExe,
  ensureBrowser,
  ensureChrome,
  findBrowser,
  findChrome,
  httpGetJson,
  httpPutJson,
  listPages,
};
