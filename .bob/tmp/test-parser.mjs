import { readFileSync } from 'node:fs';

const yaml = readFileSync('.bob/tmp/manifest-v1.9.2.yml', 'utf8');
const REQUIRED_STACK = 'cflinuxfs4';
const versions = [];

for (const block of yaml.split(/^- name:/m)) {
  if (!block.match(/^\s*node\s*$/m)) continue;

  const cfStacksIdx = block.indexOf('cf_stacks:');
  if (cfStacksIdx === -1) continue;

  const stacks = [];
  for (const line of block.slice(cfStacksIdx + 'cf_stacks:'.length).split('\n')) {
    const item = line.match(/^\s+-\s+(\S+)/);
    if (item) { stacks.push(item[1]); continue; }
    if (line.match(/^\s+\S/) && stacks.length > 0) break;
  }

  if (!stacks.includes(REQUIRED_STACK)) continue;

  const v = block.match(/version:\s*["']?(\d+\.\d+\.\d+)["']?/);
  if (v) versions.push(v[1]);
}

const unique = [...new Set(versions)].sort((a, b) => {
  const [aM, am, ap] = a.split('.').map(Number);
  const [bM, bm, bp] = b.split('.').map(Number);
  return bM - aM || bm - am || bp - ap;
});

const local = process.version.replace('v', '');
console.log('Supported Node versions for', REQUIRED_STACK, ':', unique.join(', '));
console.log('Local node                 :', local);
console.log('Would block?               :', !unique.includes(local));
