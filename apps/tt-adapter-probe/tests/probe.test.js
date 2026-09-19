const test = require('node:test');
const assert = require('node:assert/strict');
const { core } = require('../index.js');

test('snapshot changes when the current chat head changes', () => {
  const first = core.snapshotFromState({
    chatId: 'chat-a',
    chat: [{ name: 'A', is_user: false, is_system: false, mes: 'one' }],
  });
  const same = core.snapshotFromState({
    chatId: 'chat-a',
    chat: [{ name: 'A', is_user: false, is_system: false, mes: 'one' }],
  });
  const changed = core.snapshotFromState({
    chatId: 'chat-a',
    chat: [{ name: 'A', is_user: false, is_system: false, mes: 'two' }],
  });

  assert.equal(core.sameSnapshot(first, same), true);
  assert.equal(core.sameSnapshot(first, changed), false);
});

test('request gate rejects a response after the head changes', async () => {
  let current = { chatId: 'chat-a', chat: [{ mes: 'one' }] };
  const gate = core.createRequestGate(async () => core.snapshotFromState(current));
  const request = await gate.begin({ type: 'normal' });

  assert.equal(await gate.canApply(request), true);
  current = { chatId: 'chat-a', chat: [{ mes: 'two' }] };
  assert.equal(await gate.canApply(request), false);
});

test('a newer request cancels the older request', async () => {
  const gate = core.createRequestGate(async () => core.snapshotFromState({ chatId: 'chat-a', chat: [] }));
  const first = await gate.begin();
  const second = await gate.begin();

  assert.equal(first.signal.aborted, true);
  assert.equal(first.signal.reason, 'superseded');
  assert.equal(await gate.canApply(first), false);
  assert.equal(await gate.canApply(second), true);
});

test('an older concurrent begin cannot reclaim active after snapshot reorder', async () => {
  let callCount = 0;
  let releaseFirstSnapshot;
  const firstSnapshot = new Promise(resolve => {
    releaseFirstSnapshot = resolve;
  });
  const snapshot = core.snapshotFromState({ chatId: 'chat-a', chat: [] });
  const gate = core.createRequestGate(async () => {
    callCount += 1;
    return callCount === 1 ? firstSnapshot : snapshot;
  });

  const firstPromise = gate.begin({ label: 'A' });
  await Promise.resolve();
  const secondPromise = gate.begin({ label: 'B' });
  const second = await secondPromise;

  assert.equal(gate.current(), second);
  releaseFirstSnapshot(snapshot);
  const first = await firstPromise;

  assert.equal(first.signal.aborted, true);
  assert.equal(first.signal.reason, 'superseded');
  assert.equal(await gate.canApply(first), false);
  assert.equal(gate.current(), second);
  assert.equal(await gate.canApply(second), true);
});

test('fake prepare supports delay, failure, timeout, and cancellation', async () => {
  const delayed = await core.fakePrepare({ mode: 'delay', delayMs: 1, marker: 'x' });
  assert.equal(delayed.marker, 'x');

  await assert.rejects(core.fakePrepare({ mode: 'fail' }), /fake_prepare_failed/);
  await assert.rejects(core.fakePrepare({ mode: 'timeout', timeoutMs: 1 }), /fake_prepare_timeout/);

  const controller = new AbortController();
  const pending = core.fakePrepare({ mode: 'delay', delayMs: 100 }, controller.signal);
  controller.abort('test-cancel');
  await assert.rejects(pending, error => error.name === 'AbortError' && error.message === 'test-cancel');
});

test('raw log summary exposes role order without prompt content', () => {
  const summary = core.summarizeRaw(JSON.stringify({
    messages: [
      { role: 'system', content: 'MNEMOSYNE_TT_PROBE:system' },
      { role: 'user', content: 'MNEMOSYNE_TT_PROBE user @d0' },
    ],
  }));

  assert.deepEqual(summary.roles, ['system', 'user']);
  assert.deepEqual(summary.contentLengths, [25, 27]);
  assert.equal(summary.containsProbeMarker, true);
  assert.deepEqual(summary.markers, { beforeHistory: false, userD0: true, systemD0: false });
  assert.deepEqual(summary.markerMessageIndexes, [{ index: 1, role: 'user', hits: ['userD0'] }]);
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'content'), false);
});

