import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {encrypt,decrypt,session,validSession,signature,inboundOK} from '../lib/security.js';
import {buildRequest,sendEmail} from '../lib/providers.js';
import {email,domain,parseEmailList} from '../lib/validation.js';
test('credentials store as JSON and decrypt accurately',()=>{const a=encrypt({apiKey:'secret'});assert.deepEqual(decrypt(a),{apiKey:'secret'});});
test('session validates and expires',()=>{const s=session();assert.ok(validSession(s));assert.ok(!validSession('expired'));});

test('header and domain injection are rejected',()=>{assert.throws(()=>email('a@b.com\r\nBcc: x@y.com'));assert.throws(()=>domain('https://a.com'));assert.equal(email('A@Example.com'),'a@example.com');});
const payload={id:randomUUID(),from:'chima@example.com',fromName:'Chima',to:'reader@example.org',subject:'Hello',text:'Hello <world>',replyTo:'reply+abc@example.com',headers:{'In-Reply-To':'<parent@example.org>'}};
test('seven adapters build fixed HTTPS endpoints and provider-specific fields',()=>{for(const provider of ['brevo','resend','mailgun','elastic','gosend','maileroo','sequenzy']){const {url,init}=buildRequest(provider,{apiKey:'key',apiSecret:'secret',sendingDomain:'example.com'},payload,{});assert.ok(url.startsWith('https://'));assert.equal(init.method,'POST');if(provider!=='mailgun'){const b=JSON.parse(init.body);assert.ok(JSON.stringify(b).includes('reader@example.org'));if(provider==='maileroo')assert.equal(b.from.address,'chima@example.com');if(provider==='sequenzy'){assert.equal(b.replyTo,payload.replyTo);assert.ok(!('headers' in b));}if(provider==='gosend')assert.ok(!('headers' in b));}else assert.equal(init.body.get('h:In-Reply-To'),'<parent@example.org>');}});
test('provider 4xx is a clear rejection but 5xx is uncertain',async()=>{const original=global.fetch;try{for(const status of [400,429,500]){global.fetch=async()=>new Response('{}',{status});await assert.rejects(()=>sendEmail('resend',{apiKey:'key'},payload,{}),e=>e.uncertain===(status>=500));}}finally{global.fetch=original;}});
test('Neon quota reservations, failures, retries and billing cycles (messages stay in D1)',async()=>{
 const pg=new PGlite();await pg.exec(await readFile(new URL('../db/schema.sql',import.meta.url),'utf8'));
 const cid=randomUUID(),pid=randomUUID();
 await pg.query(`INSERT INTO connections(id,provider,label,domains,credentials,enabled,daily_limit,monthly_limit,provider_monthly_limit,connected_at,provider_anchor) VALUES($1,'resend','Resend','["example.com"]','encrypted',true,2,3,3,'2026-01-01T12:00:00Z','2026-01-01T12:00:00Z')`,[cid]);
 await pg.query(`INSERT INTO personas(id,name,email) VALUES($1,'Chima','chima@example.com')`,[pid]);
 const reserve=async id=>(await pg.query(`SELECT reserve_email($1,$2,$3,null,'a@example.org','Subject','Body','','{}',$4,null) AS result`,[cid,pid,id,randomUUID()])).rows[0].result;
 const a=randomUUID(),b=randomUUID();assert.equal((await reserve(a)).duplicate,false);assert.equal((await reserve(a)).duplicate,true);await reserve(b);await assert.rejects(()=>reserve(randomUUID()),/Quota reached/);
 await pg.query(`SELECT finish_email($1,'failed',null,null,'rejected')`,[a]);await pg.query(`SELECT finish_email($1,'failed',null,null,'rejected')`,[a]);
 const c=randomUUID();await reserve(c);assert.equal((await pg.query(`SELECT min(used) AS used FROM usage_counters`)).rows[0].used,2);
 await pg.query(`SELECT finish_email($1,'unknown',null,null,'timeout')`,[c]);await assert.rejects(()=>reserve(randomUUID()),/Quota reached/);
 const windows=(await pg.query(`SELECT quota_windows(c,'2026-01-31T12:00:00Z') AS w FROM connections c`)).rows[0].w;
 assert.equal(new Date(windows[1].start).toISOString(),'2026-01-31T12:00:00.000Z');
 assert.equal(new Date(windows[2].end).toISOString(),'2026-02-01T00:00:00.000Z');
 // Fresh daily window automatically uses another key, but the period remains capped.
 await pg.query(`UPDATE connections SET daily_limit=5,monthly_limit=2`);await assert.rejects(()=>reserve(randomUUID()),/30-day/);
 await pg.query(`UPDATE connections SET monthly_limit=100,provider_monthly_limit=2`);await assert.rejects(()=>reserve(randomUUID()),/provider-month/);
 await pg.query(`UPDATE connections SET provider_monthly_limit=100,daily_limit=3`);
 const concurrent=await Promise.allSettled([reserve(randomUUID()),reserve(randomUUID())]);assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);
 await pg.query(`UPDATE connections SET enabled=false`);await assert.rejects(()=>reserve(randomUUID()),/disabled/);
 assert.equal((await pg.query('SELECT count(*) AS n FROM email_reservations')).rows[0].n > 0,true);
 await pg.query(`UPDATE connections SET provider_cycle='billing',provider_anchor='2026-01-31T12:00:00Z'`);
 const billing=(await pg.query(`SELECT quota_windows(c,'2026-02-28T12:00:00Z') AS w FROM connections c`)).rows[0].w[2];
 assert.equal(new Date(billing.start).toISOString(),'2026-02-28T12:00:00.000Z');
 assert.equal(new Date(billing.end).toISOString(),'2026-03-31T12:00:00.000Z');
 await pg.query('DELETE FROM personas WHERE id=$1',[pid]);
 assert.equal((await pg.query('SELECT count(*) AS n FROM personas WHERE id=$1',[pid])).rows[0].n,0);
 await pg.query('DELETE FROM usage_counters WHERE key LIKE $1',[cid+':%']);
 await pg.query('DELETE FROM connections WHERE id=$1',[cid]);
 assert.equal((await pg.query('SELECT count(*) AS n FROM connections WHERE id=$1',[cid])).rows[0].n,0);

 const campId = randomUUID();
 await pg.query(`INSERT INTO campaigns(id,name,recipients) VALUES($1,'Beta Users','["alice@example.com","bob@example.com"]')`,[campId]);
 const msgId = randomUUID();
 await pg.query(`INSERT INTO campaign_messages(id,campaign_id,subject,text_body,total_recipients,status) VALUES($1,$2,'Welcome','Hello all',2,'completed')`,[msgId,campId]);
 assert.equal((await pg.query('SELECT count(*) AS n FROM campaigns WHERE id=$1',[campId])).rows[0].n,1);
 assert.equal((await pg.query('SELECT count(*) AS n FROM campaign_messages WHERE campaign_id=$1',[campId])).rows[0].n,1);
 await pg.query('DELETE FROM campaigns WHERE id=$1',[campId]);
 assert.equal((await pg.query('SELECT count(*) AS n FROM campaigns WHERE id=$1',[campId])).rows[0].n,0);
 assert.equal((await pg.query('SELECT count(*) AS n FROM campaign_messages WHERE campaign_id=$1',[campId])).rows[0].n,0);

 await pg.close();
});

test('parseEmailList validates, normalizes, deduplicates from various delimiters', () => {
 const input = `
   alice@example.com
   BOB@example.com, Charlie@Example.com;
   alice@example.com
   invalid-email
   dan@example.org
 `;
 const result = parseEmailList(input);
 assert.deepEqual(result, ['alice@example.com', 'bob@example.com', 'charlie@example.com', 'dan@example.org']);
 assert.deepEqual(parseEmailList(['test@a.com', 'TEST@A.COM']), ['test@a.com']);
 assert.deepEqual(parseEmailList(null), []);
});

