import { schedules } from "@trigger.dev/sdk";
import { Client } from "@upstash/qstash";
import { db } from "../../lib/db.js";

export const dailySchedulerTask = schedules.task({
  id: "daily-scheduler",
  cron: "0 2 * * *", // 2:00 AM UTC every day
  run: async (payload, { ctx }) => {
    const sql = db();

    // Query broadcasts scheduled for the upcoming 26-hour window that haven't been pushed to QStash yet
    const now = new Date();
    const endWindow = new Date(now.getTime() + 26 * 60 * 60 * 1000);

    const scheduled = await sql`
      SELECT id, scheduled_at 
      FROM campaign_messages
      WHERE status = 'scheduled' 
        AND scheduled_at IS NOT NULL
        AND scheduled_at <= ${endWindow.toISOString()}
        AND qstash_message_id IS NULL
      ORDER BY scheduled_at ASC
    `;

    if (!scheduled.length) {
      return { scheduledCount: 0, message: "No unqueued broadcasts scheduled for today." };
    }

    const token = process.env.QSTASH_TOKEN;
    if (!token) {
      throw new Error("Missing QSTASH_TOKEN in environment variables");
    }

    const qstash = new Client({ token });
    const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
    const targetUrl = `${appUrl}/api/campaigns/trigger-scheduled`;

    const queued = [];
    for (const item of scheduled) {
      const scheduledTime = new Date(item.scheduled_at);
      const notBefore = Math.floor(scheduledTime.getTime() / 1000);

      const qRes = await qstash.publishJSON({
        url: targetUrl,
        body: { campaignMessageId: item.id },
        notBefore
      });

      await sql`
        UPDATE campaign_messages 
        SET qstash_message_id = ${qRes.messageId}
        WHERE id = ${item.id}
      `;

      queued.push({
        id: item.id,
        qstashMessageId: qRes.messageId,
        scheduledAt: item.scheduled_at
      });
    }

    return {
      scheduledCount: queued.length,
      queued
    };
  },
});
