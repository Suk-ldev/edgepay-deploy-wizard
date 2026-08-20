const KEY_PART_A=Uint8Array.from([158,187,103,112,58,192,85,169,10,92,156,28,206,167,154,39,97,106,64,164,53,3,62,197,29,21,48,165,27,130,77,18]);
const KEY_PART_B=Uint8Array.from([69,160,30,87,30,234,3,60,171,196,95,194,232,237,138,243,51,237,48,176,138,96,78,158,98,62,30,152,140,167,64,135]);
const IV=Uint8Array.from([217,242,221,142,2,101,9,186,224,255,231,209]);
const BOX=Uint8Array.from([206,39,181,91,186,31,100,81,219,213,228,134,206,56,119,34,222,182,22,221,199,99,188,37,174,52,180,19,56,1,128,45,3,104,189,219,94,217,37,36]);
const AAD=new TextEncoder().encode('EDGE_ENDPOINT_V1');
let cached;

export async function licenseServerUrl(){
  if(cached)return cached;
  const raw=new Uint8Array(32);
  for(let index=0;index<raw.length;index+=1)raw[index]=KEY_PART_A[index]^KEY_PART_B[31-index];
  const key=await crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:IV,additionalData:AAD},key,BOX);
  const value=new TextDecoder().decode(plain);
  const parsed=new URL(value);
  if(parsed.protocol!=='https:'||parsed.pathname!=='/'||parsed.username||parsed.password||parsed.port||parsed.search||parsed.hash)throw new Error('授权端点完整性校验失败');
  cached=parsed.origin;
  return cached;
}

