import { Agent, type AgentResult, type ChatSession, type ChatMessage, type LlmClient, type Vault, type AgentEvent } from '@relay/core';
import type { TaskService } from './tasks.js';
import type { NoteModeService } from './note-mode.js';
import type { ChatStore } from './chat-store.js';
import { mastraLoop } from './mastra-runtime.js';
import type { ContextTool } from './agent-context.js';
import { TaskModeService } from './task-mode.js';

export interface ModeRunInput { preferencesContext?: string; userText?: string; contextTools?: ContextTool[]; engine?: 'legacy'|'mastra'; maxSteps?: number; device:number; chat:ChatSession; text:string; operationId:string; referenceInstant?:string; history:{role:'user'|'assistant';content:string;createdAt?:number}[]; parts?:ChatMessage['parts']; signal:AbortSignal; onEvent:(e:AgentEvent)=>void; llm:LlmClient; toolsEnabled:boolean; structuredOutput:boolean; extraPrompt?:string; memoryContext?:string }

export class ChatModeService {
  private readonly taskMode:TaskModeService;
  constructor(store:ChatStore,tasks:TaskService,private readonly notes:NoteModeService,private readonly vault:Vault){this.taskMode=new TaskModeService(store,tasks);}
  async run(input:ModeRunInput):Promise<AgentResult>{
    if(input.chat.mode==='task')return this.taskMode.run(input);
    return new Agent({preferencesContext:input.preferencesContext,contextTools:input.contextTools,runtime:input.engine==='mastra'?mastraLoop:undefined,maxRounds:input.maxSteps,vault:this.vault,llm:input.llm,mode:'note',noteWriter:this.notes.writer(input.operationId,input.signal),toolsEnabled:input.toolsEnabled,extraSystemPrompt:input.extraPrompt,memoryContext:input.memoryContext}).run({text:input.text,history:input.history,parts:input.parts,signal:input.signal,onEvent:input.onEvent});
  }
}
