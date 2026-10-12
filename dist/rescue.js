const ARCHIVE_STORES = [
  "stories",
  "branches",
  "source_messages",
  "source_revisions",
  "history_snapshots",
  "manifest_blocks",
  "host_bindings",
  "message_mappings",
  "memories",
  "memory_revisions",
  "memory_views",
  "reviews",
  "event_chains",
  "event_revisions",
  "event_memberships",
  "event_progress",
  "event_processing_receipts",
  "custom_table_defs",
  "custom_table_rows",
  "table_receipts",
  "table_history",
  "library_meta"
];
const ACTIVE_KEY = "mnemosyne_daily_active_v1";
const isArchive = (name) => /^mnemosyne_daily_(default|lib[_-].+)$/.test(name);
const errorInfo = (e) => ({ name: e instanceof Error ? e.name : "Error", message: e instanceof Error ? e.message : String(e) });
function failure(name, message) {
  return Object.assign(new Error(message), { name });
}
function bounded(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(failure("TimeoutError", "操作超时；没有把超时当成底层操作已取消")), ms);
    promise.then((v) => {
      clearTimeout(timer);
      resolve(v);
    }, (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
async function enumerate(factory, ms = 1e4) {
  if (typeof factory.databases !== "function") throw failure("NotSupportedError", "此浏览器不能枚举数据库；不会猜测库名或尝试创建数据库");
  return (await bounded(factory.databases(), ms)).filter((d) => typeof d.name === "string");
}
async function openExisting(factory, name, ms = 1e4) {
  if (!isArchive(name)) throw failure("NotAllowedError", "只能选择已枚举的 Mnemosyne 日用库");
  const known = await enumerate(factory, ms);
  if (!known.some((d) => d.name === name)) throw failure("NotFoundError", "数据库已不存在；未尝试打开");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => finish(failure("TimeoutError", "打开超时；迟到的连接会关闭")), ms);
    let request;
    try {
      request = factory.open(name);
    } catch (e) {
      finish(e);
      return;
    }
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      finish(failure("NotFoundError", "打开期间数据库消失或需要升级；已中止，未创建库结构"));
    };
    request.onerror = () => finish(request.error ?? failure("UnknownError", "打开失败"));
    request.onblocked = () => finish(failure("BlockedError", "数据库被其他连接阻塞；请关闭旧会话"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
  });
}
async function snapshot(db, raw, ms) {
  const names = Array.from(db.objectStoreNames);
  if (!names.length) return { counts: [], stores: [] };
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(names, "readonly");
    } catch (e) {
      reject(e);
      return;
    }
    const counts = [], stores = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        tx.abort();
      } catch {
      }
      reject(failure("TimeoutError", "只读事务超时；未生成部分备份"));
    }, ms);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve({ counts, stores });
    };
    tx.oncomplete = () => finish();
    tx.onabort = () => finish(tx.error ?? failure("AbortError", "只读事务已中止"));
    tx.onerror = () => {
    };
    try {
      for (const name of names) {
        const store = tx.objectStore(name);
        const info = { name };
        counts.push(info);
        const count = store.count();
        count.onsuccess = () => {
          info.count = count.result;
        };
        count.onerror = (event) => {
          info.error = errorInfo(count.error);
          if (!raw) {
            event.preventDefault();
            event.stopPropagation();
          }
        };
        if (raw && ARCHIVE_STORES.includes(name)) {
          const data = { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, records: [] };
          stores.push(data);
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            if (!cursor.result) return;
            data.records.push({ key: cursor.result.primaryKey, value: cursor.result.value });
            cursor.result.continue();
          };
        }
      }
    } catch (e) {
      try {
        tx.abort();
      } catch {
      }
      finish(e);
    }
  });
}
async function inspect(factory, name, ms = 1e4) {
  const db = await openExisting(factory, name, ms);
  try {
    return { name, version: db.version, ...await snapshot(db, false, ms) };
  } finally {
    db.close();
  }
}
async function readRaw(factory, name, ms = 6e4) {
  const db = await openExisting(factory, name, ms);
  try {
    const data = await snapshot(db, true, ms);
    return { name, version: db.version, ...data, omittedStores: data.counts.filter((s) => !ARCHIVE_STORES.includes(s.name)).map((s) => s.name) };
  } finally {
    db.close();
  }
}
async function encodeGraph(value) {
  const nodes = [], seen = /* @__PURE__ */ new Map();
  async function encode(v) {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) && !Object.is(v, -0) ? v : { $number: String(Object.is(v, -0) ? "-0" : v) };
    if (typeof v === "undefined") return { $undefined: true };
    if (typeof v === "bigint") return { $bigint: String(v) };
    if (typeof v !== "object") throw failure("DataCloneError", "不支持的值类型；导出已停止");
    const old = seen.get(v);
    if (old !== void 0) return { $ref: old };
    const index = nodes.length;
    seen.set(v, index);
    nodes.push(null);
    let node;
    if (v instanceof Date) node = { type: "Date", value: await encode(v.getTime()) };
    else if (v instanceof RegExp) node = { type: "RegExp", source: v.source, flags: v.flags, lastIndex: v.lastIndex };
    else if (v instanceof ArrayBuffer) node = { type: "ArrayBuffer", bytes: Array.from(new Uint8Array(v)) };
    else if (ArrayBuffer.isView(v)) node = { type: v.constructor.name, buffer: await encode(v.buffer), byteOffset: v.byteOffset, byteLength: v.byteLength };
    else if (v instanceof Blob) node = { type: typeof File !== "undefined" && v instanceof File ? "File" : "Blob", mime: v.type, ...typeof File !== "undefined" && v instanceof File ? { name: v.name, lastModified: v.lastModified } : {}, bytes: Array.from(new Uint8Array(await bounded(v.arrayBuffer(), 3e4))) };
    else if (v instanceof Map) {
      const entries = [];
      for (const [k, val] of v) entries.push([await encode(k), await encode(val)]);
      node = { type: "Map", entries };
    } else if (v instanceof Set) {
      const entries = [];
      for (const val of v) entries.push(await encode(val));
      node = { type: "Set", entries };
    } else if (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) {
      const entries = [];
      for (const key of Object.keys(v)) entries.push([key, await encode(v[key])]);
      node = { type: Array.isArray(v) ? "Array" : "Object", ...Array.isArray(v) ? { length: v.length } : { nullPrototype: Object.getPrototypeOf(v) === null }, entries };
    } else throw failure("DataCloneError", `不支持的对象 ${v.constructor?.name ?? "unknown"}；未生成不完整备份`);
    nodes[index] = node;
    return { $ref: index };
  }
  return { encoding: "mnemosyne-tagged-graph-v1", root: await encode(value), nodes };
}
function mount() {
  const hot = !!document.getElementById("mnemosyne-app-host") || typeof globalThis.mnemosyne_generateInterceptor === "function";
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `:host{all:initial;font-family:system-ui,sans-serif;color:#15202b}section{position:fixed;inset:4%;z-index:2147483647;overflow:auto;background:#fff;color:#15202b;border:3px solid #536777;border-radius:12px;padding:16px;font-size:16px;line-height:1.5;box-sizing:border-box}button,select{font:inherit;padding:12px;margin:6px 4px 6px 0;max-width:100%;min-height:44px}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}label{display:block;padding:10px 0}input{width:22px;height:22px;vertical-align:middle}h1{font-size:21px;margin:0}p{margin:10px 0}.danger{color:#8b1d12}button:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid #1769aa}section[hidden]{display:none}.toggle{position:fixed;bottom:14px;right:14px;z-index:2147483647;background:#fff;color:#15202b;border:2px solid #536777;border-radius:8px}`;
  root.append(style);
  const section = document.createElement("section");
  section.setAttribute("aria-label", "Mnemosyne 只读救援诊断");
  root.append(section);
  const add = (tag, text = "") => {
    const el = document.createElement(tag);
    el.textContent = text;
    section.append(el);
    return el;
  };
  add("h1", "Mnemosyne 只读救援诊断");
  add("p", "这是独立救援入口，不启动自动同步、摘要、继承、迁移或正常记忆界面。不会更改选库键、写库或上传资料。");
  add("p", "它不能暂停其他标签页、旧版插件或正在进行的生成。操作前须禁用普通版本、关闭所有旧会话，再用救援版本冷启动。保持原来的地址、端口、浏览器配置和设备；不要卸载应用或清除数据。").className = "danger";
  const toggle = document.createElement("button");
  toggle.className = "toggle";
  toggle.textContent = "隐藏救援窗口";
  toggle.setAttribute("aria-expanded", "true");
  root.append(toggle);
  toggle.onclick = () => {
    section.hidden = !section.hidden;
    toggle.textContent = section.hidden ? "打开只读救援" : "隐藏救援窗口";
    toggle.setAttribute("aria-expanded", String(!section.hidden));
  };
  if (hot) {
    add("p", "检测到普通 Mnemosyne 已加载。为避免并发写入，本次救援已锁定。请禁用普通版并关闭旧会话后冷启动，不要在当前页面直接切换运行。").className = "danger";
    return;
  }
  const label = add("label");
  const consent = document.createElement("input");
  consent.type = "checkbox";
  label.append(consent, " 我已完成上述冷启动，并关闭其他旧会话；我知道这里无法验证其他进程是否静止");
  const origin = location.origin;
  let selector = null, selectorError;
  try {
    selector = localStorage.getItem(ACTIVE_KEY);
  } catch (e) {
    selectorError = errorInfo(e);
  }
  add("p", `当前来源：${origin}`);
  add("p", selectorError ? `选库键读取失败：${selectorError.name}: ${selectorError.message}` : `保存的选库键：${selector ?? "缺失（普通版会使用默认库；这里只读，不设置）"}`);
  const scan = add("button", "1. 枚举现有数据库");
  scan.disabled = true;
  const pickLabel = add("label", "选择待检查的日用数据库（不会切换当前档案）");
  const select = document.createElement("select");
  select.setAttribute("aria-label", "已枚举的 Mnemosyne 日用数据库");
  pickLabel.append(select);
  const count = add("button", "2. 读取表数量");
  count.disabled = true;
  const saveReport = add("button", "下载诊断报告（无聊天正文）");
  saveReport.disabled = true;
  add("p", "下方原始救援文件可能包含全部私人 RP 正文、摘要和档案，只下载并私下保存，不要公开发送。它不是可直接导入的核心包；不做领域校验或修复。未知表只计数，不读取其内容，因此不能称为完整数据库备份。").className = "danger";
  const privacyLabel = add("label");
  const privacy = document.createElement("input");
  privacy.type = "checkbox";
  privacyLabel.append(privacy, " 我了解文件含私人资料，并希望下载所选库的已知档案表原始记录");
  const exportButton = add("button", "3. 下载私人原始救援 JSON");
  exportButton.disabled = true;
  const status = add("p", "等待冷启动确认");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const output = add("pre");
  let busy = false, report = { format: "mnemosyne-rescue-diagnostic-v1", origin, selector, selectorError, isolation: "cold-start acknowledged by user; other contexts not verified" };
  function refresh() {
    scan.disabled = busy || !consent.checked;
    count.disabled = busy || !consent.checked || !select.value;
    exportButton.disabled = count.disabled || !privacy.checked;
    select.disabled = busy;
    consent.disabled = busy;
    privacy.disabled = busy;
    saveReport.disabled = busy || !consent.checked;
  }
  consent.onchange = refresh;
  privacy.onchange = refresh;
  select.onchange = () => {
    privacy.checked = false;
    refresh();
  };
  function download(data, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    root.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 6e4);
  }
  async function run(action) {
    if (busy || !consent.checked) return;
    busy = true;
    refresh();
    status.textContent = "正在只读检查，请稍候…";
    try {
      await action();
    } catch (e) {
      const error = errorInfo(e);
      report = { ...report, error };
      output.textContent = JSON.stringify(report, null, 2);
      status.textContent = `${error.name}: ${error.message}`;
    } finally {
      busy = false;
      refresh();
    }
  }
  scan.onclick = () => void run(async () => {
    select.replaceChildren();
    const { selected: _selected, error: _error, inspectedAt: _inspectedAt, ...base } = report;
    report = base;
    const databases = await enumerate(indexedDB);
    const archives = databases.filter((d) => isArchive(d.name));
    report = { ...report, scannedAt: (/* @__PURE__ */ new Date()).toISOString(), archives, otherDatabaseCount: databases.length - archives.length };
    for (const db of archives) {
      const option = document.createElement("option");
      option.value = db.name;
      option.textContent = db.name;
      select.append(option);
    }
    if (selector && archives.some((d) => d.name === selector)) select.value = selector;
    privacy.checked = false;
    output.textContent = JSON.stringify(report, null, 2);
    status.textContent = archives.length ? `发现 ${archives.length} 个日用库。请检查库名和数量，未切换任何档案。` : "此来源未枚举到日用库；这不证明其他来源或配置的数据已消失。";
  });
  count.onclick = () => void run(async () => {
    const result = await inspect(indexedDB, select.value);
    report = { ...report, inspectedAt: (/* @__PURE__ */ new Date()).toISOString(), selected: { name: result.name, version: result.version, counts: result.counts } };
    output.textContent = JSON.stringify(report, null, 2);
    status.textContent = "只读数量检查完成；报告没有读取或包含聊天正文。";
  });
  saveReport.onclick = () => download(report, "mnemosyne-rescue-diagnostic.json");
  exportButton.onclick = () => void run(async () => {
    const result = await readRaw(indexedDB, select.value);
    const payload = await encodeGraph(result.stores);
    download({ format: "mnemosyne-raw-rescue-v1", exportedAt: (/* @__PURE__ */ new Date()).toISOString(), origin, database: result.name, version: result.version, omittedStores: result.omittedStores, counts: result.counts, warning: "Private rescue records; NOT a core import package. Unknown stores omitted. Other contexts not verified idle.", payload }, `mnemosyne-private-rescue-${Date.now()}.json`);
    status.textContent = `已请求浏览器下载私人救援文件，请确认文件确实保存。已知表 ${result.stores.length} 个，未导出未知表 ${result.omittedStores.length} 个。`;
  });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
else mount();
