import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2),agent=args[0]==='agent';if(agent)args.shift();
const child=spawn(process.execPath,[path.join(root,'node_modules/promptfoo/dist/src/entrypoint.js'),'eval','-c',agent?'evals/agent.json':'evals/retrieval.json','--no-cache','--no-progress-bar',...args],{
  cwd:root,stdio:'inherit',env:{...process.env,PROMPTFOO_DISABLE_TELEMETRY:'1',PROMPTFOO_CONFIG_DIR:path.join(root,'data/promptfoo')}
});
child.on('error',()=>{process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
