import admin from 'firebase-admin';
import { db } from './db.js';

let appInitialized = false;

function parseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
      if (raw.startsWith('{')) {
        return JSON.parse(raw);
      }
      // Try base64
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      return JSON.parse(decoded);
    } catch (e) {
      console.warn('[FCM] Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:', e.message);
    }
  }

  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }

  return null;
}

export function getFirebaseAdmin() {
  if (appInitialized && admin.apps.length > 0) {
    return admin;
  }

  const serviceAccount = parseServiceAccount();
  if (!serviceAccount) {
    return null;
  }

  try {
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }
    appInitialized = true;
    return admin;
  } catch (err) {
    console.error('[FCM] Initialization failed:', err.message);
    return null;
  }
}

export function isFcmConfigured() {
  return Boolean(parseServiceAccount());
}

export function getPublicFcmConfig() {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY || '';
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || (parseServiceAccount()?.projectId) || '';
  const messagingSenderId = process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || process.env.FIREBASE_MESSAGING_SENDER_ID || '';
  const appId = process.env.NEXT_PUBLIC_FIREBASE_APP_ID || process.env.FIREBASE_APP_ID || '';
  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY || process.env.FIREBASE_VAPID_KEY || '';
  const isEnabled = Boolean(apiKey && projectId && vapidKey);

  return {
    apiKey,
    projectId,
    messagingSenderId,
    appId,
    vapidKey,
    isEnabled
  };
}

/**
 * Sends a push notification to all registered browser devices.
 * Automatically prunes unregistered or expired tokens.
 */
export async function sendFcmPushToAll({
  title,
  body,
  url = '/mailbox',
  tag = 'email-inbound',
  sql = db()
}) {
  const fcmAdmin = getFirebaseAdmin();
  if (!fcmAdmin) {
    return {
      ok: false,
      skipped: true,
      reason: 'FCM is not configured on the server. Set FIREBASE_SERVICE_ACCOUNT in your environment.'
    };
  }

  const tokenRows = await sql`SELECT token FROM fcm_tokens ORDER BY updated_at DESC`;
  if (!tokenRows.length) {
    return {
      ok: true,
      sentCount: 0,
      totalDevices: 0,
      note: 'No registered devices found'
    };
  }

  const tokens = tokenRows.map(r => r.token);
  const appUrl = (process.env.APP_URL || 'https://emailsender-multiplatfrom.vercel.app').replace(/\/$/, '');
  const destinationUrl = url.startsWith('http') ? url : `${appUrl}${url.startsWith('/') ? '' : '/'}${url}`;

  const message = {
    tokens,
    notification: {
      title,
      body: String(body || '').slice(0, 300)
    },
    webpush: {
      headers: {
        Urgency: 'high'
      },
      notification: {
        title,
        body: String(body || '').slice(0, 300),
        icon: '/favicon.ico',
        tag,
        requireInteraction: false
      },
      fcmOptions: {
        link: destinationUrl
      }
    },
    data: {
      url: destinationUrl,
      title: String(title),
      body: String(body || '')
    }
  };

  try {
    const response = await fcmAdmin.messaging().sendEachForMulticast(message);
    const tokensToRemove = [];

    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const errCode = resp.error?.code;
        if (
          errCode === 'messaging/registration-token-not-registered' ||
          errCode === 'messaging/invalid-registration-token' ||
          errCode === 'messaging/mismatched-credential'
        ) {
          tokensToRemove.push(tokens[idx]);
        }
      }
    });

    if (tokensToRemove.length > 0) {
      await sql`DELETE FROM fcm_tokens WHERE token = ANY(${tokensToRemove})`;
    }

    return {
      ok: true,
      sentCount: response.successCount,
      failedCount: response.failureCount,
      totalDevices: tokens.length,
      prunedTokensCount: tokensToRemove.length
    };
  } catch (err) {
    console.error('[FCM] sendEachForMulticast error:', err.message);
    return {
      ok: false,
      error: err.message
    };
  }
}
