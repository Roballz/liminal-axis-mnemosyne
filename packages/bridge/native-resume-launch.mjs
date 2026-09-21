import {runResume} from './native-resume.mjs';
const status=document.getElementById('mnemosyne-resume-status');
try{const result=await runResume();if(status)status.textContent=JSON.stringify(result,null,2);}
catch{if(status)status.textContent='回执传送未完成，请返回Codex，不要重复点击或刷新。';}
