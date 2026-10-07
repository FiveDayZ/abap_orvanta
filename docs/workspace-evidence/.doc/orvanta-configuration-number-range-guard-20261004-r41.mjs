import assert from 'node:assert/strict';
export function guardNumberRangeBackend(backend,metrics,save,verifyFrozen){
 const remote=backend.callRemoteFunction.bind(backend),ddic=backend.callSapDdic.bind(backend),repository=backend.callSapRepository.bind(backend);
 const zero='00000000000000000001',hundred='00000000000000000100',twoHundred='00000000000000000200';
 backend.callRemoteFunction=async(connectionId,request)=>{
  assert.equal(connectionId,'w200');await verifyFrozen();
  if(request.functionName==='Z_ORVANTA_CFG_NR_READ'){
   assert.deepEqual(request.inputParameters,{IV_OBJECT:'ZORVCFGNR'});metrics.nativeReads++;await save();return remote(connectionId,request);
  }
  assert.equal(request.functionName,'Z_ORVANTA_CFG_NR_APPLY');assert.equal(metrics.stopped,false);
  const index=metrics.nativeWrites;
  assert.ok(index<4,'Approved native command budget exhausted');
  const expected={IV_OBJECT:'ZORVCFGNR',IV_EXPECTED_VERSION:request.inputParameters.IV_EXPECTED_VERSION,IV_ACTION:index===0?'I':'U',IV_INTERVAL:'01',IV_FROM_NUMBER:zero,IV_TO_NUMBER:index===0?hundred:twoHundred,IV_EXTERNAL:'',IV_ACK_LOCAL_ONLY:'X'};
  assert.deepEqual(request.inputParameters,expected);assert.match(expected.IV_EXPECTED_VERSION,/^[a-f0-9]{64}$/);
  if(index===0)metrics.initialVersion=expected.IV_EXPECTED_VERSION;
  if(index===1)assert.equal(expected.IV_EXPECTED_VERSION,metrics.initialVersion,'Only the approved old-version native probe may be second');
  else if(index>1)assert.notEqual(expected.IV_EXPECTED_VERSION,metrics.initialVersion);
  assert.equal(metrics.committedWrites,index===0?0:index===3?2:1);
  metrics.nativeWrites++;metrics.events.push({at:new Date().toISOString(),kind:'native_command_started',index:index+1,input:expected});await save();
  try{
   const result=await remote(connectionId,request),out=result.outputs;
   if(out.EV_COMMITTED==='X')metrics.committedWrites++;
   metrics.events.push({at:new Date().toISOString(),kind:'native_command_result',index:index+1,result});await save();
   assert.equal(out.EV_CODE,['SAVED_LOCAL_CLIENT','VERSION_CHANGED','SAVED_LOCAL_CLIENT','NO_CHANGES'][index]);
   assert.equal(out.EV_COMMITTED,index===0||index===2?'X':'');assert.equal(out.EV_UNLOCKED,'X');assert.ok(['X','not_required'].includes(out.EV_SESSION_RESET));
   assert.ok(metrics.committedWrites<=2);return result;
  }catch(error){metrics.stopped=true;await save();throw error;}
 };
 backend.callSapDdic=async(connectionId,request)=>{
  assert.equal(connectionId,'w200');await verifyFrozen();
  if(request.operation==='UPSERT_NUMBER_RANGE_OBJECT'){
   assert.equal(request.objectName,'ZORVCFGNR');assert.equal(request.packageName,'ZABAP');assert.equal(request.transportNumber,'GR2K923472');assert.equal(request.expectedVersion,undefined);
   assert.equal(request.header.DOMLEN,'NUMC20');for(const field of ['YEARIND','BUFFER','DTELSOBJ','NRTAB','TEXTIND','RFCDEST','NRCHECKASCII'])assert.equal(request.header[field],'');
   assert.equal(request.numberRangeTexts[0].LANGU,'1');assert.equal(request.numberRangeTexts.length,1);assert.equal(metrics.definitionWrites,0);metrics.definitionWrites++;await save();
  }else{assert.ok(['READ_NUMBER_RANGE_OBJECT','READ_TRANSPARENT_TABLE','READ_STRUCTURE','READ_DATA_ELEMENT','READ_DOMAIN'].includes(request.operation));metrics.ddicReads++;await save();}
  return ddic(connectionId,request);
 };
 backend.callSapRepository=async(connectionId,request)=>{assert.equal(connectionId,'w200');assert.equal(request.operation,'READ_FUNCTION_INTERFACE');metrics.repositoryReads++;await save();return repository(connectionId,request);};
 backend.callSapHelper=async()=>assert.fail('Generic helper not authorized in isolated number range acceptance');
 backend.runQuery=async()=>assert.fail('No data query in isolated number range acceptance');
}
