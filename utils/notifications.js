import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// Show an error notification in GNOME Shell.
export function sendErrorNotification(message) {
    try {
        const source = new MessageTray.Source({
            title: 'Live LockPaper',
            iconName: 'dialog-error-symbolic',
        });

        Main.messageTray.add(source);

        const notification = new MessageTray.Notification({
            source,
            title: 'Live LockPaper',
            body: message,
            urgency: MessageTray.Urgency.HIGH,
        });

        source.addNotification(notification);
    } catch (e) {
        console.error(`[LiveLockPaper] Failed to send notification: ${e.message}`);
    }
}
