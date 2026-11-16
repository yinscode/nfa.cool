import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHireLink,hireLink,nearToYocto,parseBudgetLink} from '../hire-link.mjs';

test('hire link round-trips a drafted Scout job', () => {
  const input={question:'Does the vault survive a sale?',sources:[{title:'Spec',url:'https://example.org',text:'Same vault after transfer & sale.'}]};
  const url=new URL(hireLink('https://NFA.cool','nfa-2','scout',input));
  assert.equal(url.pathname,'/nfa/nfa-2');
  assert.deepEqual(parseHireLink(url.search),{service:'scout',input});
  assert.equal(parseHireLink('?foo=1'),null);
  assert.deepEqual(parseHireLink('?service=compare'),{service:'compare',input:null});
});

test('hire link rejects bad service, JSON, shape and size', () => {
  assert.throws(()=>parseHireLink('?service=research'),/Unknown service/);
  assert.throws(()=>parseHireLink('?input=%7Bnope'),/not valid JSON/);
  assert.throws(()=>parseHireLink('?input='+encodeURIComponent('{"question":"q"}')),/sources/);
  assert.throws(()=>parseHireLink('?input='+encodeURIComponent(JSON.stringify({question:'x'.repeat(8000),sources:[]}))),/too large/);
});

test('NEAR amounts convert to yocto exactly', () => {
  assert.equal(nearToYocto('0.1'),'100000000000000000000000');
  assert.equal(nearToYocto('2'),'2000000000000000000000000');
  assert.equal(nearToYocto('0.000000000000000000000001'),'1');
  for(const bad of ['0','-1','1e3','.5','abc','0.0000000000000000000000001'])assert.throws(()=>nearToYocto(bad));
});

test('budget link grants one capped, expiring NFA hire', () => {
  const agent='a'.repeat(64);
  assert.deepEqual(parseBudgetLink(`?token=nfa-1&grant=${agent}&method=NFA_HIRE&recipient=nfa-2&budgetNear=0.25&hours=48`),
    {delegate:agent,method:'NFA_HIRE',recipient:'nfa-2',budget:'250000000000000000000000',hours:48});
  assert.equal(parseBudgetLink('?token=nfa-1'),null);
  assert.throws(()=>parseBudgetLink(`?grant=${agent}&method=NEAR_TRANSFER&recipient=nfa-2`),/only grant NFA hiring/);
  assert.throws(()=>parseBudgetLink(`?grant=${agent}&recipient=bob.testnet`),/one NFA/);
  assert.throws(()=>parseBudgetLink(`?grant=${agent}&recipient=nfa-2&hours=999`),/1 to 168 hours/);
  assert.throws(()=>parseBudgetLink('?grant=Bad..Account&recipient=nfa-2'),/valid NEAR account/);
});
