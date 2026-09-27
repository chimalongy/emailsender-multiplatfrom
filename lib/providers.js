import { htmlEscape } from './validation.js';
const basic=(a,b)=>'Basic '+Buffer.from(`${a}:${b}`).toString('base64');
export function buildRequest(provider,c,m,settings={}) {
 const from=`"${m.fromName.replace(/["\\]/g,'')}" <${m.from}>`, h=m.headers||{}, html=m.html||`<pre>${htmlEscape(m.text)}</pre>`;
 const json=(url,body,headers={})=>({url,init:{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}});
 const bearer={Authorization:`Bearer ${c.apiKey}`};
 switch(provider) {
 case 'brevo': return json('https://api.brevo.com/v3/smtp/email',{sender:{name:m.fromName,email:m.from},to:[{email:m.to}],subject:m.subject,textContent:m.text,htmlContent:html,replyTo:{email:m.replyTo},...(Object.keys(h).length?{headers:h}:{})},{'api-key':c.apiKey});
 case 'mailjet': return json('https://api.mailjet.com/v3.1/send',{Messages:[{From:{Email:m.from,Name:m.fromName},To:[{Email:m.to}],Subject:m.subject,TextPart:m.text,HTMLPart:html,ReplyTo:{Email:m.replyTo},Headers:h,CustomID:m.id}]},{Authorization:basic(c.apiKey,c.apiSecret)});
 case 'resend': return json('https://api.resend.com/emails',{from,to:[m.to],subject:m.subject,text:m.text,html,reply_to:m.replyTo,headers:h},{...bearer,'Idempotency-Key':m.id});
 case 'mailgun': {const body=new FormData(); for(const [k,v] of Object.entries({from,to:m.to,subject:m.subject,text:m.text,html,'h:Reply-To':m.replyTo,...Object.fromEntries(Object.entries(h).map(([k,v])=>['h:'+k,v]))})) body.set(k,v); return {url:`https://${settings.region==='eu'?'api.eu.mailgun.net':'api.mailgun.net'}/v3/${encodeURIComponent(c.sendingDomain)}/messages`,init:{method:'POST',headers:{Authorization:basic('api',c.apiKey)},body}};}
 case 'elastic': return json('https://api.elasticemail.com/v4/emails/transactional',{Recipients:{To:[m.to]},Content:{From:from,ReplyTo:m.replyTo,Subject:m.subject,Headers:h,Body:[{ContentType:'PlainText',Content:m.text,Charset:'utf-8'},{ContentType:'HTML',Content:html,Charset:'utf-8'}]}},{'X-ElasticEmail-ApiKey':c.apiKey});
 case 'gosend': return json('https://www.gosend.dev/api/v1/emails',{from,to:[m.to],subject:m.subject,html},bearer);
 case 'maileroo': return json('https://smtp.maileroo.com/api/v2/emails',{from:{address:m.from,display_name:m.fromName},to:[{address:m.to}],subject:m.subject,plain:m.text,html,reply_to:{address:m.replyTo},headers:h,reference_id:m.id.replaceAll('-','').slice(0,24)},bearer);
 case 'sequenzy': return json('https://api.sequenzy.com/api/v1/transactional/send',{from,to:[m.to],subject:m.subject,body:html,replyTo:m.replyTo,trackingSettings:{clickTracking:false,openTracking:false}},bearer);
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
 const providerId=data.id||data.messageId||data.TransactionID||data.data?.reference_id||data.data?.id||data.emailId||data.Messages?.[0]?.To?.[0]?.MessageUUID;
 const actual=provider==='brevo'?data.messageId:provider==='mailgun'?data.id:null;
 return {providerId:providerId?String(providerId):null,messageId:actual||null};
}
export async function inspectDomain(provider,c,domain,settings={}) {
 let url,headers;
 if(provider==='resend'&&c.domainId) {url=`https://api.resend.com/domains/${encodeURIComponent(c.domainId)}`;headers={Authorization:`Bearer ${c.apiKey}`};}
 else if(provider==='brevo') {url=`https://api.brevo.com/v3/senders/domains/${encodeURIComponent(domain)}`;headers={'api-key':c.apiKey};}
 else if(provider==='mailgun') {url=`https://${settings.region==='eu'?'api.eu.mailgun.net':'api.mailgun.net'}/v3/domains/${encodeURIComponent(c.sendingDomain)}`;headers={Authorization:basic('api',c.apiKey)};}
 else if(provider==='cloudflare'&&c.apiKey&&c.zoneId) {url=`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(c.zoneId)}`;headers={Authorization:`Bearer ${c.apiKey}`};}
 else return {manual:true,note:'Complete verification in the provider dashboard, then enable this connection.'};
 const response=await fetch(url,{headers,signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!response.ok) throw Object.assign(new Error('Check failed. Check credentials, region, domain ID and API permissions.'),{status:400});
 const data=await response.json();
 if(provider==='resend') return {domain:data.name,status:data.status,records:data.records};
 if(provider==='brevo') return {domain:data.domain,verified:data.verified,authenticated:data.authenticated,dns:data.dns_records};
 if(provider==='mailgun') return {domain:data.domain?.name,status:data.domain?.state,records:data.sending_dns_records};
 return {domain:data.result?.name,status:data.result?.status,success:data.success};
}
