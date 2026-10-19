import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Vault, searchNotes } from '../packages/core/dist/src/index.js';
import { createCorpus, retrievalCases } from './corpus.mjs';

const label = process.argv[2] ?? 'current';
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('Invalid report label');
const count = Math.max(20, Number(process.argv[3] ?? 1000));
await mkdir('data/benchmarks', { recursive: true });
const root = await mkdtemp(path.resolve('data/benchmarks/vault-'));
await createCorpus(root, count);
const vault = new Vault({ root, inboxFolder: 'Inbox', dailyFolder: 'Daily', dailyFormat: 'YYYY-MM-DD', privateFolders: ['Private'] });
let reads = 0;
const read = vault.readNote.bind(vault);
vault.readNote = async (...args) => { reads++; return read(...args); };
const start = performance.now();
await searchNotes(vault, 'инфляции');
const coldMs = performance.now() - start;
reads = 0;
const times = [];
let found = 0;
for (const item of retrievalCases) {
  const at = performance.now();
  const hits = await searchNotes(vault, item.query, { limit: 5 });
  times.push(performance.now() - at);
  if (hits.some(hit => hit.path === item.expected)) found++;
}
times.sort((a, b) => a - b);
const report = { label, node: process.version, platform: process.platform, count, cases: times.length,
  model: null, network: false, coldMs, p50Ms: times[Math.floor(times.length * .5)],
  p95Ms: times[Math.min(times.length - 1, Math.floor(times.length * .95))],
  warmFileReads: reads, recallAt5: found / times.length, rssBytes: process.memoryUsage().rss,
  note: 'Synthetic retrieval benchmark; does not measure LLM response time or production capacity.' };
await writeFile(`docs/search-benchmark-${label}.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
const core = await import('../packages/core/dist/src/index.js');
core.disposeSearch?.(vault);
