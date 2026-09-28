import { task } from "@trigger.dev/sdk";
import { dispatchCampaignMessage } from "../../lib/campaign-dispatcher.js";
import { db } from "../../lib/db.js";

export const campaignMailSenderTask = task({
  id: "campaign-mail-sender",
  run: async (payload, { ctx }) => {
    const { campaignMessageId } = payload;
    if (!campaignMessageId) {
      throw new Error("Missing campaignMessageId in payload");
    }
    const sql = db();
    const result = await dispatchCampaignMessage({ campaignMessageId, sql });
    return result;
  },
});
