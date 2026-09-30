import { htmlEscape } from './validation.js';
const basic=(a,b)=>'Basic '+Buffer.from(`${a}:${b}`).toString('base64');
export function buildRequest(provider,c,m,settings={}) {
 const from=`"${m.fromName.replace(/["\\]/g,'')}" <${m.from}>`, h=m.headers||{};
 const html=m.html||`<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6;">${htmlEscape(m.text).replace(/\r\n|\r|\n/g, '<br>')}</div>`;
 const json=(url,body,headers={})=>({url,init:{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}});
 const bearer={Authorization:`Bearer ${c.apiKey}`};
 switch(provider) {
 case 'brevo': return json('https://api.brevo.com/v3/smtp/email',{sender:{name:m.fromName,email:m.from},to:[{email:m.to}],subject:m.subject,textContent:m.text,htmlContent:html,replyTo:{email:m.replyTo},...(Object.keys(h).length?{headers:h}:{})},{'api-key':c.apiKey});
 case 'resend': return json('https://api.resend.com/emails',{from,to:[m.to],subject:m.subject,text:m.text,html,reply_to:m.replyTo,headers:h},{...bearer,'Idempotency-Key':m.id});
 case 'mailgun': {const body=new FormData(); for(const [k,v] of Object.entries({from,to:m.to,subject:m.subject,text:m.text,html,'h:Reply-To':m.replyTo,...Object.fromEntries(Object.entries(h).map(([k,v])=>['h:'+k,v]))})) body.set(k,v); return {url:`https://${settings.region==='eu'?'api.eu.mailgun.net':'api.mailgun.net'}/v3/${encodeURIComponent(c.sendingDomain)}/messages`,init:{method:'POST',headers:{Authorization:basic('api',c.apiKey)},body}};}
 case 'elastic': return json('https://api.elasticemail.com/v4/emails/transactional',{Recipients:{To:[m.to]},Content:{From:from,ReplyTo:m.replyTo,Subject:m.subject,Headers:h,Body:[{ContentType:'PlainText',Content:m.text,Charset:'utf-8'},{ContentType:'HTML',Content:html,Charset:'utf-8'}]}},{'X-ElasticEmail-ApiKey':c.apiKey});
 case 'gosend': return json('https://www.gosend.dev/api/v1/emails',{from,to:[m.to],subject:m.subject,html},bearer);
 case 'maileroo': return json('https://smtp.maileroo.com/api/v2/emails',{from:{address:m.from,display_name:m.fromName},to:[{address:m.to}],subject:m.subject,plain:m.text,html,reply_to:{address:m.replyTo},headers:h,reference_id:m.id.replaceAll('-','').slice(0,24)},bearer);
 case 'sequenzy': return json('https://api.sequenzy.com/api/v1/transactional/send',{from,to:[m.to],subject:m.subject,body:html,replyTo:m.replyTo,trackingSettings:{clickTracking:false,openTracking:false}},bearer);
 case 'mailtrap': return json('https://send.api.mailtrap.io/api/send',{from:{email:m.from,name:m.fromName},to:[{email:m.to}],subject:m.subject,text:m.text,html,headers:h,category:'Transactional',...(m.replyTo?{reply_to:{email:m.replyTo}}:{})},bearer);
 case 'noticeapi': return json('https://www.noticeapi.com/api/v1/email/send',{from,to:m.to,subject:m.subject,text:m.text,html,headers:h,...(m.replyTo?{reply_to:m.replyTo}:{})},{...bearer,'Idempotency-Key':m.id});
 case 'quolle': return json('https://api.quolle.com/v1/emails/send',{from,to:m.to,subject:m.subject,text:m.text,html,...(m.replyTo?{replyTo:m.replyTo}:{})},{...bearer,'Idempotency-Key':m.id});
 default: throw new Error('Unsupported provider');
 }
}
export async function sendEmail(provider,credentials,message,settings) {
 const {url,init}=buildRequest(provider,credentials,message,settings);
 const response=await fetch(url,{...init,signal:AbortSignal.timeout(20000),redirect:'error'});
 let data; try {data=await response.json();} catch {throw Object.assign(new Error('Unreadable provider response; check provider logs'),{uncertain:true});}
 if(!response.ok || data.success===false || data.Messages?.some(x=>x.Status==='error')) {
  const detail = data.message || data.error || (data.errors ? JSON.stringify(data.errors) : '') || (data.Messages?.[0]?.Errors?.[0]?.ErrorMessage) || '';
  throw Object.assign(new Error(`Provider rejected request (HTTP ${response.status})${detail ? ': ' + detail : ''}. Check provider logs, domain verification and quota.`),{uncertain:response.status>=500||response.status===408});
 }
 const providerId=data.id||data.messageId||data.TransactionID||data.data?.reference_id||data.data?.id||data.emailId||data.Messages?.[0]?.To?.[0]?.MessageUUID||data.message_ids?.[0];
 const actual=provider==='brevo'?data.messageId:provider==='mailgun'?data.id:provider==='mailtrap'?data.message_ids?.[0]:null;
 return {providerId:providerId?String(providerId):null,messageId:actual||null};
}
export async function inspectDomain(provider,c,domain,settings={}) {
 let url,headers;
 if(provider==='resend'&&c.domainId) {url=`https://api.resend.com/domains/${encodeURIComponent(c.domainId)}`;headers={Authorization:`Bearer ${c.apiKey}`};}
 else if(provider==='brevo') {url=`https://api.brevo.com/v3/senders/domains/${encodeURIComponent(domain)}`;headers={'api-key':c.apiKey};}
 else if(provider==='mailgun') {url=`https://${settings.region==='eu'?'api.eu.mailgun.net':'api.mailgun.net'}/v3/domains/${encodeURIComponent(c.sendingDomain)}`;headers={Authorization:basic('api',c.apiKey)};}
 else if(provider==='cloudflare'&&c.apiKey&&c.zoneId) {url=`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(c.zoneId)}`;headers={Authorization:`Bearer ${c.apiKey}`};}
 else if(provider==='mailtrap'&&c.apiKey) {url='https://mailtrap.io/api/domains';headers={Authorization:`Bearer ${c.apiKey}`,'Api-Token':c.apiKey};}
 else if(provider==='noticeapi'&&c.apiKey) {url='https://www.noticeapi.com/api/v1/domains';headers={Authorization:`Bearer ${c.apiKey}`};}
 else if(provider==='quolle'&&c.apiKey) {url='https://api.quolle.com/v1/domains';headers={Authorization:`Bearer ${c.apiKey}`};}
 else return {manual:true,note:'Complete verification in the provider dashboard, then enable this connection.'};
 const response=await fetch(url,{headers,signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!response.ok) throw Object.assign(new Error('Check failed. Check credentials, region, domain ID and API permissions.'),{status:400});
 const data=await response.json();
 if(provider==='resend') return {domain:data.name,status:data.status,records:data.records};
 if(provider==='brevo') return {domain:data.domain,verified:data.verified,authenticated:data.authenticated,dns:data.dns_records};
 if(provider==='mailgun') return {domain:data.domain?.name,status:data.domain?.state,records:data.sending_dns_records};
 if(provider==='mailtrap') {
  const list=Array.isArray(data)?data:[];
  const item=list.find(d=>(d.domain_name||d.name||'').toLowerCase()===(domain||'').toLowerCase())||list[0];
  return {domain:item?.domain_name||domain,status:item?.compliance_status||(item?.dns_verified?'verified':'unverified'),verified:item?.dns_verified,records:item?.dns_records};
 }
 if(provider==='noticeapi') {
  const list=Array.isArray(data)?data:(Array.isArray(data?.domains)?data.domains:[]);
  const item=list.find(d=>(d.domain_name||d.domain||d.name||'').toLowerCase()===(domain||'').toLowerCase())||list[0];
  return {domain:item?.domain_name||item?.domain||domain,status:item?.status||(item?.verified?'verified':'unverified'),verified:item?.verified||item?.status==='verified',records:item?.dns_records||item?.records};
 }
 if(provider==='quolle') {
  const list=Array.isArray(data)?data:(Array.isArray(data?.domains)?data.domains:[]);
  const item=list.find(d=>(d.domain_name||d.domain||d.name||'').toLowerCase()===(domain||'').toLowerCase())||list[0];
  return {domain:item?.domain_name||item?.domain||domain,status:item?.status||(item?.verified?'verified':'unverified'),verified:item?.verified||item?.status==='verified',records:item?.dns_records||item?.records};
 }
 return {domain:data.result?.name,status:data.result?.status,success:data.success};
}
