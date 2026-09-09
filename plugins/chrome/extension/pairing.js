/** A remote-client pairing code still connects exclusively to this computer. */
export function decodePairing(value) {
  const raw=String(value??'').trim();
  if(!raw.startsWith('tek-client-v1:')) {
    if(!/^[a-f0-9]{64}$/i.test(raw))throw new Error('Paste a pairing token or code copied from Tek Desktop.');
    return {token:raw,port:52871};
  }
  try {
    const data=JSON.parse(atob(raw.slice('tek-client-v1:'.length).replace(/-/g,'+').replace(/_/g,'/')));
    if(!/^[a-f0-9]{64}$/i.test(data.token)||!Number.isInteger(data.port)||data.port<1024||data.port>65535)throw new Error();
    return {token:data.token,port:data.port};
  }catch{throw new Error('Invalid pairing code. Copy a fresh code from Tek Desktop.');}
}
