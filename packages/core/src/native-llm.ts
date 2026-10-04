import { LlmError, type ChatCompletionResult } from './llm.js';
import type { ChatMessage, LlmConfig, ToolDefinition } from './types.js';
const record=(v:unknown):Record<string,any>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new LlmError('Некорректный ответ API модели.');return v as Record<string,any>;};
const image=(url:string)=>{const m=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);if(!m)throw new LlmError('Нативный адаптер принимает изображения из загруженных файлов.');return {type:m[1],data:m[2]};};
const text=(m:ChatMessage)=>m.content??'';
export async function nativeChat(cfg:LlmConfig,transport:typeof fetch,messages:ChatMessage[],tools?:ToolDefinition[],signal?:AbortSignal,options?:{toolChoice?:unknown;responseFormat?:unknown}):Promise<ChatCompletionResult> {
  const system=messages.filter(m=>m.role==='system').map(text).join('\n'),history=messages.filter(m=>m.role!=='system'),base=cfg.baseUrl.replace(/\/+$/,''),isClaude=cfg.adapter==='anthropic';
  const headers:Record<string,string>={'content-type':'application/json',...(cfg.headers??{})};let body:Record<string,unknown>,url:string;
  const forced=(options?.toolChoice as {function?:{name?:string}}|undefined)?.function?.name;
  if(isClaude){
    headers['x-api-key']=cfg.apiKey;headers['anthropic-version']='2023-06-01';url=base+'/messages';
    const native:Record<string,unknown>[]=[];
    for(const m of history){let content:unknown[];
      if(m.role==='tool')content=[{type:'tool_result',tool_use_id:m.tool_call_id,content:text(m)}];
      else if(m.nativeParts)content=m.nativeParts;
      else {content=m.parts?m.parts.map(p=>p.type==='text'?{type:'text',text:p.text}:{type:'image',source:{type:'base64',media_type:image(p.image_url.url).type,data:image(p.image_url.url).data}}):text(m)?[{type:'text',text:text(m)}]:[];
        if(m.tool_calls)content.push(...m.tool_calls.map(c=>({type:'tool_use',id:c.id,name:c.function.name,input:JSON.parse(c.function.arguments)})));}
      if(content.length)native.push({role:m.role==='assistant'?'assistant':'user',content});
    }
    body={model:cfg.model,max_tokens:cfg.maxTokens??4096,temperature:cfg.temperature??.3,system:system+(options?.responseFormat?'\nReturn one valid JSON object only, without markdown fences.':''),messages:native};
    if(tools?.length){body.tools=tools.map(t=>({name:t.function.name,description:t.function.description,input_schema:t.function.parameters}));body.tool_choice=forced?{type:'tool',name:forced}:{type:'auto'};}
  }else{
    headers['x-goog-api-key']=cfg.apiKey;url=base+'/models/'+encodeURIComponent(cfg.model.replace(/^models\//,''))+':generateContent';
    const names=new Map<string,string>();for(const m of history)for(const c of m.tool_calls??[])names.set(c.id,c.function.name);
    const contents=history.map(m=>({role:m.role==='assistant'?'model':'user',parts:m.role==='tool'?[{functionResponse:{id:m.tool_call_id,name:names.get(m.tool_call_id??'')??'unknown',response:{result:text(m)}}}]:m.nativeParts??[...(m.parts?m.parts.map(p=>p.type==='text'?{text:p.text}:{inlineData:{mimeType:image(p.image_url.url).type,data:image(p.image_url.url).data}}):text(m)?[{text:text(m)}]:[]),...(m.tool_calls??[]).map(c=>({functionCall:{id:c.id,name:c.function.name,args:JSON.parse(c.function.arguments)}}))]})).filter(c=>c.parts.length);
    body={systemInstruction:{parts:[{text:system}]},contents,generationConfig:{temperature:cfg.temperature??.3,...(cfg.maxTokens?{maxOutputTokens:cfg.maxTokens}:{}),...(options?.responseFormat?{responseMimeType:'application/json'}:{})}};
    if(tools?.length){body.tools=[{functionDeclarations:tools.map(t=>({name:t.function.name,description:t.function.description,parametersJsonSchema:t.function.parameters}))}];body.toolConfig={functionCallingConfig:forced?{mode:'ANY',allowedFunctionNames:[forced]}:{mode:'AUTO'}};}
  }
  const response=await transport(url,{method:'POST',headers,body:JSON.stringify(body),signal});if(!response.ok){await response.body?.cancel();throw new LlmError('LLM request failed: HTTP '+response.status,response.status);}
  let data:Record<string,any>;try{data=record(await response.json());}catch{throw new LlmError('Некорректный JSON API модели.');}
  const parts=isClaude?data.content:data.candidates?.[0]?.content?.parts;
  if(!Array.isArray(parts)||parts.length>64)throw new LlmError('Нативный API не вернул ответ модели.');
  const calls:NonNullable<ChatMessage['tool_calls']>=[],texts:string[]=[];
  for(let i=0;i<parts.length;i++){const p=record(parts[i]);if(typeof p.text==='string'&&!p.thought)texts.push(p.text);
    const call=isClaude&&p.type==='tool_use'?p:p.functionCall;if(call){const c=record(call),args=isClaude?c.input:c.args;if(typeof c.name!=='string'||!c.name||!args||typeof args!=='object'||Array.isArray(args))throw new LlmError('Некорректный вызов инструмента.');calls.push({id:typeof c.id==='string'?c.id:'gemini_call_'+i,type:'function',function:{name:c.name,arguments:JSON.stringify(args)}});}}
  const reason=isClaude?data.stop_reason:data.candidates[0].finishReason;
  return {message:{role:'assistant',content:texts.join('\n')||null,...(calls.length?{tool_calls:calls}:{}),nativeParts:parts},finishReason:['max_tokens','MAX_TOKENS'].includes(reason)?'length':calls.length?'tool_calls':'stop',usage:isClaude?{promptTokens:Number(data.usage?.input_tokens??0),completionTokens:Number(data.usage?.output_tokens??0)}:{promptTokens:Number(data.usageMetadata?.promptTokenCount??0),completionTokens:Number(data.usageMetadata?.candidatesTokenCount??0)}};
}
