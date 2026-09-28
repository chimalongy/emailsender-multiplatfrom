export function fail(message,status=400) { throw Object.assign(new Error(message),{status}); }
export function line(v,name,max=255) { if(typeof v!=='string'||!v.trim()||v.length>max||/[\r\n\0]/.test(v)) fail(`Invalid ${name}`); return v.trim(); }
export function email(v) { v=line(v,'email',254).toLowerCase(); if(!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(v)) fail('Invalid email address'); return v; }
export function domain(v) { v=line(v,'domain').toLowerCase(); if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(v)) fail('Enter a domain without https://'); return v; }
export function uuid(v) { if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v||'')) fail('Invalid identifier'); return v; }
export function limit(v) { if(v===''||v===null||v===undefined) return null; const n=Number(v); if(!Number.isInteger(n)||n<1||n>100000000) fail('Limits must be positive integers'); return n; }
export function parseEmailList(input) {
  if (Array.isArray(input)) return [...new Set(input.map(x => String(x).trim().toLowerCase()).filter(Boolean))];
  if (typeof input !== 'string') return [];
  const raw = input.split(/[\r\n,;]+/).map(e => e.trim().toLowerCase()).filter(Boolean);
  return [...new Set(raw.filter(e => /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(e)))];
}
export const htmlEscape = s => s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
