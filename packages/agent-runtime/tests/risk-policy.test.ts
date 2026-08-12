import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCommand,
  classifyInlineScript,
  classifyWriteTarget,
  isManifestPath,
  isSensitivePath,
  splitCommandSegments,
  worstRisk,
} from "../src/risk-policy.js";

test("提权、系统配置与强制推送属于 blocked", () => {
  assert.equal(classifyCommand("sudo rm -rf /").risk, "blocked");
  assert.equal(classifyCommand("reg add HKLM\\Software\\Test /v A /d 1").risk, "blocked");
  assert.equal(classifyCommand("Set-Service -Name W32Time -StartupType Disabled").risk, "blocked");
  assert.equal(classifyCommand("git push --force origin main").risk, "blocked");
  assert.equal(classifyCommand("winget install Git.Git").risk, "blocked");
  assert.equal(classifyCommand("setx PATH C:\\bin").risk, "blocked");
});

test("命令中出现凭据或密钥路径一律 blocked", () => {
  const verdict = classifyCommand("type C:\\Users\\me\\.ssh\\id_rsa");
  assert.equal(verdict.risk, "blocked");
  assert.equal(verdict.kind, "read_credentials");
});

test("删除、回退与未知命令属于 high", () => {
  assert.equal(classifyCommand("Remove-Item .\\dist -Recurse").risk, "high");
  assert.equal(classifyCommand("git reset --hard HEAD~1").risk, "high");
  assert.equal(classifyCommand("git push origin main").risk, "high");
  assert.equal(classifyCommand("some-unknown-binary --run").risk, "high");
  assert.equal(classifyCommand("some-unknown-binary --run").kind, "unknown");
});

test("依赖安装、提交、网络与长期服务属于 medium", () => {
  assert.equal(classifyCommand("npm install lodash").risk, "medium");
  assert.equal(classifyCommand("pip install requests").risk, "medium");
  assert.equal(classifyCommand("git commit -m \"更新\"").risk, "medium");
  assert.equal(classifyCommand("curl https://example.com").risk, "medium");
  assert.equal(classifyCommand("npm run dev").risk, "medium");
});

test("只读查询、测试与格式化属于 low", () => {
  assert.equal(classifyCommand("git status").risk, "low");
  assert.equal(classifyCommand("npm test").risk, "low");
  assert.equal(classifyCommand("npm run lint").risk, "low");
  assert.equal(classifyCommand("tsc --noEmit").risk, "low");
  assert.equal(classifyCommand("rg 标题 src").risk, "low");
});

test("链式命令取最严重的一段", () => {
  assert.deepEqual(splitCommandSegments("git status && rm -rf dist"), ["git status", "rm -rf dist"]);
  assert.equal(classifyCommand("git status && rm -rf dist").risk, "high");
  assert.equal(classifyCommand("npm test && sudo shutdown").risk, "blocked");
});

/**
 * PowerShell 只读管道。
 *
 * 这是实际踩到的坑：Windows 上模型几乎必然用 `| Select-Object -First N` 截断输出，
 * 而 Select-Object 当时不在任何规则里，兜底成 unknown → high，于是整条命令被顶成
 * 高风险弹窗——哪怕前半段只是 curl（medium）甚至 git status（low）。
 */
test("PowerShell 的筛选与格式化管道不该把整条命令顶成 high", () => {
  const curl = classifyCommand(
    'curl.exe -s -L --max-time 20 "https://example.com/" 2>$null | Select-Object -First 120',
  );
  assert.equal(curl.risk, "medium", "整条应回落到 curl 自身的联网风险");
  assert.equal(curl.kind, "network_access");

  assert.equal(classifyCommand("Select-Object -First 120").risk, "low");
  assert.equal(classifyCommand("git status | Measure-Object -Line").risk, "low");
  assert.equal(classifyCommand("Get-ChildItem | Sort-Object Length | Format-Table").risk, "low");
  assert.equal(classifyCommand("Get-Content package.json | ConvertFrom-Json").risk, "low");
  assert.equal(classifyCommand("npm test | Out-String").risk, "low");

  // 落盘的仍然是写入：Out-File / Tee-Object 不在只读名单里。
  assert.equal(classifyCommand("git status | Out-File log.txt").risk, "medium");
  assert.equal(classifyCommand("git status | Tee-Object log.txt").risk, "medium");
});

/**
 * `^format\b` 的词边界落在 "Format" 和 "-" 之间，于是 Format-Table / Format-List
 * 命中了「磁盘格式化」这条 blocked 规则。blocked 是硬拒，连人工批准都救不回来，
 * 所以这类误判比多弹一次窗严重得多。
 */
test("Format-Table 不是磁盘格式化，但 format C: 仍要 blocked", () => {
  assert.equal(classifyCommand("Format-Table -AutoSize").risk, "low");
  assert.equal(classifyCommand("Format-List *").risk, "low");
  assert.equal(classifyCommand("format C: /fs:ntfs").risk, "blocked");
  assert.equal(classifyCommand("diskpart").risk, "blocked");
});

