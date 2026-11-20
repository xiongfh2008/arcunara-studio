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
    "projectRowTemplate","projectTools","clearProjectSearch",
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
  assert.match(html,/<dialog id="detailCard"[^>]*aria-labelledby="projectHeading"/);
  assert.match(html,/<details class="project-tools" id="projectTools">/);
  assert.match(html,/<summary>更多操作/);
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
  const calls={detail:0,render:0,open:0};
  const nodes={
    githubWorkflowResult:{classList:{add(){} }},
    drawerFeedback:{textContent:"previous project"},
    detailCard:{open:false,showModal(){this.open=true;calls.open++;}}
  };
  const state=vm.createContext({
    selectionRequest:0,drawerProjectId:null,
    selected:null,projects:[{id:"A",currentVersion:1},{id:"B",currentVersion:1}],
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
  const first=vm.runInContext('selectProject("A", {openDetails:true})',state);
  const second=vm.runInContext('selectProject("B")',state);
  const complete=id=>{
    pending.get("/api/projects/"+id)({id,name:id,currentVersion:1,isAxure:id==="A"});
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
  assert.equal(calls.open,0,"background selection and stale requests do not open the drawer");

  const explicit=vm.runInContext('selectProject("A", {openDetails:true})',state);
  complete("A");
  await explicit;
  assert.equal(calls.open,1);
  assert.equal(state.projects[0].isAxure,true);
  assert.equal(state.projects[1].isAxure,false);
  assert.equal(state.drawerProjectId,"A");
  assert.equal(nodes.drawerFeedback.textContent,"");
});

test("RC19 responsive design and keyboard search do not override dialogs or token storage policy",async()=>{
  const html=await consoleHtml();
  assert.match(html, /@media \(max-width: 700px\)[^{]*\{[\s\S]*?\.app-sidebar \{ display: none;/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html, /\.portfolio-overview \{[^}]*display: flex/);
  assert.match(html, /\.portfolio-tile \{[^}]*white-space: nowrap/);
  assert.doesNotMatch(html, /button:not\(\.ghost\):not\(\.danger\)/);
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

test("switching a project source keeps the other dialog's selection and fields intact", async () => {
  const html = await consoleHtml();
  const panels = new Map();
  function dialog(prefix) {
    const buttons = ["file", "html"].map(mode => {
      const id = prefix + "-" + mode;
      const panel = { hidden: mode !== "file" };
      panel.classList = { toggle(_name, value) { panel.hidden = value; } };
      panels.set(id, panel);
      return {
        dataset: { uploadMode: mode },
        getAttribute(name) { assert.equal(name, "aria-controls"); return id; },
        setAttribute(name, value) { assert.equal(name, "aria-pressed"); this.pressed = value; }
      };
    });
    return { buttons, querySelectorAll() { return buttons; } };
  }
  const create = dialog("new");
  const upload = dialog("version");
  const context = vm.createContext({ $: id => panels.get(id) });
  vm.runInContext(functionText(html, "setUploadMode"), context);
  context.setUploadMode(create, "html");
  assert.deepEqual(create.buttons.map(button => button.pressed), ["false", "true"]);
  assert.deepEqual([...panels.values()].map(panel => panel.hidden), [true, false, false, true]);
  context.setUploadMode(upload, "html");
  context.setUploadMode(create, "file");
  assert.deepEqual([...panels.values()].map(panel => panel.hidden), [false, true, true, false]);
});

test("a file drop updates only the chosen input and reports invalid files inside its dialog", async () => {
  const html = await consoleHtml();
  const zone = new EventTarget();
  zone.classList = { toggle() {} };
  const input = new EventTarget();
  const filename = { textContent: "" };
  const status = { textContent: "" };
  class Transfer {
    files = [];
    items = { add: file => this.files.push(file) };
  }
  const ctx = vm.createContext({ DataTransfer: Transfer, Event });
  vm.runInContext(functionText(html, "bindDropzone"), ctx);
  ctx.bindDropzone(zone, input, filename, status);
  function drop(name) {
    const event = new Event("drop", { cancelable: true });
    event.dataTransfer = { files: [{ name }] };
    zone.dispatchEvent(event);
    assert.ok(event.defaultPrevented);
  }
  drop("first.zip");
  assert.equal(filename.textContent, "first.zip");
  drop("unrelated.txt");
  assert.equal(input.files[0].name, "first.zip");
  assert.match(status.textContent, /仅支持/);
  drop("second.HTML");
  assert.equal(filename.textContent, "second.HTML");
  assert.equal(status.textContent, "");
});
