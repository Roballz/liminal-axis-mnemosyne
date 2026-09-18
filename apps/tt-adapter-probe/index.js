(function installProbe(global) {
  'use strict';

  const core = createCore();

  if (typeof module === 'object' && module.exports) {
    module.exports = { core };
  }
  global.MnemosyneTTProbeCore = core;

  if (typeof document === 'undefined') return;

  const runtime = createRuntime(global, core);
  global.mnemosyneProbe = runtime.publicApi;
  global.mnemosyneProbeGenerateInterceptor = runtime.generateInterceptor;
  void runtime.start();

  function createCore() {
    const PLACEMENTS = Object.freeze({
      beforeHistory: Object.freeze({ name: 'before_history', position: 2, depth: 0, role: 0 }),
      userD0: Object.freeze({ name: 'user @d0', position: 1, depth: 0, role: 1 }),
      systemD0: Object.freeze({ name: 'system @d0', position: 1, depth: 0, role: 0 }),
    });

    function now() {
      return Date.now();
    }

    function makeToken(prefix = 'probe') {
      if (global.crypto && typeof global.crypto.randomUUID === 'function') {
        return `${prefix}-${global.crypto.randomUUID()}`;
      }
      return `${prefix}-${now()}-${Math.random().toString(36).slice(2)}`;
    }

    function fnv1a(value) {
      const text = String(value ?? '');
      let hash = 0x811c9dc5;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    }

    function abortError(reason = 'aborted') {
      const error = new Error(reason);
      error.name = 'AbortError';
      return error;
    }

    function snapshotFromState(state = {}) {
      const chat = Array.isArray(state.chat) ? state.chat : [];
      const lastIndex = chat.length - 1;
      const last = lastIndex >= 0 ? chat[lastIndex] : null;
      const lastFingerprint = last
        ? fnv1a(JSON.stringify({
          name: last.name ?? '',
          is_user: Boolean(last.is_user),
          is_system: Boolean(last.is_system),
          mes: typeof last.mes === 'string' ? last.mes : '',
          swipe_id: Number.isInteger(last.swipe_id) ? last.swipe_id : 0,
        }))
        : null;

      return {
        chatId: state.chatId ?? null,
        head: {
          count: chat.length,
          lastIndex,
          lastFingerprint,
        },
      };
    }

    function sameSnapshot(left, right) {
      return Boolean(left)
        && Boolean(right)
        && left.chatId === right.chatId
        && left.head?.count === right.head?.count
        && left.head?.lastIndex === right.head?.lastIndex
        && left.head?.lastFingerprint === right.head?.lastFingerprint;
    }

    function createRequestGate(readSnapshot) {
      let active = null;
      let sequence = 0;

      return {
        async begin(meta = {}) {
          if (active) active.cancel('superseded');
          const controller = new AbortController();
          const request = {
            requestToken: makeToken('request'),
            sequence: sequence += 1,
            controller,
            signal: controller.signal,
            snapshot: null,
            meta,
            startedAt: now(),
            cancel(reason = 'cancelled') {
              if (!controller.signal.aborted) controller.abort(reason);
            },
          };

          // Claim active before awaiting so an older snapshot cannot reclaim the gate.
          active = request;
          try {
            request.snapshot = await readSnapshot();
          } catch (error) {
            if (active === request) active = null;
            throw error;
          }
          return request;
        },
        async canApply(request) {
          if (!request || request.signal.aborted || active !== request) return false;
          return sameSnapshot(request.snapshot, await readSnapshot());
        },
        cancel(reason = 'cancelled') {
          if (active) active.cancel(reason);
          active = null;
        },
        current() {
          return active;
        },
      };
    }

    function fakePrepare(options = {}, signal) {
      const mode = options.mode ?? 'immediate';
      const delayMs = Math.max(0, Number(options.delayMs) || 0);
      const timeoutMs = Math.max(1, Number(options.timeoutMs) || 1000);
      const marker = String(options.marker ?? makeToken('prepare'));

      if (signal?.aborted) return Promise.reject(abortError(signal.reason || 'aborted'));
      if (mode === 'fail') return Promise.reject(new Error('fake_prepare_failed'));

      const waitMs = mode === 'delay' ? delayMs : mode === 'timeout' ? timeoutMs : 0;
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          clearTimeout(timer);
          callback(value);
        };
        const onAbort = () => finish(reject, abortError(signal.reason || 'aborted'));
        const timer = setTimeout(() => {
          if (mode === 'timeout') finish(reject, new Error('fake_prepare_timeout'));
          else finish(resolve, { marker, preparedAt: now(), mode });
        }, waitMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    function summarizeRaw(raw) {
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
      let parsed = null;
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        parsed = null;
      }

      const messages = Array.isArray(parsed?.messages)
        ? parsed.messages
        : Array.isArray(parsed?.request?.messages)
          ? parsed.request.messages
          : [];
      const roles = messages.map(message => String(message?.role ?? 'unknown'));
      const contentLengths = messages.map(message => {
        if (typeof message?.content === 'string') return message.content.length;
        return message?.content == null ? 0 : JSON.stringify(message.content).length;
      });
      const hasProbeMarker = text.includes('MNEMOSYNE_TT_PROBE');
      const markers = {
        beforeHistory: hasProbeMarker && text.includes('before_history'),
        userD0: hasProbeMarker && text.includes('user @d0'),
        systemD0: hasProbeMarker && text.includes('system @d0'),
      };
      const markerMessageIndexes = messages
        .map((message, index) => {
          const content = typeof message?.content === 'string'
            ? message.content
            : JSON.stringify(message?.content ?? '');
          const hasMarker = content.includes('MNEMOSYNE_TT_PROBE');
          const hits = Object.entries({
            beforeHistory: hasMarker && content.includes('before_history'),
            userD0: hasMarker && content.includes('user @d0'),
            systemD0: hasMarker && content.includes('system @d0'),
          }).filter(([, hit]) => hit).map(([name]) => name);
          return hits.length ? { index, role: String(message?.role ?? 'unknown'), hits } : null;
        })
        .filter(Boolean);

      return {
        length: text.length,
        hash: fnv1a(text),
        parsed: Boolean(parsed),
        messageCount: messages.length,
        roles,
        contentLengths,
        containsProbeMarker: hasProbeMarker,
        markers,
        markerMessageIndexes,
      };
    }

    return Object.freeze({
      PLACEMENTS,
      abortError,
      createRequestGate,
      fakePrepare,
      fnv1a,
      makeToken,
      sameSnapshot,
      snapshotFromState,
      summarizeRaw,
    });
  }

  function createRuntime(globalObject, probeCore) {
    const KEYS = Object.freeze({
      beforeHistory: 'mnemosyne_tt_probe_before_history',
      userD0: 'mnemosyne_tt_probe_user_d0',
      systemD0: 'mnemosyne_tt_probe_system_d0',
    });
    const logEntries = [];
    const state = {
      armed: false,
      mode: 'immediate',
      delayMs: 1000,
      timeoutMs: 1000,
      httpsUrl: '',
      started: false,
      hostReady: false,
      latestLlmIndex: [],
      lastRawSummary: null,
    };

    const gate = probeCore.createRequestGate(readSnapshot);

    function addLog(event, details = {}) {
      logEntries.push({ at: Date.now(), event, ...sanitize(details) });
      if (logEntries.length > 80) logEntries.shift();
      render();
    }

    function sanitize(value) {
      if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
      if (Array.isArray(value)) return value.map(sanitize);
      if (typeof value !== 'object') return String(value);
      const output = {};
      for (const [key, item] of Object.entries(value)) {
        if (/^(mes|content|prompt|response|requestRaw|responseRaw|text)$/i.test(key)) {
          output[`${key}Length`] = typeof item === 'string' ? item.length : item == null ? 0 : JSON.stringify(item).length;
          continue;
        }
        output[key] = sanitize(item);
      }
      return output;
    }

    function getContext() {
      try {
        return globalObject.SillyTavern?.getContext?.() ?? null;
      } catch (error) {
        addLog('context-error', { message: error.message });
        return null;
      }
    }

    async function waitForHost() {
      const ready = globalObject.__TAURITAVERN__?.ready ?? globalObject.__TAURITAVERN_MAIN_READY__;
      if (ready && typeof ready.then === 'function') await ready;
      state.hostReady = Boolean(globalObject.__TAURITAVERN__?.api);
      return globalObject.__TAURITAVERN__ ?? null;
    }

    async function callMaybe(target, method, ...args) {
      if (!target || typeof target[method] !== 'function') return undefined;
      return target[method](...args);
    }

    async function getCurrentRefs(options = {}) {
      const api = globalObject.__TAURITAVERN__?.api;
      const chatApi = api?.chat;
      const current = chatApi?.current;
      let ref;
      let handle;
      let errorMessage = null;
      try {
        ref = await callMaybe(current, 'ref');
        handle = await callMaybe(current, 'handle');
      } catch (error) {
        errorMessage = error?.message ?? String(error);
        if (!options.quiet) addLog('chat-ref-error', { message: errorMessage });
      }
      return { api, chatApi, current, ref, handle, errorMessage };
    }

    async function waitForCurrentRefs(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      let last = await getCurrentRefs({ quiet: true });
      while (!last.ref && !last.handle && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        last = await getCurrentRefs({ quiet: true });
      }
      if (!last.ref && !last.handle && last.errorMessage) {
        addLog('chat-ref-error', { message: last.errorMessage });
      }
      return last;
    }

    async function resolveChatId() {
      const refs = await waitForCurrentRefs();
      let stableId;
      try {
        stableId = await callMaybe(refs.handle, 'stableId');
      } catch (error) {
        addLog('stable-id-error', { message: error.message });
      }
      if (stableId != null) return String(stableId);

      const context = getContext();
      try {
        const fallback = await context?.getCurrentChatId?.();
        if (fallback != null) return String(fallback);
      } catch (error) {
        addLog('context-chat-id-error', { message: error.message });
      }
      return null;
    }

    async function readSnapshot() {
      const context = getContext();
      const chat = Array.isArray(context?.chat) ? context.chat : [];
      return probeCore.snapshotFromState({ chat, chatId: await resolveChatId() });
    }

    function methodStatus(target, names) {
      return Object.fromEntries(names.map(name => [name, typeof target?.[name] === 'function']));
    }

    function normalizeLogIndex(value) {
      if (Array.isArray(value)) return value;
      if (Array.isArray(value?.items)) return value.items;
      if (Array.isArray(value?.entries)) return value.entries;
      if (Array.isArray(value?.logs)) return value.logs;
      return [];
    }

    async function fetchLlmIndex() {
      const logs = globalObject.__TAURITAVERN__?.api?.dev?.llmApiLogs;
      if (typeof logs?.index !== 'function') {
        state.latestLlmIndex = [];
        return [];
      }
      const value = await logs.index({ limit: 20 });
      const entries = normalizeLogIndex(value);
      state.latestLlmIndex = entries;
      return entries;
    }

    async function inspectHost() {
      await waitForHost();
      const refs = await waitForCurrentRefs();
      let windowInfo;
      let tail;
      try {
        windowInfo = await callMaybe(refs.current, 'windowInfo');
        tail = await refs.handle?.history?.tail?.({ limit: 3 });
      } catch (error) {
        addLog('chat-inspect-error', { message: error.message });
      }

      const dev = refs.api?.dev;
      let llmIndex = [];
      try {
        llmIndex = await fetchLlmIndex();
      } catch (error) {
        addLog('llm-index-error', { message: error.message });
      }

      const context = getContext();
      const eventTypes = context?.eventTypes ?? context?.event_types ?? {};
      const chat = Array.isArray(context?.chat) ? context.chat : [];
      return {
        observedAt: Date.now(),
        tauri: {
          present: Boolean(globalObject.__TAURITAVERN__),
          api: Object.keys(refs.api ?? {}),
          chat: Object.keys(refs.chatApi ?? {}),
          dev: Object.keys(dev ?? {}),
        },
        chat: {
          ref: sanitize(refs.ref),
          ready: Boolean(refs.ref || refs.handle),
          stableIdAvailable: typeof refs.handle?.stableId === 'function',
          windowInfo: sanitize(windowInfo),
          tailCount: Array.isArray(tail?.messages) ? tail.messages.length : null,
          tailHasMoreBefore: typeof tail?.hasMoreBefore === 'boolean' ? tail.hasMoreBefore : null,
          contextCount: chat.length,
        },
        context: {
          available: Boolean(context),
          setExtensionPrompt: typeof context?.setExtensionPrompt === 'function',
          eventTypes: Object.keys(eventTypes),
          currentChatId: typeof context?.getCurrentChatId === 'function',
        },
        llmApiLogs: {
          index: methodStatus(dev?.llmApiLogs, ['index', 'getPreview', 'getRaw', 'subscribeIndex']),
          recentCount: Array.isArray(llmIndex) ? llmIndex.length : null,
          recent: sanitize(llmIndex),
        },
      };
    }

    function promptSink() {
      const context = getContext();
      if (typeof context?.setExtensionPrompt !== 'function') return null;
      return context.setExtensionPrompt.bind(context);
    }

    function clearPrompts() {
      const setPrompt = promptSink();
      if (!setPrompt) return false;
      for (const key of Object.values(KEYS)) {
        const placement = key === KEYS.beforeHistory
          ? probeCore.PLACEMENTS.beforeHistory
          : key === KEYS.userD0
            ? probeCore.PLACEMENTS.userD0
            : probeCore.PLACEMENTS.systemD0;
        setPrompt(key, '', placement.position, placement.depth, false, placement.role, null);
      }
      return true;
    }

    function applyPrompts(request, prepared) {
      const setPrompt = promptSink();
      if (!setPrompt) throw new Error('setExtensionPrompt_unavailable');
      const marker = `MNEMOSYNE_TT_PROBE:${request.requestToken}:${prepared.marker}`;
      const blocks = [
        [KEYS.beforeHistory, probeCore.PLACEMENTS.beforeHistory, `[${marker}] before_history`],
        [KEYS.userD0, probeCore.PLACEMENTS.userD0, `[${marker}] user @d0`],
        [KEYS.systemD0, probeCore.PLACEMENTS.systemD0, `[${marker}] system @d0`],
      ];
      for (const [key, placement, text] of blocks) {
        setPrompt(key, text, placement.position, placement.depth, false, placement.role, null);
      }
      return { marker, placements: blocks.map(([, placement]) => placement.name) };
    }

    async function readNewestRaw() {
      const dev = globalObject.__TAURITAVERN__?.api?.dev;
      let list = [];
      try {
        list = await fetchLlmIndex();
      } catch (error) {
        addLog('llm-index-error', { message: error.message });
      }
      const newest = [...list].sort((left, right) => {
        const leftTime = Number(left?.timestampMs ?? left?.id ?? 0);
        const rightTime = Number(right?.timestampMs ?? right?.id ?? 0);
        return rightTime - leftTime;
      })[0];
      if (!newest || typeof dev?.llmApiLogs?.getRaw !== 'function') {
        addLog('llm-raw-unavailable');
        return null;
      }
      try {
        const raw = await dev.llmApiLogs.getRaw(newest.id);
        const summary = {
          id: newest.id,
          indexTimestampMs: newest.timestampMs ?? null,
          rawKeys: raw && typeof raw === 'object' ? Object.keys(raw) : [],
          request: probeCore.summarizeRaw(raw?.requestRaw),
          response: probeCore.summarizeRaw(raw?.responseRaw),
        };
        state.lastRawSummary = summary;
        addLog('llm-raw-summary', summary);
        return summary;
      } catch (error) {
        addLog('llm-raw-error', { message: error.message });
        return null;
      }
    }

    async function runHttpsProbe() {
      const value = state.httpsUrl.trim();
      if (!value) {
        addLog('https-url-missing');
        return null;
      }
      let url;
      try {
        url = new URL(value);
        if (url.protocol !== 'https:') throw new Error('https_only');
      } catch (error) {
        addLog('https-invalid-url', { error: error?.message ?? String(error) });
        return null;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort('https_timeout'), 5000);
      const startedAt = Date.now();
      try {
        const response = await fetch(url.href, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'omit',
          headers: { 'X-Mnemosyne-TT-Probe': '1' },
          signal: controller.signal,
        });
        const contentType = response.headers.get('content-type');
        const body = await response.text();
        const result = {
          origin: url.origin,
          pathname: url.pathname,
          status: response.status,
          ok: response.ok,
          contentType,
          bodyLength: body.length,
          durationMs: Date.now() - startedAt,
        };
        addLog('https-complete', result);
        return result;
      } catch (error) {
        const result = {
          origin: url.origin,
          pathname: url.pathname,
          error: error?.name === 'AbortError' ? 'timeout_or_abort' : error?.message ?? String(error),
          durationMs: Date.now() - startedAt,
        };
        addLog('https-failed', result);
        return result;
      } finally {
        clearTimeout(timeout);
      }
    }

    function bindEvents() {
      const context = getContext();
      const source = context?.eventSource;
      const types = context?.eventTypes ?? context?.event_types ?? {};
      if (!source || typeof source.on !== 'function') {
        addLog('events-unavailable');
        return;
      }
      const events = [
        ['CHAT_CHANGED', 'chat-changed', true],
        ['CHAT_LOADED', 'chat-loaded', true],
        ['MESSAGE_SENT', 'message-sent', false],
        ['MESSAGE_EDITED', 'message-edited', false],
        ['MESSAGE_UPDATED', 'message-updated', false],
        ['MESSAGE_DELETED', 'message-deleted', false],
        ['MESSAGE_SWIPED', 'message-swiped', false],
        ['GENERATION_STARTED', 'generation-started', false],
        ['GENERATION_STOPPED', 'generation-stopped', true],
        ['GENERATION_ENDED', 'generation-ended', true],
      ];
      for (const [typeKey, name, invalidates] of events) {
        const eventName = types[typeKey];
        if (!eventName) continue;
        source.on(eventName, () => {
          if (invalidates) {
            gate.cancel(name);
            const cleared = clearPrompts();
            addLog('probe-cleared', { reason: name, applied: cleared });
          }
          addLog(name);
          if (name === 'chat-changed' || name === 'chat-loaded') void refreshHost();
        });
      }
    }

    async function generateInterceptor(_chat, contextSize, _abort, type) {
      if (!state.armed) return;
      const request = await gate.begin({ type: type ?? null, contextSize: contextSize ?? null });
      addLog('prepare-start', { requestToken: request.requestToken, type, contextSize, snapshot: request.snapshot });
      try {
        const prepared = await probeCore.fakePrepare({
          mode: state.mode,
          delayMs: state.delayMs,
          timeoutMs: state.timeoutMs,
          marker: probeCore.makeToken('prepared'),
        }, request.signal);
        addLog('prepare-complete', { requestToken: request.requestToken, mode: state.mode, preparedAt: prepared.preparedAt });
        if (!(await gate.canApply(request))) {
          addLog('response-discarded', { requestToken: request.requestToken, reason: 'request_or_head_changed' });
          clearPrompts();
          return;
        }
        const applied = applyPrompts(request, prepared);
        addLog('probe-applied', { requestToken: request.requestToken, marker: applied.marker, placements: applied.placements });
      } catch (error) {
        clearPrompts();
        addLog(error?.name === 'AbortError' ? 'prepare-cancelled' : 'prepare-failed', {
          requestToken: request.requestToken,
          error: error?.message ?? String(error),
        });
      }
    }

    async function start() {
      await waitForHost();
      mountPanel();
      bindEvents();
      state.started = true;
      addLog('probe-ready', { hostReady: state.hostReady });
      await refreshHost();
    }

    async function refreshHost() {
      const snapshot = await inspectHost();
      render(snapshot);
      return snapshot;
    }

    function cancelActive() {
      gate.cancel('user-cancelled');
      clearPrompts();
      addLog('probe-cancelled');
    }

    async function runPrepareOnly() {
      const request = await gate.begin({ type: 'manual', contextSize: null });
      addLog('manual-prepare-start', { requestToken: request.requestToken, snapshot: request.snapshot });
      try {
        const prepared = await probeCore.fakePrepare({
          mode: state.mode,
          delayMs: state.delayMs,
          timeoutMs: state.timeoutMs,
          marker: probeCore.makeToken('manual'),
        }, request.signal);
        addLog('manual-prepare-complete', { requestToken: request.requestToken, mode: state.mode, preparedAt: prepared.preparedAt });
      } catch (error) {
        addLog('manual-prepare-failed', { requestToken: request.requestToken, error: error?.message ?? String(error) });
      }
    }

    let panel;
    let hostSnapshot = null;

    function safeOrigin(value) {
      try {
        return value ? new URL(value).origin : '';
      } catch {
        return '';
      }
    }

    function mountPanel() {
      if (document.getElementById('mnemosyne-tt-probe')) return;
      const host = document.createElement('div');
      host.id = 'mnemosyne-tt-probe';
      host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;';
      document.body.appendChild(host);
      panel = host.attachShadow({ mode: 'open' });
      panel.innerHTML = `
        <style>
          :host { all: initial; }
          .box { width: 360px; max-height: 72vh; overflow: auto; background: #141820; color: #e8edf2; border: 1px solid #46515d; border-radius: 6px; box-shadow: 0 10px 30px #0008; font: 12px/1.45 system-ui, sans-serif; }
          .head { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border-bottom: 1px solid #303944; font-weight: 700; }
          .body { padding: 8px 10px; display: grid; gap: 7px; }
          .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
          button, select, input { font: inherit; color: inherit; background: #202833; border: 1px solid #586574; border-radius: 4px; padding: 4px 6px; }
          button { cursor: pointer; }
          button:hover { background: #2b3744; }
          input { width: 70px; }
          label { display: inline-flex; gap: 5px; align-items: center; }
          pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: #b9c4ce; }
          .muted { color: #9aa7b3; }
        </style>
        <section class="box">
          <div class="head"><span>Mnemosyne TT Probe</span><span class="muted" id="version">0.1.0</span></div>
          <div class="body">
            <div class="row">
              <label>mode <select id="mode"><option value="immediate">immediate</option><option value="delay">delay</option><option value="timeout">timeout</option><option value="fail">fail</option></select></label>
              <label>ms <input id="delay" type="number" min="0" step="100" value="1000"></label>
              <label><input id="armed" type="checkbox"> arm</label>
            </div>
            <div class="row">
              <label>HTTPS <input id="https-url" type="url" placeholder="https://..." style="width: 190px"></label>
              <button id="https">Test HTTPS</button>
            </div>
            <div class="row">
              <button id="refresh">Refresh host</button>
              <button id="prepare">Prepare</button>
              <button id="cancel">Cancel</button>
              <button id="clear">Clear</button>
              <button id="raw">LLM raw summary</button>
            </div>
            <pre id="status"></pre>
            <pre id="log"></pre>
          </div>
        </section>`;

      panel.getElementById('mode').addEventListener('change', event => {
        state.mode = event.target.value;
      });
      panel.getElementById('delay').addEventListener('change', event => {
        state.delayMs = Math.max(0, Number(event.target.value) || 0);
      });
      panel.getElementById('https-url').addEventListener('change', event => {
        state.httpsUrl = String(event.target.value || '');
      });
      panel.getElementById('armed').addEventListener('change', event => {
        state.armed = Boolean(event.target.checked);
        addLog('armed-changed', { armed: state.armed });
        if (!state.armed) clearPrompts();
      });
      panel.getElementById('refresh').addEventListener('click', () => void refreshHost());
      panel.getElementById('prepare').addEventListener('click', () => void runPrepareOnly());
      panel.getElementById('cancel').addEventListener('click', cancelActive);
      panel.getElementById('clear').addEventListener('click', () => {
        clearPrompts();
        addLog('probe-cleared');
      });
      panel.getElementById('raw').addEventListener('click', () => void readNewestRaw());
      panel.getElementById('https').addEventListener('click', () => void runHttpsProbe());
    }

    function render(snapshot) {
      if (snapshot) hostSnapshot = snapshot;
      if (!panel) return;
      const status = panel.getElementById('status');
      const log = panel.getElementById('log');
      status.textContent = JSON.stringify({
        armed: state.armed,
        mode: state.mode,
        hostReady: state.hostReady,
        host: hostSnapshot,
        lastRawSummary: state.lastRawSummary,
        httpsUrl: safeOrigin(state.httpsUrl),
      }, null, 2);
      log.textContent = logEntries.slice(-12).map(entry => JSON.stringify(entry)).join('\n');
    }

    return {
      generateInterceptor,
      publicApi: Object.freeze({
        inspectHost,
        refreshHost,
        clearPrompts,
        cancelActive,
        runHttpsProbe,
        logs: () => logEntries.map(entry => ({ ...entry })),
        state,
      }),
      start,
    };
  }
}(typeof globalThis === 'object' ? globalThis : window));
