import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { db } from '../../../lib/db.js';
import { decrypt, encrypt, equal, passwordOK, session, validSession } from '../../../lib/security.js';
import { providers } from '../../../lib/catalog.js';
import { buildRequest, inspectDomain, sendEmail } from '../../../lib/providers.js';
import { domain, email, fail, line, limit, uuid, parseEmailList } from '../../../lib/validation.js';
import { messageStore } from '../../../lib/d1.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const json = (v, status = 200) => NextResponse.json(v, { status });
const clean = html => sanitizeHtml(html || '', { allowedTags: ['p','br','b','strong','em','i','ul','ol','li','blockquote','pre','h1','h2','h3','table','tbody','tr','td','th','a','hr'], allowedAttributes: { a: ['href','title'] }, allowedSchemes: ['https','http','mailto'] });
async function readBody(req, max = 400000) { const reader = req.body?.getReader(); if (!reader) return ''; let size = 0; const chunks = []; for (; ;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) { await reader.cancel(); fail('Message too large', 413); } chunks.push(Buffer.from(value)); } return Buffer.concat(chunks).toString('utf8'); }
async function authenticated(req) { if (!validSession((await cookies()).get('session')?.value)) fail('Sign in required', 401); }
let campaignTablesChecked = false;
async function ensureCampaignTables(sql) {
    if (campaignTablesChecked) return;
    await sql`
        CREATE TABLE IF NOT EXISTS campaigns (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            name text NOT NULL,
            recipients jsonb NOT NULL DEFAULT '[]',
            created_at timestamptz NOT NULL DEFAULT now()
        );
    `;
    await sql`
        CREATE TABLE IF NOT EXISTS campaign_messages (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
            subject text NOT NULL,
            text_body text NOT NULL,
            persona_id uuid,
            connection_id uuid,
            total_recipients int NOT NULL DEFAULT 0,
            sent_count int NOT NULL DEFAULT 0,
            failed_count int NOT NULL DEFAULT 0,
            status text NOT NULL DEFAULT 'pending',
            created_at timestamptz NOT NULL DEFAULT now()
        );
    `;
    campaignTablesChecked = true;
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
        messages: campaignMessages.filter(m => m.campaign_id === c.id)
    }));
    return {
        connections: connections.map(c => ({ ...c, usage: usage.filter(u => u.id === c.id).map(u => u.window) })),
        personas: await sql`SELECT * FROM personas ORDER BY name`,
        campaigns: campaignsWithMessages,
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
        if (req.method === 'POST' && path === 'login') {
            const body = JSON.parse(await readBody(req, 2000));
            if (!passwordOK(body.password, body.email)) fail('Incorrect email or password', 401);
            (await cookies()).set('session', session(), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 43200 });
            return json({ ok: true });
        }

        await authenticated(req);
        if (req.method === 'GET' && path === 'state') return json(await state());
        const sql = db();
        if (req.method === 'GET' && path === 'messages') {
            const url = new URL(req.url), thread = url.searchParams.get('thread'), folder = url.searchParams.get('folder') === 'sent' ? 'out' : 'in';
            const offset = Math.max(0, Math.min(100000, Number(url.searchParams.get('offset')) || 0));
            const rows=await messageStore('messages',{thread:thread?uuid(thread):null,folder,offset});
            return json(thread?rows.map(m=>({...m,html_body:clean(m.html_body)})):rows);
        }
        if (req.method !== 'POST') fail('Not found', 404);
        if (path === 'logout') { (await cookies()).delete('session'); return json({ ok: true }); }
        const p = JSON.parse(await readBody(req));
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
                const recipients = p.recipients !== undefined ? parseEmailList(p.recipients) : (Array.isArray(existing.recipients) ? existing.recipients : JSON.parse(existing.recipients || '[]'));
                const [updated] = await sql`UPDATE campaigns SET name=${name}, recipients=${JSON.stringify(recipients)}::jsonb WHERE id=${id} RETURNING *`;
                return json({ ok: true, campaign: updated });
            }
            const name = line(p.name, 'name', 100);
            const recipients = parseEmailList(p.recipients || p.emails || []);
            const [inserted] = await sql`INSERT INTO campaigns(name, recipients) VALUES(${name}, ${JSON.stringify(recipients)}::jsonb) RETURNING *`;
            return json({ ok: true, campaign: inserted });
        }
        if (path === 'campaigns/send') {
            await ensureCampaignTables(sql);
            const campaignId = uuid(p.campaignId);
            const [campaign] = await sql`SELECT * FROM campaigns WHERE id=${campaignId}`;
            if (!campaign) fail('Campaign not found', 404);

            const recipients = Array.isArray(campaign.recipients) ? campaign.recipients : JSON.parse(campaign.recipients || '[]');
            if (!recipients.length) fail('Campaign has no recipient emails', 400);

            const subject = line(p.subject, 'subject');
            if (typeof p.text !== 'string' || !p.text.trim() || p.text.length > 100000) fail('Message body is required (maximum 100,000 characters)');

            const [c] = await sql`SELECT * FROM connections WHERE id=${uuid(p.connectionId)}`;
            const [persona] = await sql`SELECT * FROM personas WHERE id=${uuid(p.personaId)}`;
            if (!c || !persona) fail('Choose a persona and connection');
            if (!c.enabled) fail('Selected connection is paused');
            const senderDomain = persona.email.split('@')[1];
            if (!c.domains.includes(senderDomain)) fail('Verify the persona domain on this provider first');

            const [campaignMsg] = await sql`
                INSERT INTO campaign_messages(campaign_id, subject, text_body, persona_id, connection_id, total_recipients, status)
                VALUES(${campaign.id}, ${subject}, ${p.text}, ${persona.id}, ${c.id}, ${recipients.length}, 'sending')
                RETURNING *
            `;

            const credentials = decrypt(c.credentials);
            const [inbound] = await sql`SELECT id FROM connections WHERE provider='cloudflare' AND enabled AND domains ? ${senderDomain}`;

            let sentCount = 0;
            let failedCount = 0;
            let quotaHit = false;
            let lastError = null;

            for (const recipient of recipients) {
                try {
                    const sup = await messageStore('suppressed', { email: recipient });
                    if (sup && sup.blocked) {
                        failedCount++;
                        continue;
                    }
                } catch {}

                const msgId = randomUUID();
                const token = randomBytes(16).toString('hex');
                const replyTo = inbound ? `reply+${token}@${senderDomain}` : persona.email;
                const payload = { id: msgId, from: persona.email, fromName: persona.name, to: recipient, subject, text: p.text, html: '', replyTo, headers: {} };

                let reservation;
                try {
                    const [res] = await sql`SELECT reserve_email(${c.id},${persona.id},${msgId},null,${recipient},${subject},${p.text},'',${JSON.stringify({})}::jsonb,${token},null) AS result`;
                    reservation = res.result;
                } catch (e) {
                    if (e.message && e.message.includes('Quota reached')) {
                        quotaHit = true;
                        lastError = e.message;
                        break;
                    }
                    failedCount++;
                    lastError = e.message;
                    continue;
                }

                if (reservation?.duplicate) {
                    continue;
                }

                const reservationKeys = reservation?.reservation || [];
                try {
                    await messageStore('insertOutbound', {
                        message: {
                            id: msgId,
                            connection_id: c.id,
                            persona_id: persona.id,
                            thread_id: msgId,
                            parent_id: null,
                            from_email: persona.email,
                            from_name: persona.name,
                            to_email: recipient,
                            subject,
                            text_body: p.text,
                            html_body: '',
                            headers: {},
                            message_id: null,
                            reply_token: token,
                            status: 'sending',
                            reservation: reservationKeys
                        }
                    });
                } catch (e) {
                    await sql`SELECT finish_email(${msgId}, 'failed', null, null, ${e.message})`;
                    failedCount++;
                    lastError = e.message;
                    continue;
                }

                try {
                    const outcome = await sendEmail(c.provider, credentials, payload, c.settings);
                    await sql`SELECT finish_email(${msgId}, 'accepted', ${outcome.providerId}, ${outcome.messageId}, null)`;
                    await messageStore('updateMessage', { id: msgId, status: 'accepted', provider_id: outcome.providerId, message_id: outcome.messageId });
                    sentCount++;
                } catch (e) {
                    const status = e.uncertain === false ? 'failed' : 'unknown';
                    await sql`SELECT finish_email(${msgId}, ${status}, null, null, ${e.message})`;
                    await messageStore('updateMessage', { id: msgId, status, error: e.message });
                    if (status === 'failed') failedCount++;
                    else sentCount++;
                    lastError = e.message;
                }
            }

            let finalStatus = 'completed';
            if (quotaHit) finalStatus = 'quota-stopped';
            else if (failedCount > 0 && sentCount === 0) finalStatus = 'failed';
            else if (failedCount > 0) finalStatus = 'partial';

            await sql`
                UPDATE campaign_messages
                SET sent_count=${sentCount}, failed_count=${failedCount}, status=${finalStatus}
                WHERE id=${campaignMsg.id}
            `;

            return json({
                ok: true,
                campaignMessageId: campaignMsg.id,
                sentCount,
                failedCount,
                total: recipients.length,
                status: finalStatus,
                error: lastError
            });
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
