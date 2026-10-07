import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startHttpServer} from './runtime/dist/src/http.js';
import {ToolService} from './runtime/dist/src/tools.js';
import {MockBackend} from './runtime/dist/test/mock-backend.js';
import {WriteOperationReceiptStore} from './runtime/dist/src/write-operation-receipts.js';
const root=new URL('./',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1');
const proof={startedAt:new Date().toISOString(),mode:'new public MCP over live read-only metadata bridge; native invocation forbidden',sharedEndpoint:'http://127.0.0.1:4849/mcp',liveReads:[],publicCalls:[],nativeInvocations:0,sapWrites:0};
const shared=new Client({name:'configuration-r40-readonly-metadata',version:'r40'});
const local=new Client({name:'configuration-r40-public-readonly-acceptance',version:'r40'});
const original={function:ToolService.prototype.readFunctionModuleInterface,table:ToolService.prototype.readDdicTransparentTable};
let running;
const parse=r=>{const text=r.content.filter(i=>i.type==='text').map(i=>i.text).join('\n');try{return JSON.parse(text)}catch{return {message:text}}};
try{
 await shared.connect(new StreamableHTTPClientTransport(new URL(proof.sharedEndpoint)));
 const inventory=(await shared.listTools()).tools;
 const allowed=new Set(['get_connected_systems','read_function_module_interface','read_ddic_transparent_table']);
 for(const name of allowed)assert.equal(inventory.find(t=>t.name===name)?.annotations?.readOnlyHint,true);
 async function read(name,args){
  assert.ok(allowed.has(name));
  const r=await shared.callTool({name,arguments:args},undefined,{timeout:60000});
  const data=parse(r);proof.liveReads.push({name,args,isError:!!r.isError,data});
  if(r.isError)throw Error(data.code??'LIVE_READ_REFUSED');
  return data;
 }
 proof.systems=await read('get_connected_systems',{});
 ToolService.prototype.readFunctionModuleInterface=async args=>JSON.stringify(await read('read_function_module_interface',args));
 ToolService.prototype.readDdicTransparentTable=async args=>JSON.stringify(await read('read_ddic_transparent_table',args));
 const backend=new MockBackend();
 backend.callRemoteFunction=async()=>{proof.nativeInvocations++;throw Error('LIVE_NATIVE_DISPATCH_FORBIDDEN');};
 backend.runQuery=async()=>assert.fail('no query allowed');
 backend.callSapHelper=async()=>assert.fail('no generic helper allowed');
 backend.callSapRepository=async()=>assert.fail('no repository write or proxy allowed');
 backend.callSapDdic=async()=>assert.fail('no DDIC write or proxy allowed');
 await mkdir(root+'live-state',{recursive:true});
 running=await startHttpServer(backend,0,root+'live-state');
 proof.localEndpoint=running.mcpUrl;
 await local.connect(new StreamableHTTPClientTransport(new URL(running.mcpUrl)));
 const listed=(await local.listTools()).tools;
 proof.schemas=listed.filter(t=>['read_configuration_number_range_api','apply_configuration_number_range','reconcile_configuration_number_range'].includes(t.name));
 assert.equal(proof.schemas.length,3);
 const operationId='r40-live-missing-api';
 const args={connectionId:'w200',objectName:'ZORVCFGNR',expectedVersion:'a'.repeat(64),action:'create',intervalNumber:'01',fromNumber:'00000000000000000001',toNumber:'00000000000000000100',external:false,operationId,acknowledgeConfigurationWrite:true,acknowledgeLocalClientOnly:true};
 async function call(name,arguments_){const r=await local.callTool({name,arguments:arguments_},undefined,{timeout:60000});const entry={name,args:arguments_,isError:!!r.isError,data:parse(r)};proof.publicCalls.push(entry);return entry;}
 const before=proof.liveReads.length;
 assert.equal((await call('apply_configuration_number_range',{...args,connectionId:'w300'})).isError,true);
 assert.equal(proof.liveReads.length,before);
 const nativeRead=await call('read_configuration_number_range_api',{connectionId:'w200',objectName:'ZORVCFGNR'});
 assert.equal(nativeRead.isError,true);
 assert.ok(proof.liveReads.some(r=>r.name==='read_function_module_interface'&&r.args.functionName==='Z_ORVANTA_CFG_NR_READ'&&r.isError),'require actual absent/refused customer reader');
 const command=await call('apply_configuration_number_range',args);
 assert.equal(command.isError,true);assert.equal(command.data.status,'declined');
 assert.equal(command.data.operationReceipt.sapInvocationStarted,false);
 assert.equal(command.data.operationReceipt.outcomeMayBeUnknown,false);
 const observation=await call('reconcile_configuration_number_range',{connectionId:'w200',objectName:'ZORVCFGNR',operationId});
 assert.equal(observation.isError,false);assert.equal(observation.data.status,'not_dispatched');
 assert.equal(observation.data.operationReceipt.receiptHash,command.data.operationReceipt.receiptHash);
 proof.persistedReceipt=await new WriteOperationReceiptStore(root+'live-state').status('w200',operationId);
 assert.equal(proof.persistedReceipt.sapInvocationStarted,false);
 assert.equal(proof.nativeInvocations,0);
 proof.status='passed_readonly_live_refusal_only';
}catch(error){proof.status='failed';proof.error=String(error);process.exitCode=1;}
finally{
 await local.close();if(running)await running.close();await shared.close();
 ToolService.prototype.readFunctionModuleInterface=original.function;ToolService.prototype.readDdicTransparentTable=original.table;
 proof.finishedAt=new Date().toISOString();proof.isolatedServerClosed=true;
 await writeFile(root+'live-readonly.json',JSON.stringify(proof,null,2),{flag:'wx'});
 console.log(JSON.stringify({status:proof.status,liveReads:proof.liveReads.length,publicCalls:proof.publicCalls.length,nativeInvocations:proof.nativeInvocations,error:proof.error}));
}
