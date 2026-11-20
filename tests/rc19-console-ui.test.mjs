import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { startServer } from "./helpers/harness.mjs";

async function consoleHtml() {
  const app = await startServer();
  try {
    const response=await fetch(app.apiBase+"/console");
    assert.equal(response.status,200);
    const html=await response.text();
    assert.match(response.headers.get("content-type")||"",/text\/html/);
    return html;
  } finally {
    await app.stop();
    await app.cleanup();
  }
}

function functionText(html,name) {
  const needle="function "+name+"(";
  const start=html.indexOf(needle);
  assert.ok(start>0,"Missing function "+name);
  const end=html.indexOf("\n}\n",start);
  assert.ok(end>start,"Missing function closure "+name);
  const begin=html.slice(start-6,start)==="async " ? start-6 : start;
  return html.slice(begin,end+2);
}

test("RC19 console preserves all business controls and introduces accessible dashboard navigation",async()=>{
  const html=await consoleHtml();
  for(const id of [
    "connectionToggle","tokenInput","saveToken",
    "openCreateDialog","openUploadDialog","projectSearch","lifecycleFilter",
    "projectList","projectListCard","projectCount","detailCard",
    "inspectorEmpty","emptyCreateBtn","clearProjectSearch",
    "metricAll","metricActive","metricArchived","metricTrashed",
    "openVersionsPanel","openSharesPanel","openDeployPanel","openSettingsPanel",
    "downloadVersionZipBtn","downloadAxureIrBtn","downloadRp1SourceBtn",
    "purgeProjectBtn","siteHostingToggle"
  ]){
    assert.match(html,new RegExp('id="'+id+'"'),id);
  }
  assert.match(html,/class="portfolio-overview"/);
  assert.match(html,/aria-label="项目状态概览"/);
  assert.match(html,/data-portfolio-filter="active" aria-pressed="true"/);
  assert.match(html,/role="search" aria-label="搜索和筛选原型项目"/);
  assert.match(html,/id="projectList" aria-busy="false"/);
  assert.match(html,/aria-label="项目详情引导"/);
  assert.match(html,/<button[^>]*type="button"[^>]*id="clearProjectSearch"/);
  assert.match(html,/id="viewTitle">项目管理/);
  assert.doesNotMatch(html,/innerHTML\s*=\s*p\.name/);
});

test("RC19 portfolio metrics use actual project lifecycle values and reflect selected filter",async()=>{
  const html=await consoleHtml();
  const metrics={};
  const tiles=["all","active","archived","trashed"].map(value=>({
    dataset:{portfolioFilter:value},
    disabled:true,
    attributes:{},
    setAttribute(name,val){this.attributes[name]=val;}
  }));
  const scope=vm.createContext({
    projects:[
      {id:"1",lifecycleState:"active"},
      {id:"2",lifecycleState:"archived"},
      {id:"3",lifecycleState:"trashed"},
      {id:"4"}, // legacy active
      {id:"5",lifecycleState:"active"}
    ],
    projectListLoaded:true,
    $:id=>id==="lifecycleFilter"?{value:"archived"}:
      (metrics[id]??=( { textContent:"" })),
    document:{querySelectorAll:()=>tiles},
    Object
  });
  vm.runInContext(functionText(html,"renderPortfolioStats")+
    "\nrenderPortfolioStats();",scope);
  assert.deepEqual(
    ["metricAll","metricActive","metricArchived","metricTrashed"].map(id=>metrics[id].textContent),
    ["5","3","1","1"]
  );
  assert.equal(tiles.find(t=>t.dataset.portfolioFilter==="archived").attributes["aria-pressed"],"true");
  assert.equal(tiles.find(t=>t.dataset.portfolioFilter==="active").attributes["aria-pressed"],"false");
  assert.ok(tiles.every(t=>!t.disabled));
});

test("RC19 project selection ignores stale requests if user clicks another project",async()=>{
  const html=await consoleHtml();
  const pending=new Map();
  const calls={detail:0,render:0};
  const nodes={
    githubWorkflowResult:{classList:{add(){} }},
    inspectorEmpty:{classList:{add(){} }}
  };
  const state=vm.createContext({
    selectionRequest:0,
    selected:null,
    versions:[],shares:[],deployKeys:[],selectedVersion:null,
    generatedGithubWorkflow:null,
    $:id=>nodes[id],
    api:url=>new Promise(resolve=>pending.set(url,resolve)),
    renderDetail(){calls.detail++;},
    renderProjects(){calls.render++;},
    friendlyError:err=>String(err),
    feedback(message){throw new Error("Unexpected feedback "+message);},
    Promise
  });
  vm.runInContext(functionText(html,"selectProject"),state);
  const first=vm.runInContext('selectProject("A")',state);
  const second=vm.runInContext('selectProject("B")',state);
  const complete=id=>{
    pending.get("/api/projects/"+id)({id,name:id});
    pending.get("/api/projects/"+id+"/versions")({versions:[{version:1,isCurrent:true}]});
    pending.get("/api/projects/"+id+"/shares")({shares:[]});
    pending.get("/api/projects/"+id+"/deploy-keys")({deployKeys:[]});
  };
  complete("B");
  await second;
  assert.equal(state.selected.id,"B");
  complete("A");
  await first;
  assert.equal(state.selected.id,"B");
  assert.equal(calls.detail,1);
  assert.equal(calls.render,1);
});

test("RC19 responsive design and keyboard search do not override dialogs or token storage policy",async()=>{
  const html=await consoleHtml();
  assert.match(html,/RC19 — Unified workbench visual language/);
  assert.match(html,/\.app-sidebar\{background:#151e35/);
  assert.match(html,/\.portfolio-overview\{display:grid;grid-template-columns:repeat\(4/);
  assert.match(html,/@media\(max-width:820px\)/);
  assert.match(html,/@media\(max-width:640px\)/);
  assert.match(html,/\.app-sidebar\{display:flex;padding:9px 18px/);
  assert.match(html,/@media\(prefers-reduced-motion:reduce\)/);
  assert.match(html,/const modalOpen = Boolean\(document\.querySelector\("dialog\[open\]"\)\)/);
  assert.match(html,/event\.key === "\/"/);
  assert.match(html,/event\.key === "Escape"/);
  assert.match(html,/projectListRequest/);
  assert.match(html,/aria-busy","true"/);
  assert.match(html,/resetSelectedProject/);
  assert.match(html,/Token lives ONLY in this variable/);
  assert.doesNotMatch(html,/localStorage\.(setItem|getItem)\(/);
  assert.doesNotMatch(html,/sessionStorage\.(setItem|getItem)\(/);
});
