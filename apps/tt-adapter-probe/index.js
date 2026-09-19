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

    function redactText(value) {
      const text = String(value ?? '');
      return { length: text.length, hash: fnv1a(text) };
    }

    function summarizeIdentityValue(value) {
      if (value == null) return null;
      return { kind: typeof value, ...redactText(typeof value === 'string' ? value : JSON.stringify(value)) };
    }

    async function readMetadataEvidence(handle, context, stableId) {
      let metadata;
      let metadataStatus = 'unavailable';
      if (typeof handle?.metadata?.get === 'function') {
        try {
          metadata = await handle.metadata.get();
          metadataStatus = 'ok';
        } catch {
          metadataStatus = 'error';
        }
      }
      const integrity = metadata?.integrity ?? null;
      const contextIntegrity = context?.chatMetadata?.integrity ?? null;
      const matches = (left, right) => left == null || right == null ? null : left === right;
      return {
        metadataStatus,
        integrity: summarizeIdentityValue(integrity),
        contextIntegrity: summarizeIdentityValue(contextIntegrity),
        stableIdMatchesIntegrity: matches(stableId, integrity),
        stableIdMatchesContextIntegrity: matches(stableId, contextIntegrity),
        metadataMatchesContextIntegrity: matches(integrity, contextIntegrity),
      };
    }

    async function readChatSummary(handle) {
      if (typeof handle?.summary !== 'function') return { status: 'unavailable', message_count: null };
      try {
        const summary = await handle.summary({ includeMetadata: false });
        return {
          status: summary == null ? 'empty' : 'ok',
          message_count: Number.isInteger(summary?.message_count) ? summary.message_count : null,
        };
      } catch {
        return { status: 'error', message_count: null };
      }
    }

    function bindPanelDrag(host, header, viewport) {
      let drag = null;
      const place = (left, top) => {
        const rect = host.getBoundingClientRect();
        host.style.left = `${Math.max(0, Math.min(left, viewport.innerWidth - rect.width))}px`;
        host.style.top = `${Math.max(0, Math.min(top, viewport.innerHeight - rect.height))}px`;
        host.style.right = 'auto';
        host.style.bottom = 'auto';
      };
      header.addEventListener('pointerdown', event => {
        if (event.button !== 0 || drag) return;
        const rect = host.getBoundingClientRect();
        drag = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
        header.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      header.addEventListener('pointermove', event => {
        if (drag?.id !== event.pointerId) return;
        place(event.clientX - drag.x, event.clientY - drag.y);
      });
      const stop = event => {
        if (drag?.id !== event.pointerId) return;
        drag = null;
        if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId);
      };
      header.addEventListener('pointerup', stop);
      header.addEventListener('pointercancel', stop);
      header.addEventListener('lostpointercapture', stop);
      const clamp = () => {
        const rect = host.getBoundingClientRect();
        place(rect.left, rect.top);
      };
      viewport.addEventListener('resize', clamp);
      if (typeof viewport.ResizeObserver === 'function') new viewport.ResizeObserver(clamp).observe(host);
    }

    function summarizeWindowInfo(value) {
      if (value == null) return null;
      if (typeof value !== 'object') return { kind: typeof value };

      const output = {};
      for (const key of ['mode', 'chatKind']) {
        if (typeof value[key] === 'string') output[key] = value[key];
      }
      for (const key of ['totalCount', 'windowStartIndex', 'windowLength']) {
        if (Number.isInteger(value[key])) output[key] = value[key];
      }

      if (value.chatRef && typeof value.chatRef === 'object') {
        const chatRef = {};
        if (typeof value.chatRef.kind === 'string') chatRef.kind = value.chatRef.kind;
        for (const key of ['characterId', 'fileName', 'chatId', 'id']) {
          const item = value.chatRef[key];
          if (typeof item === 'string' || typeof item === 'number') {
            chatRef[key] = redactText(item);
          }
        }
        output.chatRef = chatRef;
      }
      return output;
    }

    function messageFingerprint(message, index = null) {
      const text = typeof message?.mes === 'string' ? message.mes : '';
      const swipes = Array.isArray(message?.swipes) ? message.swipes : [];
      const rawSwipeId = message?.swipe_id;
      const swipeId = rawSwipeId == null || rawSwipeId === '' || !Number.isInteger(Number(rawSwipeId))
        ? null
        : Number(rawSwipeId);
      const activeSwipe = swipeId != null && typeof swipes[swipeId] === 'string'
        ? swipes[swipeId]
        : null;

      return {
        index,
        isUser: Boolean(message?.is_user),
        isSystem: Boolean(message?.is_system),
        text: redactText(text),
        hasProbeMarker: text.includes('MNEMOSYNE_TT_PROBE') || text.includes('T02A_TEST_'),
        swipeId,
        swipeCount: swipes.length,
        activeSwipe: activeSwipe == null ? null : redactText(activeSwipe),
      };
    }

    function messageStateFromChat(chat, indexes = []) {
      const messages = Array.isArray(chat) ? chat : [];
      const requested = Array.isArray(indexes) ? indexes : [indexes];
      const anchors = requested
        .flatMap(value => [Number(value) - 1, Number(value), Number(value) + 1])
        .concat(messages.length ? messages.length - 1 : [])
        .filter(Number.isInteger)
        .filter(index => index >= 0 && index < messages.length);
      const selectedIndexes = [...new Set(anchors)].slice(0, 12).sort((left, right) => left - right);

      return {
        count: messages.length,
        selected: selectedIndexes.map(index => messageFingerprint(messages[index], index)),
      };
    }

    function inferMessageIndexes(args, eventName) {
      if (eventName === 'message-deleted') {
        return { candidates: [], numericValues: args.filter(Number.isInteger), inference: 'post_delete_count' };
      }
      if (eventName && !['message-edited', 'message-updated', 'message-swiped', 'message-received'].includes(eventName)) {
        return { candidates: [], numericValues: [], inference: 'not_a_message_index' };
      }
      const explicit = [];
      const numeric = [];
      const seen = new WeakSet();
      const visit = (value, key = '') => {
        if (Number.isInteger(value)) {
          numeric.push(value);
          if (/^(index|messageIndex|message_index|mesId|mes_id)$/i.test(key)) explicit.push(value);
          return;
        }
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
          value.forEach(item => visit(item));
          return;
        }
        Object.entries(value).forEach(([entryKey, item]) => visit(item, entryKey));
      };
      visit(args);
      const unique = values => [...new Set(values.filter(value => value >= 0))];
      const numericValues = unique(numeric);
      const candidates = unique(explicit.length ? explicit : numericValues.slice(0, 1));
      return {
        candidates,
        numericValues,
        inference: explicit.length ? 'keyed' : numericValues.length ? 'numeric_candidate' : 'none',
      };
    }

    function summarizeEventValue(value, key = '', depth = 0, seen = new WeakSet()) {
      if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
      if (typeof value === 'string') return redactText(value);
      if (typeof value !== 'object') return { type: typeof value };
      if (seen.has(value)) return { type: 'cycle' };
      if (depth >= 3) return { type: Array.isArray(value) ? 'array' : 'object' };
      seen.add(value);
      if (Array.isArray(value)) return value.slice(0, 12).map(item => summarizeEventValue(item, '', depth + 1, seen));

      const output = {};
      for (const [entryKey, item] of Object.entries(value).slice(0, 24)) {
        if (/^(mes|content|prompt|response|requestRaw|responseRaw|text)$/i.test(entryKey) && typeof item === 'string') {
          output[`${entryKey}LengthHash`] = redactText(item);
        } else {
          output[entryKey] = summarizeEventValue(item, entryKey, depth + 1, seen);
        }
      }
      return output;
    }

    function orderTrace(entries) {
      return (Array.isArray(entries) ? entries : []).slice().sort((left, right) => {
        const leftSequence = Number.isFinite(left?.sequence) ? left.sequence : Number.MAX_SAFE_INTEGER;
        const rightSequence = Number.isFinite(right?.sequence) ? right.sequence : Number.MAX_SAFE_INTEGER;
        return leftSequence - rightSequence;
      });
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
      bindPanelDrag,
      createRequestGate,
      fakePrepare,
      fnv1a,
      inferMessageIndexes,
      messageFingerprint,
      messageStateFromChat,
      makeToken,
      orderTrace,
      redactText,
      readMetadataEvidence,
      readChatSummary,
      sameSnapshot,
      snapshotFromState,
      summarizeEventValue,
      summarizeIdentityValue,
      summarizeWindowInfo,
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
      latestMessageState: null,
      eventTrace: [],
      eventSequence: 0,
      traceVisible: false,
      watchIndex: null,
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
          if (item && typeof item === 'object'
            && Number.isInteger(item.length)
            && typeof item.hash === 'string') {
            output[key] = { length: item.length, hash: item.hash };
            continue;
          }
          output[`${key}Length`] = typeof item === 'string' ? item.length : item == null ? 0 : JSON.stringify(item).length;
          continue;
        }
        output[key] = sanitize(item);
      }
      return output;
    }

    function summarizeIdentityValue(value) {
      return probeCore.summarizeIdentityValue(value);
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

    async function readIdentity(options = {}) {
      const refs = options.refs ?? await waitForCurrentRefs();
      let stableId = null;
      try {
        stableId = await callMaybe(refs.handle, 'stableId');
      } catch (error) {
        if (!options.quiet) addLog('stable-id-error', { message: error.message });
      }
      const context = getContext();
      let currentChatId = null;
      try {
        currentChatId = await callMaybe(context, 'getCurrentChatId');
      } catch (error) {
        if (!options.quiet) addLog('context-chat-id-error', { message: error.message });
      }
      const identity = {
        stableId: summarizeIdentityValue(stableId),
        ...await probeCore.readMetadataEvidence(refs.handle, context, stableId),
        ref: summarizeIdentityValue(refs.ref),
        currentChatId: summarizeIdentityValue(currentChatId),
      };
      return identity;
    }

    async function readMessageState(indexes = []) {
      const context = getContext();
      const chat = Array.isArray(context?.chat) ? context.chat : [];
      const watched = state.watchIndex == null ? indexes : [...indexes, state.watchIndex];
      const messages = probeCore.messageStateFromChat(chat, watched);
      const refs = await waitForCurrentRefs(2500);
      let tail;
      try {
        tail = await refs.handle?.history?.tail?.({ limit: 3 });
      } catch (error) {
        addLog('history-state-error', { message: error.message });
      }
      const summary = await probeCore.readChatSummary(refs.handle);
      return {
        ...messages,
        watchIndex: state.watchIndex,
        history: {
          tailCount: Array.isArray(tail?.messages) ? tail.messages.length : null,
          tailHasMoreBefore: typeof tail?.hasMoreBefore === 'boolean' ? tail.hasMoreBefore : null,
          summary,
        },
      };
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
      const identity = await readIdentity({ refs, quiet: true });
      const messageState = await readMessageState();
      return {
        probeVersion: '0.1.4',
        observedAt: Date.now(),
        tauri: {
          present: Boolean(globalObject.__TAURITAVERN__),
          api: Object.keys(refs.api ?? {}),
          chat: Object.keys(refs.chatApi ?? {}),
          dev: Object.keys(dev ?? {}),
        },
        chat: {
          ref: summarizeIdentityValue(refs.ref),
          ready: Boolean(refs.ref || refs.handle),
          stableIdAvailable: typeof refs.handle?.stableId === 'function',
          identity,
          windowInfo: probeCore.summarizeWindowInfo(windowInfo),
          tailCount: Array.isArray(tail?.messages) ? tail.messages.length : null,
          tailHasMoreBefore: typeof tail?.hasMoreBefore === 'boolean' ? tail.hasMoreBefore : null,
          contextCount: chat.length,
          messageState,
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

    async function captureHostEvent(name, args, sequence) {
      const inferred = probeCore.inferMessageIndexes(args, name);
      const before = state.latestMessageState;
      const observedAt = Date.now();
      const identity = await readIdentity({ quiet: true });
      const immediate = await readMessageState(inferred.candidates);
      await new Promise(resolve => setTimeout(resolve, 0));
      const after = await readMessageState(inferred.candidates);
      const record = {
        sequence,
        observedAt,
        eventName: name,
        eventArgs: probeCore.summarizeEventValue(args),
        indexInference: inferred,
        generationType: name === 'generation-started' && ['normal', 'regenerate', 'swipe', 'continue'].includes(args[0])
          ? args[0] : null,
        identity,
        before,
        immediate,
        after,
      };
      state.latestMessageState = after;
      state.eventTrace.push(record);
      if (state.eventTrace.length > 40) state.eventTrace.shift();
      addLog('host-event', record);
      return record;
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
        ['MESSAGE_RECEIVED', 'message-received', false],
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
        source.on(eventName, (...args) => {
          const sequence = state.eventSequence += 1;
          if (invalidates) {
            gate.cancel(name);
            const cleared = clearPrompts();
            addLog('probe-cleared', { reason: name, applied: cleared });
          }
          void captureHostEvent(name, args, sequence).then(() => {
            if (name === 'chat-changed' || name === 'chat-loaded') void refreshHost();
          });
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
      state.latestMessageState = snapshot.chat.messageState;
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

    function t02aTraceText() {
      return JSON.stringify(probeCore.orderTrace(state.eventTrace), null, 2);
    }

    function hostSnapshotText() {
      return JSON.stringify(hostSnapshot, null, 2);
    }

    async function copyHostSnapshot() {
      const clipboard = globalObject.navigator?.clipboard;
      if (!hostSnapshot || typeof clipboard?.writeText !== 'function') {
        addLog('host-copy-unavailable');
        return;
      }
      try {
        await clipboard.writeText(hostSnapshotText());
        addLog('host-snapshot-copied');
      } catch (error) {
        addLog('host-copy-failed', { error: error?.message ?? String(error) });
      }
    }

    async function copyT02aTrace() {
      state.traceVisible = true;
      const clipboard = globalObject.navigator?.clipboard;
      if (typeof clipboard?.writeText !== 'function') {
        addLog('t02a-copy-unavailable', { events: state.eventTrace.length });
        return;
      }
      try {
        await clipboard.writeText(t02aTraceText());
        addLog('t02a-trace-copied', { events: state.eventTrace.length });
      } catch (error) {
        addLog('t02a-copy-failed', { error: error?.message ?? String(error) });
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
          .box { width: min(360px, calc(100vw - 24px)); max-height: 72vh; overflow: auto; background: #141820; color: #e8edf2; border: 1px solid #46515d; border-radius: 6px; box-shadow: 0 10px 30px #0008; font: 12px/1.45 system-ui, sans-serif; }
          .head { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border-bottom: 1px solid #303944; font-weight: 700; cursor: move; touch-action: none; user-select: none; position: sticky; top: 0; background: #141820; }
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
          <div class="head" id="drag-handle" title="Drag panel"><span>Mnemosyne TT Probe</span><span class="muted" id="version">0.1.4</span></div>
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
              <button id="copy-host">Copy host</button>
              <button id="prepare">Prepare</button>
              <button id="cancel">Cancel</button>
              <button id="clear">Clear</button>
              <button id="raw">LLM raw summary</button>
              <button id="trace">T-02A trace</button>
              <button id="copy-trace">Copy trace</button>
            </div>
            <div class="row"><label>Index (0-based) <input id="watch-index" type="number" min="0" step="1"></label></div>
            <pre id="status"></pre>
            <pre id="trace-output" hidden></pre>
            <pre id="log"></pre>
          </div>
        </section>`;

      probeCore.bindPanelDrag(host, panel.getElementById('drag-handle'), globalObject);
      panel.getElementById('watch-index').addEventListener('change', event => {
        const value = event.target.value;
        state.watchIndex = value !== '' && Number.isInteger(Number(value)) && Number(value) >= 0
          ? Number(value) : null;
      });
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
      panel.getElementById('copy-host').addEventListener('click', () => void copyHostSnapshot());
      panel.getElementById('prepare').addEventListener('click', () => void runPrepareOnly());
      panel.getElementById('cancel').addEventListener('click', cancelActive);
      panel.getElementById('clear').addEventListener('click', () => {
        clearPrompts();
        addLog('probe-cleared');
      });
      panel.getElementById('raw').addEventListener('click', () => void readNewestRaw());
      panel.getElementById('https').addEventListener('click', () => void runHttpsProbe());
      panel.getElementById('trace').addEventListener('click', () => {
        state.traceVisible = !state.traceVisible;
        render();
      });
      panel.getElementById('copy-trace').addEventListener('click', () => void copyT02aTrace());
    }

    function render(snapshot) {
      if (snapshot) hostSnapshot = snapshot;
      if (!panel) return;
      const status = panel.getElementById('status');
      const trace = panel.getElementById('trace-output');
      const log = panel.getElementById('log');
      status.textContent = JSON.stringify({
        armed: state.armed,
        mode: state.mode,
        hostReady: state.hostReady,
        host: hostSnapshot,
        lastRawSummary: state.lastRawSummary,
        httpsUrl: safeOrigin(state.httpsUrl),
      }, null, 2);
      trace.hidden = !state.traceVisible;
      trace.textContent = t02aTraceText();
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
        t02aTrace: () => probeCore.orderTrace(state.eventTrace).map(entry => ({ ...entry })),
        state,
      }),
      start,
    };
  }
}(typeof globalThis === 'object' ? globalThis : window));
