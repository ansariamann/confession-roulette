import { useState, useEffect, useCallback, useRef } from 'react';
import { getToken, onMessage } from 'firebase/messaging';
import { messaging } from '../firebase';
import { useAuth } from '../context/AuthProvider';

/**
 * Robust notification hook.
 *
 * Design:
 * - On mount, detects platform (native Capacitor or web browser).
 * - Immediately requests notification permission (no manual toggle needed).
 * - Registers the FCM token with the backend.
 * - Exposes `disableNotifications` so the user can turn them off later.
 * - Exposes `enableNotifications` to re-enable them.
 *
 * Native detection:
 * - We know `Capacitor.isNativePlatform()` works at module init time in
 *   firebase.js (Google login uses it). So we use the same import and
 *   call it inside a useEffect (client-side only).
 */

// Lazy-load Capacitor modules only on the client
let _Capacitor = null;
let _PushNotifications = null;
let _nativeDetected = null; // cached result

function isNative() {
  if (typeof window === 'undefined') return false;
  if (_nativeDetected !== null) return _nativeDetected;

  try {
    // Check raw bridge first (most reliable for remote URL)
    if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function') {
      _nativeDetected = window.Capacitor.isNativePlatform();
      return _nativeDetected;
    }
  } catch { /* ignore */ }

  try {
    if (_Capacitor && _Capacitor.isNativePlatform()) {
      _nativeDetected = true;
      return true;
    }
  } catch { /* ignore */ }

  _nativeDetected = false;
  return false;
}

async function loadCapacitorModules() {
  if (_Capacitor && _PushNotifications) return true;
  try {
    const core = await import('@capacitor/core');
    const push = await import('@capacitor/push-notifications');
    _Capacitor = core.Capacitor;
    _PushNotifications = push.PushNotifications;
    // Re-check native now that module is loaded
    if (_Capacitor.isNativePlatform()) {
      _nativeDetected = true;
    }
    return true;
  } catch (err) {
    console.error('[Notifications] Failed to load Capacitor modules:', err);
    return false;
  }
}

export function useNotifications() {
  const { user } = useAuth();
  const [permission, setPermission] = useState('default');
  const [isSupported, setIsSupported] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const registeredRef = useRef(false);
  const initRef = useRef(false);

  // ── Register token with backend ─────────────────────────────────────────
  const registerToken = useCallback(async (token) => {
    if (!user) return false;
    try {
      const { auth } = await import('../firebase');
      if (!auth.currentUser) return false;
      const idToken = await auth.currentUser.getIdToken();

      const res = await fetch('/api/notifications/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
        body: JSON.stringify({ token }),
      });

      if (res.ok) {
        console.log('[Notifications] Token registered with backend');
        return true;
      } else {
        console.error('[Notifications] Backend registration failed:', res.status);
        return false;
      }
    } catch (err) {
      console.error('[Notifications] registerToken error:', err);
      return false;
    }
  }, [user]);

  // ── Native (Capacitor) registration ─────────────────────────────────────
  const registerNative = useCallback(async () => {
    if (!_PushNotifications) return false;

    try {
      let permStatus = await _PushNotifications.checkPermissions();

      if (permStatus.receive !== 'granted') {
        permStatus = await _PushNotifications.requestPermissions();
      }

      if (permStatus.receive !== 'granted') {
        console.warn('[Notifications] Native permission denied');
        setPermission('denied');
        return false;
      }

      setPermission('granted');

      // Wait for registration event with timeout
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.warn('[Notifications] Native registration timed out after 15s');
          resolve(false);
        }, 15000);

        _PushNotifications.addListener('registration', async (regToken) => {
          clearTimeout(timeout);
          console.log('[Notifications] Native FCM token received');
          const success = await registerToken(regToken.value);
          registeredRef.current = success;
          resolve(success);
        });

        _PushNotifications.addListener('registrationError', (error) => {
          clearTimeout(timeout);
          console.error('[Notifications] Native registration error:', JSON.stringify(error));
          resolve(false);
        });

        _PushNotifications.register();
      });
    } catch (err) {
      console.error('[Notifications] registerNative error:', err);
      return false;
    }
  }, [registerToken]);

  // ── Web (browser) registration ──────────────────────────────────────────
  const registerWeb = useCallback(async () => {
    if (!messaging) return false;

    try {
      const currentPermission = await Notification.requestPermission();
      setPermission(currentPermission);

      if (currentPermission !== 'granted') {
        console.warn('[Notifications] Web permission denied');
        return false;
      }

      const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
      if (!vapidKey) {
        console.error('[Notifications] VAPID key missing');
        return false;
      }

      const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
      await navigator.serviceWorker.ready;

      const token = await getToken(messaging, {
        vapidKey,
        serviceWorkerRegistration: registration,
      });

      if (token) {
        const success = await registerToken(token);
        registeredRef.current = success;
        return success;
      }

      console.warn('[Notifications] No web token received');
      return false;
    } catch (err) {
      console.error('[Notifications] registerWeb error:', err);
      return false;
    }
  }, [registerToken]);

  // ── Main init: detect platform, request permission, register ────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!user) return;
    if (initRef.current) return;
    initRef.current = true;

    async function init() {
      setIsRegistering(true);

      // Try native first
      await loadCapacitorModules();

      if (isNative()) {
        console.log('[Notifications] Native platform detected');
        setIsSupported(true);
        await registerNative();
      } else if ('Notification' in window && messaging) {
        console.log('[Notifications] Web platform detected');
        setIsSupported(true);
        await registerWeb();
      } else {
        console.warn('[Notifications] No notification support detected');
      }

      setIsRegistering(false);
    }

    // Small delay to let the Capacitor bridge fully initialize
    const timer = setTimeout(init, 500);
    return () => clearTimeout(timer);
  }, [user, registerNative, registerWeb]);

  // ── Listen for foreground messages ──────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (permission !== 'granted') return;

    if (isNative() && _PushNotifications) {
      const listener = _PushNotifications.addListener('pushNotificationReceived', (notification) => {
        console.log('[Notifications] Foreground push:', notification);
      });
      return () => { listener.then(l => l.remove()); };
    } else if (messaging) {
      const unsub = onMessage(messaging, (payload) => {
        console.log('[Notifications] Foreground web message:', payload);
      });
      return () => unsub();
    }
  }, [permission]);

  // ── Enable notifications (re-register) ─────────────────────────────────
  const enableNotifications = useCallback(async () => {
    if (!user || !isSupported) return false;
    setIsRegistering(true);

    let success;
    if (isNative()) {
      success = await registerNative();
    } else {
      success = await registerWeb();
    }

    setIsRegistering(false);
    return success;
  }, [user, isSupported, registerNative, registerWeb]);

  // ── Disable notifications (unregister token from backend) ───────────────
  const disableNotifications = useCallback(async () => {
    if (!user) return;
    try {
      const { auth } = await import('../firebase');
      if (!auth.currentUser) return;
      const idToken = await auth.currentUser.getIdToken();

      await fetch('/api/notifications/unregister', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
        },
      });
      registeredRef.current = false;
      setPermission('disabled'); // app-level disable, not OS-level
      console.log('[Notifications] Disabled on server');
    } catch (err) {
      console.error('[Notifications] disableNotifications error:', err);
    }
  }, [user]);

  return {
    permission,
    isSupported,
    isRegistering,
    enableNotifications,
    disableNotifications,
  };
}
