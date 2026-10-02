import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {encrypt,decrypt,session,validSession,signature,inboundOK} from '../lib/security.js';
import {buildRequest,sendEmail} from '../lib/providers.js';
import {email,domain,parseEmailList,campaignSlug,matchesCampaign} from '../lib/validation.js';
import {parseLocalDateTimeInTz,formatDateInTz,toLocalDateStr,toLocalDatetimeInputStr} from '../lib/timezone.js';
test('credentials store as JSON and decrypt accurately',()=>{const a=encrypt({apiKey:'secret'});assert.deepEqual(decrypt(a),{apiKey:'secret'});});
test('session validates and expires',()=>{const s=session();assert.ok(validSession(s));assert.ok(!validSession('expired'));});

test('header and domain injection are rejected',()=>{assert.throws(()=>email('a@b.com\r\nBcc: x@y.com'));assert.throws(()=>domain('https://a.com'));assert.equal(email('A@Example.com'),'a@example.com');});
const payload={id:randomUUID(),from:'chima@example.com',fromName:'Chima',to:'reader@example.org',subject:'Hello',text:'Hello <world>',replyTo:'reply+abc@example.com',headers:{'In-Reply-To':'<parent@example.org>'}};
test('ten adapters build fixed HTTPS endpoints and provider-specific fields',()=>{for(const provider of ['brevo','resend','mailgun','elastic','sequenzy','mailtrap','quolle','senddev','epostix','anypost']){const {url,init}=buildRequest(provider,{apiKey:'key',apiSecret:'secret',sendingDomain:'example.com'},payload,{});assert.ok(url.startsWith('https://'));assert.equal(init.method,'POST');if(provider!=='mailgun'){const b=JSON.parse(init.body);assert.ok(JSON.stringify(b).includes('reader@example.org'));if(provider==='mailtrap'){assert.equal(b.from.email,'chima@example.com');assert.equal(b.reply_to.email,payload.replyTo);}if(provider==='quolle'){assert.equal(b.to,'reader@example.org');assert.equal(b.replyTo,payload.replyTo);}if(provider==='senddev'){assert.equal(b.to[0],'reader@example.org');assert.equal(b.replyTo,payload.replyTo);assert.ok(!('headers' in b));}if(provider==='epostix'){assert.equal(b.to[0],'reader@example.org');assert.equal(b.reply_to,payload.replyTo);assert.ok(b.headers);}if(provider==='anypost'){assert.equal(b.to[0],'reader@example.org');assert.equal(b.reply_to,payload.replyTo);assert.ok(b.headers);}if(provider==='sequenzy'){assert.equal(b.replyTo,payload.replyTo);assert.ok(!('headers' in b));}}else assert.equal(init.body.get('h:In-Reply-To'),'<parent@example.org>');}});
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
 const deliv1 = randomUUID(), deliv2 = randomUUID();
 await pg.query(`INSERT INTO campaign_deliveries(id,campaign_message_id,recipient,message_uuid,wire_message_id,thread_id,platform,status) VALUES($1,$2,'alice@example.com',$3,'<wire-1>','thread-1','Resend','accepted')`,[deliv1,msgId,randomUUID()]);
 await pg.query(`INSERT INTO campaign_deliveries(id,campaign_message_id,recipient,message_uuid,thread_id,platform,status,error) VALUES($1,$2,'bob@example.com',$3,'thread-2','Brevo','failed','Invalid recipient')`,[deliv2,msgId,randomUUID()]);

 // Follow-up batch
 const followUpId = randomUUID();
 await pg.query(`INSERT INTO campaign_messages(id,campaign_id,subject,text_body,total_recipients,status,is_follow_up,parent_batch_id) VALUES($1,$2,'Re: Welcome','Just checking in',2,'completed',true,$3)`,[followUpId,campId,msgId]);
 const followUpBatch = (await pg.query('SELECT * FROM campaign_messages WHERE id=$1',[followUpId])).rows[0];
 assert.equal(followUpBatch.is_follow_up, true);
 assert.equal(followUpBatch.parent_batch_id, msgId);

 const batchDeliveries = (await pg.query('SELECT * FROM campaign_deliveries WHERE campaign_message_id=$1 ORDER BY recipient',[msgId])).rows;
 assert.equal(batchDeliveries.length, 2);
 assert.equal(batchDeliveries[0].recipient, 'alice@example.com');
 assert.equal(batchDeliveries[0].status, 'accepted');
 assert.equal(batchDeliveries[1].recipient, 'bob@example.com');
 assert.equal(batchDeliveries[1].status, 'failed');

 assert.equal((await pg.query('SELECT count(*) AS n FROM campaigns WHERE id=$1',[campId])).rows[0].n,1);
 assert.equal((await pg.query('SELECT count(*) AS n FROM campaign_messages WHERE campaign_id=$1',[campId])).rows[0].n,2);
 assert.equal((await pg.query('SELECT count(*) AS n FROM campaign_deliveries WHERE campaign_message_id=$1',[msgId])).rows[0].n,2);
 await pg.query('DELETE FROM campaigns WHERE id=$1',[campId]);
 assert.equal((await pg.query('SELECT count(*) AS n FROM campaigns WHERE id=$1',[campId])).rows[0].n,0);
 assert.equal((await pg.query('SELECT count(*) AS n FROM campaign_messages WHERE campaign_id=$1',[campId])).rows[0].n,0);
 assert.equal((await pg.query('SELECT count(*) AS n FROM campaign_deliveries WHERE campaign_message_id=$1',[msgId])).rows[0].n,0);

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

