import { email } from './validation.js';

export function extractBouncedRecipient(m) {
  if (!m) return null;
  // 1. VERP return path in to_email or envelopeTo
  const toAddress = (m.to_email || '') + ' ' + (m.headers?.envelopeTo || '') + ' ' + (m.headers?.to || '');
  const verpMatch = toAddress.match(/bounce\+[a-zA-Z0-9._]+-([a-zA-Z0-9._%+-]+)=([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})@/i) ||
                    toAddress.match(/bounce\+([a-zA-Z0-9._%+-]+)=([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})@/i);
  if (verpMatch) {
    try {
      return email(`${verpMatch[1]}@${verpMatch[2]}`).toLowerCase();
    } catch {}
  }

  const text = (m.text_body || '') + '\n' + (m.html_body || '');

  // 2. Google / Gmail Non-delivery report
  const googleMatch = text.match(/wasn't delivered to\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i) ||
                      text.match(/could not be delivered to\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
  if (googleMatch) {
    try { return email(googleMatch[1]).toLowerCase(); } catch {}
  }

  // 3. Microsoft 365 / Exchange NDR
  const msMatch = text.match(/(?:Your message to|Your message sent to)\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i) ||
                  text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s+wasn't found/i);
  if (msMatch) {
    try { return email(msMatch[1]).toLowerCase(); } catch {}
  }

  // 4. Mimecast
  const mimecastMatch = text.match(/message you sent to\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
  if (mimecastMatch) {
    try { return email(mimecastMatch[1]).toLowerCase(); } catch {}
  }

  // 5. Sendmail / Postfix / RFC 3464 fatal errors
  const fatalMatch = text.match(/fatal errors\s*-+\s*<([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>/i) ||
                     text.match(/Final-Recipient:\s*rfc822;\s*<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/i) ||
                     text.match(/Original-Recipient:\s*rfc822;\s*<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/i);
  if (fatalMatch) {
    try { return email(fatalMatch[1]).toLowerCase(); } catch {}
  }

  // 6. Embedded original headers block
  const origMatch = text.match(/-----\s*Original message\s*-----[\s\S]*?\n(?:To|for)\s*:?\s*<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/i);
  if (origMatch) {
    try { return email(origMatch[1]).toLowerCase(); } catch {}
  }

  return null;
}

export function isBounceMessage(m) {
  if (!m) return false;
  const from = (m.from_email || '').toLowerCase();
  const sub = (m.subject || '').toLowerCase();
  return (
    from.includes('mailer-daemon') ||
    from.includes('postmaster') ||
    sub.includes('delivery status notification') ||
    sub.includes('returned mail') ||
    sub.includes('undeliverable') ||
    sub.includes('failure notice')
  );
}

export async function handleCampaignBounce(sql, { recipientEmail, reason = 'Permanent bounce / mailbox not found' }) {
  if (!recipientEmail) return null;
  const targetEmail = recipientEmail.toLowerCase().trim();

  // 1. Find all campaigns containing this recipient in their active list or deliveries
  const allCampaigns = await sql`SELECT id, name, recipients, unsubscribed FROM campaigns`;
  const deliveriesWithRecipient = await sql`
    SELECT DISTINCT cm.campaign_id
    FROM campaign_deliveries cd
    JOIN campaign_messages cm ON cd.campaign_message_id = cm.id
    WHERE lower(cd.recipient) = ${targetEmail}
  `;
  const deliveredCampaignIds = new Set(deliveriesWithRecipient.map(d => d.campaign_id));
  const updatedCampaigns = [];

  for (const c of allCampaigns) {
    const recipients = Array.isArray(c.recipients) ? c.recipients : JSON.parse(c.recipients || '[]');
    const unsubscribed = Array.isArray(c.unsubscribed) ? c.unsubscribed : JSON.parse(c.unsubscribed || '[]');

    const hasInRecipients = recipients.some(e => e.toLowerCase() === targetEmail);
    const hasInUnsubscribed = unsubscribed.some(e => e.toLowerCase() === targetEmail);
    const wasDeliveredInCampaign = deliveredCampaignIds.has(c.id);

    if (hasInRecipients || (wasDeliveredInCampaign && !hasInUnsubscribed)) {
      const newRecipients = recipients.filter(e => e.toLowerCase() !== targetEmail);
      const newUnsubscribed = hasInUnsubscribed ? unsubscribed : [...unsubscribed, targetEmail];

      await sql`
        UPDATE campaigns 
        SET recipients = ${JSON.stringify(newRecipients)}::jsonb,
            unsubscribed = ${JSON.stringify(newUnsubscribed)}::jsonb
        WHERE id = ${c.id}
      `;

      updatedCampaigns.push({
        id: c.id,
        name: c.name,
        removedFromActive: hasInRecipients,
        addedToUnsubscribed: !hasInUnsubscribed
      });
    }
  }

  // 2. Mark matching deliveries as 'bounced'
  const affectedDeliveries = await sql`
    UPDATE campaign_deliveries
    SET status = 'bounced',
        error = COALESCE(error, ${reason})
    WHERE lower(recipient) = ${targetEmail} AND status IN ('accepted', 'sending')
    RETURNING id, campaign_message_id
  `;

  // 3. Recalculate metrics for affected batches
  const batchIds = [...new Set(affectedDeliveries.map(d => d.campaign_message_id))];
  for (const bid of batchIds) {
    const [counts] = await sql`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'accepted')::int as sent_count,
        COUNT(*) FILTER (WHERE status IN ('failed', 'suppressed', 'bounced'))::int as failed_count
      FROM campaign_deliveries
      WHERE campaign_message_id = ${bid}
    `;
    if (counts) {
      await sql`
        UPDATE campaign_messages
        SET sent_count = ${counts.sent_count},
            failed_count = ${counts.failed_count},
            status = CASE WHEN ${counts.failed_count} > 0 THEN 'partial' ELSE status END
        WHERE id = ${bid}
      `;
    }
  }

  // 4. Auto-add to global blacklist with bounce reason
  await sql`
    INSERT INTO blacklist (email, reason)
    VALUES (${targetEmail}, ${'Automated Bounce: ' + reason.slice(0, 200)})
    ON CONFLICT (email) DO UPDATE SET 
      reason = COALESCE(blacklist.reason, excluded.reason)
  `;

  return {
    recipientEmail: targetEmail,
    updatedCampaigns,
    bouncedDeliveriesCount: affectedDeliveries.length
  };
}

export async function scanAndProcessAllBounces(sql, messageStore) {
  let allInbound = [];
  let offset = 0;
  while (true) {
    const batch = await messageStore('messages', { folder: 'in', offset }).catch(() => []);
    if (!batch || !batch.length) break;
    allInbound.push(...batch);
    if (batch.length < 50) break;
    offset += 50;
    if (offset >= 500) break;
  }

  const bounceMessages = allInbound.filter(isBounceMessage);
  const processed = [];

  for (const b of bounceMessages) {
    const full = await messageStore('messageById', { id: b.id }).catch(() => null);
    const bouncedRecipient = extractBouncedRecipient(full || b);
    if (bouncedRecipient) {
      const result = await handleCampaignBounce(sql, {
        recipientEmail: bouncedRecipient,
        reason: (b.subject || 'Delivery failure notification').slice(0, 200)
      });
      if (result) processed.push(result);
    }
  }

  return {
    scannedBounceMessagesCount: bounceMessages.length,
    processedBouncesCount: processed.length,
    processed
  };
}
