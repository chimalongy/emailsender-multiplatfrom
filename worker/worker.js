import PostalMime from "postal-mime";
const enc=new TextEncoder(), hex=b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,"0")).join("");
const iso=()=>new Date().toISOString();
function json(v,s=200){return new Response(JSON.stringify(v),{status:s,headers:{"content-type":"application/json","cache-control":"no-store"}})}
async function verify(req,env,body){
 return true;
}
function parse(r){return r?{...r,headers:JSON.parse(r.headers||"{}"),reservation:JSON.parse(r.reservation||"[]")}:null}
async function first(db,s){return parse(await s.first())}
async function rows(s){return (await s.all()).results.map(parse)}
async function inbound(env,p){
 const to=String(p.envelopeTo||"").toLowerCase(),from=String(p.from||p.envelopeFrom||"").toLowerCase(),domain=to.split("@").pop();
 if(!to.includes("@")||!from.includes("@"))throw Error("Bad address");
 const refs=String(p.references||"").match(/<[^<>\r\n]{1,250}>/g)||[], ir=String(p.inReplyTo||"").match(/<[^<>\r\n]{1,250}>/)?.[0]||null;
 const token=to.split("@")[0].match(/^reply\+([a-f0-9]{32})$/)?.[1];let parent=null;
 if(token)parent=await first(env.MESSAGES,env.MESSAGES.prepare("SELECT * FROM messages WHERE reply_token=? AND lower(substr(from_email,instr(from_email,'@')+1))=? ORDER BY created_at DESC LIMIT 1").bind(token,domain));
 if(!parent)for(const mid of [ir,...refs.slice().reverse()].filter(Boolean).slice(0,20)){parent=await first(env.MESSAGES,env.MESSAGES.prepare("SELECT * FROM messages WHERE message_id=? ORDER BY created_at DESC LIMIT 1").bind(mid));if(parent)break}
 const id=crypto.randomUUID(), meta={references:refs.slice(0,20),inReplyTo:ir,replyTo:p.replyTo||null,attachmentsOmitted:Number(p.attachmentsOmitted)||0,envelopeFrom:p.envelopeFrom||"",match:token&&parent?"reply-address":parent?"headers":"unmatched"};
 await env.MESSAGES.prepare("INSERT OR IGNORE INTO messages(id,direction,persona_id,thread_id,parent_id,from_email,from_name,to_email,subject,text_body,html_body,headers,message_id,status,dedupe_key,created_at) VALUES(?,'in',?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
 .bind(id,parent?.persona_id||null,parent?.thread_id||id,parent?.id||null,from,String(p.fromName||"").slice(0,200),to,String(p.subject||"(No subject)").slice(0,255),String(p.text||"").slice(0,150000),String(p.html||"").slice(0,150000),JSON.stringify(meta),String(p.messageId||"").slice(0,300)||null,"received",String(p.dedupeKey||""),iso()).run();
}
async function notifyNtfy(env,m,message){
 if(!env.NTFY_TOPIC)return;
 try{
  const senderEmail=m.from?.address||message.from;
  const senderName=m.from?.name?`${m.from.name} (${senderEmail})`:senderEmail;
  const appUrl=(env.APP_URL||"https://emailsender-multiplatfrom.vercel.app").replace(/\/$/,"");
  const mailboxUrl=`${appUrl}/mailbox`;
  const subject=m.subject||"(No subject)";
  const preview=String(m.text||"").trim().slice(0,180)||"(No preview text)";
  const replySubject=encodeURIComponent("Re: "+subject.replace(/^re:\s*/i,""));
  await fetch("https://ntfy.sh",{
   method:"POST",
   headers:{"Content-Type":"application/json"},
   body:JSON.stringify({
    topic:env.NTFY_TOPIC,
    title:`✉️ New email from ${senderName}`,
    message:`To: ${message.to}\nSubject: ${subject}\n\n${preview}`,
    priority:4,
    tags:["email","incoming_envelope"],
    click:mailboxUrl,
    actions:[
     {
      action:"view",
      label:"📂 Open Mailbox",
      url:mailboxUrl
     },
     {
      action:"view",
      label:"↩️ Quick Reply",
      url:`mailto:${senderEmail}?subject=${replySubject}`
     }
    ]
   })
  });
 }catch(err){
  console.error("Push notification failed:",err?.message||err);
 }
}
async function action(env,p){
 const d=env.MESSAGES;
 switch(p.action){
 case "messages":{const off=Math.max(0,Math.min(100000,Number(p.offset)||0));if(p.thread)return json(await rows(d.prepare("SELECT * FROM messages WHERE thread_id=? ORDER BY created_at LIMIT 500").bind(p.thread)));return json(await rows(d.prepare("SELECT id,thread_id,from_email,to_email,subject,status,created_at,read_at FROM messages WHERE direction=? ORDER BY created_at DESC LIMIT 50 OFFSET ?").bind((p.folder==="sent"||p.folder==="out")?"out":"in",off)))}

 case "messageById":return json(await first(d,d.prepare("SELECT * FROM messages WHERE id=?").bind(p.id)));
 case "findReply":return json(await first(d,d.prepare("SELECT * FROM messages WHERE reply_token=? AND lower(substr(from_email,instr(from_email,'@')+1))=? ORDER BY created_at DESC LIMIT 1").bind(p.token,p.domain)));
 case "findMessageId":return json(await first(d,d.prepare("SELECT * FROM messages WHERE message_id=? ORDER BY created_at DESC LIMIT 1").bind(p.messageId)));
 case "insertOutbound":{const m=p.message;await d.prepare("INSERT INTO messages(id,direction,connection_id,persona_id,thread_id,parent_id,from_email,from_name,to_email,subject,text_body,html_body,headers,message_id,reply_token,status,reservation,created_at) VALUES(?,'out',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(m.id,m.connection_id,m.persona_id,m.thread_id,m.parent_id,m.from_email,m.from_name,m.to_email,m.subject,m.text_body,m.html_body,JSON.stringify(m.headers||{}),m.message_id||null,m.reply_token,m.status||"sending",JSON.stringify(m.reservation||[]),m.created_at||iso()).run();return json({ok:true})}
 case "updateMessage":{const m=p;await d.prepare("UPDATE messages SET status=coalesce(?,status),provider_id=coalesce(?,provider_id),message_id=coalesce(?,message_id),error=?,headers=coalesce(?,headers) WHERE id=?").bind(m.status||null,m.provider_id||null,m.message_id||null,m.error??null,m.headers?JSON.stringify(m.headers):null,m.id).run();return json({ok:true})}
 case "markRead":await d.prepare("UPDATE messages SET read_at=? WHERE thread_id=?").bind(iso(),p.thread).run();return json({ok:true});
 case "clearPersona":await d.prepare("UPDATE messages SET persona_id=NULL WHERE persona_id=?").bind(p.id).run();return json({ok:true});
 case "link":{const t=await first(d,d.prepare("SELECT thread_id FROM messages WHERE id=?").bind(p.target));if(!t)return json({error:"Target message not found"},404);await d.prepare("UPDATE messages SET thread_id=?,parent_id=? WHERE id=? AND direction='in'").bind(t.thread_id,p.target,p.id).run();return json({ok:true})}
 case "suppressed":return json({blocked:!!(await first(d,d.prepare("SELECT id FROM messages WHERE to_email=? AND status IN ('bounced','complained') LIMIT 1").bind(p.email)))});
 case "webhookUpdate":if(p.providerId)await d.prepare("UPDATE messages SET status=? WHERE connection_id=? AND (provider_id=? OR message_id=? OR message_id=?) AND status NOT IN ('bounced','complained','failed-delivery')").bind(p.status,p.connectionId,p.providerId,p.providerId,"<"+p.providerId+">").run();return json({ok:true});
 default:return json({error:"Unknown message action"},404)
 }
}
export default{
 async fetch(req,env){if(req.method!=="POST")return json({error:"Not found"},404);const body=await req.text();if(!await verify(req,env,body))return json({error:"Invalid signature"},401);let p;try{p=JSON.parse(body)}catch{return json({error:"Invalid JSON"},400)}try{return await action(env,p)}catch(e){console.error("D1 operation failed",e?.message);return json({error:"D1 message store operation failed"},500)}},
 async email(message,env){
  const allowed=(env.ALLOWED_DOMAINS||"").toLowerCase().split(",").map(x=>x.trim());if(!allowed.includes(message.to.toLowerCase().split("@")[1]))return message.setReject("Receiving domain not configured");
  if(!env.MESSAGES)return message.setReject("Mailbox storage unavailable");if(message.rawSize>4*1024*1024)return message.setReject("This mailbox accepts messages up to 4 MiB");
  try{const raw=await new Response(message.raw).arrayBuffer(),m=await PostalMime.parse(raw);if((m.text||"").length>150000||(m.html||"").length>150000)return message.setReject("Message body exceeds mailbox limit");
   const digest=hex(await crypto.subtle.digest("SHA-256",raw)),dedupeKey=hex(await crypto.subtle.digest("SHA-256",enc.encode(digest+":"+message.to.toLowerCase())));
   await inbound(env,{envelopeFrom:message.from,envelopeTo:message.to,from:m.from?.address||message.from,fromName:m.from?.name||"",replyTo:m.replyTo?.[0]?.address||null,subject:m.subject||"",text:m.text||"",html:m.html||"",messageId:m.messageId||message.headers.get("message-id")||"",inReplyTo:message.headers.get("in-reply-to")||"",references:message.headers.get("references")||"",attachmentsOmitted:m.attachments?.length||0,dedupeKey});
   await notifyNtfy(env,m,message);
  }catch(e){console.error("Inbound D1 write failed",e?.message);message.setReject("Mailbox could not store this message; please contact the recipient")}
 }
};
