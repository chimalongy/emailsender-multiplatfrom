import { initializeApp, getApps } from 'firebase/app';
import { getMessaging, getToken, deleteToken, isSupported } from 'firebase/messaging';

let clientApp = null;
let clientMessaging = null;

export async function initFirebaseClient(config) {
  if (typeof window === 'undefined') return null;
  const supported = await isSupported();
  if (!supported) return null;

  if (!config?.apiKey || !config?.projectId) {
    return null;
  }

  if (!getApps().length) {
    clientApp = initializeApp({
      apiKey: config.apiKey,
      projectId: config.projectId,
      messagingSenderId: config.messagingSenderId,
      appId: config.appId
    });
  } else {
    clientApp = getApps()[0];
  }

  if (!clientMessaging) {
    clientMessaging = getMessaging(clientApp);
  }

  return { app: clientApp, messaging: clientMessaging };
}

export async function registerPushDevice(config) {
  if (typeof window === 'undefined') {
    throw new Error('Push notifications can only be registered in a browser');
  }

  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    throw new Error('Push notifications are not supported in this browser');
  }

  if (!config?.isEnabled || !config?.vapidKey) {
    throw new Error('Firebase Web Push credentials are not configured. Please set Firebase config in environment.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was ' + permission);
  }

  const client = await initFirebaseClient(config);
  if (!client) {
    throw new Error('Firebase Messaging is not supported on this device/browser');
  }

  // Register service worker with config parameters so background handler has API keys
  const swUrl = `/firebase-messaging-sw.js?apiKey=${encodeURIComponent(config.apiKey)}&projectId=${encodeURIComponent(config.projectId)}&messagingSenderId=${encodeURIComponent(config.messagingSenderId || '')}&appId=${encodeURIComponent(config.appId || '')}`;
  const swRegistration = await navigator.serviceWorker.register(swUrl, { scope: '/' });
  await navigator.serviceWorker.ready;

  const currentToken = await getToken(client.messaging, {
    vapidKey: config.vapidKey,
    serviceWorkerRegistration: swRegistration
  });

  if (!currentToken) {
    throw new Error('Failed to retrieve FCM device token from Google');
  }

  // Register token with backend
  const res = await fetch('/api/notifications/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: currentToken,
      userAgent: navigator.userAgent
    })
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to save device token on server');
  }

  localStorage.setItem('fcm_token', currentToken);
  return { ok: true, token: currentToken };
}

export async function unregisterPushDevice(config) {
  if (typeof window === 'undefined') return { ok: true };

  const savedToken = localStorage.getItem('fcm_token');
  try {
    const client = await initFirebaseClient(config);
    if (client && savedToken) {
      await deleteToken(client.messaging);
    }
  } catch (e) {
    console.warn('[FCM] deleteToken error:', e.message);
  }

  if (savedToken) {
    try {
      await fetch('/api/notifications/unregister', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: savedToken })
      });
    } catch {}
  }

  localStorage.removeItem('fcm_token');
  return { ok: true };
}

export function getLocalDevicePushState() {
  if (typeof window === 'undefined') {
    return { supported: false, permission: 'default', registered: false };
  }
  const supported = ('Notification' in window) && ('serviceWorker' in navigator);
  const permission = supported ? Notification.permission : 'unsupported';
  const savedToken = localStorage.getItem('fcm_token');

  return {
    supported,
    permission,
    registered: Boolean(permission === 'granted' && savedToken)
  };
}