test("ForEach-Object / Where-Object 的脚本块要按里面的命令判", () => {
  assert.equal(classifyCommand("Get-ChildItem | Where-Object Length -gt 100").risk, "low");
  assert.equal(classifyCommand("Get-ChildItem | ForEach-Object { $_.Name }").risk, "low");

  // 花括号里可以塞任意命令，删起文件来和直接 rm 没区别。
  const remove = classifyCommand("Get-ChildItem | ForEach-Object { Remove-Item $_ }");
  assert.equal(remove.risk, "high");
  assert.equal(remove.kind, "delete_file");

  assert.equal(classifyCommand("Get-ChildItem | % { Remove-Item $_ }").risk, "high");
  assert.equal(classifyCommand("Get-ChildItem | ForEach-Object { sudo rm $_ }").risk, "blocked");
  // 别名 ? 同样要看进去。
  assert.equal(classifyCommand("Get-ChildItem | ? { Remove-Item $_ }").risk, "high");
  // 赋值不是挡箭牌：等号右边照样是命令。
  assert.equal(classifyCommand("Get-ChildItem | ForEach-Object { $x = Remove-Item $_ }").risk, "high");
});

test("取值与比较表达式算 low，但内嵌命令调用不算", () => {
  assert.equal(classifyCommand("$_.Length -gt 100").risk, "low");
  assert.equal(classifyCommand("-not $_.PSIsContainer").risk, "low");

  // 子表达式、调用操作符与 Invoke-Expression 会真的执行命令，仍按无法判读处理。
  assert.equal(classifyCommand("$x = $(Remove-Item foo)").risk, "high");
  assert.equal(classifyCommand("& C:\\tools\\thing.exe").risk, "high");
  assert.equal(classifyCommand("$code | Invoke-Expression").risk, "high");
  // 改环境变量的 high 规则排在前面，不会被表达式兜底降级。
  assert.equal(classifyCommand("$env:TOKEN = \"abc\"").risk, "high");
});

test("环境变量前缀不会掩盖真实命令", () => {
  assert.equal(classifyCommand("CI=1 npm test").risk, "low");
  assert.equal(classifyCommand("CI=1 sudo npm test").risk, "blocked");
});

test("只读的内联解析脚本不再一律按 high 处理", () => {
  const parse = classifyCommand('python -c "import json,sys; print(json.loads(sys.stdin.read())[\'a\'])"');
  assert.equal(parse.risk, "low");
  assert.equal(parse.kind, "run_command");

  const readFile = classifyCommand('python -c "from html.parser import HTMLParser; print(open(\'index.html\').read()[:200])"');
  assert.equal(readFile.risk, "medium");
  assert.equal(readFile.kind, "read_file");

  assert.equal(classifyCommand('python -c "import ast; ast.parse(open(\'app.py\').read())"').risk, "medium");
  assert.equal(classifyCommand('node -e "console.log(JSON.parse(process.argv[1]).name)"').risk, "low");
  assert.equal(classifyCommand("python -m json.tool package.json").risk, "medium");
});

test("内联脚本一旦有副作用仍然是 high", () => {
  assert.equal(classifyCommand('python -c "open(\'a.txt\',\'w\').write(\'x\')"').kind, "write_file");
  assert.equal(classifyCommand('python -c "open(\'a.txt\',\'w\').write(\'x\')"').risk, "high");
  assert.equal(classifyCommand('python -c "import os; os.remove(\'a.txt\')"').kind, "delete_file");
  assert.equal(classifyCommand('python -c "import subprocess; subprocess.run([\'ls\'])"').kind, "run_command");
  assert.equal(classifyCommand('python -c "import subprocess; subprocess.run([\'ls\'])"').risk, "high");
  assert.equal(classifyCommand('python -c "import os; os.system(\'dir\')"').risk, "high");
  assert.equal(classifyCommand('python -c "import urllib.request; urllib.request.urlopen(\'http://x\')"').kind, "network_access");
  assert.equal(classifyCommand('python -c "import os; os.environ[\'PATH\']=\'x\'"').kind, "modify_environment");
  assert.equal(classifyCommand('node -e "require(\'fs\').writeFileSync(\'a.txt\',\'x\')"').risk, "high");
  assert.equal(classifyCommand('python -c "exec(open(\'x.py\').read())"').risk, "high");
});

test("内联脚本判定不会掩盖提权与凭据", () => {
  assert.equal(classifyCommand('sudo python -c "print(1)"').risk, "blocked");
  assert.equal(classifyCommand('python -c "print(open(\'.ssh/id_rsa\').read())"').risk, "blocked");
  assert.equal(classifyCommand(`python -c "${"x".repeat(2_100)}"`).risk, "high");
  assert.equal(classifyInlineScript("npm test"), undefined);
});

test("写到标准输出不算写文件", () => {
  const verdict = classifyInlineScript('python -c "import sys,json; sys.stdout.write(json.dumps({}))"');
  assert.equal(verdict?.risk, "low");
});

test("写入清单文件比普通源文件风险更高", () => {
  assert.equal(classifyWriteTarget(["E:\\ws\\src\\index.ts"]).risk, "low");
  assert.equal(classifyWriteTarget(["E:\\ws\\package.json"]).risk, "medium");
  assert.equal(isManifestPath("E:\\ws\\requirements.txt"), true);
  assert.equal(isSensitivePath("E:\\ws\\.env"), true);
  assert.equal(worstRisk("low", "high"), "high");
});
