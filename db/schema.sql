-- Run once in the Neon SQL editor. Four tables. No background reset task.
CREATE TABLE IF NOT EXISTS connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider text NOT NULL UNIQUE,
 label text NOT NULL, domains jsonb NOT NULL DEFAULT '[]', credentials text NOT NULL,
 settings jsonb NOT NULL DEFAULT '{}', enabled boolean NOT NULL DEFAULT false,
 connected_at timestamptz NOT NULL DEFAULT now(), daily_limit int CHECK(daily_limit>0), monthly_limit int CHECK(monthly_limit>0),
 provider_monthly_limit int CHECK(provider_monthly_limit>0), provider_cycle text NOT NULL DEFAULT 'calendar' CHECK(provider_cycle IN ('calendar','30days','billing')),
 provider_anchor timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS personas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, email text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS usage_counters (key text PRIMARY KEY, used int NOT NULL DEFAULT 0 CHECK(used>=0), expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS email_reservations (
 message_uuid uuid PRIMARY KEY, reservation jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL CHECK(status IN ('sending','accepted','failed','unknown')),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION quota_windows(c connections, t timestamptz DEFAULT now()) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE d timestamptz; a timestamptz; p timestamptz; pe timestamptz; result jsonb; months int;
BEGIN
 d := date_trunc('day',t AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 a := c.connected_at + floor(extract(epoch FROM (t-c.connected_at))/2592000)*interval '30 days';
 IF c.provider_cycle='calendar' THEN p:=date_trunc('month',t AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'; pe:=p+interval '1 month';
 ELSIF c.provider_cycle='30days' THEN p:=c.provider_anchor + floor(extract(epoch FROM(t-c.provider_anchor))/2592000)*interval '30 days'; pe:=p+interval '30 days';
 ELSE
  months := (extract(year FROM t AT TIME ZONE 'UTC')::int-extract(year FROM c.provider_anchor AT TIME ZONE 'UTC')::int)*12 + extract(month FROM t AT TIME ZONE 'UTC')::int-extract(month FROM c.provider_anchor AT TIME ZONE 'UTC')::int;
  p:=c.provider_anchor + months*interval '1 month';
  IF p>t THEN months:=months-1; p:=c.provider_anchor+months*interval '1 month'; END IF;
  pe:=c.provider_anchor + (months+1)*interval '1 month';
 END IF;
 result:=jsonb_build_array(jsonb_build_object('name','day','start',d,'end',d+interval '1 day','limit',c.daily_limit),jsonb_build_object('name','30-day','start',a,'end',a+interval '30 days','limit',c.monthly_limit),jsonb_build_object('name','provider-month','start',p,'end',pe,'limit',c.provider_monthly_limit));
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION reserve_email(cid uuid, pid uuid, mid uuid, parent uuid, recipient text, title text, body text, markup text, hdr jsonb, token text, msgid text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c connections; person personas; w jsonb; k text; n int; keys jsonb:='[]'; windows jsonb; inserted int;
BEGIN
 SELECT * INTO c FROM connections WHERE id=cid FOR UPDATE;
 IF NOT FOUND OR NOT c.enabled OR c.provider='cloudflare' THEN RAISE EXCEPTION 'Connection is disabled'; END IF;
 SELECT * INTO person FROM personas WHERE id=pid;
 IF NOT FOUND THEN RAISE EXCEPTION 'Persona not found'; END IF;
 IF NOT c.domains ? split_part(person.email,'@',2) THEN RAISE EXCEPTION 'Verify the persona domain on this provider first'; END IF;
 INSERT INTO email_reservations(message_uuid,status) VALUES(mid,'sending') ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS inserted = ROW_COUNT;
 IF inserted=0 THEN
  RETURN jsonb_build_object('duplicate',true,'status',(SELECT status FROM email_reservations WHERE message_uuid=mid));
 END IF;
 windows:=quota_windows(c);
 FOR w IN SELECT value FROM jsonb_array_elements(windows) LOOP
  k:=cid::text||':'||(w->>'name')||':'||(w->>'start');
  INSERT INTO usage_counters(key,used,expires_at) VALUES(k,0,(w->>'end')::timestamptz) ON CONFLICT DO NOTHING;
  SELECT used INTO n FROM usage_counters WHERE key=k FOR UPDATE;
  IF w->>'limit' IS NOT NULL AND n >= (w->>'limit')::int THEN RAISE EXCEPTION 'Quota reached: %',w->>'name'; END IF;
  UPDATE usage_counters SET used=used+1 WHERE key=k;
  keys:=keys||jsonb_build_array(k);
 END LOOP;
 UPDATE email_reservations SET reservation=keys WHERE message_uuid=mid;
 RETURN jsonb_build_object('duplicate',false,'reservation',keys);
END $$;

CREATE OR REPLACE FUNCTION finish_email(mid uuid, state text, providerid text, actualid text, detail text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r email_reservations; k text;
BEGIN
 SELECT * INTO r FROM email_reservations WHERE message_uuid=mid FOR UPDATE;
 IF NOT FOUND OR r.status NOT IN ('sending','unknown') THEN RETURN; END IF;
 IF state NOT IN ('accepted','failed','unknown') THEN RAISE EXCEPTION 'Invalid state'; END IF;
 IF state='failed' THEN
  FOR k IN SELECT jsonb_array_elements_text(r.reservation) LOOP UPDATE usage_counters SET used=greatest(0,used-1) WHERE key=k; END LOOP;
 END IF;
 UPDATE email_reservations SET status=state WHERE message_uuid=mid;
END $$;

CREATE OR REPLACE FUNCTION release_email(keys jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
 FOR k IN SELECT jsonb_array_elements_text(keys) LOOP
  UPDATE usage_counters SET used=greatest(0,used-1) WHERE key=k;
 END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL,
 recipients jsonb NOT NULL DEFAULT '[]',
 unsubscribed jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now()
);

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
 scheduled_at timestamptz,
 qstash_message_id text,
 parent_batch_id uuid REFERENCES campaign_messages(id) ON DELETE SET NULL,
 is_follow_up boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);

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

CREATE INDEX IF NOT EXISTS idx_campaign_deliveries_batch ON campaign_deliveries(campaign_message_id);
CREATE INDEX IF NOT EXISTS idx_campaign_deliveries_lookup ON campaign_deliveries(campaign_message_id, recipient);

CREATE TABLE IF NOT EXISTS blacklist (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 email text NOT NULL UNIQUE,
 reason text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_blacklist_email ON blacklist(email);