test('message fingerprints retain edit and swipe evidence without message text', () => {
  const fingerprint = core.messageFingerprint({
    is_user: false,
    mes: 'T02A_TEST_EDITED',
    swipe_id: 1,
    swipes: ['T02A_TEST_OLD', 'T02A_TEST_ACTIVE'],
  }, 4);

  assert.equal(fingerprint.index, 4);
  assert.equal(fingerprint.text.length, 16);
  assert.equal(fingerprint.text.hash, core.fnv1a('T02A_TEST_EDITED'));
  assert.equal(fingerprint.swipeId, 1);
  assert.equal(fingerprint.swipeCount, 2);
  assert.equal(fingerprint.activeSwipe.length, 16);
  assert.equal(Object.prototype.hasOwnProperty.call(fingerprint, 'mes'), false);
});

test('event index inference keeps numeric candidates separate from redacted args', () => {
  assert.deepEqual(core.inferMessageIndexes([{ index: 7, text: 'secret body' }]), {
    candidates: [7],
    numericValues: [7],
    inference: 'keyed',
  });

  const summary = core.summarizeEventValue({ index: 7, mes: 'secret body' });
  assert.equal(summary.index, 7);
  assert.equal(summary.mesLengthHash.length, 11);
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'mes'), false);
  assert.equal(JSON.stringify(summary).includes('secret body'), false);
});

test('message state reports count and a bounded neighboring fingerprint window', () => {
  const state = core.messageStateFromChat([
    { mes: 'zero' },
    { mes: 'one' },
    { mes: 'two' },
  ], [1]);

  assert.equal(state.count, 3);
  assert.deepEqual(state.selected.map(message => message.index), [0, 1, 2]);
  assert.deepEqual(state.selected.map(message => message.text.length), [4, 3, 3]);
  assert.equal(state.selected[0].swipeId, null);
});

test('window info redacts chat display identifiers while retaining hashes', () => {
  const summary = core.summarizeWindowInfo({
    mode: 'off',
    chatKind: 'character',
    chatRef: {
      kind: 'character',
      characterId: 'default_Seraphina',
      fileName: 'Seraphina - chat - RENAME',
    },
    totalCount: 7,
    windowStartIndex: 0,
    windowLength: 7,
  });

  assert.equal(summary.chatRef.kind, 'character');
  assert.deepEqual(summary.chatRef.characterId, core.redactText('default_Seraphina'));
  assert.deepEqual(summary.chatRef.fileName, core.redactText('Seraphina - chat - RENAME'));
  assert.equal(JSON.stringify(summary).includes('Seraphina'), false);
  assert.equal(summary.totalCount, 7);
});

test('trace export orders entries by sequence without mutating capture order', () => {
  const captured = [{ sequence: 3 }, { sequence: 1 }, { sequence: 2 }];
  const ordered = core.orderTrace(captured);

  assert.deepEqual(ordered.map(entry => entry.sequence), [1, 2, 3]);
  assert.deepEqual(captured.map(entry => entry.sequence), [3, 1, 2]);
});

test('metadata uses handle.metadata.get and camelCase context evidence, without exporting metadata', async () => {
  const metadata = { integrity: 'test-parent-id', secret: 'not for export' };
  const handle = { metadata: { async get() { assert.equal(this, handle.metadata); return metadata; } } };
  const evidence = await core.readMetadataEvidence(handle, {
    chatMetadata: metadata,
    chat_metadata: { integrity: 'wrong-legacy-path' },
  }, 'test-parent-id');
  assert.equal(evidence.metadataStatus, 'ok');
  assert.equal(evidence.stableIdMatchesIntegrity, true);
  assert.equal(evidence.stableIdMatchesContextIntegrity, true);
  assert.equal(evidence.metadataMatchesContextIntegrity, true);
  assert.equal(evidence.integrity.hash, core.fnv1a('test-parent-id'));
  assert.equal(JSON.stringify(evidence).includes('test-parent-id'), false);
  assert.equal(JSON.stringify(evidence).includes('not for export'), false);
});

test('metadata mismatch, missing API and rejected API remain distinct', async () => {
  const context = { chatMetadata: { integrity: 'context-id' } };
  const mismatch = await core.readMetadataEvidence({
    metadata: { get: async () => ({ integrity: 'metadata-id' }) },
  }, context, 'stable-id');
  assert.equal(mismatch.stableIdMatchesIntegrity, false);
  assert.equal(mismatch.metadataMatchesContextIntegrity, false);
  const absent = await core.readMetadataEvidence({}, context, 'context-id');
  assert.equal(absent.metadataStatus, 'unavailable');
  assert.equal(absent.integrity, null);
  assert.equal(absent.stableIdMatchesIntegrity, null);
  assert.equal(absent.stableIdMatchesContextIntegrity, true);
  const failed = await core.readMetadataEvidence({
    metadata: { get: async () => { throw new Error('private detail'); } },
  }, {}, 'stable-id');
  assert.equal(failed.metadataStatus, 'error');
  assert.equal(failed.contextIntegrity, null);
  assert.equal(JSON.stringify(failed).includes('private detail'), false);
});

