import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../vscode');
process.chdir(root);
const { getProductionDependencies } = require('./build/lib/dependencies.js');
const gulp = require('gulp');

const productionDependencies = getProductionDependencies(root);
const dependenciesSrc = productionDependencies
  .map((d) => path.relative(root, d))
  .map((d) => {
    const norm = d.split(path.sep).join('/');
    return [`${norm}/**`, `!${norm}/**/{test,tests}/**`, '!**/*.mk'];
  })
  .flat();

console.log('deps', productionDependencies.length);
console.log('first patterns', dependenciesSrc.slice(0, 6));
console.log(
  'backslash patterns',
  productionDependencies
    .map((d) => path.relative(root, d))
    .filter((d) => d.includes('\\'))
    .slice(0, 5),
);

const rawPatterns = productionDependencies
  .map((d) => path.relative(root, d))
  .map((d) => [`${d}/**`, `!${d}/**/{test,tests}/**`, '!**/*.mk'])
  .flat();

let nRaw = 0;
let nNorm = 0;
await new Promise((resolve, reject) => {
  gulp
    .src(rawPatterns, { base: '.', dot: true, allowEmpty: true })
    .on('data', () => nRaw++)
    .on('error', reject)
    .on('end', resolve);
});
await new Promise((resolve, reject) => {
  gulp
    .src(dependenciesSrc, { base: '.', dot: true, allowEmpty: true })
    .on('data', () => nNorm++)
    .on('error', reject)
    .on('end', resolve);
});
console.log('gulp matched raw(backslash)=', nRaw, 'normalized=', nNorm);
