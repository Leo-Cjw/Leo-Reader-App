import { spawnSync } from 'node:child_process';

const allowedBuildAdvisories = new Set([
  'https://github.com/advisories/GHSA-mh99-v99m-4gvg'
]);
const allowedDirectBuildPackages = new Set([
  '@electron/universal',
  'electron-builder'
]);

function runAudit(extraArgs = []) {
  const result = spawnSync('npm', ['audit', '--json', '--audit-level=low', ...extraArgs], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(result.stderr || result.stdout || 'npm audit 没有返回可解析的 JSON');
  }
  return { result, report };
}

const production = runAudit(['--omit=dev']);
if (production.result.status !== 0 || production.report.metadata?.vulnerabilities?.total !== 0) {
  process.stderr.write(`${JSON.stringify(production.report, null, 2)}\n`);
  throw new Error('生产依赖审计失败');
}

const full = runAudit();
const vulnerabilitiesByName = new Map(Object.entries(full.report.vulnerabilities || {}));
const vulnerabilities = [...vulnerabilitiesByName.values()];
const advisoryURLsByPackage = new Map();
const dependencyReferencesByPackage = new Map();
const malformedReferences = [];

for (const [name, item] of vulnerabilitiesByName) {
  const advisoryURLs = new Set();
  const dependencyReferences = new Set();
  for (const via of item.via || []) {
    if (typeof via === 'string') dependencyReferences.add(via);
    else if (via && typeof via === 'object' && typeof via.url === 'string') advisoryURLs.add(via.url);
    else malformedReferences.push(name);
  }
  advisoryURLsByPackage.set(name, advisoryURLs);
  dependencyReferencesByPackage.set(name, dependencyReferences);
}

let changed = true;
while (changed) {
  changed = false;
  for (const [name, dependencyReferences] of dependencyReferencesByPackage) {
    const advisoryURLs = advisoryURLsByPackage.get(name);
    for (const dependencyName of dependencyReferences) {
      const dependencyAdvisories = advisoryURLsByPackage.get(dependencyName);
      if (!dependencyAdvisories) {
        malformedReferences.push(`${name} -> ${dependencyName}`);
        continue;
      }
      for (const url of dependencyAdvisories) {
        if (!advisoryURLs.has(url)) {
          advisoryURLs.add(url);
          changed = true;
        }
      }
    }
  }
}

const advisoryURLs = new Set([...advisoryURLsByPackage.values()].flatMap((urls) => [...urls]));
const unresolvedPackages = [...advisoryURLsByPackage]
  .filter(([, urls]) => urls.size === 0)
  .map(([name]) => name);
const unexpectedAdvisories = [...advisoryURLs].filter((url) => !allowedBuildAdvisories.has(url));
const unexpectedDirectPackages = vulnerabilities
  .filter((item) => item.isDirect && !allowedDirectBuildPackages.has(item.name))
  .map((item) => item.name);

if (malformedReferences.length || unresolvedPackages.length || unexpectedAdvisories.length || unexpectedDirectPackages.length) {
  process.stderr.write(`${JSON.stringify(full.report, null, 2)}\n`);
  throw new Error(`发现未评估的依赖漏洞：${[...malformedReferences, ...unresolvedPackages, ...unexpectedAdvisories, ...unexpectedDirectPackages].join(', ')}`);
}
if (full.result.status !== 0 && advisoryURLs.size === 0) {
  process.stderr.write(`${JSON.stringify(full.report, null, 2)}\n`);
  throw new Error('完整依赖审计失败，但没有可识别的安全公告');
}

console.log('生产依赖：0 个已知漏洞');
if (advisoryURLs.size) {
  console.log(`构建依赖：仅允许已评估公告 ${[...advisoryURLs].join(', ')}；受影响直接工具为 ${vulnerabilities.filter((item) => item.isDirect).map((item) => item.name).join(', ')}`);
} else {
  console.log('构建依赖：0 个已知漏洞');
}
