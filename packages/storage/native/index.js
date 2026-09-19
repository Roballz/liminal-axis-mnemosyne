// Installed only in the isolated portable TT fixture. No chat/model APIs.
(async () => {
  const endpoint = 'http://127.0.0.1:19374';
  const send = async value => {
    const response = await fetch(endpoint + '/result', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    if (!response.ok) throw Error('Evidence collector rejected result');
  };
  try {
    await window.__TAURITAVERN__.ready;
    const config = await (await fetch(endpoint + '/phase')).json();
    if (config.fixture !== 'mnemosyne-t03-isolated-367b0c7') throw Error('Wrong collector');
    const { runNative } = await import('./packages/storage/native/suite.mjs');
    await runNative(window.__TAURITAVERN__.api.db, config, send);
  } catch (error) {
    await send({ type: 'error', code: error.code ?? null, message: String(error.message),
      cause: error.cause ? String(error.cause.message ?? error.cause) : null,
      stack: String(error.stack ?? '').split('\n').slice(0, 5) }).catch(() => {});
  }
})();
