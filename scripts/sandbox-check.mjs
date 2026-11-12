#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {connect,KeyPair,keyStores,KeyPairSigner,utils,transactions} from 'near-api-js';
import {NfaSdk} from '@nfa/sdk';
import {AccessService,verifyNearFullAccessKey} from '../services/api/access.mjs';
import {WorkStore} from '../services/api/work-store.mjs';
import {InputStore} from '../services/worker/input-store.mjs';
import {runScout} from '../services/worker/run-scout.mjs';
import {createApiServer} from '../services/api/server.mjs';
import {ArtifactStore} from '../services/api/artifact-store.mjs';
import {AvatarRenderer} from '../services/api/render.mjs';
import {createScoutBrief} from '../services/worker/scout.mjs';
import {createCompareBrief} from '../services/worker/compare.mjs';
import {studioPort,listenStudio,assertStudioPortAvailable} from '../services/api/studio-listen.mjs';

const YOCTO=10n**24n;
const wasmPath=resolve(process.env.NFA_SANDBOX_REGISTRY_WASM||'contracts/registry/target/wasm32-unknown-unknown/release/nfa_registry_opt.wasm');
const outlayerMock=process.env.NFA_SANDBOX_OUTLAYER==='1';
const near=x=>(BigInt(x)*YOCTO).toString();
const ns=seconds=>Number((BigInt(Date.now())+BigInt(seconds)*1000n)*1_000_000n);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(work,tries=30){let last;
  for(let i=0;i<tries;i++){try{return await work()}catch(error){last=error;await pause(150)}}
  throw last;
}
async function until(work,predicate,tries=40){let value;
  for(let i=0;i<tries;i++){value=await work();if(predicate(value))return value;await pause(150)}
  throw Error('Sandbox state did not settle: '+JSON.stringify(value));
}
const port=()=>new Promise((resolvePort,reject)=>{const server=createServer();server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolvePort(p))})});
const gas=tx=>[tx.transaction_outcome,...(tx.receipts_outcome||[])].reduce((n,x)=>n+BigInt(x?.outcome?.gas_burnt||0),0n).toString();
function success(tx,label){if(tx.status?.Failure)throw Error(`${label}: ${JSON.stringify(tx.status.Failure)}`);return tx}

export async function startSandbox(binary,home,rpcPort,netPort,{reuse=false}={}){
  if(!reuse){const init=spawnSync(binary,['--home',home,'init','--fast'],{encoding:'utf8',timeout:60_000});
    if(init.error||init.status!==0)throw Error('Sandbox init failed: '+(init.error?.message||init.stderr))}
  const child=spawn(binary,['--home',home,'run','--rpc-addr',`127.0.0.1:${rpcPort}`,
    '--network-addr',`127.0.0.1:${netPort}`],{stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-3000)});
  const rpcUrl=`http://127.0.0.1:${rpcPort}`;
  for(let i=0;i<100;i++){
    if(child.exitCode!==null)throw Error(`Sandbox exited: ${stderr}`);
    try{const response=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:'ready',method:'status',params:[]})});
      if((await response.json()).result?.chain_id)return {child,rpcUrl};}catch{}
    await pause(200);
  }
  child.kill();throw Error('Sandbox RPC did not become ready: '+stderr);
}

