const ALLOWED_NOTIFICATION_ACTIONS = new Set(['wifi', 'settings', 'remote', 'devices']);
const NOTIFICATION_ACTION_IDS = { open_wifi: 'wifi' };

function createConnectionNotificationPolicy() {
  let connectionState = 'unknown';
  let wifiUnavailableNotified = false;

  return {
    markConnected() {
      const previous = connectionState;
      connectionState = 'connected';
      wifiUnavailableNotified = false;
      if (previous === 'connected') return null;
      return previous === 'disconnected' ? 'reconnected' : 'connected';
    },
    markDisconnected() {
      if (connectionState !== 'connected') {
        if (connectionState !== 'unknown') connectionState = 'disconnected';
        return null;
      }
      connectionState = 'disconnected';
      return 'disconnected';
    },
    markWifiUnavailable() {
      if (wifiUnavailableNotified) return false;
      wifiUnavailableNotified = true;
      return true;
    },
    markWifiAvailable() {
      wifiUnavailableNotified = false;
    },
    reset() {
      connectionState = 'unknown';
      wifiUnavailableNotified = false;
    },
    getConnectionState() {
      return connectionState;
    },
  };
}

function notificationActionFromResponse(response) {
  const actionIdentifier = response?.actionIdentifier;
  const actionFromButton = NOTIFICATION_ACTION_IDS[actionIdentifier];
  const actionFromData = response?.notification?.request?.content?.data?.action;
  const action = actionFromButton || actionFromData;
  return ALLOWED_NOTIFICATION_ACTIONS.has(action) ? action : null;
}

function notificationResponseKey(response) {
  const requestId = response?.notification?.request?.identifier;
  if (!requestId) return null;
  return `${requestId}:${response?.actionIdentifier || 'default'}`;
}

module.exports = {
  ALLOWED_NOTIFICATION_ACTIONS,
  createConnectionNotificationPolicy,
  notificationActionFromResponse,
  notificationResponseKey,
};
