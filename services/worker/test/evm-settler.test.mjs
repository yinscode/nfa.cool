import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EvmJournal,submitAndObserve} from '../evm-journal.mjs';
import {NearIntentWallet} from '../near-intent.mjs';
import {settleEvmTick} from '../evm-settler.mjs';

test('settler restarts through mark/report/reconcile, preserving pending authority until receipt',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'nfa-settler-'));
  try{
    const address='0x'+'b'.repeat(40),block='0x'+'c'.repeat(64),signed={raw:'0x02c0',nonce:0,sender:address};
    let pending=1,hash=null,vaultPending={Evm:{signature:[1],uncertain:false}},receipt=null,broadcasts=0;
    const journal=new EvmJournal(dir),record=await journal.saveSigned('nfa-1',1,signed);
    const fetchImpl=async(_url,options)=>{const {method}=JSON.parse(options.body);let result;
      if(method==='eth_chainId')result='0xaa36a7';
      if(method==='eth_getTransactionByHash')result={hash:record.hash,from:address,blockHash:block,nonce:'0x0',chainId:'0xaa36a7'};
      if(method==='eth_getTransactionReceipt')result={transactionHash:record.hash,from:address,blockHash:block,blockNumber:'0x64',status:'0x1'};
      if(method==='eth_blockNumber')result='0x66';if(method==='eth_getBlockByNumber')result={hash:block,number:'0x64'};
      if(method==='eth_sendRawTransaction'){broadcasts++;result=record.hash}
      return {ok:true,json:async()=>({result})};
    };
    const sdk={registryAccountId:'registry.testnet',get:async()=>({vaultAccountId:'vault.testnet',foreignWallet:{chain_id:11155111,path:'eth-sepolia-v1',address,public_key:'key'}}),
      getAgentState:async()=>({pending_op:pending}),view:async(_account,method)=>({
        operation:{kind:'EVM_TRANSFER',status:'Submitted'},evm_operation:{nonce:0,tx_hash:hash},status:{controller:'registry.testnet',reporter:'reporter.testnet',chain_id:11155111,path:'eth-sepolia-v1',pending:vaultPending,last_receipt:receipt}}[method])};
    const wallet={send:async(_label,a)=>{assert.equal(a.deposit,'0');
      if(a.methodName==='mark_evm_broadcast')hash=a.args.tx_hash;
      if(a.methodName==='report_evm_receipt'){vaultPending=null;receipt=[0,record.hash,100,true]}
      if(a.methodName==='reconcile_evm')pending=null;
      return {state:'FINAL'};
    }};
    const tick=()=>settleEvmTick({sdk,journal:new EvmJournal(dir),wallet,reporterId:'reporter.testnet',tokenId:'nfa-1',rpcUrl:'https://rpc.invalid',fetchImpl,assemble:()=>signed});
    assert.equal((await tick()).stage,'mark');assert.equal(pending,1);
    assert.equal((await tick()).stage,'report');assert.equal(pending,1);
    assert.equal((await tick()).stage,'reconcile');assert.equal(pending,null);
    assert.equal((await tick()).state,'IDLE');assert.equal(broadcasts,0);
    let sent=false;
    const wrong=await submitAndObserve({journal:new EvmJournal(join(dir,'wrong')),tokenId:'nfa-1',id:1,signed,rpcUrl:'https://rpc.invalid',
      fetchImpl:async(_url,o)=>{if(JSON.parse(o.body).method==='eth_sendRawTransaction')sent=true;return {ok:true,json:async()=>({result:'0x1'})}}});
    assert.equal(wrong.reason,'wrong_chain');assert.equal(sent,false);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('ambiguous NEAR reporter submission replays the exact signed intent after restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'nfa-near-intent-'));let signed=0;const sent=[];
  try{
    const opts={directory,accountId:'reporter.testnet',sign:async()=>{signed++;return {hash:'public-hash',signedTxBase64:'private-test-bytes'}},
      rpc:async(method,p)=>{if(method==='send_tx')sent.push(p.signed_tx_base64);throw Error('timeout')}};
    const action={receiverId:'registry.testnet',methodName:'reconcile_evm',args:{token_id:'nfa-1',id:1},deposit:'0'};
    assert.equal((await new NearIntentWallet(opts).send('nfa-1-1-reconcile',action)).state,'UNCERTAIN');
    assert.equal((await new NearIntentWallet(opts).send('nfa-1-1-reconcile',action)).state,'UNCERTAIN');
    assert.equal(signed,1);assert.deepEqual(sent,['private-test-bytes','private-test-bytes']);
    await assert.rejects(()=>new NearIntentWallet(opts).send('nfa-1-1-reconcile',{...action,deposit:'1'}),/Conflicting/);
  }finally{await rm(directory,{recursive:true,force:true})}
});
