import { randomUUID, randomBytes } from 'crypto';
import { db, ensureCampaignTables } from './db.js';
import { decrypt } from './security.js';
import { sendEmail, buildRequest } from './providers.js';
import { messageStore } from './d1.js';
import { providers } from './catalog.js';

export async function dispatchCampaignMessage({ campaignMessageId, sql = db() }) {
    await ensureCampaignTables(sql);
    const [campaignMsg] = await sql`SELECT * FROM campaign_messages WHERE id=${campaignMessageId}`;
    if (!campaignMsg) throw new Error('Campaign message record not found');
    if (campaignMsg.status === 'completed') return { status: 'completed', alreadyCompleted: true };

    const [campaign] = await sql`SELECT * FROM campaigns WHERE id=${campaignMsg.campaign_id}`;
    if (!campaign) throw new Error('Associated campaign not found');

    const [persona] = await sql`SELECT * FROM personas WHERE id=${campaignMsg.persona_id}`;
    if (!persona) throw new Error('Associated persona not found');

    const rawRecipients = Array.isArray(campaign.recipients) 
        ? campaign.recipients 
        : JSON.parse(campaign.recipients || '[]');

    const unsubscribedList = Array.isArray(campaign.unsubscribed)
        ? campaign.unsubscribed
        : JSON.parse(campaign.unsubscribed || '[]');
    const unsubscribedSet = new Set(unsubscribedList.map(e => String(e).toLowerCase().trim()));

    const blacklistRows = await sql`SELECT lower(email) AS email FROM blacklist`;
    const blacklistSet = new Set(blacklistRows.map(r => r.email.toLowerCase().trim()));

    const recipients = rawRecipients.filter(e => {
        const lower = String(e).toLowerCase().trim();
        return !unsubscribedSet.has(lower) && !blacklistSet.has(lower);
    });

    if (!recipients.length) throw new Error('No active recipients in this campaign (all recipients are either unsubscribed from this campaign or in the global blacklist)');

    await sql`UPDATE campaign_messages SET status='sending' WHERE id=${campaignMsg.id}`;

    const senderDomain = persona.email.split('@')[1];

    // Find eligible connections for persona's domain
    const eligibleConnections = await sql`
        SELECT * FROM connections 
        WHERE provider<>'cloudflare' AND enabled=true AND domains ? ${senderDomain}
        ORDER BY label ASC
    `;

    if (!eligibleConnections.length) {
        await sql`UPDATE campaign_messages SET status='failed' WHERE id=${campaignMsg.id}`;
        throw new Error(`No enabled platforms found that have verified the sender domain "${senderDomain}".`);
    }

    const connIds = eligibleConnections.map(c => c.id);
    const usageRows = await sql`
        SELECT c.id, w.value || jsonb_build_object('used', coalesce(u.used, 0)) AS window 
        FROM connections c 
        CROSS JOIN LATERAL jsonb_array_elements(quota_windows(c)) w 
        LEFT JOIN usage_counters u ON u.key = c.id::text || ':' || (w.value->>'name') || ':' || (w.value->>'start') 
        WHERE c.id = ANY(${connIds})
    `;

    const platformPool = [];
    for (const c of eligibleConnections) {
        const cWindows = usageRows.filter(r => r.id === c.id).map(r => r.window);
        const dayW = cWindows.find(w => w.name === 'day');
        const limitVal = (c.daily_limit !== null && c.daily_limit !== undefined) 
            ? Number(c.daily_limit) 
            : (providers[c.provider]?.daily || 100000);
        const used = dayW?.used || 0;
        const remaining = Math.max(0, limitVal - used);
        if (remaining > 0) {
            platformPool.push({
                connection: c,
                credentials: decrypt(c.credentials),
                remaining,
                sentThisBatch: 0
            });
        }
    }

    if (!platformPool.length) {
        await sql`UPDATE campaign_messages SET status='quota-stopped' WHERE id=${campaignMsg.id}`;
        throw new Error(`All platforms capable of sending for "${senderDomain}" have exhausted their daily sending quota for today.`);
    }

    const [inbound] = await sql`SELECT id FROM connections WHERE provider='cloudflare' AND enabled AND domains ? ${senderDomain}`;

    // If this batch is a follow-up, fetch parent deliveries so we can thread each recipient's email
    const parentMap = new Map();
    if (campaignMsg.parent_batch_id) {
        const parentDeliveries = await sql`
            SELECT recipient, message_uuid, wire_message_id, thread_id 
            FROM campaign_deliveries 
            WHERE campaign_message_id = ${campaignMsg.parent_batch_id} AND status = 'accepted'
        `;
        for (const row of parentDeliveries) {
            parentMap.set(row.recipient.toLowerCase(), row);
        }
    }

    let sentCount = 0;
    let failedCount = 0;
    let currentPoolIdx = 0;
    let quotaHit = false;
    let lastError = null;

    for (const recipient of recipients) {
        const parent = parentMap.get(recipient.toLowerCase());
        const msgId = randomUUID();
        const threadId = parent?.thread_id || parent?.message_uuid || msgId;
        const parentId = parent?.message_uuid || null;
        const wireId = parent?.wire_message_id || null;
        const hdr = {};
        if (wireId) {
            const cleanWireId = wireId.startsWith('<') ? wireId : `<${wireId}>`;
            hdr['In-Reply-To'] = cleanWireId;
            hdr['References'] = cleanWireId;
        }

        try {
            const suppressed = await messageStore('suppressed', { email: recipient });
            if (suppressed?.blocked) {
                failedCount++;
                await sql`
                    INSERT INTO campaign_deliveries (campaign_message_id, recipient, message_uuid, thread_id, status, error)
                    VALUES (${campaignMsg.id}, ${recipient}, ${msgId}, ${threadId}, 'suppressed', 'Recipient suppressed after a bounce or complaint')
                `;
                continue;
            }
        } catch {}

        while (currentPoolIdx < platformPool.length && platformPool[currentPoolIdx].remaining <= 0) {
            currentPoolIdx++;
        }

        if (currentPoolIdx >= platformPool.length) {
            quotaHit = true;
            lastError = 'Daily quota limit reached across all available platforms';
            await sql`
                INSERT INTO campaign_deliveries (campaign_message_id, recipient, message_uuid, thread_id, status, error)
                VALUES (${campaignMsg.id}, ${recipient}, ${msgId}, ${threadId}, 'failed', ${lastError})
            `;
            break;
        }

        const token = randomBytes(16).toString('hex');
        const replyTo = inbound ? `reply+${token}@${senderDomain}` : persona.email;
        const payload = { 
            id: msgId, 
            from: persona.email, 
            fromName: persona.name, 
            to: recipient, 
            subject: campaignMsg.subject, 
            text: campaignMsg.text_body, 
            html: '', 
            replyTo, 
            headers: hdr 
        };

        let reservation = null;
        let activePlatform = null;
        let c = null;
        let credentials = null;

        while (currentPoolIdx < platformPool.length) {
            activePlatform = platformPool[currentPoolIdx];
            c = activePlatform.connection;
            credentials = activePlatform.credentials;

            try {
                const [res] = await sql`SELECT reserve_email(${c.id},${persona.id},${msgId},${parentId},${recipient},${campaignMsg.subject},${campaignMsg.text_body},'',${JSON.stringify(hdr)}::jsonb,${token},null) AS result`;
                reservation = res.result;
                break;
            } catch (e) {
                if (e.message && e.message.includes('Quota reached')) {
                    activePlatform.remaining = 0;
                    currentPoolIdx++;
                    continue;
                }
                lastError = e.message;
                break;
            }
        }

        if (!reservation) {
            if (currentPoolIdx >= platformPool.length) {
                quotaHit = true;
                break;
            }
            failedCount++;
            await sql`
                INSERT INTO campaign_deliveries (campaign_message_id, recipient, message_uuid, thread_id, status, error)
                VALUES (${campaignMsg.id}, ${recipient}, ${msgId}, ${threadId}, 'failed', ${lastError || 'Quota reached or reservation failed'})
            `;
            continue;
        }

        if (reservation.duplicate) continue;

        const reservationKeys = reservation.reservation || [];
        try {
            await messageStore('insertOutbound', {
                message: {
                    id: msgId,
                    connection_id: c.id,
                    persona_id: persona.id,
                    thread_id: threadId,
                    parent_id: parentId,
                    from_email: persona.email,
                    from_name: persona.name,
                    to_email: recipient,
                    subject: campaignMsg.subject,
                    text_body: campaignMsg.text_body,
                    html_body: '',
                    headers: hdr,
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
            await sql`
                INSERT INTO campaign_deliveries (campaign_message_id, recipient, message_uuid, thread_id, platform, status, error)
                VALUES (${campaignMsg.id}, ${recipient}, ${msgId}, ${threadId}, ${c.label || providers[c.provider]?.name || c.provider}, 'failed', ${e.message})
            `;
            continue;
        }

        try {
            buildRequest(c.provider, credentials, payload, c.settings);
            const outcome = await sendEmail(c.provider, credentials, payload, c.settings);
            await sql`SELECT finish_email(${msgId}, 'accepted', ${outcome.providerId}, ${outcome.messageId}, null)`;
            await messageStore('updateMessage', { id: msgId, status: 'accepted', provider_id: outcome.providerId, message_id: outcome.messageId });
            sentCount++;
            activePlatform.remaining--;
            activePlatform.sentThisBatch++;
            await sql`
                INSERT INTO campaign_deliveries (campaign_message_id, recipient, message_uuid, wire_message_id, thread_id, platform, status)
                VALUES (${campaignMsg.id}, ${recipient}, ${msgId}, ${outcome.messageId || outcome.providerId || null}, ${threadId}, ${c.label || providers[c.provider]?.name || c.provider}, 'accepted')
            `;
        } catch (e) {
            const status = e.uncertain === false ? 'failed' : 'unknown';
            await sql`SELECT finish_email(${msgId}, ${status}, null, null, ${e.message})`;
            await messageStore('updateMessage', { id: msgId, status, error: e.message });
            if (status === 'failed') failedCount++;
            else {
                sentCount++;
                activePlatform.remaining--;
                activePlatform.sentThisBatch++;
            }
            lastError = e.message;
            await sql`
                INSERT INTO campaign_deliveries (campaign_message_id, recipient, message_uuid, thread_id, platform, status, error)
                VALUES (${campaignMsg.id}, ${recipient}, ${msgId}, ${threadId}, ${c.label || providers[c.provider]?.name || c.provider}, ${status}, ${e.message})
            `;
        }
    }


    const platformStats = {};
    for (const p of platformPool) {
        if (p.sentThisBatch > 0) {
            platformStats[p.connection.label || p.connection.provider] = p.sentThisBatch;
        }
    }

    let finalStatus = 'completed';
    if (quotaHit) finalStatus = 'quota-stopped';
    else if (failedCount > 0 && sentCount === 0) finalStatus = 'failed';
    else if (failedCount > 0) finalStatus = 'partial';

    await sql`
        UPDATE campaign_messages
        SET sent_count=${sentCount}, failed_count=${failedCount}, status=${finalStatus}, platform_stats=${JSON.stringify(platformStats)}::jsonb
        WHERE id=${campaignMsg.id}
    `;

    return {
        campaignMessageId: campaignMsg.id,
        sentCount,
        failedCount,
        total: recipients.length,
        status: finalStatus,
        platformStats,
        error: lastError
    };
}
