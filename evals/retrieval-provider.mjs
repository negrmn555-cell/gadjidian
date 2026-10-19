import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Vault, searchNotes } from '../packages/core/dist/src/index.js';
import { createCorpus } from '../benchmarks/corpus.mjs';

export default class RetrievalProvider {
  constructor() {
    this.ready=(async()=>{await mkdir('data/evals',{recursive:true});const root=await mkdtemp(path.resolve('data/evals/vault-'));await createCorpus(root,20);return new Vault({root,inboxFolder:'Inbox',dailyFolder:'Daily',dailyFormat:'YYYY-MM-DD',privateFolders:['Private']});})();
  }
  id(){return 'relay-fulltext';}
  async callApi(prompt){const vault=await this.ready;const hits=await searchNotes(vault,prompt,{limit:5});return {output:hits.map(h=>h.path).join('\n'),metadata:{count:hits.length}};}
}
