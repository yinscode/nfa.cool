import test from 'node:test';
import assert from 'node:assert/strict';
import {businessSummary,buyerInventory} from '../business.mjs';
import {finances} from '../studio-state.mjs';
test('buyer economics separates deposits, paid revenue, escrow, refunds and unknown profit',()=>{
  const row=(id,status,fee,replenish)=>({id,service:{service_id:'scout',job:{status,fee,replenish,output_hash:'hash'}}});
  const jobs=[row(1,'FINALIZED','100','60'),row(2,'UNCERTAIN','200','160'),row(3,'FAILED','300','250')];
  const snapshot={identity:{tokenId:'nfa-1',ownerAccountId:'bob.testnet',ownerEpoch:1,lifecycle:'ACTIVE',income:'25',vaultAccountId:'vault.testnet'},
    agent:{pending_op:2},treasury:{balance:'999999',available:'900000'},jobs,financial:finances(jobs),financialComplete:true};
  const e=businessSummary(snapshot);
  assert.equal(e.grossCustomerReceipts,'100');assert.equal(e.creditedServiceEarnings,'40');assert.equal(e.withdrawableIncome,'25');
  assert.equal(e.customerEscrow,'200');assert.equal(e.customerRefundCredits,'300');assert.equal(e.netProfit,null);
  assert.equal(e.actualOutlayerExecutionCost,null);assert.equal(e.byService.scout.finalized,1);
  const inventory=buyerInventory(snapshot);assert.equal(inventory.transferBarrier.blocked,true);assert.equal(inventory.included.eligibleWork.length,1);
  assert.equal(inventory.included.vault,'vault.testnet');assert.ok(inventory.excluded.some(x=>x.includes('OAuth')));
});
