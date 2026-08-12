/**
 * 预检：确保 desktop/patches 里所有 localize / localize2 调用的 key 和 value 都是字面量。
 *
 * 为什么需要它：
 * Code-OSS 构建期的 build/lib/nls.js 会静态扫描这两个函数的调用来生成翻译表，
 * 它取的是参数在源码里的**原文**，然后直接 eval。传变量会 eval 到一个不存在的
 * 标识符，报 "xxx is not defined"。
 *
 * 而这一步跑在整条流水线的最末端 —— 实测在一小时的编译之后才失败。用 gulp 去发现
 * 这个问题，一次的代价是一个小时；用这个脚本，代价是一秒。
 *
 * 判定逻辑照抄 nls.js 的口径：能被 eval 成常量的才算数。
 */

import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, '..');
const patchesRoot = join(desktopRoot, 'patches');
const require = createRequire(join(desktopRoot, 'vscode', 'package.json'));

let ts;
try {
	ts = require('typescript');
} catch {
	console.error('[nls-check] 找不到 typescript（desktop/vscode/node_modules）。跳过检查。');
	process.exit(0);
}

function collectTsFiles(dir) {
	const found = [];
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return found;
	}
	for (const name of entries) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			found.push(...collectTsFiles(full));
		} else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
			found.push(full);
		}
	}
	return found;
}

/**
 * nls.js 对参数做的是 eval(`(${原文})`)，所以只有自包含的字面量能过。
 * key 允许写成 { key: '...', comment: [...] } 的对象形式，这是 VS Code 自己的用法。
 */
function isEvaluableLiteral(node) {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		return true;
	}
	if (ts.isObjectLiteralExpression(node)) {
		return node.properties.every(
			(p) => ts.isPropertyAssignment(p) && isEvaluableLiteralOrArray(p.initializer)
		);
	}
	return false;
}

function isEvaluableLiteralOrArray(node) {
	if (ts.isArrayLiteralExpression(node)) {
		return node.elements.every(isEvaluableLiteralOrArray);
	}
	return isEvaluableLiteral(node);
}

const files = collectTsFiles(patchesRoot);
const problems = [];
let callCount = 0;

for (const file of files) {
	const text = readFileSync(file, 'utf8');
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

	const visit = (node) => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			(node.expression.text === 'localize' || node.expression.text === 'localize2')
		) {
			callCount++;
			const fn = node.expression.text;
			// 只有前两个参数（key 和 value）进翻译表；后面的是运行期占位符实参，不受限制。
			for (const [index, label] of [[0, 'key'], [1, 'value']]) {
				const arg = node.arguments[index];
				if (!arg) {
					continue;
				}
				if (!isEvaluableLiteral(arg)) {
					const { line, character } = source.getLineAndCharacterOfPosition(arg.getStart(source));
					problems.push({
						file: relative(desktopRoot, file),
						line: line + 1,
						column: character + 1,
						fn,
						label,
						text: arg.getText(source),
					});
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
}

if (problems.length > 0) {
	console.error('');
	console.error('[nls-check] localize 的参数必须是字面量，下列写法会让 gulp 在编译末尾崩溃：');
	console.error('');
	for (const p of problems) {
		console.error(`  ${p.file}:${p.line}:${p.column}`);
		console.error(`      ${p.fn} 的 ${p.label} 写成了 \`${p.text}\`，应改为字符串字面量`);
	}
	console.error('');
	console.error(`共 ${problems.length} 处。修好再构建，否则会白等一小时。`);
	process.exit(1);
}

console.log(`[nls-check] ${files.length} 个文件 / ${callCount} 处 localize 调用，参数均为字面量。`);
