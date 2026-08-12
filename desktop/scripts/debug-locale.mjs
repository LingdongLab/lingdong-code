import fs from 'fs';

const p =
  'E:/LingdongCode/desktop/VSCode-win32-x64-fresh/resources/app/extensions/ms-ceintl.vscode-language-pack-zh-hans/translations/main.i18n.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log('top keys', Object.keys(j));
console.log('contents keys', j.contents ? Object.keys(j.contents).slice(0, 10) : null);
const s = JSON.stringify(j);
console.log('has Chinese file char', s.includes('文件'));
console.log('has &&File', s.includes('&&File'));
console.log('has menu.file', s.includes('menu.file') || s.includes('menubar'));
const idx = s.indexOf('文件');
console.log('context', s.slice(Math.max(0, idx - 60), idx + 60));

const nls =
  'E:/LingdongCode/desktop/VSCode-win32-x64-fresh/resources/app/out/nls.messages.json';
console.log(
  'nls.messages',
  fs.existsSync(nls),
  fs.existsSync(nls) ? fs.statSync(nls).size : 0,
);

const lp = JSON.parse(
  fs.readFileSync('C:/Users/Administrator/AppData/Roaming/Lingdong/languagepacks.json', 'utf8'),
);
console.log('languagepacks zh-cn hash', lp['zh-cn']?.hash);
console.log('languagepacks label', lp['zh-cn']?.label);
console.log('vscode translation path exists', fs.existsSync(lp['zh-cn']?.translations?.vscode));
