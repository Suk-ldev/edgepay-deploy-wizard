const KEY_PART_A=Uint8Array.from([158,187,103,112,58,192,85,169,10,92,156,28,206,167,154,39,97,106,64,164,53,3,62,197,29,21,48,165,27,130,77,18]);
const KEY_PART_B=Uint8Array.from([69,160,30,87,30,234,3,60,171,196,95,194,232,237,138,243,51,237,48,176,138,96,78,158,98,62,30,152,140,167,64,135]);
const IV=Uint8Array.from([217,242,221,142,2,101,9,186,224,255,231,209]);
const BOX=Uint8Array.from([206,39,181,91,186,31,100,81,219,213,228,134,206,56,119,34,222,182,22,221,199,99,188,37,174,52,180,19,56,1,128,45,3,104,189,219,94,217,37,36]);
const FALLBACK_KEY_PART_A=Uint8Array.from([224,203,107,198,184,102,207,186,179,49,129,193,96,114,85,229,144,238,215,82,119,187,35,197,68,78,11,50,62,167,74,213]);
const FALLBACK_KEY_PART_B=Uint8Array.from([43,237,2,179,191,120,163,211,121,232,72,7,245,191,231,170,163,84,94,23,142,12,20,234,193,143,133,148,156,66,11,75]);
const FALLBACK_IV=Uint8Array.from([6,135,198,42,42,112,114,39,53,172,168,35]);
const FALLBACK_BOX=Uint8Array.from([164,11,42,111,185,222,13,219,164,58,123,238,13,17,168,213,232,107,109,115,115,176,212,247,150,179,152,79,91,125,41,123,141,4,208,42,82,139,133,211,125,181,93,38,198,45,80,117,193]);
const AAD=new TextEncoder().encode('EDGE_ENDPOINT_V1');
let cached;
let fallbackCached;

async function decryptEndpoint(partA,partB,iv,box){
  const raw=new Uint8Array(32);
  for(let index=0;index<raw.length;index+=1)raw[index]=partA[index]^partB[31-index];
  const key=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:AAD},key,box);
  const parsed=new URL(new TextDecoder().decode(plain));
  if(parsed.protocol!=='https:'||parsed.pathname!=='/'||parsed.username||parsed.password||parsed.port||parsed.search||parsed.hash)throw new Error('授权端点完整性校验失败');
  return parsed.origin;
}

export async function licenseServerUrl(){
  if(cached)return cached;
  cached=await decryptEndpoint(KEY_PART_A,KEY_PART_B,IV,BOX);
  return cached;
}

export async function licenseFallbackServerUrl(){
  if(fallbackCached)return fallbackCached;
  fallbackCached=await decryptEndpoint(FALLBACK_KEY_PART_A,FALLBACK_KEY_PART_B,FALLBACK_IV,FALLBACK_BOX);
  return fallbackCached;
}

export async function licenseServerUrls(){
  return [await licenseServerUrl(),await licenseFallbackServerUrl()];
}
