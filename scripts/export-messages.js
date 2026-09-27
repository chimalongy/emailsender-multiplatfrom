import { neon } from '@neondatabase/serverless';
import { writeFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before exporting existing messages');
const sql=neon(process.env.DATABASE_URL);
const rows=await sql`SELECT id,direction,connection_id,persona_id,thread_id,parent_id,from_email,from_name,to_email,subject,text_body,html_body,headers,message_id,provider_id,reply_token,status,error,dedupe_key,reservation,created_at,read_at FROM messages ORDER BY created_at`;
await sql`INSERT INTO email_reservations(message_uuid,reservation,status,created_at)
 SELECT id,reservation,
 CASE WHEN status IN ('sending','unknown','failed') THEN status ELSE 'accepted' END,
 created_at
 FROM messages WHERE direction='out'
 ON CONFLICT(message_uuid) DO UPDATE SET reservation=excluded.reservation,status=excluded.status`;
const quote=v=>{
  if(v===null||v===undefined)return 'NULL';
  if(v instanceof Date)v=v.toISOString();
  else if(typeof v==='object')v=JSON.stringify(v);
  return "'"+String(v).replaceAll("'","''")+"'";
};
const cols='id,direction,connection_id,persona_id,thread_id,parent_id,from_email,from_name,to_email,subject,text_body,html_body,headers,message_id,provider_id,reply_token,status,error,dedupe_key,reservation,created_at,read_at';
const statements=rows.map(r=>'INSERT OR IGNORE INTO messages('+cols+') VALUES('+cols.split(',').map(k=>quote(r[k])).join(',')+');');
await writeFile('db/d1-messages-import.sql',statements.join('\n')+'\n',{mode:0o600});
console.log(`Exported ${rows.length} message rows to db/d1-messages-import.sql. Treat the file as sensitive and remove it after importing.`);