export async function serveStudio({sdk,people,rpcUrl,registry,alice,bob,customer,persistent=false,workspaceId=null,controlToken=null}){
      if(!outlayerMock)throw Error('Studio sandbox requires the OutLayer mock');
      const apiPort=studioPort(),origin=`http://127.0.0.1:${apiPort}`;
      const data=resolve('.data/sandbox');
      const peopleById=new Map([alice,bob,customer].map(p=>[p.id,p]));
      const localWallet={accounts:[alice.id,bob.id,customer.id],instanceId:process.env.NFA_STUDIO_INSTANCE_ID||null,
        async transaction({accountId,action}){
          const person=peopleById.get(accountId);if(!person)throw Error('Unknown sandbox account');
          if(action.receiverId!==registry.id&&!action.receiverId.endsWith('.'+registry.id))throw Error('Sandbox target refused');
          if(['start_service_job','start_paid_scout'].includes(action.methodName)){
            const payload=JSON.parse(action.args.input_data),record=await sdk.getServiceJob(action.args.token_id,action.args.id);
            const result=record.service_id==='scout'?createScoutBrief(payload):createCompareBrief(payload);
            await people.outlayer.account.functionCall({contractId:people.outlayer.id,methodName:'set_fixture',
              args:{vault:(await sdk.get(action.args.token_id)).vaultAccountId,service:record.service_id,job_id:action.args.id,output_hash:result.outputHash},
              gas:30_000_000_000_000n,attachedDeposit:0n});
          }
          const actions=[action.methodName?transactions.functionCall(action.methodName,action.args,BigInt(action.gas),BigInt(action.deposit)):
            transactions.transfer(BigInt(action.deposit))];
          const result=await person.account.signAndSendTransactionLegacy({receiverId:action.receiverId,actions,returnError:true});
          return result;
        },
        async message({accountId,challenge}){const person=peopleById.get(accountId);if(!person)throw Error('Unknown sandbox account');
          const proof=await new KeyPairSigner(person.key).signNep413Message(challenge.message,accountId,challenge.recipient,
            Buffer.from(challenge.nonce,'base64'),challenge.callbackUrl);
          return {accountId,publicKey:proof.publicKey.toString(),signature:Buffer.from(proof.signature).toString('base64')};
        }};
      const policy={limits:{max_instructions:1_000_000_000,max_memory_mb:64,max_execution_seconds:10},
        marginYocto:'10000000000000000000000',maxDepositYocto:'500000000000000000000000'};
      let stop;const stopped=new Promise(resolve=>{stop=resolve});
      const server=createApiServer({sdk,localWallet,workspace:{persistent,id:workspaceId},
        localControl:controlToken?{token:controlToken,stop}:null,servicePolicy:{scout:policy,compare:policy},
        access:new AccessService({sdk,origin,verifyKey:args=>verifyNearFullAccessKey({...args,rpcUrl})}),
        store:new WorkStore(join(data,'work')),manifests:new WorkStore(join(data,'manifests')),
        artifacts:new ArtifactStore(join(data,'artifacts')),renderer:new AvatarRenderer(join(data,'render'))});
      await listenStudio(server,apiPort);
      console.log(`Studio sandbox at ${origin}/studio${persistent||process.argv.includes('--serve-fast')?'':'?token=nfa-1'}`);
      process.once('SIGINT',stop);process.once('SIGTERM',stop);await stopped;
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}

