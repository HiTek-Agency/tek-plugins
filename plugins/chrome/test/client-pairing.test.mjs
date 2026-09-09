import test from 'node:test';
import assert from 'node:assert/strict';
import {decodePairing} from '../extension/pairing.js';
const token='ab'.repeat(32);
const code=value=>'tek-client-v1:'+Buffer.from(JSON.stringify(value)).toString('base64url');
test('legacy token keeps the gateway loopback port',()=>assert.deepEqual(decodePairing(token),{token,port:52871}));
test('desktop pairing binds to a local port and ignores any remote host fields',()=>assert.deepEqual(decodePairing(code({token,port:55123,host:'evil.example'})),{token,port:55123}));
test('malformed pairing codes and port/token injection are rejected',()=>{
 for(const value of ['',token+'?remote=true',code({token,port:'55123'}),code({token,port:0}),code({token,port:65536}),code({token:'é'.repeat(64),port:55123}),'tek-client-v1:invalid'])assert.throws(()=>decodePairing(value));
});