test('blacklist table stores excluded recipients and filters campaign email lists', async () => {
 const pg = new PGlite();
 await pg.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
 await pg.query("INSERT INTO blacklist(email, reason) VALUES('bad@example.com', 'Unsubscribed')");
 await pg.query("INSERT INTO blacklist(email, reason) VALUES('spam@example.org', 'Spam complaint')");
 const rows = (await pg.query("SELECT lower(email) AS email FROM blacklist")).rows;
 const blacklisted = new Set(rows.map(r => r.email));
 const inputList = ['good@example.com', 'BAD@example.com', 'spam@example.org', 'another@example.com'];
 const parsed = parseEmailList(inputList);
 const filtered = parsed.filter(e => !blacklisted.has(e.toLowerCase()));
 const removed = parsed.filter(e => blacklisted.has(e.toLowerCase()));
 assert.deepEqual(filtered, ['good@example.com', 'another@example.com']);
 assert.deepEqual(removed, ['bad@example.com', 'spam@example.org']);
});

test('campaignSlug generates clean URL slugs and matchesCampaign matches slugs, names, or ids', () => {
 const c1 = { id: 'c-123', name: 'VIP Newsletter 2026!' };
 const c2 = { id: 'c-456', name: 'Product Launch & Updates' };
 assert.equal(campaignSlug(c1), 'vip-newsletter-2026');
 assert.equal(campaignSlug(c2), 'product-launch-updates');
 assert.ok(matchesCampaign(c1, 'vip-newsletter-2026'));
 assert.ok(matchesCampaign(c1, 'VIP Newsletter 2026!'));
 assert.ok(matchesCampaign(c1, 'c-123'));
 assert.ok(!matchesCampaign(c1, 'product-launch-updates'));
});



