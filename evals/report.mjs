import { promises as fs } from 'node:fs';
const suites=[];
for(const [name,file] of [['retrieval','data/retrieval-evals.json'],['agent','data/agent-evals.json']]){
  const raw=JSON.parse(await fs.readFile(file,'utf8')),stats=raw.results.stats;
  const cases=raw.results.results.map(r=>({scenario:r.vars?.scenario??'retrieval',runtime:r.response?.metadata?.engine??null,passed:!!r.success}));
  suites.push({name,successes:stats.successes,failures:stats.failures,errors:stats.errors,durationMs:stats.evaluationDurationMs??stats.durationMs,cases:name==='agent'?cases:undefined});
}
const report={runner:'Promptfoo 0.124.1',promptVersion:'relay-v1',agentModel:'synthetic-model-v1',externalLlm:false,paidGrading:false,suites};await fs.writeFile('docs/agent-quality-report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(suites.some(s=>s.failures||s.errors))process.exitCode=1;
