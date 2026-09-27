CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, direction TEXT NOT NULL CHECK(direction IN ('in','out')),
 connection_id TEXT, persona_id TEXT, thread_id TEXT NOT NULL, parent_id TEXT,
 from_email TEXT NOT NULL, from_name TEXT NOT NULL DEFAULT '', to_email TEXT NOT NULL,
 subject TEXT NOT NULL, text_body TEXT NOT NULL DEFAULT '', html_body TEXT NOT NULL DEFAULT '',
 headers TEXT NOT NULL DEFAULT '{}', message_id TEXT, provider_id TEXT, reply_token TEXT UNIQUE,
 status TEXT NOT NULL, error TEXT, dedupe_key TEXT UNIQUE, reservation TEXT NOT NULL DEFAULT '[]',
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), read_at TEXT
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id,created_at);
CREATE INDEX IF NOT EXISTS messages_messageid ON messages(message_id);
CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS messages_recipient_status ON messages(to_email,status);
