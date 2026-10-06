'use client';
import {useEffect,useState,useMemo,Fragment} from 'react';
import {useRouter,usePathname} from 'next/navigation';
import {providers} from '../lib/catalog.js';
import {parseEmailList, campaignSlug, matchesCampaign} from '../lib/validation.js';
import {toLocalDatetimeInputStr, toLocalDateStr} from '../lib/timezone.js';
import {FiTrash2, FiRefreshCw, FiUserX, FiChevronDown, FiChevronRight, FiAlertTriangle} from 'react-icons/fi';
import {registerPushDevice, unregisterPushDevice, getLocalDevicePushState} from '../lib/firebase-client.js';
const fmt=d=>new Date(d).toLocaleString();
async function api(path,body){const r=await fetch('/api/'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(r.status===401){location.href='/login';throw Error('Sign in required');}if(!r.ok&&!(path==='send'&&d.status==='failed'))throw Error(d.error||'Request failed');return d;}
const initialConnection=p=>({provider:p,label:providers[p].name,domains:'',credentials:{},dailyLimit:providers[p].daily??'',monthlyLimit:providers[p].monthly??'',providerMonthlyLimit:providers[p].providerMonthly??'',providerCycle:'calendar',providerAnchor:new Date().toISOString(),region:'us',enabled:false});
export default function Dashboard({initialTab='Overview', initialCampaignSlug=null, initialFolder=null}){
 const router=useRouter();
 const pathname=usePathname();
 const getFolderFromPath=(p,defaultF='inbox')=>{
  if(!p)return defaultF;
  const parts=p.replace(/^\//,'').split('/');
  if(parts[0]?.toLowerCase()==='mailbox'){
   const sub=parts[1]?.toLowerCase();
   if(sub==='sent')return 'sent';
   if(sub==='inbox')return 'inbox';
  }
  return defaultF;
 };
 const pathToTab=p=>{
  if(!p)return null;
  const s=p.replace(/^\//,'').split('/')[0].toLowerCase();
  if(s==='campaigns')return 'Campaigns';
  if(s==='blacklist')return 'Blacklist';
  if(s==='schedules')return 'Schedules';
  if(s==='connected'||s==='connections')return 'Connected';
  if(s==='personas')return 'Personas';
  if(s==='compose')return 'Compose';
  if(s==='mailbox')return 'Mailbox';
  if(s==='deployment')return 'Deployment';
  if(s===''||s==='overview')return 'Overview';
  return null;
 };
 const tabToPath={
  Overview:'/',
  Campaigns:'/campaigns',
  Blacklist:'/blacklist',
  Schedules:'/schedules',
  Connected:'/connected',
  Personas:'/personas',
  Compose:'/compose',
  Mailbox:'/mailbox/inbox',
  Deployment:'/deployment'
 };
 const [page,setPage]=useState(initialTab||pathToTab(pathname)||'Overview'),[connectedTab,setConnectedTab]=useState('capacity'),[data,setData]=useState({connections:[],personas:[],campaigns:[],blacklist:[]}),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 const [connection,setConnection]=useState(initialConnection('brevo')),[inspect,setInspect]=useState(null),[persona,setPersona]=useState({name:'',email:''});
 const [compose,setCompose]=useState({id:'',personaId:'',connectionId:'',to:'',subject:'',text:'',parentId:null}),[folder,setFolder]=useState(initialFolder||getFolderFromPath(pathname,'inbox')),[offset,setOffset]=useState(0),[messages,setMessages]=useState([]),[thread,setThread]=useState([]),[selectedThreadId,setSelectedThreadId]=useState(null),[threadLoading,setThreadLoading]=useState(false);
 const [selectedCampaignId,setSelectedCampaignId]=useState(null),[campaignForm,setCampaignForm]=useState({name:'',emails:''}),[campaignMsg,setCampaignMsg]=useState({personaId:'',subject:'',text:'',sendMode:'now',scheduledAt:'',isFollowUp:false,parentBatchId:null}),[editingRecipients,setEditingRecipients]=useState(false),[recipientEditText,setRecipientEditText]=useState('');
 const [recipientTab,setRecipientTab]=useState('active'),[unsubInput,setUnsubInput]=useState(''),[addingUnsub,setAddingUnsub]=useState(false);
 const [batchDetailsModal,setBatchDetailsModal]=useState(null),[batchDetailsLoading,setBatchDetailsLoading]=useState(false),[batchDeliveryFilter,setBatchDeliveryFilter]=useState('all'),[batchDeliverySearch,setBatchDeliverySearch]=useState('');
 const [expandedDeliveryId,setExpandedDeliveryId]=useState(null),[resendingDeliveryId,setResendingDeliveryId]=useState(null),[deletingDeliveryId,setDeletingDeliveryId]=useState(null);
 const [selectedResendProvider,setSelectedResendProvider]=useState(''),[isResendingAll,setIsResendingAll]=useState(false);
 const [calMonth,setCalMonth]=useState(new Date().getMonth()+1);
 const [calYear,setCalYear]=useState(new Date().getFullYear());
 const [calData,setCalData]=useState(null);
 const [calLoading,setCalLoading]=useState(false);
 const [selectedCalDay,setSelectedCalDay]=useState(null);
 const [calView,setCalView]=useState('grid');
 const [mobileMenuOpen,setMobileMenuOpen]=useState(false);
 const [blacklistForm,setBlacklistForm]=useState({emails:'',reason:'Do Not Contact'});
 const [blacklistSearch,setBlacklistSearch]=useState('');
 const [pushState, setPushState] = useState({ supported: false, permission: 'default', registered: false });
 const [pushBusy, setPushBusy] = useState(false);
 useEffect(() => {
  setPushState(getLocalDevicePushState());
 }, []);

 async function togglePushNotifications() {
  if (pushBusy) return;
  setPushBusy(true);
  setError('');
  setNotice('');
  try {
   if (pushState.registered) {
    await unregisterPushDevice(data.fcm?.publicConfig);
    setPushState(getLocalDevicePushState());
    await refresh();
    setNotice('Push notifications disabled on this device.');
   } else {
    if (!data.fcm?.configured || !data.fcm?.publicConfig?.isEnabled) {
     throw new Error('Firebase credentials are not configured yet. See the Deployment tab for setup instructions.');
    }
    await registerPushDevice(data.fcm.publicConfig);
    setPushState(getLocalDevicePushState());
    await refresh();
    setNotice('🔔 Push notifications enabled! You will now receive instant alerts for incoming emails.');
   }
  } catch (err) {
   setError(err.message || 'Failed to toggle push notifications');
  } finally {
   setPushBusy(false);
  }
 }

 async function sendTestPush() {
  if (pushBusy) return;
  setPushBusy(true);
  setError('');
  setNotice('');
  try {
   const res = await api('notifications/test', {});
   if (res.result?.skipped) {
    setError(`Cannot send push: ${res.result.reason}`);
   } else if (res.result?.totalDevices === 0) {
    setNotice('⚠️ Push service is ready, but no devices are registered yet. Click "Enable Push" to register this device first.');
   } else {
    setNotice(`🔔 Test push notification dispatched! Sent to ${res.result.sentCount} of ${res.result.totalDevices} registered device(s).`);
   }
   await refresh();
  } catch (err) {
   setError(err.message || 'Failed to send test push notification');
  } finally {
   setPushBusy(false);
  }
 }
 async function loadCalendar(year,month){setCalLoading(true);try{const tz=typeof Intl!=='undefined'?(Intl.DateTimeFormat().resolvedOptions().timeZone||'Africa/Lagos'):'Africa/Lagos';const d=await api(`campaigns/calendar?year=${year}&month=${month}&timezone=${encodeURIComponent(tz)}`);setCalData(d);}catch(e){setError(e.message);}finally{setCalLoading(false);}}
 useEffect(()=>{if(page==='Schedules')loadCalendar(calYear,calMonth);},[page,calYear,calMonth]);
 useEffect(()=>{const t=pathToTab(pathname);if(t&&t!==page)setPage(t);},[pathname]);
 useEffect(()=>{
  if(!pathname)return;
  const parts=pathname.replace(/^\//,'').split('/');
  if(parts[0]?.toLowerCase()==='mailbox'){
   const f=parts[1]?.toLowerCase()==='sent'?'sent':'inbox';
   if(f!==folder){
    setFolder(f);
    setOffset(0);
    setThread([]);
    setSelectedThreadId(null);
   }
  }
 },[pathname,folder]);
 useEffect(()=>{
  if(initialCampaignSlug && (data.campaigns||[]).length){
   const found=(data.campaigns||[]).find(c=>matchesCampaign(c,initialCampaignSlug));
   if(found){
    setSelectedCampaignId(found.id);
    setRecipientEditText((found.recipients||[]).join('\n'));
   }
  }
 },[initialCampaignSlug,data.campaigns]);
 useEffect(()=>{
  if(!pathname)return;
  const parts=pathname.replace(/^\//,'').split('/');
  if(parts[0]==='campaigns'&&parts[1]&&(data.campaigns||[]).length){
   const found=(data.campaigns||[]).find(c=>matchesCampaign(c,parts[1]));
   if(found&&selectedCampaignId!==found.id){
    setSelectedCampaignId(found.id);
    setRecipientEditText((found.recipients||[]).join('\n'));
   }
  }else if(parts[0]==='campaigns'&&!parts[1]&&selectedCampaignId){
   setSelectedCampaignId(null);
  }
 },[pathname,data.campaigns,selectedCampaignId]);
 async function cancelScheduledBroadcast(id){if(!confirm('Are you sure you want to cancel this scheduled broadcast?'))return;await run(async()=>{await api('campaigns/cancel-schedule',{id});await refresh();if(page==='Schedules')await loadCalendar(calYear,calMonth);setNotice('Scheduled broadcast was cancelled.');});}
 async function refresh(){setData(await api('state'));}
 async function run(fn){setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}}
 useEffect(()=>{refresh().catch(e=>setError(e.message)).finally(()=>setLoading(false));},[]);
 useEffect(()=>{const timer=setInterval(()=>refresh().catch(()=>{}),60000);return()=>clearInterval(timer);},[]);
 useEffect(()=>{if(page==='Mailbox')api(`messages?folder=${folder}&offset=${offset}`).then(setMessages).catch(e=>setError(e.message));},[page,folder,offset,notice]);
 const senders=data.connections.filter(c=>c.provider!=='cloudflare'),selectedPersona=data.personas.find(p=>p.id===compose.personaId);
 const activeSenders=senders.filter(c=>c.enabled);

 const getDailyLimit=c=>(c.daily_limit!==null&&c.daily_limit!==undefined&&c.daily_limit!=='')?Number(c.daily_limit):(providers[c.provider]?.daily||0);
 const getDailySent=c=>c.usage?.find(w=>w.name==='day')?.used||0;
 const getMonthlyLimit=c=>{
  if(c.monthly_limit!==null&&c.monthly_limit!==undefined&&c.monthly_limit!=='')return Number(c.monthly_limit);
  if(c.provider_monthly_limit!==null&&c.provider_monthly_limit!==undefined&&c.provider_monthly_limit!=='')return Number(c.provider_monthly_limit);
  return providers[c.provider]?.monthly||0;
 };
 const getMonthlySent=c=>{
  const w30=c.usage?.find(w=>w.name==='30-day')?.used;
  const wMonth=c.usage?.find(w=>w.name==='provider-month')?.used;
  return w30??wMonth??0;
 };

 const totalDailySent=senders.reduce((n,c)=>n+getDailySent(c),0);
 const totalDailyCapacity=senders.reduce((n,c)=>n+getDailyLimit(c),0);
 const activeDailyCapacity=activeSenders.reduce((n,c)=>n+getDailyLimit(c),0);

 const totalMonthlySent=senders.reduce((n,c)=>n+getMonthlySent(c),0);
 const totalMonthlyCapacity=senders.reduce((n,c)=>n+getMonthlyLimit(c),0);
 const activeMonthlyCapacity=activeSenders.reduce((n,c)=>n+getMonthlyLimit(c),0);

 const dailyPercent=totalDailyCapacity>0?Math.min(100,Math.round((totalDailySent/totalDailyCapacity)*100)):0;
 const monthlyPercent=totalMonthlyCapacity>0?Math.min(100,Math.round((totalMonthlySent/totalMonthlyCapacity)*100)):0;

 function edit(c){setInspect(null);setConnection({provider:c.provider,label:c.label,domains:c.domains.join(', '),credentials:{},dailyLimit:c.daily_limit??'',monthlyLimit:c.monthly_limit??'',providerMonthlyLimit:c.provider_monthly_limit??'',providerCycle:c.provider_cycle,providerAnchor:new Date(c.provider_anchor).toISOString(),region:c.settings.region,enabled:c.enabled});setConnectedTab('settings');navigate('Connected');}
 function field(key,value){setConnection(c=>({...c,[key]:value}));}
 async function openThread(id){
  if(selectedThreadId===id){
   setSelectedThreadId(null);
   setThread([]);
   return;
  }
  setSelectedThreadId(id);
  setThreadLoading(true);
  await run(async()=>{
   try{
    setThread(await api('messages?thread='+id));
    await api('read',{thread:id});
   }finally{
    setThreadLoading(false);
   }
  });
 }
 function reply(m){const p=data.personas.find(p=>p.id===m.persona_id)||data.personas.find(p=>p.email===m.to_email)||data.personas[0];setCompose({id:crypto.randomUUID(),personaId:p?.id||'',connectionId:senders.find(c=>c.enabled)?.id||'',to:m.headers?.replyTo||m.from_email,subject:/^re:/i.test(m.subject)?m.subject:'Re: '+m.subject,text:'',parentId:m.id});navigate('Compose');}
 async function deletePersona(p){if(!confirm(`Delete persona "${p.name}" (${p.email})?`))return;await run(async()=>{await api('personas',{action:'delete',id:p.id});await refresh();if(persona.email===p.email)setPersona({name:'',email:''});if(compose.personaId===p.id)setCompose(c=>({...c,personaId:''}));setNotice(`Persona "${p.name}" deleted.`);});}
 async function deleteConnection(c){if(!confirm(`Delete connection "${c.label}" (${providers[c.provider]?.name||c.provider})? This will remove its settings and usage counters.`))return;await run(async()=>{await api('connections',{action:'delete',id:c.id});await refresh();setConnection(initialConnection('brevo'));setInspect(null);if(compose.connectionId===c.id)setCompose(prev=>({...prev,connectionId:''}));setNotice(`Connection "${c.label}" deleted.`);});}
 const availableDailyCapacity=data.dailyCapacity!==undefined?Number(data.dailyCapacity):activeSenders.reduce((n,c)=>n+Math.max(0,getDailyLimit(c)-getDailySent(c)),0);
 const selectedCampaign=(data.campaigns||[]).find(c=>c.id===selectedCampaignId);
 const campaignSelectedPersona=data.personas.find(p=>p.id===campaignMsg.personaId);
 const campaignSelectedDomain=campaignSelectedPersona?campaignSelectedPersona.email.split('@')[1]:null;
 const campaignEligiblePlatforms=campaignSelectedDomain?activeSenders.filter(c=>c.domains.includes(campaignSelectedDomain)):activeSenders;
 const campaignEligibleCapacity=campaignEligiblePlatforms.reduce((n,c)=>n+Math.max(0,getDailyLimit(c)-getDailySent(c)),0);
 const campaignRecipients = selectedCampaign?.recipients || [];
 const campaignUnsubscribed = selectedCampaign?.unsubscribed || [];
 const unsubscribedSet = useMemo(() => new Set(campaignUnsubscribed.map(e => String(e).toLowerCase().trim())), [campaignUnsubscribed]);
 const blacklistSet = useMemo(() => new Set((data.blacklist || []).map(b => String(b.email).toLowerCase().trim())), [data.blacklist]);

 const activeRecipients = useMemo(() => {
  return campaignRecipients.filter(e => {
   const l = String(e).toLowerCase().trim();
   return !unsubscribedSet.has(l) && !blacklistSet.has(l);
  });
 }, [campaignRecipients, unsubscribedSet, blacklistSet]);

 const parentBatch = campaignMsg.parentBatchId 
  ? (selectedCampaign?.messages || []).find(m => m.id === campaignMsg.parentBatchId) 
  : null;
 const isParentScheduled = Boolean(campaignMsg.isFollowUp && parentBatch?.status === 'scheduled');

 const pendingScheduledForCampaign = useMemo(() => {
  return (selectedCampaign?.messages || []).filter(m => m.status === 'scheduled');
 }, [selectedCampaign?.messages]);

 const scheduledDateConflict = useMemo(() => {
  if (campaignMsg.sendMode !== 'schedule' || !campaignMsg.scheduledAt) return null;
  const chosenDateStr = campaignMsg.scheduledAt.slice(0, 10);
  return pendingScheduledForCampaign.find(m => {
   if (!m.scheduled_at) return false;
   const mDateStr = toLocalDatetimeInputStr(new Date(m.scheduled_at)).slice(0, 10);
   return mDateStr === chosenDateStr;
  });
 }, [campaignMsg.sendMode, campaignMsg.scheduledAt, pendingScheduledForCampaign]);

 const isBeforeParentScheduled = useMemo(() => {
  if (!isParentScheduled || campaignMsg.sendMode !== 'schedule' || !campaignMsg.scheduledAt || !parentBatch?.scheduled_at) return false;
  const parentTime = new Date(parentBatch.scheduled_at).getTime();
  const chosenTime = new Date(campaignMsg.scheduledAt).getTime();
  return chosenTime <= parentTime;
 }, [isParentScheduled, campaignMsg.sendMode, campaignMsg.scheduledAt, parentBatch?.scheduled_at]);

 function selectCampaign(c){
  setSelectedCampaignId(c.id);
  setRecipientEditText((c.recipients||[]).join('\n'));
  setEditingRecipients(false);
  setRecipientTab('active');
  setAddingUnsub(false);
  setUnsubInput('');
  router.push('/campaigns/'+campaignSlug(c));
 }
 function backToAllCampaigns(){
  setSelectedCampaignId(null);
  setEditingRecipients(false);
  setRecipientTab('active');
  setAddingUnsub(false);
  setUnsubInput('');
  router.push('/campaigns');
 }
 async function unsubscribeFromCampaign(emailOrList, campaignId = null){
  const targetId = campaignId || selectedCampaign?.id || batchDetailsModal?.batch?.campaign_id;
  if(!targetId)return;
  const list=parseEmailList(emailOrList);
  if(!list.length){setError('Please enter at least one valid email address to unsubscribe.');return;}
  await run(async()=>{
   const res=await api('campaigns/unsubscribe',{campaignId:targetId,emails:list});
   await refresh();
   setAddingUnsub(false);
   setUnsubInput('');
   setNotice(`Added ${res.addedCount||list.length} recipient${(res.addedCount||list.length)===1?'':'s'} to the campaign unsubscribed list. Future follow-ups will exclude them.`);
  });
 }
 async function resubscribeToCampaign(emailOrList, campaignId = null){
  const targetId = campaignId || selectedCampaign?.id || batchDetailsModal?.batch?.campaign_id;
  if(!targetId)return;
  const list=parseEmailList(emailOrList);
  if(!list.length)return;
  await run(async()=>{
   const res=await api('campaigns/resubscribe',{campaignId:targetId,emails:list});
   await refresh();
   setNotice(`Restored ${res.removedCount||list.length} recipient${(res.removedCount||list.length)===1?'':'s'} back to active campaign list.`);
  });
 }
 async function createCampaign(e){e.preventDefault();const parsed=parseEmailList(campaignForm.emails);if(!parsed.length){setError('Please enter at least one valid recipient email address.');return;}if(parsed.length>availableDailyCapacity){setError(`Cannot create campaign: The recipient list contains ${parsed.length} emails, but the total available daily sending capacity across all active platforms is only ${availableDailyCapacity}. Please increase platform limits or reduce your recipient list.`);return;}await run(async()=>{const res=await api('campaigns',{name:campaignForm.name,recipients:parsed});await refresh();setCampaignForm({name:'',emails:''});const removedMsg=res.blacklistedRemovedCount?` (${res.blacklistedRemovedCount} blacklisted email${res.blacklistedRemovedCount===1?' was':'s were'} automatically removed)`:'';setNotice(`Campaign "${campaignForm.name}" created with ${res.campaign?.recipients?.length||parsed.length} recipient${(res.campaign?.recipients?.length||parsed.length)===1?'':'s'}${removedMsg}.`);if(res.campaign?.id){setSelectedCampaignId(res.campaign.id);setRecipientEditText((res.campaign.recipients||[]).join('\n'));router.push('/campaigns/'+campaignSlug(res.campaign));}});}
 async function deleteCampaign(c){if(!confirm(`Delete campaign "${c.name}"? This will also remove its campaign message history.`))return;await run(async()=>{await api('campaigns',{action:'delete',id:c.id});if(selectedCampaignId===c.id){setSelectedCampaignId(null);router.push('/campaigns');}await refresh();setNotice(`Campaign "${c.name}" deleted.`);});}
 async function saveRecipients(c){const parsed=parseEmailList(recipientEditText);if(!parsed.length){setError('Please enter at least one valid recipient email address.');return;}if(parsed.length>availableDailyCapacity){setError(`Cannot update campaign: Recipient list has ${parsed.length} emails, but available daily sending capacity across all active platforms is only ${availableDailyCapacity}.`);return;}await run(async()=>{const res=await api('campaigns',{action:'update',id:c.id,recipients:parsed});await refresh();setEditingRecipients(false);const removedMsg=res.blacklistedRemovedCount?` (${res.blacklistedRemovedCount} blacklisted email${res.blacklistedRemovedCount===1?' was':'s were'} automatically removed)`:'';setNotice(`Updated "${c.name}" with ${res.campaign?.recipients?.length||parsed.length} recipient${(res.campaign?.recipients?.length||parsed.length)===1?'':'s'}${removedMsg}.`);});}
 async function addToBlacklist(e){e.preventDefault();const parsed=parseEmailList(blacklistForm.emails);if(!parsed.length){setError('Please enter at least one valid email address.');return;}await run(async()=>{const res=await api('blacklist',{emails:parsed,reason:blacklistForm.reason});await refresh();setBlacklistForm(f=>({...f,emails:''}));setNotice(`Added ${res.addedCount||parsed.length} email${(res.addedCount||parsed.length)===1?'':'s'} to the blacklist.`);});}
 async function removeFromBlacklist(b){if(!confirm(`Remove "${b.email}" from the blacklist?`))return;await run(async()=>{await api('blacklist',{action:'delete',id:b.id});await refresh();setNotice(`Removed "${b.email}" from the blacklist.`);});}
 async function sendCampaignBroadcast(e){
  e.preventDefault();
  if(!selectedCampaign||!activeRecipients.length){setError('No active recipients found in this campaign (all recipients are either unsubscribed or in the global blacklist).');return;}
  if(campaignMsg.sendMode==='schedule'&&!campaignMsg.scheduledAt){setError('Please select a scheduled date and time for this broadcast.');return;}
  if(scheduledDateConflict){setError(`A ${scheduledDateConflict.is_follow_up?'follow-up':'broadcast'} ("${scheduledDateConflict.subject}") is already scheduled for ${campaignMsg.scheduledAt.slice(0,10)}. Cannot schedule multiple dispatches on the same date.`);return;}
  if(isBeforeParentScheduled){setError(`Follow-up must be scheduled after the parent batch (which is scheduled for ${fmt(parentBatch.scheduled_at)}).`);return;}
  if(isParentScheduled && campaignMsg.sendMode !== 'schedule'){setError('Cannot send an immediate follow-up to a pending scheduled batch. Please schedule the follow-up for a time after the parent batch sends.');return;}
  await run(async()=>{
   const res=await api('campaigns/send',{
    campaignId:selectedCampaign.id,
    personaId:campaignMsg.personaId,
    subject:campaignMsg.subject,
    text:campaignMsg.text,
    scheduledAt:campaignMsg.sendMode==='schedule'?(campaignMsg.scheduledAt?new Date(campaignMsg.scheduledAt).toISOString():undefined):undefined,
    timezone:typeof Intl!=='undefined'?(Intl.DateTimeFormat().resolvedOptions().timeZone||'Africa/Lagos'):'Africa/Lagos',
    isFollowUp:campaignMsg.isFollowUp,
    parentBatchId:campaignMsg.parentBatchId
   });
   await refresh();
   if(res.scheduled){
    setNotice(`Broadcast successfully scheduled for ${new Date(res.scheduledAt).toLocaleString()}! QStash & DailyScheduler will dispatch via waterfall at the designated time.`);
    setCampaignMsg(prev=>({...prev,subject:'',text:'',sendMode:'now',scheduledAt:'',isFollowUp:false,parentBatchId:null}));
   }else{
    const statsStr=res.platformStats&&Object.keys(res.platformStats).length?' ('+Object.entries(res.platformStats).map(([k,v])=>`${v} via ${k}`).join(', ')+')':'';
    if(res.status==='completed'){
     setNotice(`${campaignMsg.isFollowUp?'Follow-up broadcast':'Broadcast'} successfully delivered to all ${res.sentCount} recipient${res.sentCount===1?'':'s'}!${statsStr}`);
     setCampaignMsg(prev=>({...prev,subject:'',text:'',isFollowUp:false,parentBatchId:null}));
    }else if(res.status==='quota-stopped'){
     setNotice(`Sending paused: Daily capacity reached across available platforms. ${res.sentCount} sent, ${res.total-res.sentCount} remaining.${statsStr} ${res.error||''}`);
    }else if(res.status==='partial'){
     setNotice(`Broadcast finished with issues: ${res.sentCount} sent, ${res.failedCount} failed.${statsStr} ${res.error||''}`);
    }else{
     setNotice(`Broadcast status: ${res.status}.${statsStr} ${res.error||''}`);
    }
   }
  });
 }
 async function openBatchDetails(batchId){
  setBatchDetailsLoading(true);
  setBatchDetailsModal(null);
  setBatchDeliveryFilter('all');
  setBatchDeliverySearch('');
  setExpandedDeliveryId(null);
  setResendingDeliveryId(null);
  setDeletingDeliveryId(null);
  setSelectedResendProvider('');
  setIsResendingAll(false);
  try{
   const res=await api(`campaigns/batch-details?id=${batchId}`);
   setBatchDetailsModal(res);
  }catch(e){
   setError(e.message);
  }finally{
   setBatchDetailsLoading(false);
  }
 }
 async function resendDelivery(delivery,connId){
  if(resendingDeliveryId)return;
  setResendingDeliveryId(delivery.id);
  setError('');
  setNotice('');
  try{
   const res=await api('campaigns/resend-delivery',{
    deliveryId:delivery.id,
    connectionId:connId!==undefined ? connId : (selectedResendProvider||undefined)
   });
   setBatchDetailsModal(prev=>{
    if(!prev)return prev;
    const updatedDeliveries=(prev.deliveries||[]).map(d=>{
     if(d.id===delivery.id){
      return res.delivery;
     }
     return d;
    });
    return {
     ...prev,
     batch:res.batch || {
      ...prev.batch,
      sent_count:(prev.batch?.sent_count||0)+1,
      failed_count:Math.max(0,(prev.batch?.failed_count||1)-1),
      status:(prev.batch?.failed_count||1)<=1?'completed':'partial'
     },
     deliveries:updatedDeliveries
    };
   });
   setNotice(`✅ Successfully resent email to ${delivery.recipient}! Moved to Delivered.`);
   refresh().catch(()=>{});
  }catch(err){
   setError(err.message||'Failed to resend email');
  }finally{
   setResendingDeliveryId(null);
  }
 }
 async function resendAllFailed(){
  if(isResendingAll||!batchDetailsModal)return;
  const failedList=(batchDetailsModal.deliveries||[]).filter(d=>d.status==='failed'||d.status==='suppressed');
  if(!failedList.length)return;
  const provLabel=selectedResendProvider?(data.connections.find(c=>c.id===selectedResendProvider)?.label||selectedResendProvider):'Auto Waterfall (Failover)';
  if(!confirm(`Resend all ${failedList.length} failed recipient(s) using "${provLabel}"?`))return;
  setIsResendingAll(true);
  setError('');
  setNotice('');
  try{
   const res=await api('campaigns/resend-all-failed',{
    batchId:batchDetailsModal.batch?.id,
    connectionId:selectedResendProvider||undefined
   });
   setBatchDetailsModal(prev=>({
    ...prev,
    batch:res.batch||prev?.batch,
    deliveries:res.deliveries||prev?.deliveries
   }));
   setNotice(`✅ Resent ${res.resentCount||0} recipient(s) successfully!${res.failedCount?` (${res.failedCount} still failed)`:''}`);
   refresh().catch(()=>{});
  }catch(err){
   setError(err.message||'Failed to resend failed deliveries');
  }finally{
   setIsResendingAll(false);
  }
 }
 async function deleteDelivery(delivery){
  if(!confirm(`Delete delivery log for "${delivery.recipient}"?`))return;
  setDeletingDeliveryId(delivery.id);
  setError('');
  setNotice('');
  try{
   const res=await api('campaigns/delete-delivery',{deliveryId:delivery.id});
   setBatchDetailsModal(prev=>{
    if(!prev)return prev;
    return {
     ...prev,
     batch:res.batch||prev.batch,
     deliveries:(prev.deliveries||[]).filter(d=>d.id!==delivery.id)
    };
   });
   setNotice(`Deleted delivery log for "${delivery.recipient}".`);
   refresh().catch(()=>{});
  }catch(err){
   setError(err.message||'Failed to delete delivery log');
  }finally{
   setDeletingDeliveryId(null);
  }
 }
 function startFollowUp(m){
  const orig=m.subject||'';
  const followSub=/^re:\s*/i.test(orig)?orig:`Re: ${orig}`;
  const isScheduled=m.status==='scheduled';
  let nextScheduledTime='';
  if(isScheduled && m.scheduled_at){
    const nextDay=new Date(new Date(m.scheduled_at).getTime() + 24*60*60*1000);
    nextScheduledTime=toLocalDatetimeInputStr(nextDay);
  }
  setCampaignMsg(prev=>({
   ...prev,
   isFollowUp:true,
   parentBatchId:m.id,
   personaId:m.persona_id||prev.personaId,
   subject:followSub,
   text:'',
   sendMode:isScheduled ? 'schedule' : 'now',
   scheduledAt:isScheduled ? nextScheduledTime : ''
  }));
  if(isScheduled){
   setNotice(`Follow-up schedule mode enabled for Batch "${m.subject}". It is set to dispatch after the parent batch.`);
  } else {
   setNotice(`Follow-up mode set for Batch "${m.subject}". Subsequent emails will thread into each recipient's original message.`);
  }
 }
  const renderThreadContent=()=>{
  if(threadLoading){
   return <div className="card mailbox-thread-loading" style={{padding:'28px 20px',textAlign:'center',color:'var(--muted)'}}>
    <div className="emptyicon" style={{fontSize:'22px',width:'44px',height:'44px',lineHeight:'44px',margin:'0 auto 10px',display:'grid',placeItems:'center'}}>✉️</div>
    <p style={{margin:0,fontSize:'13px',fontWeight:500}}>Loading conversation…</p>
   </div>;
  }
  if(!thread.length){
   return <div className="empty card">
    <div className="emptyicon">▤</div>
    <h2>Select a conversation</h2>
    <p>Read messages and send replies from any platform.</p>
   </div>;
  }
  return thread.map(m=><article className="card message mailbox-message-card" key={m.id}>
   <div className="cardtitle" style={{flexWrap:'wrap',gap:'8px'}}>
    <h3 style={{wordBreak:'break-word',overflowWrap:'anywhere',fontSize:'15px',margin:0,flex:'1 1 auto'}}>{m.subject}</h3>
    <span className={'badge '+(m.status==='accepted'?'green':m.status==='failed'?'error':'')}>{m.status}</span>
   </div>
   <p style={{wordBreak:'break-word',overflowWrap:'anywhere',fontSize:'12.5px',margin:'8px 0'}}><b>{m.from_name||m.from_email}</b> → {m.to_email}</p>
   <small style={{display:'block',color:'var(--muted)',marginBottom:'10px'}}>{fmt(m.created_at)}</small>
   {m.text_body?(
    <div className="messagebody">{m.text_body}</div>
   ):(
    <div className="mailbox-iframe-wrap">
     <iframe title="Email content" sandbox="" referrerPolicy="no-referrer" srcDoc={'<meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>body{font:14px system-ui,-apple-system,sans-serif;line-height:1.6;margin:12px;word-break:break-word;overflow-wrap:anywhere;color:#1a2e26;}</style>'+m.html_body}/>
    </div>
   )}
   {!!m.headers?.attachmentsOmitted&&<p className="hint">{m.headers.attachmentsOmitted} attachment(s) omitted in this text-only version.</p>}
   {m.error&&<p className="error" style={{wordBreak:'break-word'}}>{m.error}</p>}
   <div className="row mailbox-message-actions" style={{flexWrap:'wrap',gap:'10px',marginTop:'14px'}}>
    {m.direction==='in'&&<button onClick={()=>reply(m)}>Reply ↗</button>}
    <details style={{width:'100%',marginTop:'6px'}}>
     <summary>Message details</summary>
     <div style={{marginTop:'8px',padding:'12px',background:'var(--bg)',borderRadius:'6px',border:'1px solid var(--line)'}}>
      <p className="mono">ID: {m.id}</p>
      <p className="mono">Wire Message-ID: {m.message_id||'Not provided by API'}</p>
      <p className="mono">Provider ID: {m.provider_id||'—'}</p>
      {m.direction==='in'&&<form onSubmit={e=>{e.preventDefault();const target=new FormData(e.target).get('target');run(async()=>{await api('link',{id:m.id,target});setThread([]);setSelectedThreadId(null);setNotice('Message linked to the selected conversation.');});}} style={{marginTop:'10px'}}>
       <label>Link to outgoing message ID<input name="target" required placeholder="Paste outgoing message UUID" style={{marginTop:'4px'}}/></label>
       <button disabled={busy} className="secondary" style={{marginTop:'6px',fontSize:'11px',padding:'6px 12px'}}>Link conversation</button>
      </form>}
      {['sending','unknown'].includes(m.status)&&<form onSubmit={e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.target));run(async()=>{await api('reconcile',{id:m.id,...values});setThread(await api('messages?thread='+m.thread_id));await refresh();});}} style={{marginTop:'10px'}}>
       <p style={{fontSize:'11px',color:'var(--muted)',marginBottom:'6px'}}>First verify the outcome in your provider logs. Confirmed failures release reserved capacity.</p>
       <select name="status" style={{marginBottom:'6px'}}><option value="accepted">Provider accepted it</option><option value="failed">Provider confirms it was not sent</option></select>
       <label>Provider ID<input name="providerId" style={{marginTop:'4px',marginBottom:'6px'}}/></label>
       <label>Wire Message-ID (if known)<input name="messageId" style={{marginTop:'4px',marginBottom:'6px'}}/></label>
       <button disabled={busy} style={{fontSize:'11px',padding:'6px 12px'}}>Save confirmed outcome</button>
      </form>}
     </div>
    </details>
   </div>
  </article>);
 };
 function navigate(p){setPage(p);setMobileMenuOpen(false);setError('');setNotice('');if(p==='Compose'&&!compose.id)setCompose(c=>({...c,id:crypto.randomUUID()}));if(p==='Campaigns')setSelectedCampaignId(null);if(p==='Schedules')setSelectedCalDay(null);const targetPath=(p==='Mailbox'?`/mailbox/${folder||'inbox'}`:tabToPath[p])||'/';if(pathname!==targetPath)router.push(targetPath);}
  return <div className="shell">
   {mobileMenuOpen&&<div className="mobile-overlay" onClick={()=>setMobileMenuOpen(false)}/>}
   <aside className={"sidebar"+(mobileMenuOpen?' open':'')}>
    <div className="mobile-topbar">
     <a className="brand" href="/" onClick={()=>setMobileMenuOpen(false)}><span className="brandmark">E</span>EmailSender<span className="branddot">.</span></a>
     <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
      <span className="badge" style={{textTransform:'uppercase',fontSize:'10px',letterSpacing:'0.5px'}}>{(page==='Connections'?'CONNECTED':page)}</span>
      <button type="button" className="hamburger-btn" aria-label={mobileMenuOpen?"Close navigation menu":"Open navigation menu"} aria-expanded={mobileMenuOpen} onClick={()=>setMobileMenuOpen(v=>!v)}>
       {mobileMenuOpen?'✕':'☰'}
      </button>
     </div>
    </div>
    <div className="desktop-brand">
     <a className="brand" href="/"><span className="brandmark">E</span>EmailSender<span className="branddot">.</span></a>
    </div>
    <div className="sidebar-content">
     <p className="navlabel">WORKSPACE</p>
     <nav>{[['Overview','◫'],['Campaigns','📢'],['Blacklist','⊘'],['Schedules','📅'],['Connected','⇄'],['Personas','◎'],['Compose','↗'],['Mailbox','▤'],['Deployment','⌘']].map(([p,icon])=><button key={p} className={(page===p||(p==='Connected'&&page==='Connections'))?'active':''} onClick={()=>{if(p==='Connected')setConnectedTab('capacity');if(p==='Campaigns')setSelectedCampaignId(null);if(p==='Schedules')setSelectedCalDay(null);navigate(p);}}><span>{icon}</span>{p}{p==='Connected'&&<small>{senders.length}</small>}{p==='Campaigns'&&<small>{(data.campaigns||[]).length}</small>}{p==='Blacklist'&&<small>{(data.blacklist||[]).length}</small>}{p==='Schedules'&&<small>{(data.scheduledBroadcasts||[]).length}</small>}</button>)}</nav>
     <div className="sidebarfoot"><span className="dot"/>Private workspace<p>Vercel · Neon · Cloudflare</p><button className="link" onClick={()=>run(async()=>{await api('logout',{});location.href='/login';})}>Sign out</button></div>
    </div>
   </aside><main><header><div><p className="eyebrow">{page==='Campaigns'&&selectedCampaign?`EMAIL WORKSPACE / CAMPAIGNS / ${selectedCampaign.name.toUpperCase()}`:`EMAIL WORKSPACE / ${(page==='Connections'?'CONNECTED':page).toUpperCase()}`}</p><h1>{page==='Campaigns'&&selectedCampaign?selectedCampaign.name:({Overview:'Your mail, connected.',Campaigns:'Targeted email broadcasts.',Blacklist:'Excluded recipients & protection.',Schedules:'Planned dispatches & calendar capacity.',Connected:'Platform capacity and usage.',Connections:'Connect your platforms.',Personas:'Choose who you send as.',Compose:'A new conversation.',Mailbox:'Your conversations.',Deployment:'Ready to go live.'})[page]}</h1></div><div style={{display:'flex',gap:'10px',alignItems:'center',flexWrap:'wrap'}}>{pushState.supported&&<button type="button" className={pushState.registered?'secondary':''} style={{display:'inline-flex',alignItems:'center',gap:'6px',fontSize:'12px',padding:'8px 14px',borderColor:pushState.registered?'var(--green)':undefined,color:pushState.registered?'var(--green)':undefined,cursor:'pointer'}} disabled={pushBusy} onClick={togglePushNotifications} title={pushState.registered?'Push notifications are active on this browser (click to disable)':'Enable push notifications for incoming emails on this browser'}>{pushBusy?'Updating…':(pushState.registered?'✓ Push Active':'🔔 Enable Push')}</button>}<button onClick={()=>navigate('Compose')}>+ Compose email</button></div></header>{error&&<div role="alert" className="alert error">{error}</div>}{notice&&<div role="status" className="alert success">{notice}</div>}{loading&&<p className="muted">Loading your workspace…</p>}
 {page==='Overview'&&<><section className="stats"><div className="card"><p>Daily sent / Capacity</p><strong>{totalDailySent.toLocaleString()}<small> / {totalDailyCapacity>0?totalDailyCapacity.toLocaleString():'No limit'}</small></strong><progress max={totalDailyCapacity||1} value={totalDailyCapacity?totalDailySent:0}/><div style={{display:'flex',justifyContent:'space-between',fontSize:'11px',color:'var(--muted)',marginTop:'6px'}}><span>{totalDailyCapacity>0?`${Math.max(0,totalDailyCapacity-totalDailySent).toLocaleString()} remaining today`:'No daily cap'}</span><span>{dailyPercent}% used</span></div>{senders.length>0&&activeSenders.length!==senders.length&&<small style={{display:'block',marginTop:'5px',color:'#b07d12'}}>{activeDailyCapacity.toLocaleString()} active capacity ({activeSenders.length}/{senders.length} enabled)</small>}</div><div className="card"><p>Monthly sent / Capacity</p><strong>{totalMonthlySent.toLocaleString()}<small> / {totalMonthlyCapacity>0?totalMonthlyCapacity.toLocaleString():'No limit'}</small></strong><progress max={totalMonthlyCapacity||1} value={totalMonthlyCapacity?totalMonthlySent:0}/><div style={{display:'flex',justifyContent:'space-between',fontSize:'11px',color:'var(--muted)',marginTop:'6px'}}><span>{totalMonthlyCapacity>0?`${Math.max(0,totalMonthlyCapacity-totalMonthlySent).toLocaleString()} remaining`:'No monthly cap'}</span><span>{monthlyPercent}% used</span></div>{senders.length>0&&activeSenders.length!==senders.length&&<small style={{display:'block',marginTop:'5px',color:'#b07d12'}}>{activeMonthlyCapacity.toLocaleString()} active capacity ({activeSenders.length}/{senders.length} enabled)</small>}</div><div className="card"><p>Connected platforms</p><strong>{activeSenders.length}<small> / {senders.length} active</small></strong><p style={{fontSize:'12px',color:'var(--muted)',margin:'10px 0 10px'}}>{data.personas.length} persona{data.personas.length===1?'':'s'} configured</p><button className="link" onClick={()=>{setConnectedTab('capacity');navigate('Connected');}}>View platform details →</button></div></section><div className="sectiontitle"><div><h2>Sending capacity overview</h2><p className="muted">Combined sending quota calculated across your connected platforms.</p></div><div style={{display:'flex',gap:'10px'}}><button className="secondary" onClick={()=>run(refresh)}>Refresh</button><button onClick={()=>{setConnectedTab('capacity');navigate('Connected');}}>View Connected Page →</button></div></div>{!senders.length?<div className="empty card"><div className="emptyicon">⇄</div><h2>Your first connection starts here.</h2><p>Add a sending provider, verify your domain, then create your persona.</p><button onClick={()=>{setConnectedTab('settings');navigate('Connected');}}>Connect a platform →</button></div>:<div className="card" style={{padding:'24px'}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:'16px',marginBottom:'20px'}}><div><h3 style={{fontSize:'17px',marginBottom:'4px'}}>Platforms Capacity Breakdown</h3><p className="muted" style={{margin:0}}>{senders.length} connected platform{senders.length===1?'':'s'} ({activeSenders.length} active) providing {totalDailyCapacity.toLocaleString()} daily and {totalMonthlyCapacity.toLocaleString()} monthly sending capacity.</p></div><button className="link" onClick={()=>{setConnectedTab('capacity');navigate('Connected');}}>Full platform meters & reset schedules →</button></div><div style={{display:'grid',gap:'10px'}}>{senders.map(c=>{const dUsed=getDailySent(c),dLimit=getDailyLimit(c),mUsed=getMonthlySent(c),mLimit=getMonthlyLimit(c);return <div key={c.id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 16px',background:'var(--bg)',borderRadius:'8px',gap:'16px',flexWrap:'wrap'}}><div style={{display:'flex',alignItems:'center',gap:'10px',minWidth:'170px'}}><div><b style={{fontSize:'14px',display:'block'}}>{c.label}</b><span className="muted" style={{fontSize:'11px'}}>{c.domains.join(', ')}</span></div><span className={'badge '+(c.enabled?'green':'')} style={{marginLeft:'auto'}}>{c.enabled?'Enabled':'Paused'}</span></div><div style={{display:'flex',gap:'20px',fontSize:'12px',alignItems:'center'}}><div><span className="muted" style={{fontSize:'10px',display:'block',textTransform:'uppercase',letterSpacing:'0.5px'}}>Daily allowance</span><b>{dUsed} / {dLimit||'No cap'}</b></div><div><span className="muted" style={{fontSize:'10px',display:'block',textTransform:'uppercase',letterSpacing:'0.5px'}}>Monthly allowance</span><b>{mUsed} / {mLimit||'No cap'}</b></div></div><button className="link" style={{fontSize:'12px'}} onClick={()=>edit(c)}>Manage settings →</button></div>;})}</div><p className="footnote" style={{marginTop:'18px'}}>Quotas are shared by every persona. Provider approval, external usage, hourly limits and actual billing periods may reduce available capacity. For detailed per-platform usage meters and reset timestamps, visit the <button className="link" style={{display:'inline',padding:0,fontSize:'inherit'}} onClick={()=>{setConnectedTab('capacity');navigate('Connected');}}>Connected page</button>.</p></div>}</>}
 {page==='Campaigns'&&<>
  {selectedCampaign?(
   <div>
    <div className="campaign-header-row">
     <div className="campaign-title-group">
      <button className="secondary" onClick={backToAllCampaigns}>← All Campaigns</button>
      <h2>{selectedCampaign.name}</h2>
      <span className="campaign-slug-badge">/campaigns/{campaignSlug(selectedCampaign)}</span>
     </div>
     <div className="campaign-meta-actions">
      <span className="badge green">{activeRecipients.length} active recipient{(activeRecipients.length===1)?'':'s'}</span>
      {campaignUnsubscribed.length > 0 && <span className="badge" style={{background:'#fee2e2',color:'#991b1b'}}>{campaignUnsubscribed.length} unsubscribed</span>}
      <button type="button" className="btn-delete" disabled={busy} onClick={()=>deleteCampaign(selectedCampaign)}><FiTrash2 size={13}/> Delete Campaign</button>
     </div>
    </div>
    <div className="columns">
     <form className="card form composer" onSubmit={sendCampaignBroadcast}>
      {campaignMsg.isFollowUp&&(
       <div style={{background:isParentScheduled?'#fef3c7':'#eff6ff',border:`1px solid ${isParentScheduled?'#fde68a':'#bfdbfe'}`,borderRadius:'8px',padding:'12px 14px',marginBottom:'16px',display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:'10px',maxWidth:'100%',boxSizing:'border-box'}}>
        <div style={{minWidth:0,flex:'1 1 auto'}}>
         <strong style={{color:isParentScheduled?'#92400e':'#1e40af',fontSize:'12px',letterSpacing:'0.4px',display:'block'}}>
          {isParentScheduled ? 'FOLLOW-UP TO PENDING SCHEDULED BATCH' : 'FOLLOW-UP THREADING ENABLED'}
         </strong>
         <span style={{color:isParentScheduled?'#78350f':'#1e3a8a',fontSize:'12px',wordBreak:'break-word',overflowWrap:'anywhere'}}>
          {isParentScheduled 
            ? `This follow-up will thread into Batch "${parentBatch?.subject || 'Scheduled Batch'}" (scheduled for ${fmt(parentBatch?.scheduled_at)}). It must be scheduled for a date after the parent batch.`
            : `This broadcast will be sent directly in the same conversation thread as Batch "${parentBatch?.subject || 'Previous Batch'}".`
          }
         </span>
        </div>
        <button type="button" className="secondary" style={{padding:'4px 10px',fontSize:'11px',flexShrink:0}} onClick={()=>setCampaignMsg(prev=>({...prev,isFollowUp:false,parentBatchId:null,subject:''}))}>
         ✕ Cancel Follow-up
        </button>
       </div>
      )}
      <h3 style={{fontSize:'18px',marginBottom:'4px'}}>{campaignMsg.isFollowUp ? (isParentScheduled ? 'Schedule a follow-up batch' : 'Send a follow-up batch') : 'Send a message to this campaign'}</h3>
      <p className="muted" style={{marginBottom:'16px'}}>{campaignMsg.isFollowUp ? 'Follow-up emails will be delivered in the same thread as your previous email.' : 'A personalized individual copy will be sent to every recipient in this campaign.'}</p>
      <div style={{background:'var(--bg)',borderRadius:'6px',padding:'8px 12px',border:'1px solid var(--line)',marginBottom:'14px',display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:'6px',fontSize:'12px'}}>
       <span>Target: <b style={{color:'var(--green)'}}>{activeRecipients.length} active recipient{activeRecipients.length===1?'':'s'}</b></span>
       {campaignUnsubscribed.length > 0 && <span className="muted">({campaignUnsubscribed.length} excluded by campaign unsubscribed list)</span>}
      </div>
      <label>Sender persona
       <select required value={campaignMsg.personaId} onChange={e=>setCampaignMsg({...campaignMsg,personaId:e.target.value})}>
        <option value="">Choose a persona to send as</option>
        {data.personas.map(p=><option value={p.id} key={p.id}>{p.name} — {p.email}</option>)}
       </select>
      </label>
      <div style={{background:'var(--bg)',borderRadius:'8px',padding:'12px 14px',border:'1px solid var(--line)',marginBottom:'14px',maxWidth:'100%',boxSizing:'border-box'}}>
       <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'4px',flexWrap:'wrap',gap:'6px'}}>
        <strong style={{fontSize:'12px',letterSpacing:'0.3px'}}>PLATFORM AUTO-ALLOCATION</strong>
        <span className="badge green" style={{fontSize:'11px'}}>Daily Capacity Waterfall</span>
       </div>
       <p className="muted" style={{fontSize:'12px',margin:0,lineHeight:'1.4'}}>
        All connected platforms participate automatically. Emails fill Platform 1 to its daily capacity, then overflow to the next platform.
       </p>
       {campaignSelectedPersona && (
        <div style={{marginTop:'8px',paddingTop:'8px',borderTop:'1px dashed var(--line)',fontSize:'12px'}}>
         {campaignEligiblePlatforms.length > 0 ? (
          <div style={{display:'flex',flexWrap:'wrap',gap:'6px',alignItems:'center'}}>
           <span className="muted" style={{fontSize:'11px'}}>Pool for {campaignSelectedDomain} ({campaignEligibleCapacity} capacity today):</span>
           {campaignEligiblePlatforms.map(c => {
            const rem = Math.max(0, getDailyLimit(c) - getDailySent(c));
            return (
             <span key={c.id} className="badge" style={{background:'#fff',border:'1px solid var(--line)',fontSize:'11px',padding:'3px 7px'}}>
              <b>{c.label}</b>: {rem} left
             </span>
            );
           })}
          </div>
         ) : (
          <p className="error" style={{margin:0,fontSize:'12px'}}>
           ⚠️ No active platforms have verified the domain &quot;{campaignSelectedDomain}&quot;. Please enable or verify this domain in Connected.
          </p>
         )}
        </div>
       )}
      </div>
      <label>Subject
       <input required maxLength="255" value={campaignMsg.subject} onChange={e=>setCampaignMsg({...campaignMsg,subject:e.target.value})} placeholder="Subject line for campaign broadcast"/>
      </label>
      <label>Message
       <textarea required rows="8" maxLength="100000" value={campaignMsg.text} onChange={e=>setCampaignMsg({...campaignMsg,text:e.target.value})} placeholder="Write the email message for your recipients…"/>
      </label>
      <div style={{background:'var(--bg)',borderRadius:'8px',padding:'12px 14px',border:'1px solid var(--line)',marginBottom:'14px',maxWidth:'100%',boxSizing:'border-box'}}>
       <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'8px',flexWrap:'wrap',gap:'6px'}}>
        <strong style={{fontSize:'12px',letterSpacing:'0.3px'}}>DISPATCH SCHEDULE</strong>
        <span className={'badge '+(campaignMsg.sendMode==='schedule'?'':'green')} style={{fontSize:'11px'}}>
         {campaignMsg.sendMode==='schedule'?'QStash Scheduled Delivery':'Immediate Waterfall'}
        </span>
       </div>
       <div className="campaign-dispatch-options">
        <label style={{display:'flex',alignItems:'center',gap:'6px',cursor:isParentScheduled?'not-allowed':'pointer',fontWeight:'normal',opacity:isParentScheduled?0.6:1}}>
         <input type="radio" name="sendMode" disabled={isParentScheduled} checked={campaignMsg.sendMode==='now'} onChange={()=>setCampaignMsg({...campaignMsg,sendMode:'now'})}/>
         Send Immediately {isParentScheduled && <span style={{fontSize:'11px',color:'var(--muted)'}}>(Parent is scheduled)</span>}
        </label>
        <label style={{display:'flex',alignItems:'center',gap:'6px',cursor:'pointer',fontWeight:'normal'}}>
         <input type="radio" name="sendMode" checked={campaignMsg.sendMode==='schedule'} onChange={()=>setCampaignMsg({...campaignMsg,sendMode:'schedule'})}/>
         Schedule for Date & Time ⏱
        </label>
       </div>
       {isParentScheduled && (
        <div style={{background:'#fef3c7',border:'1px solid #fde68a',color:'#92400e',borderRadius:'6px',padding:'8px 12px',fontSize:'12px',marginTop:'8px'}}>
         Parent Batch &quot;{parentBatch?.subject}&quot; is scheduled for {fmt(parentBatch?.scheduled_at)}. This follow-up must be scheduled for a date after the parent batch, and on a date with no other scheduled dispatches for this campaign.
        </div>
       )}
       {campaignMsg.sendMode==='schedule'&&(
        <div style={{marginTop:'8px',paddingTop:'8px',borderTop:'1px dashed var(--line)'}}>
         <label style={{margin:0,fontSize:'12px'}}>Scheduled Date & Time (Your Local Time)
          <input 
           type="datetime-local" 
           required={campaignMsg.sendMode==='schedule'} 
           value={campaignMsg.scheduledAt} 
           min={toLocalDatetimeInputStr(isParentScheduled && parentBatch?.scheduled_at ? new Date(new Date(parentBatch.scheduled_at).getTime() + 60000) : (Date.now()+60000))} 
           onChange={e=>setCampaignMsg({...campaignMsg,scheduledAt:e.target.value})}
          />
         </label>
         {scheduledDateConflict && (
          <div style={{background:'#fee2e2',border:'1px solid #fecaca',color:'#991b1b',borderRadius:'6px',padding:'8px 12px',fontSize:'12px',marginTop:'8px'}}>
           ⚠️ A {scheduledDateConflict.is_follow_up ? 'follow-up' : 'broadcast'} (&quot;{scheduledDateConflict.subject}&quot;) is already scheduled for {campaignMsg.scheduledAt.slice(0, 10)}. A campaign cannot have multiple pending dispatches scheduled on the same date.
          </div>
         )}
         {isBeforeParentScheduled && (
          <div style={{background:'#fee2e2',border:'1px solid #fecaca',color:'#991b1b',borderRadius:'6px',padding:'8px 12px',fontSize:'12px',marginTop:'8px'}}>
           ⚠️ Follow-up must be scheduled for after the parent batch ({fmt(parentBatch?.scheduled_at)}).
          </div>
         )}
         <p className="muted" style={{fontSize:'11px',margin:'6px 0 0'}}>
          Checked against daily capacity for that scheduled date. Picked up by DailyScheduler at 2am and triggered at exact time via QStash.
         </p>
        </div>
       )}
      </div>
      <div className="composerfoot">
        <button type="button" className="secondary" disabled={busy} onClick={()=>setCampaignMsg(prev=>({...prev,subject:'',text:'',sendMode:'now',scheduledAt:'',isFollowUp:false,parentBatchId:null}))}>Clear</button>
        <p className="muted">Dispatched individually · Deduplicated · Tracked</p>
        <button disabled={busy||!activeRecipients.length||(campaignMsg.sendMode==='schedule'&&(!campaignMsg.scheduledAt||scheduledDateConflict||isBeforeParentScheduled))}>
         {busy ? (campaignMsg.sendMode==='schedule'?'Scheduling…':'Broadcasting…') : (campaignMsg.sendMode==='schedule'?`Schedule for ${activeRecipients.length} active recipient${activeRecipients.length===1?'':'s'} ⏱`:(campaignMsg.isFollowUp?`Send Follow-up to ${activeRecipients.length} recipient${activeRecipients.length===1?'':'s'} ↩`:`Send to all ${activeRecipients.length} recipient${activeRecipients.length===1?'':'s'} ↗`))}
        </button>
       </div>
      </form>
     <div className="campaign-right-column" style={{display:'flex',flexDirection:'column',gap:'20px',width:'100%',maxWidth:'100%',minWidth:0,boxSizing:'border-box',overflowX:'hidden'}}>
      <div className="card">
       <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'12px',flexWrap:'wrap',gap:'10px'}}>
        <div>
         <h3 style={{margin:0}}>Campaign Recipients</h3>
         <small className="muted">{activeRecipients.length} active / {campaignRecipients.length} total</small>
        </div>
        {!editingRecipients && recipientTab === 'active' && (
         <button className="secondary" style={{padding:'6px 14px',fontSize:'12px'}} onClick={()=>{setRecipientEditText((selectedCampaign.recipients||[]).join('\n'));setEditingRecipients(true);}}>
          Edit / Add emails
         </button>
        )}
       </div>

       <div style={{display:'flex',gap:'6px',marginBottom:'12px',borderBottom:'1px solid var(--line)',paddingBottom:'8px'}}>
        <button 
         type="button" 
         className={recipientTab === 'active' ? '' : 'secondary'} 
         style={{padding:'4px 10px',fontSize:'12px'}} 
         onClick={()=>{setRecipientTab('active');setEditingRecipients(false);}}
        >
         Active Recipients ({activeRecipients.length})
        </button>
        <button 
         type="button" 
         className={recipientTab === 'unsubscribed' ? '' : 'secondary'} 
         style={{padding:'4px 10px',fontSize:'12px'}} 
         onClick={()=>{setRecipientTab('unsubscribed');setEditingRecipients(false);}}
        >
         Unsubscribed List ({campaignUnsubscribed.length})
        </button>
       </div>

       {recipientTab === 'active' ? (
        !editingRecipients ? (
         <>
          <p className="muted" style={{fontSize:'12px',margin:'0 0 8px'}}>
           Eligible for future broadcasts and follow-ups. Click <b>⊘</b> to unsubscribe an email from this campaign.
          </p>
          <div style={{maxHeight:'220px',overflowY:'auto',background:'var(--bg)',borderRadius:'8px',padding:'12px',display:'flex',flexWrap:'wrap',gap:'6px',maxWidth:'100%',boxSizing:'border-box',overflowX:'hidden'}}>
           {activeRecipients.map((addr,i)=>(
            <span key={i} className="badge recipient-tag" style={{display:'inline-flex',alignItems:'center',gap:'6px'}}>
             <span>{addr}</span>
             <button 
              type="button" 
              style={{background:'none',border:'none',color:'#991b1b',cursor:'pointer',padding:0,fontSize:'12px',lineHeight:1}} 
              title="Unsubscribe from this campaign (exclude from future follow-ups)"
              onClick={async (e)=>{
               e.stopPropagation();
               if(confirm(`Exclude "${addr}" from future follow-up broadcasts in this campaign?`)){
                await unsubscribeFromCampaign(addr);
               }
              }}
             >
              ⊘
             </button>
            </span>
           ))}
           {!activeRecipients.length && (
            <span className="muted" style={{fontSize:'12px'}}>No active recipients. All recipients are either unsubscribed or in the global blacklist.</span>
           )}
          </div>
         </>
        ) : (
         <div className="form">
          <label>Edit recipient emails (one per line, comma or semicolon)
           <textarea rows="8" value={recipientEditText} onChange={e=>setRecipientEditText(e.target.value)} placeholder="alice@example.com&#10;bob@example.com"/>
          </label>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:'10px'}}>
           <small className="muted">{parseEmailList(recipientEditText).length} valid email(s)</small>
           <div style={{display:'flex',gap:'8px'}}>
            <button type="button" className="secondary" style={{padding:'6px 12px',fontSize:'12px'}} onClick={()=>setEditingRecipients(false)}>Cancel</button>
            <button type="button" style={{padding:'6px 14px',fontSize:'12px'}} disabled={busy} onClick={()=>saveRecipients(selectedCampaign)}>Save recipients</button>
           </div>
          </div>
         </div>
        )
       ) : (
        <div>
         <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'8px',flexWrap:'wrap',gap:'6px'}}>
          <p className="muted" style={{fontSize:'12px',margin:0}}>
           These emails are kept in the campaign, but will be <b>skipped</b> during all future broadcasts & follow-ups.
          </p>
          {!addingUnsub && (
           <button type="button" className="secondary" style={{padding:'4px 10px',fontSize:'11px'}} onClick={()=>setAddingUnsub(true)}>
            + Add to Unsubscribed
           </button>
          )}
         </div>
         {addingUnsub && (
          <div style={{background:'var(--bg)',border:'1px solid var(--line)',borderRadius:'8px',padding:'10px',marginBottom:'10px'}}>
           <label style={{fontSize:'12px',margin:0,display:'block'}}>Add email(s) to exclude from future follow-ups:
            <textarea rows="3" style={{marginTop:'4px',width:'100%'}} value={unsubInput} onChange={e=>setUnsubInput(e.target.value)} placeholder="user@example.com&#10;another@example.com"/>
           </label>
           <div style={{display:'flex',justifyContent:'flex-end',gap:'6px',marginTop:'6px'}}>
            <button type="button" className="secondary" style={{padding:'4px 10px',fontSize:'11px'}} onClick={()=>{setAddingUnsub(false);setUnsubInput('');}}>Cancel</button>
            <button type="button" style={{padding:'4px 12px',fontSize:'11px'}} disabled={busy||!unsubInput.trim()} onClick={()=>unsubscribeFromCampaign(unsubInput)}>Save to Unsubscribed</button>
           </div>
          </div>
         )}
         <div style={{maxHeight:'220px',overflowY:'auto',background:'var(--bg)',borderRadius:'8px',padding:'12px',display:'flex',flexWrap:'wrap',gap:'6px',maxWidth:'100%',boxSizing:'border-box',overflowX:'hidden'}}>
          {campaignUnsubscribed.map((addr,i)=>(
           <span key={i} className="badge" style={{background:'#fee2e2',color:'#991b1b',display:'inline-flex',alignItems:'center',gap:'6px',fontSize:'11px'}}>
            <span>{addr}</span>
            <button 
             type="button" 
             className="link" 
             style={{fontSize:'11px',color:'var(--green)',padding:0,fontWeight:'bold'}} 
             title="Restore to active campaign list"
             onClick={()=>resubscribeToCampaign(addr)}
            >
             ✓ Restore
            </button>
           </span>
          ))}
          {!campaignUnsubscribed.length && (
           <span className="muted" style={{fontSize:'12px'}}>No emails in this campaign's unsubscribed list.</span>
          )}
         </div>
        </div>
       )}
      </div>
      <div className="card batch-dispatches-card" style={{width:'100%',maxWidth:'100%',minWidth:0,boxSizing:'border-box',overflowX:'hidden'}}>
       <h3 style={{marginBottom:'4px',wordBreak:'break-word',overflowWrap:'anywhere'}}>Campaign Batches & Dispatches</h3>
       <p className="muted" style={{fontSize:'12px',margin:'0 0 12px'}}>{(selectedCampaign.messages||[]).length} batch{(selectedCampaign.messages?.length===1)?'':'es'} dispatched</p>
       {!(selectedCampaign.messages||[]).length?(
        <p className="muted" style={{fontSize:'13px',margin:0}}>No batches sent yet. Use the composer on the left to send your first message to this campaign.</p>
       ):(
        <div className="batch-dispatches-list" style={{display:'grid',gap:'12px',maxHeight:'380px',overflowY:'auto',overflowX:'hidden',width:'100%',maxWidth:'100%',minWidth:0,boxSizing:'border-box'}}>
         {selectedCampaign.messages.map((m,idx)=>{
          const batchNumber = selectedCampaign.messages.length - idx;
          const stats = m.platform_stats && typeof m.platform_stats === 'object' && Object.keys(m.platform_stats).length > 0 ? m.platform_stats : null;
          return (
           <div key={m.id} className="batch-history-card" style={{padding:'13px 14px',background:'var(--bg)',borderRadius:'8px',border:'1px solid var(--line)',width:'100%',maxWidth:'100%',minWidth:0,boxSizing:'border-box',overflowX:'hidden'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:'8px',flexWrap:'wrap'}}>
             <div style={{minWidth:0,flex:'1 1 auto'}}>
              <div style={{display:'flex',alignItems:'center',gap:'6px',flexWrap:'wrap',marginBottom:'4px'}}>
               <span className="badge" style={{fontWeight:'700',fontSize:'10px'}}>Batch #{batchNumber}</span>
               {m.is_follow_up && <span className="badge" style={{background:'#dbeafe',color:'#1e40af',fontSize:'10px'}}>↳ Follow-up</span>}
               <b style={{fontSize:'13px',wordBreak:'break-word',overflowWrap:'anywhere'}}>{m.subject}</b>
              </div>
             </div>
             <div style={{display:'flex',gap:'6px',alignItems:'center',flexShrink:0}}>
              <span className={'badge '+(m.status==='completed'?'green':m.status==='scheduled'?'':m.status==='quota-stopped'?'':m.status==='failed'?'danger':'')}>{m.status}</span>
              {m.status==='scheduled'&&<button type="button" className="link danger" style={{fontSize:'11px'}} onClick={()=>cancelScheduledBroadcast(m.id)}>Cancel</button>}
             </div>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',fontSize:'11px',color:'var(--muted)',marginTop:'6px',flexWrap:'wrap',gap:'6px'}}>
             <span>{m.sent_count} sent · {m.failed_count} failed ({m.total_recipients} total)</span>
             <time>{m.scheduled_at ? `Scheduled: ${fmt(m.scheduled_at)}` : fmt(m.created_at)}</time>
            </div>
            {stats && (
             <div style={{marginTop:'6px',display:'flex',flexWrap:'wrap',gap:'4px'}}>
              {Object.entries(stats).map(([plat, count]) => (
               <span key={plat} className="badge" style={{background:'#fff',border:'1px solid var(--line)',fontSize:'10px',padding:'2px 6px'}}>
                {count} via {plat}
               </span>
              )) }
             </div>
            )}
            {m.text_body&&<p style={{fontSize:'12px',color:'var(--muted)',margin:'8px 0 0',display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',overflow:'hidden',wordBreak:'break-word',overflowWrap:'anywhere',maxWidth:'100%',minWidth:0,lineHeight:1.4}}>{m.text_body}</p>}
            <div className="batch-action-row" style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:'12px',paddingTop:'10px',borderTop:'1px dashed var(--line)',flexWrap:'wrap',gap:'8px'}}>
             <button type="button" className="secondary batch-action-btn" style={{padding:'6px 11px',fontSize:'11px'}} onClick={()=>openBatchDetails(m.id)}>
              📊 View Batch Details
             </button>
             <button type="button" className="secondary batch-action-btn" style={{padding:'6px 11px',fontSize:'11px',color:'var(--green)'}} onClick={()=>startFollowUp(m)}>
              {m.status==='scheduled' ? '↩ Schedule Follow-up' : '↩ Send Follow-up'}
             </button>
            </div>
           </div>
          );
         })}
        </div>
       )}
      </div>
     </div>
    </div>
   </div>
  ):(
   <div className="columns">
    <section>
     <div className="sectiontitle">
      <h2>Your Campaigns</h2>
      <button className="secondary" onClick={()=>run(refresh)}>Refresh</button>
     </div>
     {!(data.campaigns||[]).length?(
      <div className="empty card">
       <div className="emptyicon">📢</div>
       <h2>No campaigns yet</h2>
       <p>Create a campaign to group recipient emails and send broadcast messages in one click.</p>
      </div>
     ):(
      <div style={{display:'grid',gap:'14px'}}>
       {(data.campaigns||[]).map(c=>(
        <div key={c.id} className="card campaign-list-card" onClick={()=>selectCampaign(c)}>
         <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:'12px'}}>
          <div>
           <h3 style={{fontSize:'18px',margin:'0 0 4px',fontWeight:'600'}}>{c.name}</h3>
           <p className="muted" style={{fontSize:'12px',margin:0}}>Created {new Date(c.created_at).toLocaleDateString()} · {(c.messages||[]).length} broadcast{(c.messages?.length===1)?'':'s'}</p>
           <span className="campaign-slug-badge">/campaigns/{campaignSlug(c)}</span>
          </div>
          <span className="badge green">{(c.recipients||[]).length} recipient{(c.recipients?.length===1)?'':'s'}</span>
         </div>
         <div className="campaign-card-footer" onClick={e=>e.stopPropagation()}>
          <button onClick={()=>selectCampaign(c)}>Open campaign & send →</button>
          <button type="button" className="btn-delete" disabled={busy} onClick={()=>deleteCampaign(c)}><FiTrash2 size={13}/> Delete</button>
         </div>
        </div>
       ))}
      </div>
     )}
    </section>
    <form className="card form" onSubmit={createCampaign}>
     <h2>Create a campaign</h2>
     <div style={{background:'var(--bg)',borderRadius:'8px',padding:'12px',border:'1px solid var(--line)',marginBottom:'14px'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
       <span style={{fontSize:'12px',fontWeight:'600'}}>Available Daily Sending Capacity</span>
       <span className="badge green">{availableDailyCapacity.toLocaleString()} emails today</span>
      </div>
      <p className="muted" style={{fontSize:'11px',margin:'4px 0 0'}}>Across all {activeSenders.length} active platform{activeSenders.length===1?'':'s'}. Campaigns cannot exceed available daily quota.</p>
     </div>
     <label>Campaign name
      <input required value={campaignForm.name} onChange={e=>setCampaignForm({...campaignForm,name:e.target.value})} placeholder="e.g. VIP Newsletter, Beta Users"/>
     </label>
     <label>Recipient emails (one per line, comma or semicolon separated)
      <textarea required rows="10" value={campaignForm.emails} onChange={e=>setCampaignForm({...campaignForm,emails:e.target.value})} placeholder="alice@example.com&#10;bob@example.com&#10;carol@example.com"/>
     </label>
     <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'12px'}}>
      <small className={parseEmailList(campaignForm.emails).length > availableDailyCapacity ? 'error' : 'muted'}>
       {parseEmailList(campaignForm.emails).length} valid email(s) detected
       {parseEmailList(campaignForm.emails).length > availableDailyCapacity && ` (Exceeds capacity by ${parseEmailList(campaignForm.emails).length - availableDailyCapacity})`}
      </small>
     </div>
     {parseEmailList(campaignForm.emails).length > availableDailyCapacity && (
      <div className="alert error" style={{marginBottom:'12px',fontSize:'13px'}}>
       Capacity exceeded: You entered {parseEmailList(campaignForm.emails).length} emails, but only {availableDailyCapacity} daily capacity remains today. Reduce emails or increase platform limits.
      </div>
     )}
     <p className="muted">Emails will be automatically allocated across your platforms up to each platform&apos;s daily capacity.</p>
     <button disabled={busy||!campaignForm.name.trim()||!parseEmailList(campaignForm.emails).length||parseEmailList(campaignForm.emails).length > availableDailyCapacity}>Create campaign</button>
    </form>
   </div>
  )}
 </>}
 {page==='Schedules'&&(()=>{
  const monthNames=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const daysInMonth=new Date(calYear,calMonth,0).getDate();
  const firstDayOfWeek=new Date(calYear,calMonth-1,1).getDay();
  const prevMonthDays=new Date(calYear,calMonth-1,0).getDate();
  const todayStr=toLocalDateStr();
  const monthTitle=`${monthNames[calMonth-1]} ${calYear}`;

  function prevMonth(){if(calMonth===1){setCalMonth(12);setCalYear(y=>y-1);}else{setCalMonth(m=>m-1);}}
  function nextMonth(){if(calMonth===12){setCalMonth(1);setCalYear(y=>y+1);}else{setCalMonth(m=>m+1);}}
  function goToday(){const n=new Date();setCalMonth(n.getMonth()+1);setCalYear(n.getFullYear());}

  const daysData=calData?.days||{};
  const totalMonthBooked=Object.values(daysData).reduce((n,d)=>n+(d.bookedEmails||0),0);
  const totalScheduledBroadcasts=Object.values(daysData).reduce((n,d)=>n+(d.broadcasts?.filter(b=>b.status==='scheduled').length||0),0);

  const gridCells=[];
  // Padding from previous month
  for(let p=firstDayOfWeek-1;p>=0;p--){
   const pDay=prevMonthDays-p;
   gridCells.push(<div key={`prev-${pDay}`} style={{padding:'10px',background:'rgba(240,240,240,0.4)',border:'1px solid var(--line)',minHeight:'110px',borderRadius:'6px',opacity:0.4}}>
    <span style={{fontSize:'12px',fontWeight:'bold',color:'var(--muted)'}}>{pDay}</span>
   </div>);
  }
  // Days of current month
  for(let day=1;day<=daysInMonth;day++){
   const dayKey=`${calYear}-${String(calMonth).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
   const dayInfo=daysData[dayKey]||{date:dayKey,day,totalCapacity:activeDailyCapacity,bookedEmails:0,availableCapacity:activeDailyCapacity,broadcasts:[]};
   const isToday=dayKey===todayStr;
   const isSelected=selectedCalDay===dayKey;
   const booked=dayInfo.bookedEmails||0;
   const totalCap=dayInfo.totalCapacity||activeDailyCapacity;
   const capPct=totalCap>0?Math.min(100,Math.round((booked/totalCap)*100)):0;

   gridCells.push(
    <div key={dayKey} onClick={()=>setSelectedCalDay(isSelected?null:dayKey)} style={{padding:'10px',background:isSelected?'rgba(99,102,241,0.06)':isToday?'rgba(16,185,129,0.04)':'#fff',border:isSelected?'2px solid #6366f1':isToday?'2px solid #10b981':'1px solid var(--line)',borderRadius:'8px',minHeight:'120px',cursor:'pointer',display:'flex',flexDirection:'column',gap:'6px',transition:'all 0.15s ease'}}>
     <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
      <div style={{display:'flex',alignItems:'center',gap:'6px'}}>
       <b style={{fontSize:'14px',color:isToday?'#10b981':'inherit'}}>{day}</b>
       {isToday&&<span className="badge green" style={{fontSize:'9px',padding:'1px 5px'}}>TODAY</span>}
      </div>
      <span className={'badge '+(booked>=totalCap?'danger':booked>totalCap*0.7?'':booked>0?'green':'')} style={{fontSize:'10px',padding:'2px 6px'}}>
       {booked>0?`${booked}/${totalCap}`:`${totalCap} free`}
      </span>
     </div>
     {booked>0&&(
      <div style={{width:'100%',background:'var(--line)',height:'4px',borderRadius:'2px',overflow:'hidden'}}>
       <div style={{width:`${capPct}%`,height:'100%',background:capPct>=100?'#ef4444':capPct>70?'#f59e0b':'#10b981'}}/>
      </div>
     )}
     <div style={{display:'flex',flexDirection:'column',gap:'4px',marginTop:'2px',flex:1,overflowY:'auto'}}>
      {(dayInfo.broadcasts||[]).map(b=>(
       <div key={b.id} style={{padding:'4px 6px',background:'var(--bg)',borderRadius:'4px',fontSize:'11px',borderLeft:`3px solid ${b.status==='completed'?'#10b981':b.status==='scheduled'?'#6366f1':b.status==='failed'?'#ef4444':'#9ca3af'}`}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:'4px'}}>
         <b style={{whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',maxWidth:'85px'}}>{b.campaign_name||'Campaign'}</b>
         <time style={{color:'var(--muted)',fontSize:'10px'}}>{new Date(b.scheduled_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time>
        </div>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',fontSize:'10px',color:'var(--muted)',marginTop:'2px'}}>
         <span>{b.total_recipients} emails</span>
         <span style={{textTransform:'capitalize',fontSize:'9px'}}>{b.status}</span>
        </div>
       </div>
      ))}
     </div>
    </div>
   );
  }

  const selectedDayData=selectedCalDay?daysData[selectedCalDay]:null;

  return (
   <div>
    <div className="schedules-header">
     <div className="schedules-nav-row">
      <div style={{display:'flex',alignItems:'center',gap:'12px',flexWrap:'wrap'}}>
       <h2 style={{margin:0,fontSize:'22px'}}>{monthTitle}</h2>
       <div style={{display:'flex',gap:'6px'}}>
        <button className="secondary" style={{padding:'6px 12px',fontSize:'12px'}} onClick={prevMonth}>← Prev</button>
        <button className="secondary" style={{padding:'6px 12px',fontSize:'12px'}} onClick={goToday}>Today</button>
        <button className="secondary" style={{padding:'6px 12px',fontSize:'12px'}} onClick={nextMonth}>Next →</button>
       </div>
       <div className="view-toggle-btns">
        <button type="button" className={calView==='grid'?'active':''} onClick={()=>setCalView('grid')}>Grid</button>
        <button type="button" className={calView==='list'?'active':''} onClick={()=>setCalView('list')}>Agenda</button>
       </div>
      </div>
      {calLoading&&<small className="muted">Refreshing calendar…</small>}
     </div>
     <div style={{display:'flex',gap:'12px',alignItems:'center',flexWrap:'wrap',width:'100%'}}>
      <div className="card schedules-stats-card">
       <div><span className="muted" style={{fontSize:'10px',display:'block'}}>DAILY CAPACITY</span><b>{activeDailyCapacity.toLocaleString()} emails/day</b></div>
       <div><span className="muted" style={{fontSize:'10px',display:'block'}}>SCHEDULED BROADCASTS</span><b>{totalScheduledBroadcasts} pending</b></div>
       <div><span className="muted" style={{fontSize:'10px',display:'block'}}>BOOKED THIS MONTH</span><b>{totalMonthBooked.toLocaleString()} emails</b></div>
      </div>
     </div>
    </div>

    {calView==='grid'?(
     <>
      <div className="mobile-swipe-hint">👈 Swipe horizontally to view full calendar grid 👉</div>
      <div className="calendar-scroll-wrap">
       <div className="calendar-grid-inner">
        <div style={{display:'grid',gridTemplateColumns:'repeat(7, 1fr)',gap:'8px',marginBottom:'8px',textAlign:'center'}}>
         {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>(
          <div key={d} style={{fontSize:'12px',fontWeight:'bold',color:'var(--muted)',padding:'6px 0',textTransform:'uppercase',letterSpacing:'0.5px'}}>{d}</div>
         ))}
        </div>

        <div style={{display:'grid',gridTemplateColumns:'repeat(7, 1fr)',gap:'8px',marginBottom:'24px'}}>
         {gridCells}
        </div>
       </div>
      </div>
     </>
    ):(
     <div style={{display:'grid',gap:'10px',marginBottom:'24px'}}>
      {Object.keys(daysData).length===0?<div className="card empty"><p className="muted">No calendar data for this month.</p></div>:(
       Object.entries(daysData).filter(([,d])=>(d.bookedEmails>0||(d.broadcasts&&d.broadcasts.length>0))).length===0?(
        <div className="card empty" style={{padding:'24px',textAlign:'center'}}>
         <div className="emptyicon">🗓</div>
         <h3>No scheduled broadcasts this month</h3>
         <p className="muted">All days have full daily capacity available ({activeDailyCapacity.toLocaleString()} emails/day).</p>
        </div>
       ):(
        Object.entries(daysData).filter(([,d])=>(d.bookedEmails>0||(d.broadcasts&&d.broadcasts.length>0))).map(([dateKey,d])=>(
         <div key={dateKey} className="card" style={{padding:'14px 16px',cursor:'pointer',borderLeft:dateKey===todayStr?'4px solid #10b981':'4px solid #6366f1'}} onClick={()=>setSelectedCalDay(selectedCalDay===dateKey?null:dateKey)}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:'8px'}}>
           <div>
            <b style={{fontSize:'15px'}}>{new Date(dateKey+'T00:00:00').toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})}</b>
            {dateKey===todayStr&&<span className="badge green" style={{marginLeft:'8px',fontSize:'10px'}}>TODAY</span>}
           </div>
           <span className={'badge '+(d.bookedEmails>=d.totalCapacity?'danger':d.bookedEmails>0?'':'')} style={{fontSize:'11px'}}>
            {d.bookedEmails} / {d.totalCapacity} emails booked
           </span>
          </div>
          {(d.broadcasts||[]).map(b=>(
           <div key={b.id} style={{marginTop:'8px',padding:'8px 10px',background:'var(--bg)',borderRadius:'6px',fontSize:'12px',display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:'8px'}}>
            <div>
             <b>{b.campaign_name||'Campaign'}</b> — {b.subject}
             <div style={{color:'var(--muted)',fontSize:'11px',marginTop:'2px'}}>{new Date(b.scheduled_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} · {b.total_recipients} recipients · {b.persona_name}</div>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
             <span className={'badge '+(b.status==='completed'?'green':b.status==='scheduled'?'':'danger')} style={{fontSize:'10px'}}>{b.status}</span>
             {b.status==='scheduled'&&(
              <button type="button" className="link danger" style={{fontSize:'11px'}} disabled={busy} onClick={(e)=>{e.stopPropagation();cancelScheduledBroadcast(b.id);}}>Cancel</button>
             )}
            </div>
           </div>
          ))}
         </div>
        ))
       )
      )}
     </div>
    )}

    {selectedDayData&&(
     <div className="card" style={{padding:'20px',marginTop:'16px',borderLeft:'4px solid #6366f1'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'12px',flexWrap:'wrap',gap:'8px'}}>
       <div>
        <h3 style={{margin:0}}>Day Details: {selectedDayData.date}</h3>
        <p className="muted" style={{fontSize:'12px',margin:'2px 0 0'}}>
         {selectedDayData.bookedEmails} / {selectedDayData.totalCapacity} emails booked ({selectedDayData.availableCapacity} remaining capacity for this date)
        </p>
       </div>
       <button className="secondary" style={{padding:'6px 12px',fontSize:'12px'}} onClick={()=>setSelectedCalDay(null)}>Close details ✕</button>
      </div>
      {!(selectedDayData.broadcasts||[]).length?(
       <p className="muted" style={{margin:'10px 0'}}>No broadcasts scheduled on this day. Full daily capacity of {selectedDayData.totalCapacity} is available.</p>
      ):(
       <div style={{display:'grid',gap:'10px'}}>
        {selectedDayData.broadcasts.map(b=>(
         <div key={b.id} style={{padding:'12px',background:'var(--bg)',borderRadius:'8px',border:'1px solid var(--line)',display:'flex',justifyContent:'space-between',alignItems:'center',gap:'12px',flexWrap:'wrap'}}>
          <div>
           <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
            <b>{b.campaign_name}</b>
            <span className={'badge '+(b.status==='completed'?'green':b.status==='scheduled'?'':b.status==='failed'?'danger':'')}>{b.status}</span>
            <small className="muted">{fmt(b.scheduled_at)}</small>
           </div>
           <p style={{fontSize:'13px',margin:'4px 0 0'}}>{b.subject}</p>
           <small className="muted">{b.total_recipients} recipient(s) · Sender: {b.persona_name} ({b.persona_email})</small>
          </div>
          {b.status==='scheduled'&&(
           <button type="button" className="secondary danger" style={{fontSize:'12px',padding:'6px 14px'}} disabled={busy} onClick={()=>cancelScheduledBroadcast(b.id)}>
            Cancel Schedule
           </button>
          )}
         </div>
        ))}
       </div>
      )}
     </div>
    )}

    <div className="card" style={{padding:'16px 20px',marginTop:'18px',fontSize:'12px',color:'var(--muted)',lineHeight:'1.6'}}>
     <b style={{color:'inherit',display:'block',marginBottom:'4px'}}>🗓 How the Scheduling Architecture Operates:</b>
     <span>1. <b>Capacity Reservation</b>: Scheduling a broadcast reserves recipient count against that specific future day&apos;s daily capacity.</span><br/>
     <span>2. <b>DailyScheduler.js</b>: Trigger.dev runs a task at 2:00 AM UTC every day that searches the database for that day&apos;s scheduled broadcasts.</span><br/>
     <span>3. <b>QStash Exact Trigger</b>: The task enqueues QStash to trigger the app at the exact minute scheduled. Broadcasts scheduled same-day are also queued immediately.</span><br/>
     <span>4. <b>CampaignMailSender.js</b>: When the QStash webhook fires, Trigger.dev executes multi-platform waterfall sending across all active platforms.</span>
    </div>
   </div>
  );
 })()}

  {(page==='Connected'||page==='Connections')&&<><div className="sectiontitle" style={{marginBottom:'24px'}}><div className="tabs"><button className={connectedTab==='capacity'?'selected':''} onClick={()=>setConnectedTab('capacity')}>Platform Capacity & Usage</button><button className={connectedTab==='settings'?'selected':''} onClick={()=>setConnectedTab('settings')}>Platform Settings & Connect</button></div>{connectedTab==='capacity'?<div style={{display:'flex',gap:'10px'}}><button className="secondary" onClick={()=>run(refresh)}>Refresh</button><button onClick={()=>{setConnection(initialConnection('brevo'));setInspect(null);setConnectedTab('settings');}}>＋ New platform</button></div>:<button className="secondary" onClick={()=>run(refresh)}>Refresh</button>}</div>{connectedTab==='capacity'&&<>{!senders.length?<div className="empty card"><div className="emptyicon">⇄</div><h2>Your first connection starts here.</h2><p>Add a sending provider, verify your domain, then create your persona.</p><button onClick={()=>setConnectedTab('settings')}>Connect a platform →</button></div>:<div className="providergrid">{senders.map(c=><div className="card" key={c.id}><div className="cardtitle"><div><h3 style={{marginBottom:'2px'}}>{c.label}</h3><small style={{color:'var(--muted)'}}>{providers[c.provider]?.name||c.provider}</small></div><span className={'badge '+(c.enabled?'green':'')}>{c.enabled?'Enabled':'Paused'}</span></div><p className="muted" style={{marginTop:'8px',marginBottom:'12px'}}>{c.domains.join(', ')}</p>{c.usage.map(w=><div className="meter" key={w.name}><div><span>{w.name==='30-day'?'Your 30-day period':w.name==='provider-month'?'Provider month':'Today (UTC)'}</span><b>{w.used} / {w.limit??'No app cap'}</b></div><progress max={w.limit||1} value={w.limit?w.used:0}/><small>{w.limit?`${Math.max(0,w.limit-w.used)} remaining · `:''}Resets {fmt(w.end)}</small></div>)}<div className="cardfooter-actions"><button className="link" onClick={()=>edit(c)}>Manage settings →</button><div><button type="button" className="link" disabled={busy} onClick={()=>run(async()=>setInspect(await api('inspect',{id:c.id})))}>Check setup</button><button type="button" className="btn-delete btn-delete-sm" disabled={busy} onClick={()=>deleteConnection(c)}><FiTrash2 size={12}/> Delete</button></div></div>{inspect&&inspect.id===c.id&&<pre className="code" style={{marginTop:'12px'}}>{JSON.stringify(inspect,null,2)}</pre>}</div>)}</div>}<p className="footnote">Quotas are shared by every persona. Provider approval, external usage, hourly limits and actual billing periods may reduce available capacity.</p></>}{connectedTab==='settings'&&<div className="columns"><section><div className="sectiontitle"><h2>Connected accounts</h2><button className="secondary" onClick={()=>{setConnection(initialConnection('brevo'));setInspect(null);}}>＋ New</button></div>{data.connections.map(c=><div className="connectionrow card" key={c.id}><div style={{flex:1,cursor:'pointer'}} onClick={()=>edit(c)}><b>{c.label}</b><p>{c.domains.join(', ')}</p></div><div className="connectionbtns"><span className={'badge '+(c.enabled?'green':'')}>{c.enabled?'Enabled':'Paused'}</span><button type="button" className="btn-delete btn-delete-sm" disabled={busy} onClick={()=>deleteConnection(c)}><FiTrash2 size={12}/> Delete</button></div></div>)}{!data.connections.length&&<p className="muted">Your connected accounts will appear here.</p>}<div className="hint">One connection per platform keeps account quotas shared. Add all verified domains to that connection.</div></section><form className="card form" onSubmit={e=>{e.preventDefault();run(async()=>{await api('connections',connection);await refresh();setNotice('Connection saved. Existing credentials and tracking start date are preserved.');setConnection(c=>({...c,credentials:{}}));});}}><h2>Platform settings</h2><label>Platform<select value={connection.provider} onChange={e=>{const existing=data.connections.find(c=>c.provider===e.target.value);existing?edit(existing):setConnection(initialConnection(e.target.value));setInspect(null);}}>{Object.entries(providers).map(([id,p])=><option key={id} value={id}>{p.name}</option>)}</select></label><label>Connection name<input required value={connection.label} onChange={e=>field('label',e.target.value)}/></label><label>Verified domains (comma separated)<input required placeholder="yourdomain.com" value={connection.domains} onChange={e=>field('domains',e.target.value)}/></label><div className="hint"><b>Domain setup</b><p>{providers[connection.provider].steps}</p><a href={providers[connection.provider].url} target="_blank" rel="noreferrer">Official instructions ↗</a></div>{providers[connection.provider].fields.map(k=><label key={k}>{({apiKey:connection.provider==='cloudflare'?'Cloudflare API token (optional)':'API / sending key',apiSecret:'API secret',domainId:'Domain ID (for status check)',webhookSecret:'Webhook signing secret (optional)',sendingDomain:'Mailgun sending domain',accountId:'Cloudflare account ID',zoneId:'Cloudflare zone ID'})[k]}<input type={/Key|Secret/.test(k)?'password':'text'} autoComplete="off" value={connection.credentials[k]||''} placeholder="Leave blank to keep saved value" onChange={e=>field('credentials',{...connection.credentials,[k]:e.target.value})}/></label>)}{connection.provider==='mailgun'&&<label>Region<select value={connection.region} onChange={e=>field('region',e.target.value)}><option value="us">US</option><option value="eu">EU</option></select></label>}{connection.provider!=='cloudflare'&&<><div className="row"><label>Daily limit<input type="number" min="1" value={connection.dailyLimit} onChange={e=>field('dailyLimit',e.target.value)}/></label><label>Your 30-day limit<input type="number" min="1" value={connection.monthlyLimit} onChange={e=>field('monthlyLimit',e.target.value)}/></label></div><details><summary>Provider billing period</summary><label>Provider monthly limit<input type="number" min="1" value={connection.providerMonthlyLimit} onChange={e=>field('providerMonthlyLimit',e.target.value)}/></label><label>Provider reset rule<select value={connection.providerCycle} onChange={e=>field('providerCycle',e.target.value)}><option value="calendar">Calendar month (UTC)</option><option value="30days">Every 30 days from provider period start</option><option value="billing">Monthly anniversary of provider period start</option></select></label><label>Provider period start (UTC ISO date)<input value={connection.providerAnchor} onChange={e=>field('providerAnchor',e.target.value)}/></label><p className="muted">Set this from your provider dashboard. Pause before changing it. Blank limits mean no app cap; they do not remove provider limits.</p></details></>}<p className="muted">{providers[connection.provider].note}</p><label className="check"><input type="checkbox" checked={connection.enabled} onChange={e=>field('enabled',e.target.checked)}/>I completed domain verification and want this connection enabled.</label><div className="connection-form-btns"><button disabled={busy}>Save connection</button><button type="button" className="secondary" disabled={busy||!data.connections.some(c=>c.provider===connection.provider)} onClick={()=>run(async()=>setInspect(await api('inspect',{id:data.connections.find(c=>c.provider===connection.provider).id})))}>Check setup</button>{data.connections.some(c=>c.provider===connection.provider)&&<button type="button" className="btn-delete" disabled={busy} onClick={()=>deleteConnection(data.connections.find(c=>c.provider===connection.provider))}><FiTrash2 size={13}/> Delete connection</button>}</div>{inspect&&<pre className="code">{JSON.stringify(inspect,null,2)}</pre>}</form></div>}</>}
  {page==='Personas'&&<div className="columns"><section><h2>Your sender identities</h2>{data.personas.map(p=><div className="card person" key={p.id}><div className="person-header"><div className="avatar">{p.name.slice(0,1).toUpperCase()}</div><div className="person-details"><h3>{p.name}</h3><p>{p.email}</p><small>Access to all sending connections</small></div></div><div className="personbtns"><button type="button" className="link" onClick={()=>setPersona({name:p.name,email:p.email})}>Edit name</button><button type="button" className="btn-delete btn-delete-sm" disabled={busy} onClick={()=>deletePersona(p)}><FiTrash2 size={12}/> Delete</button></div></div>)}{!data.personas.length&&<p className="muted">Create your first sender persona.</p>}</section><form className="card form" onSubmit={e=>{e.preventDefault();run(async()=>{await api('personas',persona);await refresh();setPersona({name:'',email:''});setNotice('Persona saved and available across all sending platforms.');});}}><h2>Create a persona</h2><label>Sender name<input required value={persona.name} onChange={e=>setPersona({...persona,name:e.target.value})} placeholder="Chima"/></label><label>Sender email<input type="email" required value={persona.email} onChange={e=>setPersona({...persona,email:e.target.value})} placeholder="chima@yourdomain.com"/></label><p className="muted">No platform assignment needed. The sender domain must be verified on the platform you choose at send time.</p><button disabled={busy}>Save persona</button></form></div>}
 {page==='Compose'&&<form className="card form composer" onSubmit={e=>{e.preventDefault();run(async()=>{const id=compose.id||crypto.randomUUID();setCompose(c=>({...c,id}));const r=await api('send',{...compose,id});await refresh();if(r.status==='accepted'){setNotice('Accepted by the provider. Saved in Sent.');setCompose(c=>({...c,id:crypto.randomUUID(),text:'',subject:'',parentId:null}));}else {setCompose(c=>({...c,id:crypto.randomUUID()}));setNotice(`Status: ${r.status}. ${r.status==='failed'?'Correct the provider issue before retrying.':'Check Sent and provider logs before trying again.'} ${r.error||''}`);}});}}><div className="row"><label>Sender persona<select required value={compose.personaId} onChange={e=>setCompose({...compose,personaId:e.target.value})}><option value="">Choose a persona</option>{data.personas.map(p=><option value={p.id} key={p.id}>{p.name} — {p.email}</option>)}</select></label><label>Sending platform<select required value={compose.connectionId} onChange={e=>setCompose({...compose,connectionId:e.target.value})}><option value="">Choose a platform</option>{senders.map(c=><option key={c.id} value={c.id} disabled={!c.enabled||!!selectedPersona&&!c.domains.includes(selectedPersona.email.split('@')[1])}>{c.label}{!c.enabled?' — paused':selectedPersona&&!c.domains.includes(selectedPersona.email.split('@')[1])?' — verify domain':''}</option>)}</select></label></div>{(()=>{const sel=senders.find(c=>c.id===compose.connectionId)?.provider;if(sel==='sequenzy')return <div className="hint">Sequenzy does not support custom threading headers. Your app retains the reply relationship via unique Reply-To, but the recipient’s mail client may show a separate conversation.</div>;if(sel==='senddev')return <div className="hint">Send.dev does not support custom email headers. Your app retains the reply relationship via unique Reply-To, but the recipient’s mail client may show a separate conversation.</div>;return null;})()}<label>To<input type="email" required value={compose.to} onChange={e=>setCompose({...compose,to:e.target.value})} placeholder="recipient@example.com"/></label><label>Subject<input required maxLength="255" value={compose.subject} onChange={e=>setCompose({...compose,subject:e.target.value})} placeholder="What would you like to say?"/></label><label>Message<textarea required rows="14" maxLength="100000" value={compose.text} onChange={e=>setCompose({...compose,text:e.target.value})} placeholder="Write your message…"/></label><div className="composerfoot"><button type="button" className="secondary" disabled={busy} onClick={()=>setCompose(c=>({...c,id:crypto.randomUUID(),to:'',subject:'',text:'',parentId:null}))}>New message</button><p className="muted">One recipient per send · Saved to Sent automatically</p><button disabled={busy}>{busy?'Sending…':'Send email ↗'}</button></div></form>}
 {page==='Mailbox'&&<><div className="sectiontitle"><div className="tabs">{['inbox','sent'].map(f=><button className={folder===f?'selected':''} key={f} onClick={()=>{setFolder(f);setOffset(0);setThread([]);setSelectedThreadId(null);if(pathname!==`/mailbox/${f}`)router.push(`/mailbox/${f}`);}}>{f==='inbox'?'Inbox':'Sent'}</button>)}</div><button className="secondary" onClick={()=>run(async()=>setMessages(await api(`messages?folder=${folder}&offset=${offset}`)))}>Refresh</button></div><div className="mailcolumns"><section className="card maillist">{messages.map(m=>{const isExpanded=selectedThreadId===m.thread_id;return <div key={m.id} className={`mail-accordion-item ${isExpanded?'expanded':''}`}><button type="button" onClick={()=>openThread(m.thread_id)} className={`mailrow ${isExpanded?'selected-row':''}`} aria-expanded={isExpanded}><div className="mailrow-header"><b className="mailrow-contact">{folder==='sent'?m.to_email:m.from_email}</b><div className="mailrow-meta"><time>{new Date(m.created_at).toLocaleDateString()}</time><span className={`accordion-chevron ${isExpanded?'open':''}`}>{isExpanded?'▲':'▼'}</span></div></div><p className="mailrow-subject">{m.subject}</p><div className="mailrow-footer"><span className={`badge ${m.status==='accepted'?'green':m.status==='failed'?'error':''}`}>{m.status}</span></div></button>{isExpanded&&<div className="mail-accordion-panel mobile-only">{renderThreadContent()}</div>}</div>;})}{!messages.length&&<div className="empty"><h3>No messages here yet.</h3><p>Incoming and outgoing messages will appear here.</p></div>}<div className="row pager"><button className="secondary" disabled={!offset} onClick={()=>{setOffset(Math.max(0,offset-50));setSelectedThreadId(null);setThread([]);}}>Previous</button><button className="secondary" disabled={messages.length<50} onClick={()=>{setOffset(offset+50);setSelectedThreadId(null);setThread([]);}}>Next</button></div></section><section className="mailbox-desktop-thread desktop-only">{renderThreadContent()}</section></div></>}
 {page==='Deployment'&&<section className="card form deployment"><p className="eyebrow">SERVERLESS SETUP</p><h2>From project to inbox.</h2><ol><li><b>Create Neon and D1.</b><p>Run <code>db/schema.sql</code> in Neon. Create a D1 database and run <code>db/d1-messages.sql</code> remotely. Message rows are stored in D1; other application data remains in Neon.</p></li><li><b>Deploy the Worker.</b><p>Set your D1 database ID in <code>worker/wrangler.jsonc</code>, deploy the Worker and save INBOUND_SECRET with Wrangler. The Worker handles incoming mail and serves the signed D1 API.</p></li><li><b>Deploy on Vercel.</b><p>Set DATABASE_URL, MESSAGE_STORE_URL (Worker URL plus <code>/api/messages</code>), APP_URL, ADMIN_PASSWORD_HASH, SESSION_SECRET, CREDENTIALS_KEY and INBOUND_SECRET. The secret must match the Worker. Redeploy after setting variables.</p></li><li><b>Connect providers and routes.</b><p>Publish provider DNS records. Keep Cloudflare's receiving MX records. Route persona addresses and a catch-all for <code>reply+…</code> addresses to the deployed Worker. Add and enable the domain in Connections.</p></li><li><b>Test the round trip.</b><p>Send to an address you control, reply, then open Inbox. Configure optional Resend/Mailgun delivery webhooks and save their signing secrets.</p></li></ol><div className="card" style={{marginTop:'24px',padding:'20px',background:'var(--bg)',borderRadius:'8px',border:'1px solid var(--line)'}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:'12px',marginBottom:'14px'}}><div><div style={{display:'flex',alignItems:'center',gap:'8px',marginBottom:'4px'}}><h3 style={{fontSize:'16px',margin:0}}>🔔 Push Notifications (Firebase Cloud Messaging)</h3><span className={'badge '+(data.fcm?.configured?'green':'')}>{data.fcm?.configured?'Server Active':'Missing Service Account'}</span><span className={'badge '+(data.fcm?.publicConfig?.isEnabled?'green':'')}>{data.fcm?.publicConfig?.isEnabled?'Web Push Ready':'Incomplete Public Config'}</span></div><p className="muted" style={{fontSize:'12px',margin:0}}>Native browser push notifications sent directly to your phone or desktop when new emails arrive.</p></div><div style={{display:'flex',gap:'8px',alignItems:'center'}}><span className="badge" style={{background:'#fff',border:'1px solid var(--line)',fontSize:'11px',padding:'4px 8px'}}>{data.fcm?.registeredCount||0} device{(data.fcm?.registeredCount===1)?'':'s'} registered</span><button type="button" className="secondary" style={{fontSize:'11px',padding:'6px 12px'}} disabled={pushBusy||!data.fcm?.configured} onClick={sendTestPush}>Send Test Push</button></div></div><div style={{fontSize:'12px',color:'var(--muted)',lineHeight:'1.6'}}><b style={{color:'inherit',display:'block',marginBottom:'4px'}}>Required Environment Variables:</b><ul style={{margin:'0 0 10px 18px',padding:0}}><li><code>FIREBASE_SERVICE_ACCOUNT</code>: Firebase Admin service account JSON (or base64 encoded string) for server dispatch. Alternatively set <code>FIREBASE_PROJECT_ID</code>, <code>FIREBASE_CLIENT_EMAIL</code>, and <code>FIREBASE_PRIVATE_KEY</code>.</li><li><code>NEXT_PUBLIC_FIREBASE_API_KEY</code>, <code>NEXT_PUBLIC_FIREBASE_PROJECT_ID</code>, <code>NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID</code>, <code>NEXT_PUBLIC_FIREBASE_APP_ID</code>: Client SDK configuration from your Firebase Web App.</li><li><code>NEXT_PUBLIC_FIREBASE_VAPID_KEY</code>: Web Push certificate key pair generated in Firebase Console (Project Settings → Cloud Messaging → Web Push certificates).</li><li><code>APP_URL</code> and <code>INBOUND_SECRET</code>: In <code>worker/wrangler.jsonc</code>, allowing Cloudflare Worker to authenticate push dispatches to <code>/api/inbound/notify</code> on incoming emails.</li></ul></div></div><div className="hint" style={{marginTop:'18px'}}>Message bodies and status live in D1. Attachments are not retained in this text/HTML version. Read README.md and docs/CLOUDFLARE.md for deployment steps.</div><details><summary>View complete Worker code</summary><WorkerCode/></details></section>}
 {page==='Blacklist'&&<div className="columns">
  <section>
   <div className="sectiontitle">
    <div>
     <h2>Blacklisted recipients</h2>
     <p className="muted" style={{margin:'2px 0 0',fontSize:'13px'}}>Addresses here are protected and will be automatically removed from campaign recipient lists.</p>
    </div>
   </div>
   <div style={{display:'flex',gap:'10px',alignItems:'center',marginBottom:'16px',flexWrap:'wrap'}}>
    <input
     type="search"
     placeholder="Filter blacklist by email or reason…"
     value={blacklistSearch}
     onChange={e=>setBlacklistSearch(e.target.value)}
     style={{flex:1,minWidth:'220px',padding:'8px 12px'}}
    />
    <span className="badge" style={{background:'#fef3c7',color:'#92400e',border:'1px solid #fde68a'}}>
     🛡️ Auto-Filtering Active
    </span>
   </div>
   {!(data.blacklist||[]).length?(
    <div className="empty card">
     <div className="emptyicon">⊘</div>
     <h2>No blacklisted emails yet.</h2>
     <p>Add emails manually or in bulk to exclude them from all campaign dispatches.</p>
    </div>
   ):(
    <div className="card" style={{padding:0,overflow:'hidden'}}>
     <div style={{overflowX:'auto'}}>
      <table className="delivery-table" style={{width:'100%',margin:0,borderCollapse:'collapse'}}>
       <thead>
        <tr style={{background:'var(--bg)',borderBottom:'1px solid var(--line)'}}>
         <th style={{padding:'10px 14px',textAlign:'left'}}>Email Address</th>
         <th style={{padding:'10px 14px',textAlign:'left'}}>Reason / Tag</th>
         <th style={{padding:'10px 14px',textAlign:'left'}}>Date Added</th>
         <th style={{padding:'10px 14px',textAlign:'right'}}>Actions</th>
        </tr>
       </thead>
       <tbody>
        {(data.blacklist||[])
         .filter(b=>!blacklistSearch||b.email.toLowerCase().includes(blacklistSearch.toLowerCase())||(b.reason||'').toLowerCase().includes(blacklistSearch.toLowerCase()))
         .map(b=>(
          <tr key={b.id} style={{borderBottom:'1px solid var(--line)'}}>
           <td style={{padding:'10px 14px'}}><b style={{fontSize:'13px'}}>{b.email}</b></td>
           <td style={{padding:'10px 14px'}}><span className="badge" style={{fontSize:'11px',background:'#f1f5f9',color:'#475569'}}>{b.reason||'Manual addition'}</span></td>
           <td style={{padding:'10px 14px',fontSize:'12px',color:'var(--muted)',whiteSpace:'nowrap'}}>{fmt(b.created_at)}</td>
           <td style={{padding:'10px 14px',textAlign:'right'}}><button type="button" className="btn-delete btn-delete-sm" disabled={busy} onClick={()=>removeFromBlacklist(b)}><FiTrash2 size={12}/> Remove</button></td>
          </tr>
         ))}
        {!(data.blacklist||[]).filter(b=>!blacklistSearch||b.email.toLowerCase().includes(blacklistSearch.toLowerCase())||(b.reason||'').toLowerCase().includes(blacklistSearch.toLowerCase())).length&&(
         <tr><td colSpan="4" style={{padding:'24px',textAlign:'center',color:'var(--muted)'}}>No blacklisted emails match &quot;{blacklistSearch}&quot;.</td></tr>
        )}
       </tbody>
      </table>
     </div>
    </div>
   )}
  </section>
  <form className="card form" onSubmit={addToBlacklist}>
   <h2>Add to Blacklist</h2>
   <p className="muted" style={{fontSize:'12px',marginBottom:'14px'}}>Paste a single email or multiple emails separated by newlines, commas, or semicolons.</p>
   <label>
    Email address(es)
    <textarea
     required
     rows="6"
     placeholder={"user1@example.com\nuser2@example.com, user3@example.com"}
     value={blacklistForm.emails}
     onChange={e=>setBlacklistForm(f=>({...f,emails:e.target.value}))}
     style={{fontFamily:'monospace',fontSize:'13px'}}
    />
   </label>
   <label>
    Reason / Category
    <select value={blacklistForm.reason} onChange={e=>setBlacklistForm(f=>({...f,reason:e.target.value}))}>
     <option value="Do Not Contact">Do Not Contact</option>
     <option value="Unsubscribed">Unsubscribed</option>
     <option value="Bounced / Invalid">Bounced / Invalid</option>
     <option value="Spam Complaint">Spam Complaint</option>
     <option value="Manual addition">Manual addition</option>
    </select>
   </label>
   <div className="hint" style={{marginTop:'10px'}}>
    <b>Automatic Protection:</b> Whenever you paste a recipient list into any campaign, the system automatically checks this blacklist and removes every matching address before saving.
   </div>
   <button disabled={busy} style={{marginTop:'12px'}}>{busy?'Saving…':'Add to Blacklist ⊘'}</button>
  </form>
 </div>}

  {batchDetailsLoading && (
   <div className="modal-overlay">
    <div className="modal-dialog" style={{maxWidth:'400px',padding:'30px',textAlign:'center'}}>
     <p className="muted">Loading batch delivery details…</p>
    </div>
   </div>
  )}
  {batchDetailsModal && (
   <div className="modal-overlay" onClick={()=>setBatchDetailsModal(null)}>
    <div className="modal-dialog" onClick={e=>e.stopPropagation()}>
     <div className="modal-header">
      <div>
       <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
        <h2 style={{fontSize:'17px',margin:0}}>Batch Delivery Details</h2>
        {batchDetailsModal.batch?.is_follow_up && <span className="badge" style={{background:'#dbeafe',color:'#1e40af'}}>↳ Follow-up</span>}
        <span className={'badge '+(batchDetailsModal.batch?.status==='completed'?'green':batchDetailsModal.batch?.status==='failed'?'danger':'')}>{batchDetailsModal.batch?.status}</span>
       </div>
       <p className="muted" style={{fontSize:'12px',margin:'4px 0 0'}}>
        Subject: <b>{batchDetailsModal.batch?.subject}</b> · Sent: {fmt(batchDetailsModal.batch?.created_at)}
       </p>
      </div>
      <button type="button" className="secondary" style={{padding:'6px 12px',fontSize:'13px'}} onClick={()=>setBatchDetailsModal(null)}>✕ Close</button>
     </div>
     <div className="modal-body">
      <div className="batch-modal-stats">
       <div style={{background:'var(--bg)',padding:'12px',borderRadius:'8px'}}>
        <span className="muted" style={{fontSize:'11px',textTransform:'uppercase'}}>Total Recipients</span>
        <strong style={{display:'block',fontSize:'20px',marginTop:'4px'}}>{batchDetailsModal.batch?.total_recipients||0}</strong>
       </div>
       <div style={{background:'var(--bg)',padding:'12px',borderRadius:'8px'}}>
        <span className="muted" style={{fontSize:'11px',textTransform:'uppercase'}}>Delivered (Accepted)</span>
        <strong style={{display:'block',fontSize:'20px',marginTop:'4px',color:'var(--green)'}}>{batchDetailsModal.batch?.sent_count||0}</strong>
       </div>
       <div style={{background:'var(--bg)',padding:'12px',borderRadius:'8px'}}>
        <span className="muted" style={{fontSize:'11px',textTransform:'uppercase'}}>Failed / Suppressed</span>
        <strong style={{display:'block',fontSize:'20px',marginTop:'4px',color:'#a64038'}}>{batchDetailsModal.batch?.failed_count||0}</strong>
       </div>
      </div>
      <div className="batch-filter-bar">
       <div className="batch-filter-btns">
        {['all','accepted','failed','suppressed'].map(f=>{
         const count = f==='all' ? (batchDetailsModal.deliveries||[]).length : (batchDetailsModal.deliveries||[]).filter(d=>d.status===f).length;
         return (
          <button key={f} type="button" className={batchDeliveryFilter===f?'':'secondary'} style={{padding:'5px 10px',fontSize:'11px',textTransform:'capitalize'}} onClick={()=>setBatchDeliveryFilter(f)}>
           {f} ({count})
          </button>
         );
        })}
       </div>
       <input
        type="search"
        placeholder="Filter by email address…"
        value={batchDeliverySearch}
        onChange={e=>setBatchDeliverySearch(e.target.value)}
        style={{width:'220px',padding:'6px 10px',fontSize:'12px'}}
       />
      </div>
      {!(batchDetailsModal.deliveries||[]).length ? (
       <div className="empty card" style={{padding:'30px'}}>
        <p className="muted" style={{margin:0}}>No per-recipient delivery logs recorded for this batch yet.</p>
       </div>
      ) : (
       <>
       {(() => {
        const failedList = (batchDetailsModal.deliveries || []).filter(d => d.status === 'failed' || d.status === 'suppressed');
        if (!failedList.length) return null;
        const senderDomain = (batchDetailsModal.batch?.persona_email || '').split('@')[1]?.toLowerCase().trim();
        const eligibleConnections = (data.connections || []).filter(c => 
          c.provider !== 'cloudflare' &&
          c.enabled &&
          Array.isArray(c.domains) &&
          c.domains.map(d => String(d).toLowerCase().trim()).includes(senderDomain)
        );
        return (
          <div className="resend-all-toolbar" style={{display:'flex',flexWrap:'wrap',alignItems:'center',justifyContent:'space-between',gap:'12px',background:'#fff7ed',border:'1px solid #fed7aa',borderRadius:'8px',padding:'10px 14px',marginBottom:'14px'}}>
            <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
              <FiAlertTriangle size={18} style={{color:'#c2410c',flexShrink:0}}/>
              <div>
                <div style={{fontSize:'12.5px',fontWeight:'700',color:'#9a3412'}}>
                  {failedList.length} failed delivery {failedList.length === 1 ? 'attempt' : 'attempts'} in this batch
                </div>
                <div style={{fontSize:'11px',color:'#c2410c'}}>
                  Select a specific provider or use automatic waterfall failover to retry failed recipients.
                </div>
              </div>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:'8px',flexWrap:'wrap'}}>
              <label style={{fontSize:'11px',fontWeight:'600',color:'#7c2d12',margin:0,whiteSpace:'nowrap'}}>
                Platform:
              </label>
              <select 
                value={selectedResendProvider} 
                onChange={e => setSelectedResendProvider(e.target.value)}
                disabled={isResendingAll}
                style={{fontSize:'12px',padding:'5px 8px',borderRadius:'5px',border:'1px solid #fdba74',background:'#fff',minWidth:'175px'}}
              >
                <option value="">Auto (Waterfall Failover)</option>
                {eligibleConnections.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.label || c.provider} ({c.provider})
                  </option>
                ))}
              </select>
              <button
                type="button"
                style={{fontSize:'12px',padding:'6px 14px',background:'#c2410c',color:'#fff',border:'none',borderRadius:'5px',fontWeight:'600',cursor:'pointer',display:'inline-flex',alignItems:'center',gap:'6px'}}
                disabled={isResendingAll}
                onClick={resendAllFailed}
              >
                <FiRefreshCw size={13} className={isResendingAll ? 'spin' : ''}/>
                {isResendingAll ? 'Resending All…' : `Resend All Failed (${failedList.length})`}
              </button>
            </div>
          </div>
        );
      })()}
        <div className="mobile-swipe-hint">⇄ Swipe horizontally to view full delivery details</div>
       <div className="delivery-table-wrap">
        <table className="delivery-table">
         <thead>
          <tr>
           <th style={{width:'34px'}}></th>
           <th>Recipient</th>
           <th>Status</th>
           <th>Platform</th>
           <th>Details / Error</th>
           <th>Timestamp</th>
           <th style={{textAlign:'right'}}>Actions</th>
          </tr>
         </thead>
         <tbody>
          {(() => {
           const batchCampaign = data.campaigns?.find(c => c.id === batchDetailsModal.batch?.campaign_id) || selectedCampaign;
           const batchUnsubList = Array.isArray(batchCampaign?.unsubscribed) ? batchCampaign.unsubscribed : JSON.parse(batchCampaign?.unsubscribed || '[]');
           const batchUnsubSet = new Set(batchUnsubList.map(e => String(e).toLowerCase().trim()));
           const filteredList = (batchDetailsModal.deliveries||[])
            .filter(d => batchDeliveryFilter==='all' || d.status===batchDeliveryFilter)
            .filter(d => !batchDeliverySearch || d.recipient.toLowerCase().includes(batchDeliverySearch.toLowerCase()));

           if (!filteredList.length) {
            return (
             <tr>
              <td colSpan={7} style={{textAlign:'center',padding:'30px',color:'var(--muted)'}}>
               No {batchDeliveryFilter === 'all' ? '' : batchDeliveryFilter} deliveries recorded for this batch.
              </td>
             </tr>
            );
           }

           return filteredList.map(d => {
            const isUnsub = batchUnsubSet.has(d.recipient.toLowerCase());
            const isExpanded = expandedDeliveryId === d.id;
            const isFailed = d.status === 'failed' || d.status === 'suppressed';
            const isResending = resendingDeliveryId === d.id;
            const isDeleting = deletingDeliveryId === d.id;
            return (
             <Fragment key={d.id}>
              <tr 
               className={`delivery-main-row ${isExpanded ? 'delivery-row-expanded' : ''} ${isFailed ? 'delivery-row-failed' : ''}`}
               onClick={() => setExpandedDeliveryId(isExpanded ? null : d.id)}
               style={{cursor:'pointer'}}
              >
               <td style={{padding:'10px 4px 10px 10px',textAlign:'center'}} onClick={e=>e.stopPropagation()}>
                <button
                 type="button"
                 className="accordion-chevron-btn"
                 style={{background:'none',border:'none',padding:'2px',cursor:'pointer',color:isExpanded ? 'var(--green)' : 'var(--muted)',display:'inline-flex',alignItems:'center'}}
                 title={isExpanded ? 'Collapse row details' : 'Expand error & actions'}
                 onClick={()=>setExpandedDeliveryId(isExpanded ? null : d.id)}
                >
                 {isExpanded ? <FiChevronDown size={15}/> : <FiChevronRight size={15}/>}
                </button>
               </td>
               <td><b>{d.recipient}</b></td>
               <td>
                <span className={'badge '+(d.status==='accepted'?'green':d.status==='failed'?'danger':d.status==='suppressed'?'warning':'')}>
                  {d.status==='accepted'?'✓ Delivered':d.status==='failed'?'✕ Failed':d.status}
                </span>
               </td>
               <td><span className="badge" style={{background:'#fff',border:'1px solid var(--line)'}}>{d.platform || '—'}</span></td>
               <td 
                style={{fontSize:'11.5px',color:d.error?'#a64038':'var(--muted)',maxWidth:'240px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}
                title={d.error ? `${d.error} (Click row to expand)` : 'Click row to expand'}
               >
                {d.error ? (
                 <span style={{display:'inline-flex',alignItems:'center',gap:'4px'}}>
                  <FiAlertTriangle size={12} style={{flexShrink:0,color:'#dc2626'}}/>
                  <span style={{overflow:'hidden',textOverflow:'ellipsis'}}>{d.error}</span>
                 </span>
                ) : (d.wire_message_id ? `ID: ${d.wire_message_id}` : 'Accepted by provider')}
               </td>
               <td style={{fontSize:'11px',color:'var(--muted)',whiteSpace:'nowrap'}}>{fmt(d.created_at)}</td>
               <td style={{textAlign:'right'}} onClick={e=>e.stopPropagation()}>
                <div style={{display:'inline-flex',alignItems:'center',gap:'6px',justifyContent:'flex-end'}}>
                 {isFailed && (
                  <button
                   type="button"
                   className="secondary"
                   style={{padding:'4px 8px',fontSize:'11px',display:'inline-flex',alignItems:'center',gap:'4px',color:'var(--green)',borderColor:'var(--green)',background:'#fff',fontWeight:'600'}}
                   disabled={isResending}
                   onClick={()=>resendDelivery(d)}
                   title="Resend email to this recipient"
                  >
                   <FiRefreshCw size={11} className={isResending ? 'spin' : ''}/>
                   {isResending ? 'Sending…' : 'Resend'}
                  </button>
                 )}
                 {isUnsub ? (
                  <div style={{display:'inline-flex',alignItems:'center',gap:'4px'}}>
                   <span className="badge" style={{background:'#fee2e2',color:'#991b1b',fontSize:'10px'}}>Unsubscribed</span>
                   <button 
                    type="button" 
                    className="link" 
                    style={{fontSize:'11px',color:'var(--green)',padding:'2px 4px'}}
                    onClick={()=>resubscribeToCampaign(d.recipient, batchCampaign?.id)}
                   >
                    Restore
                   </button>
                  </div>
                 ) : (
                  <button 
                   type="button" 
                   className="secondary" 
                   style={{padding:'4px 8px',fontSize:'11px',display:'inline-flex',alignItems:'center',gap:'4px',color:'#991b1b',borderColor:'#fca5a5',background:'#fff'}}
                   title="Exclude from future follow-up broadcasts for this campaign"
                   onClick={async()=>{
                    if(confirm(`Exclude "${d.recipient}" from future follow-ups for this campaign?`)){
                     await unsubscribeFromCampaign(d.recipient, batchCampaign?.id);
                    }
                   }}
                  >
                   <FiUserX size={11}/> Exclude
                  </button>
                 )}
                 <button 
                  type="button" 
                  className="btn-delete btn-delete-sm" 
                  disabled={isDeleting}
                  title="Delete this delivery record from batch"
                  onClick={()=>deleteDelivery(d)}
                 >
                  <FiTrash2 size={11}/> Delete
                 </button>
                </div>
               </td>
              </tr>

              {isExpanded && (
               <tr className="delivery-accordion-row">
                <td colSpan={7}>
                 <div className="delivery-accordion-content">
                  {d.error ? (
                   <div className="delivery-error-callout">
                    <div style={{display:'flex',alignItems:'center',gap:'6px',fontWeight:'700',color:'#991b1b',marginBottom:'6px',fontSize:'12px'}}>
                     <FiAlertTriangle size={15}/> Error Diagnostics & Response:
                    </div>
                    <div className="delivery-error-text">
                     {d.error}
                    </div>
                   </div>
                  ) : (
                   <div className="delivery-success-callout" style={{background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:'6px',padding:'10px 14px',marginBottom:'12px'}}>
                    <span style={{fontSize:'12px',color:'#166534',fontWeight:'600'}}>✓ Message accepted by {d.platform || 'provider'}</span>
                   </div>
                  )}

                  <div className="delivery-accordion-meta">
                   <span><b>Recipient:</b> {d.recipient}</span>
                   <span><b>Platform:</b> {d.platform || 'None'}</span>
                   {d.wire_message_id && <span><b>Wire Message-ID:</b> <code style={{fontSize:'11px',background:'#fff',padding:'2px 4px',borderRadius:'3px',border:'1px solid var(--line)'}}>{d.wire_message_id}</code></span>}
                   {d.thread_id && <span><b>Thread ID:</b> <code style={{fontSize:'11px',background:'#fff',padding:'2px 4px',borderRadius:'3px',border:'1px solid var(--line)'}}>{d.thread_id}</code></span>}
                   <span><b>Created:</b> {fmt(d.created_at)}</span>
                   <span><b>Status:</b> <span className={'badge ' + (d.status==='accepted' ? 'green' : d.status==='failed' ? 'danger' : 'warning')}>{d.status}</span></span>
                  </div>

                  <div className="delivery-accordion-actions">
                   <button
                    type="button"
                    className="secondary"
                    style={{padding:'7px 14px',fontSize:'12px',display:'inline-flex',alignItems:'center',gap:'6px',color:'var(--green)',borderColor:'var(--green)',background:'#fff',fontWeight:'600'}}
                    disabled={isResending}
                    onClick={()=>resendDelivery(d)}
                    title="Resend this campaign message to this recipient"
                   >
                    <FiRefreshCw size={13} className={isResending ? 'spin' : ''}/>
                    {isResending ? 'Resending email…' : 'Resend Email'}
                   </button>

                   {isUnsub ? (
                    <button
                     type="button"
                     className="secondary"
                     style={{padding:'7px 14px',fontSize:'12px',display:'inline-flex',alignItems:'center',gap:'6px',color:'var(--green)',background:'#fff'}}
                     onClick={()=>resubscribeToCampaign(d.recipient, batchCampaign?.id)}
                    >
                     ✓ Restore to Active Campaign
                    </button>
                   ) : (
                    <button
                     type="button"
                     className="secondary"
                     style={{padding:'7px 14px',fontSize:'12px',display:'inline-flex',alignItems:'center',gap:'6px',color:'#991b1b',borderColor:'#fca5a5',background:'#fff'}}
                     title="Exclude this recipient from future follow-up broadcasts for this campaign"
                     onClick={async()=>{
                      if(confirm(`Exclude "${d.recipient}" from future follow-up broadcasts for this campaign?`)){
                       await unsubscribeFromCampaign(d.recipient, batchCampaign?.id);
                      }
                     }}
                    >
                     <FiUserX size={13}/> Unsubscribe Recipient
                    </button>
                   )}

                   <button
                    type="button"
                    className="btn-delete"
                    disabled={isDeleting}
                    title="Delete this delivery record from batch"
                    onClick={()=>deleteDelivery(d)}
                    style={{padding:'7px 14px',fontSize:'12px'}}
                   >
                    <FiTrash2 size={13}/> Delete Record
                   </button>
                  </div>
                 </div>
                </td>
               </tr>
              )}
             </Fragment>
            );
           });
          })()}
         </tbody>
        </table>
       </div>
       </>
      )}
     </div>
     <div className="modal-footer">
      <button type="button" className="secondary" onClick={()=>setBatchDetailsModal(null)}>Close</button>
     </div>
    </div>
   </div>
  )}

 <footer>EmailSender <span>One workspace. Every persona.</span></footer></main></div>;
}
function WorkerCode(){return <pre className="code">Open worker/worker.js in the project repository to view the full Cloudflare Worker script.</pre>;}

