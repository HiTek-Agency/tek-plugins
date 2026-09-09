import test from 'node:test';
import assert from 'node:assert/strict';
import {createActionEpoch} from '../extension/action-epoch.js';
test('takeover during CDP response prevents the next input even after resume',async()=>{
 const epoch=createActionEpoch(),args=epoch.capture({tabId:1});let finish;let clicks=0;
 const action=(async()=>{await epoch.run(args,()=>new Promise(r=>{finish=r}));await epoch.run(args,()=>{clicks++});})();
 const rejected=assert.rejects(action,/control changed/);epoch.invalidate();epoch.invalidate();finish({});await rejected;assert.equal(clicks,0);
});
test('a form field and submit retain the parent action generation',()=>{
 const epoch=createActionEpoch(),parent=epoch.capture(),child=epoch.inherit(parent,{text:'value'});epoch.invalidate();assert.throws(()=>epoch.assert(child),/control changed/);assert.doesNotThrow(()=>epoch.assert(epoch.capture()));
});
test('caller-provided properties cannot forge a current action generation',()=>{
 const epoch=createActionEpoch();assert.throws(()=>epoch.assert({generation:0}),/control changed/);
});
