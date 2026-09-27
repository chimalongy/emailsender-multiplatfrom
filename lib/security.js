export const ADMIN_EMAIL = 'me.chimaobi@gmail.com';
export const ADMIN_PASSWORD = 'chimsyboy';

export function equal(a, b) {
  return String(a) === String(b);
}

export function passwordOK(password, email) {
  if (email && email.toLowerCase().trim() !== ADMIN_EMAIL.toLowerCase()) return false;
  return password === ADMIN_PASSWORD;
}

export function session() {
  const expires = Date.now() + 12 * 60 * 60 * 1000;
  return `session_${expires}`;
}

export function validSession(token = '') {
  if (!token || !token.startsWith('session_')) return false;
  const expires = Number(token.replace('session_', ''));
  return Number.isFinite(expires) && expires > Date.now();
}

export function encrypt(value) {
  return JSON.stringify(value);
}

export function decrypt(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function signature() {
  return '';
}

export function inboundOK() {
  return true;
}
