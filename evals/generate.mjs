import { writeFile } from 'node:fs/promises';
import { retrievalCases } from '../benchmarks/corpus.mjs';
await writeFile('evals/retrieval.json',JSON.stringify({description:'80 synthetic Russian retrieval cases against the actual SearchService',prompts:['{{query}}'],providers:[{id:'file://retrieval-provider.mjs'}],tests:retrievalCases.map(c=>({vars:{query:c.query},assert:[{type:'contains',value:c.expected}]}))},null,2)+'\n');
