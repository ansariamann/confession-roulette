package com.confessionroulette.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createNotificationChannel();
    }

    /**
     * Create the "Confession Drops" notification channel.
     * On Android 8.0+ (API 26), notifications MUST target a channel or they
     * are silently dropped by the OS. By creating the channel in native code,
     * we guarantee it exists before any FCM message arrives — regardless of
     * whether the JS bridge / Capacitor plugin has initialized yet.
     */
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                "drops_channel",
                "Confession Drops",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Notifications for new live confessions");
            channel.enableVibration(true);
            channel.setShowBadge(true);

            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
}