test('chat summary is invoked on handle with includeMetadata false and only exports message_count', async () => {
  let called = false;
  const handle = {
    history: { summary() { throw new Error('wrong API path'); } },
    async summary(options) {
      called = true;
      assert.equal(this, handle);
      assert.deepEqual(options, { includeMetadata: false });
      return { message_count: 7, metadata: { secret: 'private' }, file_name: 'private' };
    },
  };
  assert.deepEqual(await core.readChatSummary(handle), { status: 'ok', message_count: 7 });
  assert.equal(called, true);
});

test('chat summary distinguishes zero count, missing API, empty response and API failure', async () => {
  assert.deepEqual(await core.readChatSummary({ summary: async () => ({ message_count: 0 }) }),
    { status: 'ok', message_count: 0 });
  assert.deepEqual(await core.readChatSummary({}), { status: 'unavailable', message_count: null });
  assert.deepEqual(await core.readChatSummary({ summary: async () => null }), { status: 'empty', message_count: null });
  assert.deepEqual(await core.readChatSummary({ summary: async () => { throw new Error('private'); } }),
    { status: 'error', message_count: null });
});

test('delete length and generation arguments are not inferred as message indexes', () => {
  assert.deepEqual(core.inferMessageIndexes([6], 'message-deleted'), {
    candidates: [], numericValues: [6], inference: 'post_delete_count',
  });
  assert.deepEqual(core.inferMessageIndexes([6], 'generation-ended').candidates, []);
  assert.deepEqual(core.inferMessageIndexes([3], 'message-edited').candidates, [3]);
});

test('watched delete neighborhood retains shifted fingerprints independently of event arguments', () => {
  const chat = Array.from({ length: 7 }, (_, index) => ({ mes: `T02A_TEST_${index}` }));
  const before = core.messageStateFromChat(chat, [5]);
  chat.splice(5, 1);
  const after = core.messageStateFromChat(chat, [5]);
  assert.deepEqual(before.selected.map(message => message.index), [4, 5, 6]);
  assert.deepEqual(after.selected.map(message => message.index), [4, 5]);
  assert.equal(before.selected[2].text.hash, after.selected[1].text.hash);
});

test('panel drag uses pointer capture, clamps to viewport, ends on cancel and reclamps on resize', () => {
  const listeners = {};
  let captured = null;
  let resized;
  const header = {
    addEventListener: (name, callback) => { listeners[name] = callback; },
    setPointerCapture: id => { captured = id; },
    hasPointerCapture: id => captured === id,
    releasePointerCapture: () => { captured = null; },
  };
  const host = {
    style: {},
    getBoundingClientRect: () => ({
      left: parseFloat(host.style.left ?? '100'),
      top: parseFloat(host.style.top ?? '100'),
      width: 360, height: 300,
    }),
  };
  const viewport = { innerWidth: 1000, innerHeight: 800, addEventListener: (_, callback) => { resized = callback; } };
  core.bindPanelDrag(host, header, viewport);
  const event = { button: 0, pointerId: 1, clientX: 110, clientY: 110, preventDefault() {} };
  listeners.pointerdown({ ...event, button: 2 });
  assert.equal(captured, null);
  listeners.pointerdown(event);
  assert.equal(captured, 1);
  listeners.pointermove({ ...event, pointerId: 2, clientX: 400 });
  assert.equal(host.style.left, undefined);
  listeners.pointermove({ ...event, clientX: 400, clientY: 300 });
  assert.equal(host.style.left, '390px');
  assert.equal(host.style.top, '290px');
  listeners.pointermove({ ...event, clientX: 2000, clientY: -100 });
  assert.equal(host.style.left, '640px');
  assert.equal(host.style.top, '0px');
  listeners.pointercancel(event);
  assert.equal(captured, null);
  listeners.pointermove({ ...event, clientX: 400 });
  assert.equal(host.style.left, '640px');
  viewport.innerWidth = 500;
  resized();
  assert.equal(host.style.left, '140px');
  assert.equal(host.style.right, 'auto');
  assert.equal(host.style.bottom, 'auto');
});