async function main(){
  if(process.argv.includes('--serve-fast')||process.argv.includes('--serve'))await assertStudioPortAvailable();
  const binary=process.env.NEAR_SANDBOX_BIN_PATH;
  if(!binary)throw Error('Set NEAR_SANDBOX_BIN_PATH to the official NEAR sandbox binary (2.14.0 or compatible). No testnet is used.');
  const home=await mkdtemp(join(tmpdir(),'nfa-near-sandbox-'));
  let child;
  try{
    const {child:running,rpcUrl}=await startSandbox(binary,home,await port(),await port());child=running;
    const rootKey=JSON.parse(await readFile(join(home,'validator_key.json'),'utf8'));
    assert.equal(rootKey.account_id,'test.near','Sandbox genesis must contain test.near');
    const keys=new keyStores.InMemoryKeyStore(),networkId='sandbox';
    await keys.setKey(networkId,rootKey.account_id,KeyPair.fromString(rootKey.secret_key));
    const node=await connect({networkId,nodeUrl:rpcUrl,deps:{keyStore:keys}});
    const root=await node.account(rootKey.account_id),people={};
    async function create(name,balance){const id=`${name}.test.near`,key=KeyPair.fromRandom('ed25519');
      success(await root.createAccount(id,key.getPublicKey(),near(balance)),`create ${id}`);
      await keys.setKey(networkId,id,key);people[name]={id,key,account:await node.account(id)};
      return people[name]}
    const registry=await create('registry',30),alice=await create('alice',20),
      bob=await create('bob',20),customer=await create('customer',20),worker=await create('worker',20),
      missing=await create('receiver',1);
    if(outlayerMock){
      const mock=await create('outlayer',10);
      assert.equal(mock.id,'outlayer.test.near');
      success(await mock.account.deployContract(await readFile(resolve('output/sandbox-outlayer-mock.wasm'))),'deploy OutLayer mock');
      success(await mock.account.functionCall({contractId:mock.id,methodName:'new',args:{},gas:BigInt('30000000000000'),attachedDeposit:0n}),'init OutLayer mock');
    }
    const code=await readFile(wasmPath),codeHash=utils.serialize.base_encode(createHash('sha256').update(code).digest());
    success(await registry.account.deployContract(code),'deploy registry');
    const call=async(who,method,args,deposit='1',gasAmount='250000000000000')=>
      success(await who.account.functionCall({contractId:registry.id,methodName:method,args,
        gas:BigInt(gasAmount),attachedDeposit:BigInt(deposit)}),method);
    await call(registry,'new',{admin:registry.id,reporter:registry.id,guardian:registry.id},'0');
    const sdk=new NfaSdk({registryAccountId:registry.id,rpcUrl});
    if(process.argv.includes('--serve-fast')){await serveStudio({sdk,people,rpcUrl,registry,alice,bob,customer});return}
    const account=async id=>node.connection.provider.query({request_type:'view_account',finality:'final',account_id:id});
    const before=await account(registry.id);
    const manifestHash='sha256:'+'a'.repeat(64);
    const created=await call(alice,'create_agent',{request_id:'sandbox-scout',manifest_hash:manifestHash,
      manifest_uri:'nfa://manifest/sandbox-scout'},(6n*YOCTO).toString());
    assert.equal(await sdk.view(registry.id,'request_token',{owner:alice.id,request_id:'sandbox-scout'}),'nfa-1');
    const initial=await eventually(()=>sdk.get('nfa-1'));assert.equal(initial.ownerAccountId,alice.id);
    assert.equal(initial.vaultAccountId,`nfa-1.${registry.id}`);
    const vaultBefore=await account(initial.vaultAccountId);
    const locked=await sdk.getTreasury('nfa-1');assert.ok(BigInt(locked.balance)>BigInt(locked.storage_reserve));

    let paidResults=null;
    if(outlayerMock){
      const versionKey='b2cf2dd2b606ec158ad275d3d15cc5934197d3d9a494d01279a552167c41cbf9';
      const provision=await call(alice,'provision_outlayer',{token_id:'nfa-1',wasm_url:'https://example.org/nfa-immutable.wasm',
        version_key:versionKey,deposit:(10n**22n).toString()});
      const project=await until(()=>sdk.getOutlayerProject('nfa-1'),p=>p?.state==='READY');
      assert.equal(project.state,'READY');assert.equal(project.project_id,`${initial.vaultAccountId}/scout`);
      const limits={max_instructions:1_000_000_000,max_memory_mb:64,max_execution_seconds:10};
      const fee=(2n*10n**22n).toString(),replenish=(3n*10n**21n).toString();
      const scoutData=JSON.stringify({question:'How does an NFA retain treasury?',sources:[{title:'Vault',
        url:'https://example.org/vault',text:'The NFA vault retains the treasury after its owner transfers the NFT to another account.'}]});
      const scoutHash='sha256:'+createHash('sha256').update(scoutData).digest('hex');
      // Paid jobs require an owner policy; its limits are the job limits exactly.
      const scoutPolicy=await call(alice,'configure_service',{token_id:'nfa-1',service_id:'scout',
        schema_hash:'sha256:'+'5'.repeat(64),enabled:true,min_margin:'10000000000000000000000',
        max_deposit:'500000000000000000000000',limits});
      const scoutRequest=await call(customer,'request_reviewed_service_job',{token_id:'nfa-1',service_id:'scout',input_hash:scoutHash,
        deadline_ns:ns(3600),fee,replenish,deposit_cap:replenish,limits,expected_version:versionKey,expected_policy_version:1},fee);
      const scoutId=(await until(()=>sdk.getAgentState('nfa-1'),a=>a?.pending_op!=null)).pending_op;
      const scoutStart=await call(worker,'start_paid_scout',{token_id:'nfa-1',id:scoutId,input_data:scoutData},'0');
      await until(()=>sdk.getPaidJob('nfa-1',scoutId),j=>j?.status==='FINALIZED');
      assert.equal((await sdk.getPaidLedger()).customer_escrow,'0');
      const comparePolicy=await call(alice,'configure_service',{token_id:'nfa-1',service_id:'compare',
        schema_hash:'sha256:'+'c'.repeat(64),enabled:true,min_margin:'10000000000000000000000',
        max_deposit:'500000000000000000000000',limits});
      const compareData=JSON.stringify({question:'Which option has more evidence?',criteria:['cost'],sources:[
        {title:'A',url:'https://example.org/a',text:'The cost for option A is five units in the source text.'},
        {title:'B',url:'https://example.org/b',text:'The cost for option B is six units in the source text.'}]});
      const compareHash='sha256:'+createHash('sha256').update(compareData).digest('hex');
      const compareRequest=await call(customer,'request_service_job',{token_id:'nfa-1',service_id:'compare',
        input_hash:compareHash,deadline_ns:ns(3600),fee,replenish,deposit_cap:replenish,limits},fee);
      const compareId=(await until(()=>sdk.getAgentState('nfa-1'),a=>a?.pending_op!=null)).pending_op;
      const compareStart=await call(worker,'start_service_job',{token_id:'nfa-1',id:compareId,input_data:compareData},'0');
      await until(()=>sdk.getServiceJob('nfa-1',compareId),j=>j?.job?.status==='FINALIZED');
      assert.equal((await sdk.getServiceJob('nfa-1',compareId)).service_id,'compare');
      assert.equal((await sdk.getPaidLedger()).customer_escrow,'0');
      paidResults={project,scoutId,compareId,transactionGas:{provision:gas(provision),scoutRequest:gas(scoutRequest),
        scoutStart:gas(scoutStart),comparePolicy:gas(comparePolicy),compareRequest:gas(compareRequest),
        compareStart:gas(compareStart)}};
    }

    const workInput={question:'How does the agent retain its treasury?',sources:[{title:'Account',
      url:'https://example.org/account',text:'The agent retains its treasury in the same NEAR account after its NFT changes hands. The new owner controls the vault through the registry.'}]};
    const inputs=new InputStore(join(home,'inputs')),store=new WorkStore(join(home,'work'));
    const {briefHash,sourceHash}=await inputs.put(workInput);
    await call(alice,'grant_delegate',{token_id:'nfa-1',delegate:worker.id,method:'SCOUT_RUN',recipient:null,
      budget:'2',expires_at_ns:ns(3600)});
    const requested=await call(customer,'request_scout_job',{token_id:'nfa-1',brief_hash:briefHash,
      source_hash:sourceHash,deadline_ns:ns(3600),fee:'10000000000000000000000'},'10000000000000000000000');
    const oldScoutId=(await until(()=>sdk.getAgentState('nfa-1'),a=>a?.pending_op!=null)).pending_op;
    const job=await until(()=>sdk.getJob('nfa-1',oldScoutId),j=>j?.status==='REQUESTED');
    await runScout({sdk,store,inputStore:inputs,tokenId:'nfa-1',jobId:oldScoutId,
      wallet:{signAndSendTransaction:async action=>call(worker,action.methodName,action.args,action.deposit,action.gas)}});
    const earned=await sdk.get('nfa-1');assert.ok(BigInt(earned.income)>=10n**22n);
    const access=new AccessService({sdk,origin:'http://127.0.0.1:3000',
      verifyKey:payload=>verifyNearFullAccessKey({...payload,rpcUrl})});
    async function session(person){const challenge=access.challenge(person.id,'nfa-1');
      const signer=new KeyPairSigner(person.key);
      const proof=await signer.signNep413Message(challenge.message,person.id,challenge.recipient,
        Buffer.from(challenge.nonce,'base64'),challenge.callbackUrl);
      return (await access.authorize({challengeId:challenge.challengeId,accountId:person.id,
        publicKey:proof.publicKey.toString(),signature:Buffer.from(proof.signature).toString('base64')})).session}
    const oldSession=await session(alice);

    const rollback=await call(alice,'nft_transfer_call',{receiver_id:missing.id,token_id:'nfa-1',msg:'reject'});
    await until(()=>sdk.get('nfa-1'),a=>a?.ownerAccountId===alice.id&&a.ownerEpoch===0);
    await call(alice,'create_listing',{token_id:'nfa-1',price:near(1),expires_at_ns:ns(3600)});
    await assert.rejects(()=>call(alice,'nft_transfer',{receiver_id:bob.id,token_id:'nfa-1'}));
    const listing=await until(()=>sdk.get('nfa-1'),a=>a?.lifecycle==='LISTED');
    const sold=await call(bob,'buy',{token_id:'nfa-1',expected_nonce:listing.listing.nonce},near(1));
    const buyer=await until(()=>sdk.get('nfa-1'),a=>a?.ownerAccountId===bob.id);
    assert.equal(buyer.ownerEpoch,1);assert.equal(buyer.vaultAccountId,initial.vaultAccountId);
    assert.equal(buyer.income,earned.income);
    if(paidResults){
      const recall=await call(bob,'recall_owner_memory',{token_id:'nfa-1',job_id:paidResults.scoutId,
        deposit:'3000000000000000000000'},'3000000000000000000000');
      assert.equal((await sdk.getOutlayerProject('nfa-1')).project_uuid,paidResults.project.project_uuid);
      await assert.rejects(()=>call(alice,'recall_owner_memory',{token_id:'nfa-1',job_id:paidResults.scoutId,
        deposit:'3000000000000000000000'},'3000000000000000000000'));
      paidResults.transactionGas.recall=gas(recall);
    }
    await assert.rejects(()=>access.requireOwner(oldSession,'nfa-1'),/Ownership changed/);
    assert.equal(await access.requireOwner(await session(bob),'nfa-1'),bob.id);
    await assert.rejects(()=>call(alice,'request_near_transfer',
      {token_id:'nfa-1',recipient:alice.id,amount:'1000000000000000000000'}));

    // A nonexistent receiver makes the vault promise fail and callbacks must clear it.
    const failedOpId=(await sdk.getAgentState('nfa-1')).next_op_id;
    const failed=await call(bob,'request_near_transfer',{token_id:'nfa-1',
      recipient:'no-such-recipient.test.near',amount:'1000000000000000000000'});
    const failedOp=await until(()=>sdk.view(registry.id,'operation',{token_id:'nfa-1',id:failedOpId}),
      op=>op?.status==='Failed');
    assert.equal(failedOp.status,'Failed');
    assert.equal((await sdk.get('nfa-1')).lifecycle,'ACTIVE');
    const payout=await sdk.view(registry.id,'payout',{seller:alice.id});
    assert.equal(payout.available,near(1));
    const withdrawn=await call(alice,'withdraw_proceeds',{amount:near(1)});
    assert.equal((await sdk.view(registry.id,'payout',{seller:alice.id})).available,'0');
    const vaultAfter=await account(initial.vaultAccountId),after=await account(registry.id);
    success(await registry.account.deployContract(code),'upgrade registry');
    assert.equal((await account(registry.id)).code_hash,codeHash);
    assert.equal((await sdk.get('nfa-1')).ownerAccountId,bob.id);

    const metrics={registryCodeBytes:code.length,codeHash,registryStorageBytes:{before:before.storage_usage,after:after.storage_usage},
      vaultStorageBytes:vaultAfter.storage_usage,vaultBalanceYocto:vaultAfter.amount,
      transactionGas:{create:gas(created),job:gas(requested),rollback:gas(rollback),sale:gas(sold),
        failedPayout:gas(failed),sellerWithdrawal:gas(withdrawn)},
      paidResults,assertions:['provisioned keyless vault','paid Scout output','income follows sale','seller payout',
        'old session and old owner rejected','failed vault transfer callback','transfer-call rollback','upgrade preserves state']};
    await mkdir(resolve('output'),{recursive:true});
    await writeFile(resolve('output/sandbox-metrics.json'),JSON.stringify(metrics,null,2)+'\n');
    console.log(JSON.stringify(metrics,null,2));
    if(process.argv.includes('--serve'))await serveStudio({sdk,people,rpcUrl,registry,alice,bob,customer});
  }finally{
    if(child&&child.exitCode===null){child.kill();await new Promise(resolve=>{
      child.once('exit',resolve);setTimeout(resolve,3000).unref();
    })}
    try{await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
    catch(error){console.error('Sandbox cleanup: '+error.message)}
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{console.error(error.stack||error);process.exitCode=1});
