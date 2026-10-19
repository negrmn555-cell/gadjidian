import type { MutationReceipt } from './contracts.js';
export interface ToolProgress { id:string; name:string; label:string; state:'running'|'succeeded'|'failed'|'cancelled'; startedAt:number; durationMs?:number; summary?:string; sources:{path:string;heading?:string}[]; receipt?:MutationReceipt }
export interface RunStreamState { sequence:number; text:string; status:string; needsResume:boolean; tools:ToolProgress[] }
export const emptyRunStream = ():RunStreamState => ({sequence:0,text:'',status:'Выполняю…',needsResume:false,tools:[]});
export function finishTools(tools:ToolProgress[],outcome:string,at:number):ToolProgress[]{return tools.map(t=>t.state!=='running'?t:{...t,state:t.receipt?'succeeded':outcome==='cancelled'?'cancelled':'failed',durationMs:Math.max(0,at-t.startedAt),summary:t.receipt?'Изменения сохранены до остановки запроса.':'Действие не завершено. Проверьте сохранённые результаты.'});}
/** Snapshot and event delivery share the same reducer; a gap never appends duplicate text/cards. */
export function reduceRunEvent(state:RunStreamState,event:Record<string,unknown>):RunStreamState {
  const sequence=Number(event.sequence);if(!Number.isSafeInteger(sequence)||sequence<0)return state;
  if(event.type==='snapshot')return sequence<state.sequence?state:{sequence,text:String(event.text??''),status:String(event.status??'Выполняю…'),needsResume:false,tools:Array.isArray(event.tools)?event.tools as ToolProgress[]:[]};
  if(sequence<=state.sequence)return state;if(sequence!==state.sequence+1)return {...state,needsResume:true};
  let tools=state.tools;const id=String(event.callId??''),at=Number(event.at??0);
  if(event.type==='tool'&&id){const previous=tools.find(t=>t.id===id);if(!previous)tools=[...tools,{id,name:String(event.tool??''),label:String(event.text??'Выполняю действие'),state:'running' as const,startedAt:at,sources:[]}].slice(-64);}
  if(event.type==='artifact.saved'&&id&&event.receipt)tools=tools.map(t=>t.id===id?{...t,receipt:event.receipt as MutationReceipt}:t);
  if(['tool.completed','tool.failed','tool.cancelled'].includes(String(event.type))&&id)tools=tools.map(t=>t.id!==id?t:{...t,state:event.type==='tool.completed'?'succeeded':event.type==='tool.cancelled'?'cancelled':'failed',durationMs:Math.max(0,Number(event.durationMs??at-t.startedAt)),summary:String(event.summary??''),sources:Array.isArray(event.sources)?event.sources as ToolProgress['sources']:[],...(event.receipt?{receipt:event.receipt as MutationReceipt}:{})});
  if(event.type==='result'||event.kind==='run.interrupted')tools=finishTools(tools,String(event.outcome??'failed'),at);
  return {sequence,text:event.type==='result'?String(event.text??''):state.text+(event.type==='delta'?String(event.text??''):''),status:event.type==='status'||event.type==='tool'?String(event.text??''):state.status,needsResume:false,tools};
}
