importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

// We need to initialize the app in the service worker too
// Make sure to use the exact same config as src/firebase.js
const firebaseConfig = {
  apiKey: "AIzaSyCn1M6nfNHC1hdky-egJVN6dFYo6xkxKRo",
  authDomain: "confession-roulette-a6b4b.firebaseapp.com",
  projectId: "confession-roulette-a6b4b",
  storageBucket: "confession-roulette-a6b4b.firebasestorage.app",
  messagingSenderId: "728793328944",
  appId: "1:728793328944:web:4ffd039e05d98aa97cecf5",
  measurementId: "G-5D839RZ3LT"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log("[firebase-messaging-sw.js] Received background message ", payload);
  // Customize notification here if needed, but standard notification payload
  // from the server will automatically trigger an OS notification if we just rely on that.
  // We can intercept it to add custom tags or data if not fully supported by standard payloads.
  
  const notificationTitle = payload.notification?.title || "⚠️ 10-second confession LIVE now.";
  const notificationOptions = {
    body: payload.notification?.body || "You are one of the 100 randomly chosen to see this. Hurry!",
    icon: "/icon-192.png", // Assuming an icon exists, we should probably check if it does or use a default
    data: payload.data || {},
    tag: payload.data?.dropId ? `drop-${payload.data.dropId}` : 'confession-drop',
    requireInteraction: false // Let it dismiss automatically to avoid clutter
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

self.addEventListener('notificationclick', function(event) {
  console.log('[firebase-messaging-sw.js] Notification click Received.', event);

  event.notification.close();

  const urlToOpen = new URL(event.notification.data.url || '/live', self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Check if there is already a window/tab open with the target URL
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        // If so, just focus it. The DropContext in the app will handle the navigation to /live 
        // automatically if pendingDrop is updated via firestore listeners.
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // If no window is open, open a new one
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
