class CDPManager {
  constructor() {
    this._attached = new Set();
  }

  _call(method, ...args) {
    return new Promise((resolve, reject) => {
      chrome.debugger[method](...args, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result);
        }
      });
    });
  }

  async attach(tabId) {
    if (this._attached.has(tabId)) return;
    await this._call('attach', { tabId }, '1.3');
    this._attached.add(tabId);
  }

  async detach(tabId) {
    if (!this._attached.has(tabId)) return;
    try {
      await this._call('detach', { tabId });
    } catch (e) {
      // tab might already be closed
    }
    this._attached.delete(tabId);
  }

  async sendCommand(tabId, method, params = {}) {
    return this._call('sendCommand', { tabId }, method, params);
  }

  detachAll() {
    for (const tabId of [...this._attached]) {
      chrome.debugger.detach({ tabId }, () => {});
    }
    this._attached.clear();
  }
}

const cdp = new CDPManager();

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) cdp._attached.delete(source.tabId);
});

chrome.runtime.onStartup?.addListener(() => cdp.detachAll());

// ── CDP Execution ─────────────────────────────────────────────────────────

async function execCDP(tabId, tool, params) {
  await cdp.attach(tabId);

  switch (tool) {
    case 'computer': return execComputer(tabId, params);
    case 'navigate': return execNavigate(tabId, params);
    case 'javascript': return execJavaScript(tabId, params);
    default: throw new Error(`Unknown tool: ${tool}`);
  }
}

async function execComputer(tabId, p) {
  switch (p.action) {
    case 'click': {
      const [x, y] = p.coordinate || [0, 0];
      const btn = p.button || 'left';
      const cc = p.click_count || 1;
      await cdp.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: btn, clickCount: cc });
      await cdp.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: btn, clickCount: cc });
      return `Clicked at (${x}, ${y})`;
    }

    case 'type': {
      await cdp.sendCommand(tabId, 'Input.insertText', { text: p.text });
      return `Typed "${p.text}"`;
    }

    case 'key': {
      const key = p.text || p.keys || '';
      const KEY_MAP = { 'Enter': 13, 'Tab': 9, 'Backspace': 8, 'Delete': 46, 'Escape': 27, 'ArrowUp': 38, 'ArrowDown': 40, 'ArrowLeft': 37, 'ArrowRight': 39, 'Home': 36, 'End': 35, 'PageUp': 33, 'PageDown': 34, 'Space': 32 };
      const code = key.length === 1 ? key.toUpperCase().charCodeAt(0) : (KEY_MAP[key] || 0);
      await cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: code, key, text: key === 'Enter' ? '\r' : undefined });
      await cdp.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: code, key });
      return `Pressed ${key}`;
    }

    case 'scroll': {
      const amt = p.scroll_amount || 300;
      const dx = p.scroll_direction === 'left' ? -amt : p.scroll_direction === 'right' ? amt : 0;
      const dy = p.scroll_direction === 'down' ? amt : p.scroll_direction === 'up' ? -amt : 0;
      await cdp.sendCommand(tabId, 'Runtime.evaluate', { expression: `window.scrollBy(${dx}, ${dy})`, returnByValue: true });
      return `Scrolled ${p.scroll_direction || ''}`;
    }

    case 'hover': {
      const [hx, hy] = p.coordinate || [0, 0];
      await cdp.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx, y: hy });
      return `Hovered at (${hx}, ${hy})`;
    }

    case 'drag': {
      const [sx, sy] = p.start_coordinate || [0, 0];
      const [ex, ey] = p.end_coordinate || [0, 0];
      await cdp.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left' });
      await cdp.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: ex, y: ey });
      await cdp.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: ex, y: ey, button: 'left' });
      return `Dragged from (${sx},${sy}) to (${ex},${ey})`;
    }

    case 'screenshot': {
      const res = await cdp.sendCommand(tabId, 'Page.captureScreenshot', { format: 'png' });
      return res.data;
    }

    case 'wait': {
      await new Promise(r => setTimeout(r, (p.duration || 1) * 1000));
      return `Waited ${p.duration || 1}s`;
    }

    default:
      throw new Error(`Unknown computer action: ${p.action}`);
  }
}

async function execNavigate(tabId, p) {
  switch (p.url) {
    case 'back':
      await chrome.tabs.goBack(tabId);
      return 'Navigated back';
    case 'forward':
      await chrome.tabs.goForward(tabId);
      return 'Navigated forward';
    default: {
      const url = p.url.includes('://') ? p.url : `https://${p.url}`;
      await chrome.tabs.update(tabId, { url });
      return `Navigated to ${url}`;
    }
  }
}

async function execJavaScript(tabId, p) {
  const res = await cdp.sendCommand(tabId, 'Runtime.evaluate', {
    expression: p.code,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) return `Error: ${res.exceptionDetails.text}`;
  return String(res.result?.value ?? 'undefined');
}

// ── Message Router ─────────────────────────────────────────────────────────

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
    return true;
  }

  if (msg.type === 'TOGGLE_HALO') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab) chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_HALO' }).catch(() => {});
    });
  }

  if (msg.type === 'EXECUTE_CDP') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ error: 'No tab ID' }); return; }
    execCDP(tabId, msg.tool, msg.params)
      .then(r => sendResponse({ result: r }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'CDP_DETACH') {
    const tabId = sender.tab?.id;
    if (tabId) cdp.detach(tabId);
    sendResponse({ ok: true });
  }
});
