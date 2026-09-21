import {runInspection} from './native-inspect.mjs';
const status=document.getElementById('mnemosyne-inspect-status');
try {
  const result=await runInspection();
  if(status)status.textContent=JSON.stringify(result,null,2);
}catch {
  if(status)status.textContent='核对入口或回执传送未完成；请返回Codex，不要重复点击或刷新。';
}