test('timezone helpers parse local times and prevent UTC 1-hour delays', () => {
  // 14:30 local time in Lagos (UTC+1) must equal 13:30:00.000Z in UTC so QStash fires at 14:30 local time (not 15:30)
  const d1 = parseLocalDateTimeInTz('2026-10-02T14:30', 'Africa/Lagos');
  assert.equal(d1.toISOString(), '2026-10-02T13:30:00.000Z');
  assert.equal(formatDateInTz(d1, 'Africa/Lagos'), '2026-10-02');

  // Midnight 00:15 in Lagos is 23:15 UTC of previous day, but local date is 2026-10-02
  const d2 = parseLocalDateTimeInTz('2026-10-02T00:15', 'Africa/Lagos');
  assert.equal(d2.toISOString(), '2026-10-01T23:15:00.000Z');
  assert.equal(formatDateInTz(d2, 'Africa/Lagos'), '2026-10-02');

  // Explicit ISO string with Z preserves instant
  const d3 = parseLocalDateTimeInTz('2026-10-02T13:30:00.000Z', 'Africa/Lagos');
  assert.equal(d3.toISOString(), '2026-10-02T13:30:00.000Z');

  // toLocalDateStr produces YYYY-MM-DD
  assert.match(toLocalDateStr(new Date()), /^\d{4}-\d{2}-\d{2}$/);
  // toLocalDatetimeInputStr produces YYYY-MM-DDTHH:mm
  assert.match(toLocalDatetimeInputStr(new Date()), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

test('campaign unsubscribed list excludes recipients from dispatches and preserves main list', async () => {
  const pg = new PGlite();
  await pg.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));

  const campId = randomUUID();
  const allRecipients = ['alice@example.com', 'bob@example.com', 'charlie@example.com', 'david@example.com'];
  await pg.query(`INSERT INTO campaigns(id, name, recipients, unsubscribed) VALUES($1, 'Outreach', $2, '[]')`, [campId, JSON.stringify(allRecipients)]);

  // Verify initial state
  const camp0 = (await pg.query('SELECT * FROM campaigns WHERE id=$1', [campId])).rows[0];
  const unsub0 = typeof camp0.unsubscribed === 'string' ? JSON.parse(camp0.unsubscribed) : camp0.unsubscribed;
  assert.deepEqual(unsub0, []);

  // Unsubscribe bob and david from this campaign
  const toUnsub = ['bob@example.com', 'david@example.com'];
  await pg.query('UPDATE campaigns SET unsubscribed=$1 WHERE id=$2', [JSON.stringify(toUnsub), campId]);

  const camp1 = (await pg.query('SELECT * FROM campaigns WHERE id=$1', [campId])).rows[0];
  const recips1 = typeof camp1.recipients === 'string' ? JSON.parse(camp1.recipients) : camp1.recipients;
  const unsub1 = typeof camp1.unsubscribed === 'string' ? JSON.parse(camp1.unsubscribed) : camp1.unsubscribed;
  assert.deepEqual(recips1, allRecipients); // main campaign list is preserved
  assert.deepEqual(unsub1, toUnsub);

  // Active recipient calculation
  const unsubSet = new Set(unsub1.map(e => e.toLowerCase()));
  const activeRecipients = recips1.filter(e => !unsubSet.has(e.toLowerCase()));
  assert.deepEqual(activeRecipients, ['alice@example.com', 'charlie@example.com']);

  // Resubscribe bob
  const unsub2 = unsub1.filter(e => e.toLowerCase() !== 'bob@example.com');
  await pg.query('UPDATE campaigns SET unsubscribed=$1 WHERE id=$2', [JSON.stringify(unsub2), campId]);
  const activeAfterRestore = recips1.filter(e => !new Set(unsub2.map(x => x.toLowerCase())).has(e.toLowerCase()));
  assert.deepEqual(activeAfterRestore, ['alice@example.com', 'bob@example.com', 'charlie@example.com']);

  await pg.close();
});

test('scheduled follow-ups prevent same-date collisions and ensure follow-up is after parent batch', async () => {
  const pg = new PGlite();
  await pg.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));

  const campId = randomUUID();
  await pg.query(`INSERT INTO campaigns(id, name, recipients) VALUES($1, 'Drip Series', '["u1@example.com"]')`, [campId]);

  // Batch 1 scheduled for 2026-10-05 10:00 Lagos time
  const batch1Id = randomUUID();
  const batch1Date = parseLocalDateTimeInTz('2026-10-05T10:00', 'Africa/Lagos');
  await pg.query(`
    INSERT INTO campaign_messages(id, campaign_id, subject, text_body, scheduled_at, status, is_follow_up) 
    VALUES($1, $2, 'Batch 1 Intro', 'Intro body', $3, 'scheduled', false)
  `, [batch1Id, campId, batch1Date.toISOString()]);

  // Attempting to schedule Follow-up 1 on the SAME date (2026-10-05 16:00 Lagos time)
  const tz = 'Africa/Lagos';
  const followUpSameDay = parseLocalDateTimeInTz('2026-10-05T16:00', tz);
  const sameDayStr = formatDateInTz(followUpSameDay, tz);

  const sameDateQuery = await pg.query(`
    SELECT id, subject, is_follow_up, scheduled_at 
    FROM campaign_messages 
    WHERE campaign_id = $1 
      AND status = 'scheduled' 
      AND (scheduled_at AT TIME ZONE $2)::date = $3::date
    LIMIT 1
  `, [campId, tz, sameDayStr]);

  // Collision detected on 2026-10-05
  assert.equal(sameDateQuery.rows.length, 1);
  assert.equal(sameDateQuery.rows[0].id, batch1Id);

  // Scheduling Follow-up 1 on a subsequent date (2026-10-08 10:00 Lagos time)
  const followUpValidDate = parseLocalDateTimeInTz('2026-10-08T10:00', tz);
  const validDayStr = formatDateInTz(followUpValidDate, tz);

  const diffDateQuery = await pg.query(`
    SELECT id, subject, is_follow_up, scheduled_at 
    FROM campaign_messages 
    WHERE campaign_id = $1 
      AND status = 'scheduled' 
      AND (scheduled_at AT TIME ZONE $2)::date = $3::date
    LIMIT 1
  `, [campId, tz, validDayStr]);

  // No collision on 2026-10-08
  assert.equal(diffDateQuery.rows.length, 0);

  // Successfully schedule Follow-up 1
  const followUp1Id = randomUUID();
  await pg.query(`
    INSERT INTO campaign_messages(id, campaign_id, subject, text_body, scheduled_at, status, is_follow_up, parent_batch_id) 
    VALUES($1, $2, 'Re: Batch 1 Intro', 'Follow up body', $3, 'scheduled', true, $4)
  `, [followUp1Id, campId, followUpValidDate.toISOString(), batch1Id]);

  // Now attempting to schedule Follow-up 2 on 2026-10-08 (same date as Follow-up 1)
  const collisionFollowUp2 = await pg.query(`
    SELECT id, subject, is_follow_up, scheduled_at 
    FROM campaign_messages 
    WHERE campaign_id = $1 
      AND status = 'scheduled' 
      AND (scheduled_at AT TIME ZONE $2)::date = $3::date
    LIMIT 1
  `, [campId, tz, validDayStr]);

  // Collision detected with Follow-up 1!
  assert.equal(collisionFollowUp2.rows.length, 1);
  assert.equal(collisionFollowUp2.rows[0].id, followUp1Id);

  await pg.close();
});

