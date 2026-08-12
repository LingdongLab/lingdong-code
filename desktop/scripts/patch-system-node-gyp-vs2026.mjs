import fs from 'fs'

const findVs = String.raw`C:\tools\nodejs\node_modules\npm\node_modules\node-gyp\lib\find-visualstudio.js`
const buildJs = String.raw`C:\tools\nodejs\node_modules\npm\node_modules\node-gyp\lib\build.js`
const bak = findVs + '.lingdong-bak'

if (fs.existsSync(bak)) {
  fs.copyFileSync(bak, findVs)
}

let t = fs.readFileSync(findVs, 'utf8')
t = t.replace(
  'return this.findNewVSUsingSetupModule([2019, 2022])',
  'return this.findNewVSUsingSetupModule([2019, 2022, 2026])'
)
t = t.replace(
  'return this.findNewVS([2019, 2022])',
  'return this.findNewVS([2019, 2022, 2026])'
)
const nl = t.includes('\r\n') ? '\r\n' : '\n'
if (!t.includes('ret.versionMajor === 18')) {
  const from = [
    'if (ret.versionMajor === 17) {',
    '      ret.versionYear = 2022',
    '      return ret',
    '    }',
    "    this.log.silly('- unsupported version:', ret.versionMajor)"
  ].join(nl)
  const to = [
    'if (ret.versionMajor === 17) {',
    '      ret.versionYear = 2022',
    '      return ret',
    '    }',
    '    if (ret.versionMajor === 18) {',
    '      ret.versionYear = 2026',
    '      return ret',
    '    }',
    "    this.log.silly('- unsupported version:', ret.versionMajor)"
  ].join(nl)
  if (!t.includes(from)) throw new Error('versionMajor block not found')
  t = t.replace(from, to)
}
if (!t.includes('versionYear === 2026')) {
  const from = [
    "} else if (versionYear === 2022) {",
    "      return 'v143'",
    '    }',
    "    this.log.silly('- invalid versionYear:', versionYear)"
  ].join(nl)
  const to = [
    "} else if (versionYear === 2022) {",
    "      return 'v143'",
    '    } else if (versionYear === 2026) {',
    "      return 'v145'",
    '    }',
    "    this.log.silly('- invalid versionYear:', versionYear)"
  ].join(nl)
  if (!t.includes(from)) throw new Error('toolset block not found')
  t = t.replace(from, to)
}
fs.writeFileSync(findVs, t)
console.log('patched', findVs)

let b = fs.readFileSync(buildJs, 'utf8')
const needle = "argv.push('/p:Configuration=' + buildType + ';Platform=' + p)"
const patched =
  "argv.push('/p:Configuration=' + buildType + ';Platform=' + p + ';SpectreMitigation=false')"
if (!b.includes('SpectreMitigation=false')) {
  if (!b.includes(needle)) throw new Error('build.js needle not found')
  b = b.replace(needle, patched)
  fs.writeFileSync(buildJs, b)
  console.log('patched', buildJs)
} else {
  console.log('build.js already has SpectreMitigation=false')
}
