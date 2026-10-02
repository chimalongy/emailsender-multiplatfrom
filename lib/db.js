import { neon } from '@neondatabase/serverless';
export function db() { if(!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL and run db/schema.sql'); return neon(process.env.DATABASE_URL); }

let tablesChecked = false;
export async function ensureCampaignTables(sql = db()) {
    if (tablesChecked) return;
    await sql`
        CREATE TABLE IF NOT EXISTS campaigns (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            name text NOT NULL,
            recipients jsonb NOT NULL DEFAULT '[]',
            unsubscribed jsonb NOT NULL DEFAULT '[]',
            created_at timestamptz NOT NULL DEFAULT now()
        );
    `;
    await sql`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS unsubscribed jsonb NOT NULL DEFAULT '[]';`;
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
            platform_stats jsonb NOT NULL DEFAULT '{}',
            created_at timestamptz NOT NULL DEFAULT now()
        );
    `;
    await sql`ALTER TABLE campaign_messages ADD COLUMN IF NOT EXISTS platform_stats jsonb NOT NULL DEFAULT '{}';`;
    await sql`ALTER TABLE campaign_messages ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;`;
    await sql`ALTER TABLE campaign_messages ADD COLUMN IF NOT EXISTS qstash_message_id text;`;
    await sql`ALTER TABLE campaign_messages ADD COLUMN IF NOT EXISTS parent_batch_id uuid REFERENCES campaign_messages(id) ON DELETE SET NULL;`;
    await sql`ALTER TABLE campaign_messages ADD COLUMN IF NOT EXISTS is_follow_up boolean NOT NULL DEFAULT false;`;
    await sql`
        CREATE TABLE IF NOT EXISTS campaign_deliveries (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            campaign_message_id uuid NOT NULL REFERENCES campaign_messages(id) ON DELETE CASCADE,
            recipient text NOT NULL,
            message_uuid uuid NOT NULL,
            wire_message_id text,
            thread_id text,
            platform text,
            status text NOT NULL,
            error text,
            created_at timestamptz NOT NULL DEFAULT now()
        );
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_campaign_deliveries_batch ON campaign_deliveries(campaign_message_id);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_campaign_deliveries_lookup ON campaign_deliveries(campaign_message_id, recipient);`;
    await sql`
        CREATE TABLE IF NOT EXISTS blacklist (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            email text NOT NULL UNIQUE,
            reason text,
            created_at timestamptz NOT NULL DEFAULT now()
        );
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_blacklist_email ON blacklist(email);`;
    tablesChecked = true;
}

