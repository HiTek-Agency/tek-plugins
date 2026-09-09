// Captured by each browser action. Pause/re-pair invalidates work already awaiting
// a CDP response, so resuming cannot revive an old form fill or click sequence.
export function createActionEpoch() {
 const key=Symbol('control-generation');let generation=0;
 return {
  invalidate(){generation++;},
  capture(args={}){return {...args,[key]:generation};},
  inherit(parent,args={}){return {...args,[key]:parent[key]};},
  assert(args){if(args[key]!==generation)throw new Error('Chrome control changed during this action. Check the tab before retrying.');},
  async run(args,operation){this.assert(args);const result=await operation();this.assert(args);return result;}
 };
}
