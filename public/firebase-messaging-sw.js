/* eslint-disable no-undef */
// Firebase Messaging Service Worker for background push notifications
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// Config will be populated dynamically from client or query params if needed
const urlParams = new URL(location).searchParams;
const firebaseConfig = {
  apiKey: urlParams.get('apiKey') || '',
  projectId: urlParams.get('projectId') || '',
  messagingSenderId: urlParams.get('messagingSenderId') || '',
  appId: urlParams.get('appId') || ''
};

if (firebaseConfig.apiKey && firebaseConfig.projectId) {
  try {
    firebase.initializeApp(firebaseConfig);
    const messaging = firebase.messaging();

    messaging.onBackgroundMessage((payload) => {
      const title = payload.notification?.title || payload.data?.title || '✉️ New Email';
      const body = payload.notification?.body || payload.data?.body || 'You have received a new message.';
      const icon = payload.notification?.icon || '/favicon.ico';
      const clickAction = payload.fcmOptions?.link || payload.data?.url || '/mailbox';

      self.registration.showNotification(title, {
        body,
        icon,
        badge: '/favicon.ico',
        tag: 'email-inbound',
        renotify: true,
        data: {
          url: clickAction
        }
      });
    });
  } catch (err) {
    console.warn('[SW] Firebase messaging init failed:', err.message);
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/mailbox';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
