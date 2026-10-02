import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { db, ensureCampaignTables } from '../../../lib/db.js';
import { decrypt, encrypt, equal, passwordOK, session, validSession } from '../../../lib/security.js';
import { providers } from '../../../lib/catalog.js';
import { buildRequest, inspectDomain, sendEmail } from '../../../lib/providers.js';
import { domain, email, fail, line, limit, uuid, parseEmailList } from '../../../lib/validation.js';
import { messageStore } from '../../../lib/d1.js';
import { Client as QStashClient, Receiver as QStashReceiver } from '@upstash/qstash';
import { dispatchCampaignMessage } from '../../../lib/campaign-dispatcher.js';
import { DEFAULT_TIMEZONE, parseLocalDateTimeInTz, formatDateInTz } from '../../../lib/timezone.js';
import { isFcmConfigured, getPublicFcmConfig, sendFcmPushToAll } from '../../../lib/fcm.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const json = (v, status = 200) => NextResponse.json(v, { status });
const clean = html => sanitizeHtml(html || '', { allowedTags: ['p','br','b','strong','em','i','ul','ol','li','blockquote','pre','h1','h2','h3','table','tbody','tr','td','th','a','hr'], allowedAttributes: { a: ['href','title'] }, allowedSchemes: ['https','http','mailto'] });
async function readBody(req, max = 400000) { const reader = req.body?.getReader(); if (!reader) return ''; let size = 0; const chunks = []; for (; ;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) { await reader.cancel(); fail('Message too large', 413); } chunks.push(Buffer.from(value)); } return Buffer.concat(chunks).toString('utf8'); }
async function authenticated(req) { if (!validSession((await cookies()).get('session')?.value)) fail('Sign in required', 401); }

