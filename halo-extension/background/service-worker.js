chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_TOKEN') {
    chrome.storage.sync.get('backendUrl', async ({ backendUrl }) => {
      if (!backendUrl) {
        sendResponse({ error: 'No backend URL set. Click the Halo extension icon to configure it.' });
        return;
      }
      try {
        const res = await fetch(`${backendUrl}/api/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) {
          sendResponse({ error: `Backend returned ${res.status}: ${await res.text()}` });
          return;
        }
        const data = await res.json();
        sendResponse({ token: data.token });
      } catch (e) {
        sendResponse({ error: `Failed to reach backend: ${e.message}` });
      }
    });
    return true; // keep channel open for async sendResponse
  }

  // Popup asks us to toggle Halo on the active tab
  if (msg.type === 'TOGGLE_HALO') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab) {
        chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_HALO' }).catch(() => {});
      }
    });
  }
});
