import { useState, useEffect } from 'react';
import { getToken, onMessage } from 'firebase/messaging';
import { messaging } from '../firebase';
import { useAuth } from '../context/AuthProvider';

export function useNotifications() {
  const { user } = useAuth();
  const [permission, setPermission] = useState('default');
  const [isSupported, setIsSupported] = useState(false);

  useEffect(() => {
    // Check if running in browser and if Notification API is available
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setPermission(Notification.permission);
      
      // Basic check for messaging support (requires https and service workers)
      if (messaging) {
        setIsSupported(true);
      }
    }
  }, []);

  // Auto-register token when user is available and permission is already granted
  useEffect(() => {
    if (user && isSupported && permission === 'granted') {
      requestPermission(true);
    }
  }, [user, isSupported]);

  // Listen for foreground messages if needed
  useEffect(() => {
    if (!messaging || permission !== 'granted') return;

    const unsubscribe = onMessage(messaging, (payload) => {
      console.log('Message received. ', payload);
      // In-app foreground toast can be handled here if we want to override DropContext auto-nav.
      // But we are relying on DropContext for now.
    });

    return () => unsubscribe();
  }, [permission]);

  const requestPermission = async (isAutoLoad = false) => {
    if (!isSupported || !messaging || !user) return false;

    try {
      const currentPermission = await Notification.requestPermission();
      setPermission(currentPermission);

      if (currentPermission === 'granted') {
        const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
        if (!vapidKey) {
          if (!isAutoLoad) alert('VAPID key is missing! Did you restart your Next.js dev server after adding it to .env?');
          console.warn('NEXT_PUBLIC_FIREBASE_VAPID_KEY is missing.');
          return false;
        }

        // Explicitly register the service worker to prevent push service errors
        const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
        await navigator.serviceWorker.ready; // Wait for the service worker to be active
        
        const currentToken = await getToken(messaging, { 
          vapidKey,
          serviceWorkerRegistration: registration
        });
        
        if (currentToken) {
          await registerToken(currentToken);
          return true;
        } else {
          if (!isAutoLoad) alert('No registration token available. This might happen if the VAPID key is invalid or if there are browser restrictions.');
          console.log('No registration token available. Request permission to generate one.');
          return false;
        }
      }
      return false;
    } catch (err) {
      if (!isAutoLoad) alert(`Error requesting permission: ${err.message}`);
      console.error('An error occurred while requesting permission ', err);
      return false;
    }
  };

  const registerToken = async (token) => {
    try {
      const { auth } = await import('../firebase');
      const idToken = await auth.currentUser.getIdToken();
      
      await fetch('/api/notifications/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify({ token }),
      });
    } catch (err) {
      console.error('Failed to register FCM token', err);
    }
  };

  const disableNotifications = async () => {
    if (!user) return;
    try {
      const { auth } = await import('../firebase');
      const idToken = await auth.currentUser.getIdToken();
      
      await fetch('/api/notifications/unregister', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        }
        // Could send token here to remove a specific token, 
        // but for simplicity unregistering might clear all or just needs a dummy body
      });
      // Note: we can't 'revoke' permission from the browser side, 
      // the user has to do it in settings. We just stop sending to them.
    } catch (err) {
      console.error('Failed to unregister FCM token', err);
    }
  }

  return { permission, requestPermission, isSupported, disableNotifications };
}
