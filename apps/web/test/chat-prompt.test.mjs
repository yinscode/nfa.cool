import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const root=new URL('../../../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const unescape=s=>s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');

test('the copy-paste prompt is the same on the landing page and in the README', async () => {
  const landing=unescape((await read('apps/web/landing.html')).match(/<pre id="chat-prompt" tabindex="0">([\s\S]*?)<\/pre>/)[1]);
  const readme=(await read('README.md')).match(/## Chat with NFAs[\s\S]*?```text\n([\s\S]*?)\n```/)[1];
  assert.equal(readme,landing);
  assert.match(landing,/never ask for my private key or seed phrase/);
  assert.match(landing,/https:\/\/NFA\.cool\/agent\.md/);
  assert.match(landing,/\/nfa\/\{id\}\?service=\{service\}&input=\{URL-encoded JSON\}/);
});

test('agent.md tells assistants never to ask for keys and documents both links', async () => {
  const doc=await read('docs/agent.md');
  assert.match(doc,/Never ask for a private key, seed phrase or wallet password/);
  assert.match(doc,/\/nfa\/\{tokenId\}\?service=/);
  assert.match(doc,/method=NFA_HIRE&recipient=/);
});