async function getCapacityForDate(sql, dateObj, tz = DEFAULT_TIMEZONE) {
    const connections = await sql`SELECT id, provider, daily_limit FROM connections WHERE provider<>'cloudflare' AND enabled=true`;
    if (!connections.length) return 0;
    let totalDailyCapacity = 0;
    for (const c of connections) {
        const limitVal = (c.daily_limit !== null && c.daily_limit !== undefined) 
            ? Number(c.daily_limit) 
            : (providers[c.provider]?.daily || 100000);
        totalDailyCapacity += limitVal;
    }
    const dateStr = formatDateInTz(dateObj, tz);
    const todayStr = formatDateInTz(new Date(), tz);
    const [scheduledRow] = await sql`
        SELECT COALESCE(SUM(total_recipients), 0)::int as booked
        FROM campaign_messages
        WHERE status IN ('scheduled', 'sending', 'completed')
          AND (scheduled_at AT TIME ZONE ${tz})::date = ${dateStr}::date
    `;
    let booked = scheduledRow?.booked || 0;
    if (dateStr === todayStr) {
        const usageRows = await sql`
            SELECT c.id, w.value || jsonb_build_object('used', coalesce(u.used, 0)) AS window 
            FROM connections c 
            CROSS JOIN LATERAL jsonb_array_elements(quota_windows(c)) w 
            LEFT JOIN usage_counters u ON u.key = c.id::text || ':' || (w.value->>'name') || ':' || (w.value->>'start') 
            WHERE c.provider<>'cloudflare' AND c.enabled=true
        `;
        let sentToday = 0;
        for (const c of connections) {
            const cWindows = usageRows.filter(r => r.id === c.id).map(r => r.window);
            const dayW = cWindows.find(w => w.name === 'day');
            sentToday += dayW?.used || 0;
        }
        booked = Math.max(booked, sentToday);
    }
    return Math.max(0, totalDailyCapacity - booked);
}
async function getDailyAvailableCapacity(sql) {
    const connections = await sql`SELECT id, provider, daily_limit FROM connections WHERE provider<>'cloudflare' AND enabled=true`;
    if (!connections.length) return 0;
    const usageRows = await sql`
        SELECT c.id, w.value || jsonb_build_object('used', coalesce(u.used, 0)) AS window 
        FROM connections c 
        CROSS JOIN LATERAL jsonb_array_elements(quota_windows(c)) w 
        LEFT JOIN usage_counters u ON u.key = c.id::text || ':' || (w.value->>'name') || ':' || (w.value->>'start') 
        WHERE c.provider<>'cloudflare' AND c.enabled=true
    `;
    let total = 0;
    for (const c of connections) {
        const cWindows = usageRows.filter(r => r.id === c.id).map(r => r.window);
        const dayW = cWindows.find(w => w.name === 'day');
        const limitVal = (c.daily_limit !== null && c.daily_limit !== undefined) ? Number(c.daily_limit) : (providers[c.provider]?.daily || 100000);
        const used = dayW?.used || 0;
        total += Math.max(0, limitVal - used);
    }
    return total;
}
async function state() {
    const sql = db();
    await ensureCampaignTables(sql);
    const connections = await sql`SELECT id,provider,label,domains,settings,enabled,connected_at,daily_limit,monthly_limit,provider_monthly_limit,provider_cycle,provider_anchor FROM connections ORDER BY provider`;
    const usage = await sql`SELECT c.id,w.value || jsonb_build_object('used',coalesce(u.used,0)) AS window FROM connections c CROSS JOIN LATERAL jsonb_array_elements(quota_windows(c)) w LEFT JOIN usage_counters u ON u.key=c.id::text||':'||(w.value->>'name')||':'||(w.value->>'start') WHERE c.provider<>'cloudflare'`;
    const campaigns = await sql`SELECT * FROM campaigns ORDER BY created_at DESC`;
    const campaignMessages = await sql`SELECT * FROM campaign_messages ORDER BY created_at DESC`;
    const campaignsWithMessages = campaigns.map(c => ({
        ...c,
        recipients: Array.isArray(c.recipients) ? c.recipients : JSON.parse(c.recipients || '[]'),
        unsubscribed: Array.isArray(c.unsubscribed) ? c.unsubscribed : JSON.parse(c.unsubscribed || '[]'),
        messages: campaignMessages.filter(m => m.campaign_id === c.id)
    }));
    const dailyCapacity = await getDailyAvailableCapacity(sql);
    const activeSenders = connections.filter(c => c.provider !== 'cloudflare' && c.enabled);
    const totalDailyCapacity = activeSenders.reduce((n, c) => n + ((c.daily_limit !== null && c.daily_limit !== undefined) ? Number(c.daily_limit) : (providers[c.provider]?.daily || 0)), 0);
    const scheduledBroadcasts = campaignMessages.filter(m => m.status === 'scheduled');
    let fcmTokensCount = 0;
    try {
        const [fcmRow] = await sql`SELECT count(*)::int as count FROM fcm_tokens`;
        fcmTokensCount = fcmRow?.count || 0;
    } catch {}
    return {
        connections: connections.map(c => ({ ...c, usage: usage.filter(u => u.id === c.id).map(u => u.window) })),
        personas: await sql`SELECT * FROM personas ORDER BY name`,
        campaigns: campaignsWithMessages,
        dailyCapacity,
        totalDailyCapacity,
        scheduledBroadcasts,
        blacklist: await sql`SELECT * FROM blacklist ORDER BY created_at DESC`,
        fcm: {
            configured: isFcmConfigured(),
            publicConfig: getPublicFcmConfig(),
            registeredCount: fcmTokensCount
        },
        providers
    };
}
async function webhook(provider, req, raw) {
    const sql = db(); const [c] = await sql`SELECT * FROM connections WHERE provider=${provider}`; if (!c) fail('Unknown webhook', 404);
    const credentials = decrypt(c.credentials); if (!credentials.webhookSecret) fail('Webhook disabled', 403);
    let event, id, status;
    if (provider === 'resend') {
        const timestamp = req.headers.get('svix-timestamp'), eventId = req.headers.get('svix-id');
        if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) fail('Expired signature', 401);
        const key = Buffer.from(credentials.webhookSecret.replace(/^whsec_/, ''), 'base64');
        const expected = createHmac('sha256', key).update(`${eventId}.${timestamp}.${raw}`).digest('base64');
        if (!(req.headers.get('svix-signature') || '').split(' ').some(s => equal(s, `v1,${expected}`))) fail('Invalid signature', 401);
        event = JSON.parse(raw); id = event.data?.email_id; status = ({ 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.complained': 'complained', 'email.failed': 'failed-delivery' })[event.type];
    } else if (provider === 'mailgun') {
        event = JSON.parse(raw); const s = event.signature || {};
        if (Math.abs(Date.now() / 1000 - Number(s.timestamp)) > 300 || !equal(createHmac('sha256', credentials.webhookSecret).update(`${s.timestamp}${s.token}`).digest('hex'), s.signature || '')) fail('Invalid signature', 401);
        const e = event['event-data']; id = e?.message?.headers?.['message-id']; status = ({ delivered: 'delivered', complained: 'complained', failed: e?.severity === 'permanent' ? 'bounced' : undefined })[e?.event];
    } else fail('Webhook not supported', 404);
    if (id && status) await messageStore('webhookUpdate',{connectionId:c.id,providerId:id,status});
    return json({ ok: true });
}
async function handler(req, { params }) {
    try {
        const path = (await params).path.join('/');
        if (req.method === 'POST' && path.startsWith('webhooks/')) return await webhook(path.split('/')[1], req, await readBody(req));
        if (req.method === 'POST' && path === 'campaigns/trigger-scheduled') {
            const raw = await readBody(req);
            if (process.env.QSTASH_CURRENT_SIGNING_KEY) {
                const receiver = new QStashReceiver({
                    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
                    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || process.env.QSTASH_CURRENT_SIGNING_KEY,
                });
                const sig = req.headers.get("Upstash-Signature") || req.headers.get("upstash-signature");
                const valid = await receiver.verify({
                    signature: sig,
                    body: raw,
                    url: req.url,
                }).catch(() => false);
                if (!valid) fail('Invalid QStash signature', 401);
            }
            const body = JSON.parse(raw);
            const sql = db();
            await ensureCampaignTables(sql);
            const campaignMessageId = uuid(body.campaignMessageId);
            const [cm] = await sql`SELECT status FROM campaign_messages WHERE id=${campaignMessageId}`;
            if (!cm || cm.status !== 'scheduled') {
                return json({ ok: true, skipped: true, status: cm?.status || 'not-found' });
            }
            let triggerDevFired = false;
            try {
                const { tasks } = await import('@trigger.dev/sdk');
                if (tasks?.trigger) {
                    await tasks.trigger("campaign-mail-sender", { campaignMessageId });
                    triggerDevFired = true;
                }
            } catch {}
            if (!triggerDevFired) {
                await dispatchCampaignMessage({ campaignMessageId, sql });
            }
            return json({ ok: true });
        }
        if (req.method === 'POST' && path === 'inbound/notify') {
            const raw = await readBody(req);
            const secret = process.env.INBOUND_SECRET;
            if (secret) {
                const timestamp = req.headers.get('x-timestamp');
                const signature = req.headers.get('x-signature');
                if (!timestamp || !signature) fail('Missing signature', 401);
                if (Math.abs(Date.now() - Number(timestamp)) > 300000) fail('Expired signature', 401);
                const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
                if (!equal(signature, expected)) fail('Invalid signature', 401);
            }
            let data = {};
            try { data = JSON.parse(raw); } catch {}
            const sender = data.fromName ? `${data.fromName} <${data.from}>` : (data.from || 'Someone');
            const title = `New email from ${sender}`;
            const body = data.subject ? `Subject: ${data.subject}` : (data.snippet || 'You received a new email.');
            const sql = db();
            await ensureCampaignTables(sql);
            const dispatched = await sendFcmPushToAll({
                title,
                body,
                url: '/mailbox',
                tag: `inbound-${Date.now()}`,
                sql
            });
            return json({ ok: true, dispatched });
        }
        if (req.method === 'POST' && path === 'login') {
            const body = JSON.parse(await readBody(req, 2000));
            if (!passwordOK(body.password, body.email)) fail('Incorrect email or password', 401);
            (await cookies()).set('session', session(), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 43200 });
            return json({ ok: true });
        }

        await authenticated(req);
        if (req.method === 'GET' && path === 'state') return json(await state());
        if (req.method === 'GET' && path === 'campaigns/batch-details') {
            const sql = db();
            await ensureCampaignTables(sql);
            const url = new URL(req.url);
            const batchId = uuid(url.searchParams.get('id'));
            const [batch] = await sql`
                SELECT cm.*, c.name as campaign_name, p.name as persona_name, p.email as persona_email
                FROM campaign_messages cm
                JOIN campaigns c ON c.id = cm.campaign_id
                LEFT JOIN personas p ON p.id = cm.persona_id
                WHERE cm.id = ${batchId}
            `;
            if (!batch) fail('Batch not found', 404);
            const deliveries = await sql`
                SELECT id, recipient, platform, status, error, wire_message_id, thread_id, created_at
                FROM campaign_deliveries
                WHERE campaign_message_id = ${batchId}
                ORDER BY created_at ASC
            `;
            return json({ batch, deliveries });
        }
        if (req.method === 'GET' && path === 'campaigns/calendar') {
            const sql = db();
            await ensureCampaignTables(sql);
            const url = new URL(req.url);
            const now = new Date();
            const tz = url.searchParams.get('timezone') || process.env.TIMEZONE || DEFAULT_TIMEZONE;
            const year = parseInt(url.searchParams.get('year') || String(now.getFullYear()), 10);
            const month = parseInt(url.searchParams.get('month') || String(now.getMonth() + 1), 10);
            
            const startDate = parseLocalDateTimeInTz(`${year}-${String(month).padStart(2, '0')}-01T00:00:00`, tz);
            const nextY = month === 12 ? year + 1 : year;
            const nextM = month === 12 ? 1 : month + 1;
            const endDate = parseLocalDateTimeInTz(`${nextY}-${String(nextM).padStart(2, '0')}-01T00:00:00`, tz);
            
            const connections = await sql`SELECT id, provider, daily_limit FROM connections WHERE provider<>'cloudflare' AND enabled=true`;
            let totalDailyCapacity = 0;
            for (const c of connections) {
                const limitVal = (c.daily_limit !== null && c.daily_limit !== undefined) 
                    ? Number(c.daily_limit) 
                    : (providers[c.provider]?.daily || 100000);
                totalDailyCapacity += limitVal;
            }
            const broadcasts = await sql`
                SELECT cm.*, c.name as campaign_name, p.name as persona_name, p.email as persona_email
                FROM campaign_messages cm
                JOIN campaigns c ON c.id = cm.campaign_id
                LEFT JOIN personas p ON p.id = cm.persona_id
                WHERE cm.scheduled_at >= ${startDate.toISOString()} AND cm.scheduled_at < ${endDate.toISOString()}
                ORDER BY cm.scheduled_at ASC
            `;
            const daysInMonth = new Date(Date.UTC(year, month, 0)).getDate();
            const daysData = {};
            for (let day = 1; day <= daysInMonth; day++) {
                const dayStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                daysData[dayStr] = {
                    date: dayStr,
                    day,
                    totalCapacity: totalDailyCapacity,
                    bookedEmails: 0,
                    availableCapacity: totalDailyCapacity,
                    broadcasts: []
                };
            }
            for (const b of broadcasts) {
                const dateKey = formatDateInTz(b.scheduled_at, tz);
                if (daysData[dateKey]) {
                    daysData[dateKey].broadcasts.push(b);
                    if (['scheduled', 'sending', 'completed'].includes(b.status)) {
                        daysData[dateKey].bookedEmails += b.total_recipients || 0;
                    }
                }
            }
            for (const key of Object.keys(daysData)) {
                daysData[key].availableCapacity = Math.max(0, daysData[key].totalCapacity - daysData[key].bookedEmails);
            }
            return json({
                year,
                month,
                timezone: tz,
                totalDailyCapacity,
                days: daysData
            });
        }
        if (req.method === 'GET' && path === 'blacklist') {
            const sql = db();
            await ensureCampaignTables(sql);
            const rows = await sql`SELECT * FROM blacklist ORDER BY created_at DESC`;
            return json({ blacklist: rows });
        }
        if (req.method === 'GET' && path === 'messages') {
            const url = new URL(req.url), thread = url.searchParams.get('thread'), folder = url.searchParams.get('folder') === 'sent' ? 'out' : 'in';
            const offset = Math.max(0, Math.min(100000, Number(url.searchParams.get('offset')) || 0));
            const rows=await messageStore('messages',{thread:thread?uuid(thread):null,folder,offset});
            return json(thread?rows.map(m=>({...m,html_body:clean(m.html_body)})):rows);
        }
        if (path === 'notifications/test') {
            const sql = db();
            await ensureCampaignTables(sql);
            const result = await sendFcmPushToAll({
                title: '🔔 Test Push Notification',
                body: 'Firebase Cloud Messaging push is working seamlessly with EmailSender!',
                url: '/mailbox',
                tag: 'fcm-test',
                sql
            });
            return json({ ok: true, result });
        }
        if (req.method !== 'POST') fail('Not found', 404);
        if (path === 'logout') { (await cookies()).delete('session'); return json({ ok: true }); }
        const raw = await readBody(req);
        const p = raw ? JSON.parse(raw) : {};
        const sql = db();
        if (path === 'notifications/register') {
            const token = line(p.token, 'token', 1000);
            const userAgent = typeof p.userAgent === 'string' ? p.userAgent.slice(0, 500) : null;
            await ensureCampaignTables(sql);
            await sql`
                INSERT INTO fcm_tokens (token, user_agent, updated_at)
                VALUES (${token}, ${userAgent}, now())
                ON CONFLICT (token) DO UPDATE SET
                    user_agent = EXCLUDED.user_agent,
                    updated_at = now()
            `;
            return json({ ok: true });
        }
        if (path === 'notifications/unregister') {
            const token = line(p.token, 'token', 1000);
            await ensureCampaignTables(sql);
            await sql`DELETE FROM fcm_tokens WHERE token = ${token}`;
            return json({ ok: true });
        }
        if (path === 'personas' || path === 'personas/delete') {
            if (path === 'personas/delete' || p.action === 'delete') {
                const id = uuid(p.id);
                await messageStore('clearPersona',{id});
                await sql`DELETE FROM personas WHERE id=${id}`;
                return json({ ok: true });
            }
            const name = line(p.name, 'name', 100), address = email(p.email);
            if (/[<>"\\]/.test(name)) fail('Name cannot contain angle brackets, quotes or backslashes');
            await sql`INSERT INTO personas(name,email) VALUES(${name},${address}) ON CONFLICT(email) DO UPDATE SET name=excluded.name`;
            return json({ ok: true });
        }
        if (path === 'connections' || path === 'connections/delete') {
            if (path === 'connections/delete' || p.action === 'delete') {
                const id = uuid(p.id);
                try { await sql`UPDATE messages SET connection_id=NULL WHERE connection_id=${id}`; } catch {}
                await sql`DELETE FROM usage_counters WHERE key LIKE ${id + ':%'}`;
                await sql`DELETE FROM connections WHERE id=${id}`;
                return json({ ok: true });
            }

            if (!providers[p.provider]) fail('Unsupported provider');
            const [old] = await sql`SELECT * FROM connections WHERE provider=${p.provider}`;

            const creds = old ? decrypt(old.credentials) : {};
            for (const k of providers[p.provider].fields) if (typeof p.credentials?.[k] === 'string' && p.credentials[k].trim()) creds[k] = line(p.credentials[k], k, 2000);
            if (p.provider !== 'cloudflare' && !creds.apiKey) fail('API key required');
            if (p.provider === 'mailgun') creds.sendingDomain = domain(creds.sendingDomain);
            const domains = [...new Set(String(p.domains || '').split(',').map(x => domain(x.trim())))];
            const settings = { region: p.region === 'eu' ? 'eu' : 'us' };
            const cycle = ['calendar', '30days', 'billing'].includes(p.providerCycle) ? p.providerCycle : 'calendar';
            const anchor = p.providerAnchor ? new Date(p.providerAnchor) : new Date(); if (!Number.isFinite(anchor.getTime()) || anchor > new Date()) fail('Provider period start must not be in the future');
            const anchorISO = anchor.toISOString();
            if (old) {
                // Never reset activation date or quota period settings on credential edits.
                // Provider billing anchors are immutable after activation to avoid resetting usage.
                if (old.enabled && (cycle !== old.provider_cycle || anchorISO !== new Date(old.provider_anchor).toISOString())) fail('Pause the connection before changing provider period settings');
                await sql`UPDATE connections SET label=${line(p.label || providers[p.provider].name, 'label')},credentials=${encrypt(creds)},domains=${JSON.stringify(domains)}::jsonb,settings=${JSON.stringify(settings)}::jsonb,enabled=${!!p.enabled},daily_limit=${limit(p.dailyLimit)},monthly_limit=${limit(p.monthlyLimit)},provider_monthly_limit=${limit(p.providerMonthlyLimit)},provider_cycle=${cycle},provider_anchor=${anchorISO} WHERE id=${old.id}`;
            } else await sql`INSERT INTO connections(provider,label,credentials,domains,settings,enabled,daily_limit,monthly_limit,provider_monthly_limit,provider_cycle,provider_anchor) VALUES(${p.provider},${line(p.label || providers[p.provider].name, 'label')},${encrypt(creds)},${JSON.stringify(domains)}::jsonb,${JSON.stringify(settings)}::jsonb,${!!p.enabled},${limit(p.dailyLimit)},${limit(p.monthlyLimit)},${limit(p.providerMonthlyLimit)},${cycle},${anchorISO})`;
            return json({ ok: true });
        }
        if (path === 'inspect') { const [c] = await sql`SELECT * FROM connections WHERE id=${uuid(p.id)}`; if (!c) fail('Connection missing', 404); return json(await inspectDomain(c.provider, decrypt(c.credentials), c.domains[0], c.settings)); }
        if (path === 'read') { await messageStore('markRead',{thread:uuid(p.thread)}); return json({ ok: true }); }
        if (path === 'link') { await messageStore('link',{id:uuid(p.id),target:uuid(p.target)}); return json({ ok: true }); }
        if (path === 'reconcile') {
            if (!['accepted', 'failed'].includes(p.status)) fail('Invalid status');
            const id=uuid(p.id), message=await messageStore('messageById',{id});
            if(!message) fail('Message not found',404);
            await sql`SELECT finish_email(${id},${p.status},${p.providerId||null},${p.messageId||null},'Manually reconciled against provider logs')`;
            await messageStore('updateMessage',{id,status:p.status==='failed'?'failed':'accepted',provider_id:p.providerId?line(p.providerId,'Provider ID'):null,message_id:p.messageId?line(p.messageId,'Message-ID',300):null,error:p.status==='failed'?'Confirmed against provider logs':null});
            return json({ ok: true });
        }
        if (path === 'send') {
            const id = uuid(p.id), recipient = email(p.to), subject = line(p.subject, 'subject');
            if (typeof p.text !== 'string' || !p.text.trim() || p.text.length > 100000) fail('Message body is required (maximum 100,000 characters)');
            const existing = await messageStore('messageById',{id}); if (existing) return json({ id, status: existing.status, duplicate: true });
            const [c] = await sql`SELECT * FROM connections WHERE id=${uuid(p.connectionId)}`;
            const [persona] = await sql`SELECT * FROM personas WHERE id=${uuid(p.personaId)}`;
            if (!c || !persona) fail('Choose a persona and connection');
            let parent; if (p.parentId) { parent = await messageStore('messageById',{id:uuid(p.parentId)}); if (!parent) fail('Parent message missing'); }
            if ((await messageStore('suppressed',{email:recipient})).blocked) fail('Recipient suppressed after a bounce or complaint');
            const token = randomBytes(16).toString('hex'), senderDomain = persona.email.split('@')[1];
            const [inbound] = await sql`SELECT id FROM connections WHERE provider='cloudflare' AND enabled AND domains ? ${senderDomain}`;
            const replyTo = inbound ? `reply+${token}@${senderDomain}` : persona.email;
            const hdr = {}; if (parent?.message_id) { hdr['In-Reply-To'] = parent.message_id; hdr.References = [...(parent.headers?.references || []), parent.message_id].slice(-5).join(' '); }
            // Do not invent a wire Message-ID: providers can rewrite it. Correlation uses the unique reply address.
            const payload = { id, from: persona.email, fromName: persona.name, to: recipient, subject, text: p.text, html: '', replyTo, headers: hdr };
            const credentials = decrypt(c.credentials); buildRequest(c.provider, credentials, payload, c.settings);
            const [reservation] = await sql`SELECT reserve_email(${c.id},${persona.id},${id},${parent?.id || null},${recipient},${subject},${p.text},'',${JSON.stringify(hdr)}::jsonb,${token},null) AS result`;
            if (reservation.result.duplicate) return json({ id, ...reservation.result });
            const reservationKeys=reservation.result.reservation||[];
            const threadId=parent?.thread_id||id;
            try {
                await messageStore('insertOutbound',{message:{id,connection_id:c.id,persona_id:persona.id,thread_id:threadId,parent_id:parent?.id||null,from_email:persona.email,from_name:persona.name,to_email:recipient,subject,text_body:p.text,html_body:'',headers:hdr,message_id:null,reply_token:token,status:'sending',reservation:reservationKeys}});
            } catch(e) {
                await sql`SELECT finish_email(${id},'failed',null,null,${e.message})`;
                throw e;
            }
            let outcome;
            try { outcome = await sendEmail(c.provider, credentials, payload, c.settings); }
            catch (e) {
                const status = e.uncertain === false ? 'failed' : 'unknown';
                await sql`SELECT finish_email(${id},${status},null,null,${e.message})`;
                await messageStore('updateMessage',{id,status,error:e.message});
                return json({ id, status, error: e.message }, status === 'failed' ? 400 : 202);
            }
            // If this write fails the reservation remains 'sending'; reconcile, never blindly resend.
            await sql`SELECT finish_email(${id},'accepted',${outcome.providerId},${outcome.messageId},null)`;
            await messageStore('updateMessage',{id,status:'accepted',provider_id:outcome.providerId,message_id:outcome.messageId});
            return json({ id, status: 'accepted' });
        }
        if (path === 'blacklist' || path === 'blacklist/delete') {
            await ensureCampaignTables(sql);
            if (path === 'blacklist/delete' || p.action === 'delete') {
                if (p.id) {
                    const id = uuid(p.id);
                    await sql`DELETE FROM blacklist WHERE id=${id}`;
                } else if (p.email) {
                    const e = email(p.email);
                    await sql`DELETE FROM blacklist WHERE lower(email)=lower(${e})`;
                } else {
                    fail('ID or email required to delete from blacklist', 400);
                }
                return json({ ok: true });
            }
            const reason = p.reason ? line(p.reason, 'reason', 255) : 'Manual addition';
            const rawInput = p.emails || p.email || [];
            const parsedEmails = parseEmailList(rawInput);
            if (!parsedEmails.length) fail('Please provide at least one valid email to blacklist', 400);
            for (const e of parsedEmails) {
                await sql`
                    INSERT INTO blacklist(email, reason) 
                    VALUES(${e}, ${reason}) 
                    ON CONFLICT(email) DO UPDATE SET reason=COALESCE(excluded.reason, blacklist.reason)
                `;
            }
            const updatedList = await sql`SELECT * FROM blacklist ORDER BY created_at DESC`;
            return json({ ok: true, addedCount: parsedEmails.length, blacklist: updatedList });
        }
        if (path === 'campaigns' || path === 'campaigns/delete') {
            await ensureCampaignTables(sql);
            if (path === 'campaigns/delete' || p.action === 'delete') {
                const id = uuid(p.id);
                await sql`DELETE FROM campaigns WHERE id=${id}`;
                return json({ ok: true });
            }
            if (p.action === 'update') {
                const id = uuid(p.id);
                const [existing] = await sql`SELECT * FROM campaigns WHERE id=${id}`;
                if (!existing) fail('Campaign not found', 404);
                const name = p.name !== undefined ? line(p.name, 'name', 100) : existing.name;
                let recipients = Array.isArray(existing.recipients) ? existing.recipients : JSON.parse(existing.recipients || '[]');
                let blacklistedFound = [];
                if (p.recipients !== undefined) {
                    const parsed = parseEmailList(p.recipients);
                    if (!parsed.length) fail('Please provide at least one valid recipient email address', 400);
                    const blacklistedRows = await sql`SELECT lower(email) AS email FROM blacklist`;
                    const blacklistedSet = new Set(blacklistedRows.map(r => r.email.toLowerCase()));
                    blacklistedFound = parsed.filter(e => blacklistedSet.has(e.toLowerCase()));
                    recipients = parsed.filter(e => !blacklistedSet.has(e.toLowerCase()));
                    if (!recipients.length) {
                        fail(`All ${parsed.length} recipient email(s) were excluded because they are in the blacklist.`, 400);
                    }
                    const available = await getDailyAvailableCapacity(sql);
                    if (recipients.length > available) {
                        fail(`Cannot update campaign: List contains ${recipients.length} emails, but available daily sending capacity across all active platforms is only ${available}. Please increase platform daily limits or reduce list size.`, 400);
                    }
                }
                const [updated] = await sql`UPDATE campaigns SET name=${name}, recipients=${JSON.stringify(recipients)}::jsonb WHERE id=${id} RETURNING *`;
                return json({ ok: true, campaign: updated, blacklistedRemovedCount: blacklistedFound.length, blacklistedEmails: blacklistedFound });
            }
            const name = line(p.name, 'name', 100);
            const parsed = parseEmailList(p.recipients || p.emails || []);
            if (!parsed.length) fail('Please provide at least one valid recipient email address', 400);
            const blacklistedRows = await sql`SELECT lower(email) AS email FROM blacklist`;
            const blacklistedSet = new Set(blacklistedRows.map(r => r.email.toLowerCase()));
            const blacklistedFound = parsed.filter(e => blacklistedSet.has(e.toLowerCase()));
            const recipients = parsed.filter(e => !blacklistedSet.has(e.toLowerCase()));
            if (!recipients.length) {
                fail(`All ${parsed.length} recipient email(s) were excluded because they are in the blacklist.`, 400);
            }
            const available = await getDailyAvailableCapacity(sql);
            if (recipients.length > available) {
                fail(`Cannot create campaign: The list contains ${recipients.length} emails, but the total available daily sending capacity across all active platforms is only ${available}. Please increase your platform limits or reduce the list size.`, 400);
            }
            const [inserted] = await sql`INSERT INTO campaigns(name, recipients) VALUES(${name}, ${JSON.stringify(recipients)}::jsonb) RETURNING *`;
            return json({ ok: true, campaign: inserted, blacklistedRemovedCount: blacklistedFound.length, blacklistedEmails: blacklistedFound });
        }
        if (path === 'campaigns/cancel-schedule') {
            await ensureCampaignTables(sql);
            const id = uuid(p.id);
            const [cm] = await sql`SELECT * FROM campaign_messages WHERE id=${id}`;
            if (!cm) fail('Scheduled broadcast not found', 404);
            if (cm.status !== 'scheduled') fail(`Cannot cancel broadcast with status "${cm.status}"`, 400);

            if (cm.qstash_message_id && process.env.QSTASH_TOKEN) {
                try {
                    const qstash = new QStashClient({ token: process.env.QSTASH_TOKEN });
                    await qstash.messages.delete(cm.qstash_message_id);
                } catch (e) {
                    console.warn('Could not delete QStash message:', e.message);
                }
            }

            await sql`UPDATE campaign_messages SET status='cancelled', qstash_message_id=NULL WHERE id=${id}`;
            return json({ ok: true, cancelled: true });
        }
        if (path === 'campaigns/unsubscribe') {
            await ensureCampaignTables(sql);
            const campaignId = uuid(p.campaignId);
            const [campaign] = await sql`SELECT * FROM campaigns WHERE id=${campaignId}`;
            if (!campaign) fail('Campaign not found', 404);
            const rawEmails = parseEmailList(p.emails || p.email || []);
            if (!rawEmails.length) fail('Please provide valid email(s) to unsubscribe from this campaign', 400);

            const current = Array.isArray(campaign.unsubscribed) ? campaign.unsubscribed : JSON.parse(campaign.unsubscribed || '[]');
            const currentSet = new Set(current.map(e => e.toLowerCase()));
            const toAdd = rawEmails.filter(e => !currentSet.has(e.toLowerCase()));
            const updated = [...current, ...toAdd];

            const [saved] = await sql`UPDATE campaigns SET unsubscribed=${JSON.stringify(updated)}::jsonb WHERE id=${campaign.id} RETURNING *`;
            return json({
                ok: true,
                addedCount: toAdd.length,
                unsubscribed: updated,
                campaign: {
                    ...saved,
                    recipients: Array.isArray(saved.recipients) ? saved.recipients : JSON.parse(saved.recipients || '[]'),
                    unsubscribed: updated
                }
            });
        }
        if (path === 'campaigns/resubscribe') {
            await ensureCampaignTables(sql);
            const campaignId = uuid(p.campaignId);
            const [campaign] = await sql`SELECT * FROM campaigns WHERE id=${campaignId}`;
            if (!campaign) fail('Campaign not found', 404);
            const rawEmails = parseEmailList(p.emails || p.email || []);
            if (!rawEmails.length) fail('Please provide valid email(s) to resubscribe to this campaign', 400);

            const toRemoveSet = new Set(rawEmails.map(e => e.toLowerCase()));
            const current = Array.isArray(campaign.unsubscribed) ? campaign.unsubscribed : JSON.parse(campaign.unsubscribed || '[]');
            const updated = current.filter(e => !toRemoveSet.has(e.toLowerCase()));

            const [saved] = await sql`UPDATE campaigns SET unsubscribed=${JSON.stringify(updated)}::jsonb WHERE id=${campaign.id} RETURNING *`;
            return json({
                ok: true,
                removedCount: current.length - updated.length,
                unsubscribed: updated,
                campaign: {
                    ...saved,
                    recipients: Array.isArray(saved.recipients) ? saved.recipients : JSON.parse(saved.recipients || '[]'),
                    unsubscribed: updated
                }
            });
        }
        if (path === 'campaigns/send') {
            await ensureCampaignTables(sql);
            const campaignId = uuid(p.campaignId);
            const [campaign] = await sql`SELECT * FROM campaigns WHERE id=${campaignId}`;
            if (!campaign) fail('Campaign not found', 404);

            const rawRecipients = Array.isArray(campaign.recipients) ? campaign.recipients : JSON.parse(campaign.recipients || '[]');
            const unsubscribedList = Array.isArray(campaign.unsubscribed) ? campaign.unsubscribed : JSON.parse(campaign.unsubscribed || '[]');
            const unsubscribedSet = new Set(unsubscribedList.map(e => String(e).toLowerCase().trim()));

            const blacklistedRows = await sql`SELECT lower(email) AS email FROM blacklist`;
            const blacklistSet = new Set(blacklistedRows.map(r => r.email.toLowerCase().trim()));

            const recipients = rawRecipients.filter(e => {
                const lower = String(e).toLowerCase().trim();
                return !unsubscribedSet.has(lower) && !blacklistSet.has(lower);
            });
            if (!recipients.length) fail('No active recipients in this campaign (all recipients are either unsubscribed from this campaign or in the global blacklist)', 400);

            const subject = line(p.subject, 'subject');
            if (typeof p.text !== 'string' || !p.text.trim() || p.text.length > 100000) fail('Message body is required (maximum 100,000 characters)');

            const [persona] = await sql`SELECT * FROM personas WHERE id=${uuid(p.personaId)}`;
            if (!persona) fail('Choose a sender persona', 400);

            const isFollowUp = !!p.isFollowUp;
            const parentBatchId = p.parentBatchId ? uuid(p.parentBatchId) : null;
            if (isFollowUp && !parentBatchId) fail('Follow-up broadcast requires a parent batch ID', 400);

            let parentBatch = null;
            if (isFollowUp) {
                const [pb] = await sql`SELECT * FROM campaign_messages WHERE id=${parentBatchId}`;
                if (!pb) fail('Parent batch not found', 404);
                parentBatch = pb;
            }

            // Is this a scheduled broadcast?
            if (p.scheduledAt) {
                const tz = p.timezone || req.headers.get('x-timezone') || process.env.TIMEZONE || DEFAULT_TIMEZONE;
                const scheduledDate = parseLocalDateTimeInTz(p.scheduledAt, tz);
                if (!scheduledDate || isNaN(scheduledDate.getTime())) fail('Invalid scheduled date/time', 400);
                if (scheduledDate.getTime() <= Date.now() + 30000) fail('Scheduled time must be at least 30 seconds in the future', 400);

                // If parent batch is scheduled, ensure follow-up is scheduled AFTER parent
                if (isFollowUp && parentBatch?.status === 'scheduled') {
                    const parentDate = new Date(parentBatch.scheduled_at);
                    if (scheduledDate.getTime() <= parentDate.getTime()) {
                        fail(`The follow-up must be scheduled after the parent batch (parent batch is scheduled for ${parentDate.toLocaleString()}).`, 400);
                    }
                }

                // Check constraint: The next follow-up / broadcast should not be on the same date with a pending scheduled dispatch for this campaign
                const dateStr = formatDateInTz(scheduledDate, tz);
                const [sameDateDispatch] = await sql`
                    SELECT id, subject, is_follow_up, scheduled_at 
                    FROM campaign_messages 
                    WHERE campaign_id = ${campaign.id} 
                      AND status = 'scheduled' 
                      AND (scheduled_at AT TIME ZONE ${tz})::date = ${dateStr}::date
                    LIMIT 1
                `;
                if (sameDateDispatch) {
                    fail(`A ${sameDateDispatch.is_follow_up ? 'follow-up' : 'broadcast'} for this campaign ("${sameDateDispatch.subject}") is already scheduled for ${dateStr}. A campaign cannot have multiple pending dispatches scheduled on the same date.`, 400);
                }

                const availableForDate = await getCapacityForDate(sql, scheduledDate, tz);
                if (recipients.length > availableForDate) {
                    fail(`Cannot schedule campaign: Active recipient list has ${recipients.length} emails, but available daily sending capacity for ${formatDateInTz(scheduledDate, tz)} is only ${availableForDate}.`, 400);
                }

                const [campaignMsg] = await sql`
                    INSERT INTO campaign_messages(campaign_id, subject, text_body, persona_id, total_recipients, status, scheduled_at, is_follow_up, parent_batch_id)
                    VALUES(${campaign.id}, ${subject}, ${p.text}, ${persona.id}, ${recipients.length}, 'scheduled', ${scheduledDate.toISOString()}, ${isFollowUp}, ${parentBatchId})
                    RETURNING *
                `;

                // If scheduled within the next 26 hours (e.g. today), immediately enqueue to QStash
                let qstashId = null;
                if (process.env.QSTASH_TOKEN && (scheduledDate.getTime() - Date.now() <= 26 * 60 * 60 * 1000)) {
                    try {
                        const qstash = new QStashClient({ token: process.env.QSTASH_TOKEN });
                        const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
                        const notBefore = Math.floor(scheduledDate.getTime() / 1000);
                        const qRes = await qstash.publishJSON({
                            url: `${appUrl}/api/campaigns/trigger-scheduled`,
                            body: { campaignMessageId: campaignMsg.id },
                            notBefore
                        });
                        qstashId = qRes.messageId;
                        await sql`UPDATE campaign_messages SET qstash_message_id=${qstashId} WHERE id=${campaignMsg.id}`;
                    } catch (e) {
                        console.warn('QStash immediate queue failed (DailyScheduler will retry at 2am):', e.message);
                    }
                }

                return json({
                    ok: true,
                    scheduled: true,
                    campaignMessageId: campaignMsg.id,
                    scheduledAt: scheduledDate.toISOString(),
                    timezone: tz,
                    qstashMessageId: qstashId,
                    total: recipients.length
                });
            }

            // Immediate Send:
            if (isFollowUp && parentBatch?.status === 'scheduled') {
                fail('Cannot send an immediate follow-up to a pending scheduled batch. Please schedule the follow-up for a time after the parent batch sends.', 400);
            }

            const userTz = p.timezone || req.headers.get('x-timezone') || process.env.TIMEZONE || DEFAULT_TIMEZONE;
            const availableToday = await getCapacityForDate(sql, new Date(), userTz);
            if (recipients.length > availableToday) {
                fail(`Cannot send campaign: Active recipient list has ${recipients.length} emails, but available daily capacity today is only ${availableToday}.`, 400);
            }

            const [campaignMsg] = await sql`
                INSERT INTO campaign_messages(campaign_id, subject, text_body, persona_id, total_recipients, status, is_follow_up, parent_batch_id)
                VALUES(${campaign.id}, ${subject}, ${p.text}, ${persona.id}, ${recipients.length}, 'sending', ${isFollowUp}, ${parentBatchId})
                RETURNING *
            `;

            const outcome = await dispatchCampaignMessage({ campaignMessageId: campaignMsg.id, sql });
            return json({ ok: true, ...outcome });
        }
        fail('Not found', 404);
    } catch (e) {
        console.error('API request failed:', {
            name: e.name,
            code: e.code,
            message: String(e.message).replace(
                /postgres(?:ql)?:\/\/[^\s]+/gi,
                '[DATABASE_URL REDACTED]'
            ),
            causeCode: e.cause?.code
        });

        const known = ['Quota reached', 'Connection is disabled', 'Verify the persona domain', 'Persona not found'];
        if (known.some(x => e.message.includes(x))) return json({ error: e.message.split('\n')[0] }, 400);
        if (e.message?.includes('unable to authenticate data') || e.message?.includes('Unsupported state')) {
            return json({ error: 'Failed to decrypt provider credentials. CREDENTIALS_KEY in environment does not match the key used to save this connection. Please re-enter and save your API key in the Connections tab.' }, 400);
        }
        if (e.code === '23505') return json({ error: 'That record already exists' }, 409);
        return json({ error: e.status ? e.message : `Request failed: ${e.message}` }, e.status || 500);

    }
}
export const GET = handler;
export const POST = handler;
