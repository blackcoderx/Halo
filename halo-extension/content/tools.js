class ElementRefMap {
  constructor() {
    this._counter = 0;
    this._map = new Map();
  }

  register(el) {
    this._counter++;
    const ref = `ref_${this._counter}`;
    this._map.set(ref, el);
    return ref;
  }

  get(ref) {
    return this._map.get(ref) || null;
  }

  clear() {
    this._map.clear();
    this._counter = 0;
  }
}

class HaloTools {
  constructor() {
    this._refs = new ElementRefMap();
  }

  declarations() {
    return [
      {
        name: 'computer',
        description: 'Perform mouse, keyboard, and browser actions on the page. Use find_elements first to get coordinates/refs.',
        parameters: {
          type: 'OBJECT',
          properties: {
            action: {
              type: 'STRING',
              enum: ['click', 'type', 'key', 'scroll', 'hover', 'drag', 'wait', 'screenshot'],
              description: 'Action to perform',
            },
            coordinate: {
              type: 'ARRAY',
              items: { type: 'NUMBER' },
              description: '[x, y] pixel coordinates for click/hover/drag',
            },
            text: {
              type: 'STRING',
              description: 'Text to type (type action) or key name (key action, e.g. "Enter", "Tab")',
            },
            scroll_direction: {
              type: 'STRING',
              enum: ['up', 'down', 'left', 'right'],
              description: 'Direction to scroll',
            },
            scroll_amount: {
              type: 'NUMBER',
              description: 'Scroll distance in pixels (default: 300)',
            },
            duration: {
              type: 'NUMBER',
              description: 'Seconds to wait for wait action (0-30)',
            },
            click_count: {
              type: 'NUMBER',
              description: 'Click count for double/triple click (default: 1)',
            },
            button: {
              type: 'STRING',
              enum: ['left', 'right'],
              description: 'Mouse button for click (default: left)',
            },
            keys: {
              type: 'STRING',
              description: 'Alternative to text for key action',
            },
            start_coordinate: {
              type: 'ARRAY',
              items: { type: 'NUMBER' },
              description: '[x, y] start position for drag',
            },
            end_coordinate: {
              type: 'ARRAY',
              items: { type: 'NUMBER' },
              description: '[x, y] end position for drag',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'navigate',
        description: 'Navigate to a URL or go back/forward in browser history',
        parameters: {
          type: 'OBJECT',
          properties: {
            url: {
              type: 'STRING',
              description: 'URL to navigate to, or "back"/"forward" for history navigation',
            },
          },
          required: ['url'],
        },
      },
      {
        name: 'find_elements',
        description: 'Get all interactive elements on the page with reference IDs and coordinates for use with computer tool',
        parameters: {
          type: 'OBJECT',
          properties: {},
        },
      },
      {
        name: 'get_page_content',
        description: 'Read the main text content of the current page',
        parameters: {
          type: 'OBJECT',
          properties: {
            max_chars: {
              type: 'NUMBER',
              description: 'Maximum characters to return (default: 5000)',
            },
          },
        },
      },
      {
        name: 'get_page_info',
        description: 'Get the current page URL, title, and meta description',
        parameters: {
          type: 'OBJECT',
          properties: {},
        },
      },
      {
        name: 'save_memory',
        description: 'Remember an important fact about the user or current page for future sessions. Call this AFTER completing a meaningful action (form submitted, item purchased, setting changed) or when the user shares personal info/preferences. Do NOT save trivial things like "user asked me to scroll".',
        parameters: {
          type: 'OBJECT',
          properties: {
            note: {
              type: 'STRING',
              description: 'The fact or memory to persist',
            },
            scope: {
              type: 'STRING',
              enum: ['page', 'global'],
              description: '"page" = relevant only to this website, "global" = applies everywhere (user name, preferences)',
            },
          },
          required: ['note'],
        },
      },
      {
        name: 'recall',
        description: 'Recall what happened in past sessions on a specific website. Use when the user asks "what did I do on X?" or "do you remember when we were on Y?"',
        parameters: {
          type: 'OBJECT',
          properties: {
            hostname: {
              type: 'STRING',
              description: 'Website hostname to recall (e.g. "x.com", "github.com"). Omit to see all.',
            },
          },
        },
      },
      {
        name: 'clear_memory',
        description: 'Clear all stored memories and user facts. Ask the user to confirm before calling.',
        parameters: {
          type: 'OBJECT',
          properties: {},
        },
      },
      {
        name: 'javascript',
        description: 'Execute JavaScript code on the page',
        parameters: {
          type: 'OBJECT',
          properties: {
            code: {
              type: 'STRING',
              description: 'JavaScript code to execute',
            },
          },
          required: ['code'],
        },
      },
    ];
  }

  async execute(name, args = {}) {
    switch (name) {
      case 'computer': {
        const result = await this._execCDP(name, args);
        if (args.action === 'screenshot' && typeof result === 'string' && result.length > 500) {
          return `Screenshot captured (${result.length} bytes)`;
        }
        return result;
      }
      case 'navigate':
      case 'javascript':
        return this._execCDP(name, args);

      case 'find_elements':
        return this._findElements();
      case 'get_page_content':
        return this._getPageContent(args.max_chars || 5000);
      case 'get_page_info':
        return this._getPageInfo();
      case 'save_memory':
        return this._saveMemory(args.note, args.scope || 'page');
      case 'recall':
        return this._recall(args.hostname);
      case 'clear_memory':
        return this._clearMemory();
      default:
        return `Unknown tool: ${name}`;
    }
  }

  _execCDP(tool, params) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'EXECUTE_CDP', tool, params }, (res) => {
        if (chrome.runtime.lastError) resolve(`Error: ${chrome.runtime.lastError.message}`);
        else if (res?.error) resolve(`Error: ${res.error}`);
        else resolve(res?.result ?? 'Done');
      });
    });
  }

  sendDetach() {
    chrome.runtime.sendMessage({ type: 'CDP_DETACH' }).catch(() => {});
  }

  // ── Content-script tools (no CDP needed) ───────────────────────────────

  _findElements() {
    this._refs.clear();
    const lines = [];
    const selector = [
      'a', 'button', 'input', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="textbox"]',
      '[role="combobox"]', '[role="checkbox"]', '[role="radio"]',
      '[role="searchbox"]', '[role="spinbutton"]', '[role="slider"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ');

    document.querySelectorAll(selector).forEach((el) => {
      if (!this._isVisible(el)) return;
      const ref = this._refs.register(el);
      const rect = el.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2);
      const cy = Math.round(rect.top + rect.height / 2);

      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      let role = el.getAttribute('role') || '';
      if (!role) {
        if (tag === 'a') role = 'link';
        else if (tag === 'button' || type === 'submit' || type === 'button') role = 'button';
        else if (tag === 'input' && type === 'checkbox') role = 'checkbox';
        else if (tag === 'input' && type === 'radio') role = 'radio';
        else if (tag === 'select') role = 'combobox';
        else if (tag === 'textarea' || tag === 'input') role = 'textbox';
        else role = 'element';
      }

      const name =
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        el.textContent?.trim().slice(0, 80) ||
        el.getAttribute('name') ||
        '';

      lines.push(`[${ref}] ${role} "${name}" @(${cx},${cy})` + (el.href ? ` href="${el.href}"` : ''));
    });

    return lines.length ? lines.join('\n') : 'No interactive elements found on this page.';
  }

  _getPageContent(maxChars) {
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'FOOTER', 'NAV']);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const tag = node.parentElement?.tagName;
        if (skip.has(tag)) return NodeFilter.FILTER_REJECT;
        return node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    const parts = [];
    let node;
    while ((node = walker.nextNode()) && parts.join(' ').length < (maxChars || 5000)) {
      parts.push(node.textContent.trim());
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    return text || 'No readable text found on this page.';
  }

  _getPageInfo() {
    return JSON.stringify({
      url: location.href,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content || '',
      headings: [...document.querySelectorAll('h1, h2')].slice(0, 10).map((h) => h.textContent.trim()),
    });
  }

  async _saveMemory(note, scope = 'page') {
    const memory = window.__haloMemory;
    if (!memory) return 'Memory system not available';
    let hostname = null;
    if (scope === 'page') {
      try { hostname = new URL(location.href).hostname } catch {}
    }
    await memory.saveMemory(note, scope, hostname);
    return `Saved memory: ${note}`;
  }

  async _recall(hostname) {
    const memory = window.__haloMemory;
    if (!memory) return 'Memory system not available';
    if (hostname) {
      return memory.getPageContext(hostname);
    }
    const data = memory.data;
    const lines = ['## All stored page memories'];
    for (const [host, sessions] of Object.entries(data.sessionsByHost || {})) {
      const last = sessions[0];
      const summary = last.summary || `${last.turnCount} turns on ${last.pageTitle}`;
      lines.push(`- ${host}: ${summary}`);
    }
    return lines.length > 1 ? lines.join('\n') : 'No memories stored yet.';
  }

  async _clearMemory() {
    const memory = window.__haloMemory;
    if (!memory) return 'Memory system not available';
    await memory.clearMemory();
    return 'All memories cleared';
  }

  _isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
  }
}
