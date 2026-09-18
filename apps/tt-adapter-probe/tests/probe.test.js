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
