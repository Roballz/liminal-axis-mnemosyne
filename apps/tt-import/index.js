(async () => {
  await globalThis.__TAURITAVERN__?.ready;
  const { mountPanel } = await import('./packages/bridge/panel.mjs');
  mountPanel();
})();
