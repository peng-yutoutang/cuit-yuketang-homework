"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

function findChrome() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || null;
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

function ensureChrome(port, profileDir, startUrl) {
  return new Promise(async (resolve, reject) => {
    const existing = await debugEndpoints(port);
    if (existing) return resolve({ launched: false, version: existing });

    const chromePath = findChrome();
    if (!chromePath) return reject(new Error("未找到 Chrome 或 Edge 浏览器"));

    fs.mkdirSync(profileDir, { recursive: true });
    const args = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate,MediaRouter",
      "--new-window",
      startUrl,
    ];
    const child = spawn(chromePath, args, { detached: true, stdio: "ignore" });
    child.on("error", reject);
    child.unref();

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const info = await debugEndpoints(port);
      if (info) return resolve({ launched: true, version: info });
    }
    reject(new Error("Chrome 启动超时"));
  });
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
  ensureChrome,
  findChrome,
  httpGetJson,
  httpPutJson,
  listPages,
};
