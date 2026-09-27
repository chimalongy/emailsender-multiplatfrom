import { createHmac, timingSafeEqual, scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
export function equal(a,b) { const x=Buffer.from(String(a)), y=Buffer.from(String(b)); return x.length===y.length && timingSafeEqual(x,y); }
function secret(name) { const v=process.env[name]; if(!v || v.length<32) throw new Error(`Missing or weak ${name}`); return v; }
export function passwordOK(value) { const [salt,hash]=(process.env.ADMIN_PASSWORD_HASH||'').split(':'); return !!salt && !!hash && equal(scryptSync(value,salt,64).toString('hex'),hash); }
export function session() { const payload=String(Date.now()+12*60*60*1000); return `${payload}.${createHmac('sha256',secret('SESSION_SECRET')).update(payload).digest('hex')}`; }
export function validSession(token='') { const [p,s]=token.split('.'); return !!s && Number(p)>Date.now() && equal(s,createHmac('sha256',secret('SESSION_SECRET')).update(p).digest('hex')); }
export function encrypt(value) { const key=Buffer.from(secret('CREDENTIALS_KEY'),'hex'); if(key.length!==32) throw new Error('CREDENTIALS_KEY must be 64 hex characters'); const iv=randomBytes(12), c=createCipheriv('aes-256-gcm',key,iv); const body=Buffer.concat([c.update(JSON.stringify(value)),c.final()]); return [iv,c.getAuthTag(),body].map(x=>x.toString('base64')).join('.'); }
export function decrypt(value) { const [iv,tag,body]=value.split('.').map(x=>Buffer.from(x,'base64')); const d=createDecipheriv('aes-256-gcm',Buffer.from(secret('CREDENTIALS_KEY'),'hex'),iv); d.setAuthTag(tag); return JSON.parse(Buffer.concat([d.update(body),d.final()]).toString()); }
export function signature(body,time) { return createHmac('sha256',secret('INBOUND_SECRET')).update(`${time}.${body}`).digest('hex'); }
export function inboundOK(body,time,sig) { return Math.abs(Date.now()-Number(time))<300000 && equal(signature(body,time),sig||''); }
