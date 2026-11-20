import assert from "node:assert/strict";
import {test} from "node:test";
import {startServer} from "./helpers/harness.mjs";
import {createAiGenerator} from "../apps/api/lib/ai-generator.mjs";

const good="<html><head><title>Demo</title></head><body><h1>AI</h1></body></html>";
test("RC21C is off by default; no user can spend model credits without explicit opt-in",async()=>{
  const app=await startServer();
  try {
    const status=await app.api("/api/ai/status");
    assert.equal(status.status,200);
    assert.equal(status.json.enabled,false);
    const generate=await app.api("/api/ai/generate",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({prompt:"Build a good website"})
    });
    assert.equal(generate.status,404);
    assert.equal(generate.json.code,"AI_DISABLED");
    assert.doesNotMatch((await(await fetch(app.apiBase+"/console")).text()),/sk_live_/);
  }finally{await app.stop();await app.cleanup();}
});
test("RC21C fixed HTTPS provider endpoint, secret from protected file and bounded draft only",async()=>{
  const requests=[];
  const generator=createAiGenerator({aiGenerationEnabled:true,
    aiApiKeyFile:"/private/provider-key"},{
    readSecret:async()=> "secret-credential-test\n",
    fetcher:async(url,options)=>{
      requests.push({url,options});
      return {ok:true,text:async()=>JSON.stringify({
        choices:[{message:{content:good}}],usage:{total_tokens:89}
      })};
    }
  });
  assert.equal(generator.status().enabled,true);
  const result=await generator.generate({prompt:"Create a blue SaaS homepage"});
  assert.equal(result.html,good);
  assert.equal(result.status,"draft");
  assert.equal(result.requiresReview,true);
  assert.equal(result.usedTokens,89);
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,"https://api.deepseek.com/chat/completions");
  assert.equal(requests[0].options.redirect,"error");
  assert.match(requests[0].options.headers.authorization,/Bearer secret-credential-test/);
  assert.equal(requests[0].options.body.includes("secret-credential-test"),false);
  assert.equal(JSON.stringify(result).includes("secret-credential-test"),false);
  assert.equal(generator.status().remainingCalls,19);
  await assert.rejects(generator.generate({prompt:"x".repeat(2401)}),e=>e.code==="AI_PROMPT_INVALID");
  assert.equal(requests.length,1);
});
test("RC21C rejects malformed upstream HTML, provider errors and rate limits consumption",async()=>{
  let count=0;
  const generator=createAiGenerator({aiGenerationEnabled:true,aiApiKeyFile:"/key"},{
    readSecret:async()=> "test-token",
    fetcher:async()=>{
      count++;
      return {ok:true,text:async()=>JSON.stringify({choices:[
        {message:{content:"Not an HTML prototype"}}
      ]})};
    }
  });
  await assert.rejects(generator.generate({prompt:"prototype"}),e=>e.code==="AI_INVALID_HTML");
  assert.equal(generator.status().remainingCalls,19);
  for(let i=1;i<20;i++){
    await assert.rejects(generator.generate({prompt:"another demo"}),e=>e.code==="AI_INVALID_HTML");
  }
  assert.equal(count,20);
  await assert.rejects(generator.generate({prompt:"another demo"}),e=>e.code==="AI_DAILY_LIMIT");
  assert.equal(count,20);
});
test("RC21C admin only: member and deploy key cannot view AI status or generate",async()=>{
  const app=await startServer({ARCU_TEAM_ACCESS_ENABLED:"1"});
  try{
    const member=await app.api("/api/users",{method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({name:"Viewer",email:"viewer21@example.org"})
    });
    assert.equal(member.status,201);
    assert.equal((await app.api("/api/ai/status",{token:member.json.token})).status,403);
    const p=await app.api("/api/projects",{method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({name:"P",html:"<html>p</html>"})
    });
    const key=await app.api("/api/projects/"+p.json.id+"/deploy-keys",{
      method:"POST",headers:{"content-type":"application/json"},body:"{}"
    });
    assert.equal((await app.api("/api/ai/status",{token:key.json.token})).status,403);
    assert.equal((await app.api("/api/ai/status",{token:null})).status,401);
  }finally{await app.stop();await app.cleanup();}
});
