import{readFile,writeFile}from'node:fs/promises';import{watch}from'node:fs';import{createHash}from'node:crypto';import assert from'node:assert/strict';import{guardNumberRangeBackend}from'./guard.mjs';
const root='C:/My/Workplace/Coding/vscode-abap/abap-mcp-standalone',stage=root+'/.cache/spro-r41',hash=b=>createHash('sha256').update(b).digest('hex');
const frozenBytes=await readFile(stage+'/frozen.json'),frozen=JSON.parse(frozenBytes);async function verifyFrozen(){assert.equal(hash(await readFile(stage+'/frozen.json')),hash(frozenBytes));for(const[path,pin]of Object.entries(frozen.files))assert.equal(hash(await readFile(stage+'/'+path)),pin,path);}
await verifyFrozen();assert.ok(process.env.ABAP_MCP_W200_PASSWORD,'Temporary password required');
const {TOOL_NAMES}=await import('./runtime/dist/src/tool-registry.js');
const allowedTools=['get_runtime_info','read_configuration_number_range_api','apply_configuration_number_range','reconcile_configuration_number_range','upsert_number_range_object','read_number_range_object','read_function_module_interface','get_write_operation_status'];
process.env.ABAP_MCP_TOOL_PROFILE='full';process.env.ABAP_MCP_TOOL_DENY=TOOL_NAMES.filter(n=>!allowedTools.includes(n)).join(',');
const[{AdtBackend},{loadConnections},{startHttpServer},{ToolService},{WriteOperationReceiptStore}]=await Promise.all(['adt-backend','config','http','tools','write-operation-receipts'].map(n=>import('./runtime/dist/src/'+n+'.js')));
const connections=(await loadConnections(root+'/.cache/landscape-acceptance/connections.json')).filter(c=>c.id==='w200').map(c=>({...c,passwordEnv:'ABAP_MCP_W200_PASSWORD'}));assert.equal(connections[0].client,'200');assert.equal(connections[0].username.toUpperCase(),'WYS');
const backend=new AdtBackend(connections),metrics={startedAt:new Date().toISOString(),nativeReads:0,nativeWrites:0,committedWrites:0,definitionWrites:0,ddicReads:0,repositoryReads:0,stopped:false,events:[]};
const save=()=>writeFile(stage+'/metrics.json',JSON.stringify(metrics,null,2));guardNumberRangeBackend(backend,metrics,save,verifyFrozen);await save();
const service=new ToolService(backend,stage+'/exports'),server=await startHttpServer(backend,0,stage+'/state');
await writeFile(stage+'/ready.json',JSON.stringify({pid:process.pid,url:server.mcpUrl,allowedTools,manifestFingerprint:hash(frozenBytes),startedAt:new Date().toISOString()},null,2),{flag:'wx'});
console.log('Fixed r41 number range acceptance instance ready: '+server.mcpUrl);
let busy=false,closing=false;const handled=new Set();
async function handle(name){
 if(name==='stop.request'&&!busy)return close();
 if(name!=='native-stale.request.json'||handled.has(name)||busy)return;handled.add(name);busy=true;
 const receipts=new WriteOperationReceiptStore(stage+'/probe-state');let reservation;
 try{
  await verifyFrozen();const input=JSON.parse(await readFile(stage+'/'+name,'utf8'));assert.deepEqual(Object.keys(input).sort(),['expectedVersion','scenario']);assert.equal(input.scenario,'native_old_version');assert.equal(input.expectedVersion,metrics.initialVersion);assert.equal(metrics.nativeWrites,1);
  const before=JSON.parse(await service.readConfigurationNumberRangeApi({connectionId:'w200',objectName:'ZORVCFGNR'})).snapshot;
  assert.notEqual(before.EV_VERSION,input.expectedVersion);assert.equal(before.ET_INTERVALS.length,1);assert.equal(before.ET_INTERVALS[0].TONUMBER,'00000000000000000100');
  const defs=await Promise.all(['Z_ORVANTA_CFG_NR_READ','Z_ORVANTA_CFG_NR_APPLY'].map(functionName=>service.readFunctionModuleInterface({connectionId:'w200',functionName}).then(JSON.parse)));
  const {attestConfigurationNumberRangeApi}=await import('./runtime/dist/src/configuration-number-range-command.js');defs.forEach((d,i)=>attestConfigurationNumberRangeApi(d,i===0?'read':'apply'));
  const reserved=await receipts.reserve({connectionId:'w200',toolName:'configuration_nr_native_stale_probe',operationId:'r41-native-old-version',targetKey:'CONFIG:NRIV:200:ZORVCFGNR',inputHash:hash(JSON.stringify(input)),preChangeSummary:'Approved old-version native rejection, dedicated unused ZORVCFGNR/01',recoveryGuide:'No retry or rollback. Read complete state and locks if result is unknown.'});assert.equal(reserved.status,'reserved');reservation=reserved.reservation;
  await receipts.recordPreChangeEvidence(reservation,{observedAt:new Date().toISOString(),target:'NRIV:ZORVCFGNR:200',exists:true,active:null,version:before.EV_VERSION,fingerprint:before.EV_VERSION,packageName:'ZABAP',requestNumber:'GR2K923472',taskNumber:null,observationStatus:'complete',sources:['Z_ORVANTA_CFG_NR_READ'],warnings:['Intervals local client only']});
  await receipts.markSapInvocationStarted(reservation);
  const {configurationNumberRangeApplyApi}=await import('./runtime/dist/src/configuration-number-range-api.js');
  const result=await backend.callRemoteFunction('w200',{functionName:configurationNumberRangeApplyApi.functionName,inputParameters:{IV_OBJECT:'ZORVCFGNR',IV_EXPECTED_VERSION:input.expectedVersion,IV_ACTION:'U',IV_INTERVAL:'01',IV_FROM_NUMBER:'00000000000000000001',IV_TO_NUMBER:'00000000000000000200',IV_EXTERNAL:'',IV_ACK_LOCAL_ONLY:'X'},outputParameters:[...configurationNumberRangeApplyApi.exportParameters.map(p=>p.name==='ES_ERROR'?{name:p.name,kind:'structure',fields:['MSGNR','TABLENAME','FIELDNAME','TABIX']}:{name:p.name,kind:'scalar'}),{name:'ET_INTERVALS',kind:'table',fields:['CLIENT','OBJECT','SUBOBJECT','NRRANGENR','TOYEAR','FROMNUMBER','TONUMBER','NRLEVEL','EXTERNIND']}]});
  assert.equal(result.outputs.EV_BEFORE_VERSION,before.EV_VERSION);assert.equal(result.outputs.EV_COMMITTED,'');assert.equal(result.outputs.EV_CODE,'VERSION_CHANGED');assert.equal(result.outputs.EV_UNLOCKED,'X');assert.equal(result.outputs.EV_SESSION_RESET,'not_required');
  const after=JSON.parse(await service.readConfigurationNumberRangeApi({connectionId:'w200',objectName:'ZORVCFGNR'})).snapshot;assert.deepEqual(after,before);
  const receipt=await receipts.complete(reservation,JSON.stringify({result,before,after}),0);await writeFile(stage+'/native-stale-result.json',JSON.stringify({status:'passed',result,before,after,receipt},null,2),{flag:'wx'});
 }catch(error){metrics.stopped=true;await save();let receipt;if(reservation)receipt=await receipts.fail(reservation,error,0).catch(()=>({status:'interrupted',outcomeMayBeUnknown:true}));await writeFile(stage+'/native-stale-error.json',JSON.stringify({error:String(error),receipt},null,2),{flag:'wx'});}
 finally{busy=false;}
}
const watcher=watch(stage,(_event,name)=>void handle(name).catch(()=>{metrics.stopped=true;void save();console.error('Evidence failure; no automatic retry.');}));
async function close(){if(closing)return;closing=true;watcher.close();await server.closeIfIdle();delete process.env.ABAP_MCP_W200_PASSWORD;metrics.finishedAt=new Date().toISOString();await save();process.exit(0);}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
