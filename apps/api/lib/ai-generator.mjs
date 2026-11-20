// RC21C: strictly opt-in AI HTML draft generation through a fixed provider.
// Generated code is returned as source text for user review, never executed.
import fs from "node:fs/promises";
import { ApiError } from "./httputil.mjs";

const UPSTREAM="https://api.deepseek.com/chat/completions";
const MAX_PROMPT_CHARS=2400, MAX_HTML_BYTES=180000, DAILY_CALLS=20;
function normalizeHtml(content) {
  if(typeof content!=="string")throw new ApiError(502,"AI returned no text","AI_INVALID_RESPONSE");
  let text=content.trim();
  const fence=/^\x60{3}(?:html)?\s*\n([\s\S]*?)\n\x60{3}\s*$/i.exec(text);
  if(fence)text=fence[1].trim();
  if(Buffer.byteLength(text,"utf8")>MAX_HTML_BYTES)
    throw new ApiError(502,"Generated HTML is too large","AI_RESPONSE_TOO_LARGE");
  if(!/<html(?:\s|>)/i.test(text)||!/<\/html\s*>/i.test(text))
    throw new ApiError(502,"AI did not return a complete HTML document","AI_INVALID_HTML");
  return text;
}
export function createAiGenerator(config,{fetcher=fetch,readSecret=fs.readFile}={}) {
  const enabled=config.aiGenerationEnabled===true;
  let day="",usage=0,active=0;
  function status(){
    const today=new Date().toISOString().slice(0,10);
    if(today!==day){day=today;usage=0;}
    return {enabled,provider:enabled?"deepseek":null,model:enabled?"deepseek-flash":null,
      remainingCalls:enabled?Math.max(0,DAILY_CALLS-usage):0,
      maxPromptChars:MAX_PROMPT_CHARS,maxHtmlBytes:MAX_HTML_BYTES};
  }
  async function generate(data){
    if(!enabled)throw new ApiError(404,"AI generation is disabled","AI_DISABLED");
    const prompt=data&&typeof data==="object"?data.prompt:null;
    if(typeof prompt!=="string"||!prompt.trim()||prompt.length>MAX_PROMPT_CHARS)
      throw new ApiError(400,"Prompt must be 1–2400 characters","AI_PROMPT_INVALID");
    const state=status();
    if(state.remainingCalls===0)
      throw new ApiError(429,"Daily AI request limit reached","AI_DAILY_LIMIT");
    if(active>=1)
      throw new ApiError(429,"AI generation already in progress","AI_BUSY");
    usage++;active++;
    try{
      const key=(await readSecret(config.aiApiKeyFile,"utf8")).trim();
      if(!key||key.length>512)throw new ApiError(503,"AI provider credential unavailable","AI_CREDENTIAL_UNAVAILABLE");
      const response=await fetcher(UPSTREAM,{
        method:"POST",redirect:"error",signal:AbortSignal.timeout(45000),
        headers:{"authorization":"Bearer "+key,"content-type":"application/json"},
        body:JSON.stringify({
          model:"deepseek-flash",thinking:{type:"disabled"},temperature:0.6,max_tokens:4096,stream:false,
          messages:[
            {role:"system",content:
              "Produce one complete self-contained HTML5 prototype only. Return raw HTML, not Markdown. "+
              "Inline CSS. No external JS, CDNs, fonts, network requests, analytics, "+
              "credential collection, embedded forms, remote resources, iframes or tracking. "+
              "Include doctype, html, head and body."},
            {role:"user",content:prompt.trim()}
          ]
        })
      });
      if(!response.ok)throw new ApiError(502,"AI provider request failed","AI_UPSTREAM_ERROR");
      const raw=await response.text();
      if(Buffer.byteLength(raw,"utf8")>350000)
        throw new ApiError(502,"AI response too large","AI_RESPONSE_TOO_LARGE");
      let payload;
      try{payload=JSON.parse(raw);}catch{throw new ApiError(502,"Invalid AI response","AI_INVALID_RESPONSE");}
      const answer=payload?.choices?.[0];
      if(answer?.finish_reason && answer.finish_reason!=="stop")
        throw new ApiError(502,"AI generation did not finish","AI_INCOMPLETE_RESPONSE");
      const html=normalizeHtml(answer?.message?.content);
      return {html,model:"deepseek-flash",provider:"deepseek",
        bytes:Buffer.byteLength(html,"utf8"),status:"draft",
        requiresReview:true,usedTokens:payload?.usage?.total_tokens??null};
    }catch(err){
      if(err instanceof ApiError)throw err;
      throw new ApiError(502,"AI generation failed or timed out","AI_UPSTREAM_ERROR");
    }finally{active--;}
  }
  return {enabled,status,generate};
}
