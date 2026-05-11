class HaloTools {
  declarations() {
    return [
      {
        name: 'fill_form_field',
        description: 'Fill a form field on the current page by its visible label, placeholder, or name',
        parameters: {
          type: 'OBJECT',
          properties: {
            field_label: {
              type: 'STRING',
              description: 'The visible label text, placeholder, aria-label, or name attribute of the field'
            },
            value: {
              type: 'STRING',
              description: 'The value to fill in'
            }
          },
          required: ['field_label', 'value']
        }
      },
      {
        name: 'summarize_page',
        description: 'Read the text content of the current web page so you can summarize it aloud for the user',
        parameters: {
          type: 'OBJECT',
          properties: {}
        }
      },
      {
        name: 'click_element',
        description: 'Click a button, link, or interactive element by its visible text',
        parameters: {
          type: 'OBJECT',
          properties: {
            text: {
              type: 'STRING',
              description: 'The visible text of the button or link to click'
            }
          },
          required: ['text']
        }
      },
      {
        name: 'scroll_to_section',
        description: 'Scroll the page to a section heading',
        parameters: {
          type: 'OBJECT',
          properties: {
            heading: {
              type: 'STRING',
              description: 'The text of the heading to scroll to'
            }
          },
          required: ['heading']
        }
      },
      {
        name: 'get_page_info',
        description: 'Get the current page URL, title, and meta description as context',
        parameters: {
          type: 'OBJECT',
          properties: {}
        }
      }
    ];
  }

  async execute(name, args = {}) {
    switch (name) {
      case 'fill_form_field':   return this._fillFormField(args.field_label, args.value);
      case 'summarize_page':    return this._summarizePage();
      case 'click_element':     return this._clickElement(args.text);
      case 'scroll_to_section': return this._scrollToSection(args.heading);
      case 'get_page_info':     return this._getPageInfo();
      default:                  return `Unknown tool: ${name}`;
    }
  }

  _fillFormField(label, value) {
    const inputs = [...document.querySelectorAll('input, textarea, select')];
    const q = (label || '').toLowerCase();

    const match = inputs.find(el => {
      const forLabel = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
      return (
        forLabel?.textContent?.toLowerCase().includes(q) ||
        (el.placeholder || '').toLowerCase().includes(q) ||
        (el.name || '').toLowerCase().includes(q) ||
        (el.getAttribute('aria-label') || '').toLowerCase().includes(q) ||
        (el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent?.toLowerCase().includes(q))
      );
    });

    if (!match) return `Could not find a field matching: "${label}"`;

    match.focus();
    // Handle React/Vue controlled inputs by triggering native setter
    const nativeSetter = Object.getOwnPropertyDescriptor(
      match.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype,
      'value'
    )?.set;
    if (nativeSetter) nativeSetter.call(match, value);
    else match.value = value;

    match.dispatchEvent(new Event('input',  { bubbles: true }));
    match.dispatchEvent(new Event('change', { bubbles: true }));
    return `Filled "${label}" with "${value}"`;
  }

  _summarizePage() {
    // Skip script/style/nav noise, grab meaningful text
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'FOOTER', 'NAV']);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const tag = node.parentElement?.tagName;
        if (skip.has(tag)) return NodeFilter.FILTER_REJECT;
        return node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    const parts = [];
    let node;
    while ((node = walker.nextNode()) && parts.join(' ').length < 8000) {
      parts.push(node.textContent.trim());
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    return text || 'No readable text found on this page.';
  }

  _clickElement(text) {
    const q = (text || '').toLowerCase();
    const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"]')];
    const match = candidates.find(el => el.textContent?.trim().toLowerCase().includes(q) || el.value?.toLowerCase().includes(q));
    if (!match) return `Could not find a clickable element with text: "${text}"`;
    match.click();
    return `Clicked: "${match.textContent?.trim() || match.value}"`;
  }

  _scrollToSection(heading) {
    const q = (heading || '').toLowerCase();
    const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')];
    const match = headings.find(h => h.textContent?.toLowerCase().includes(q));
    if (!match) return `Could not find a heading matching: "${heading}"`;
    match.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return `Scrolled to: "${match.textContent.trim()}"`;
  }

  _getPageInfo() {
    return JSON.stringify({
      url: location.href,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.content || '',
      headings: [...document.querySelectorAll('h1, h2')].slice(0, 10).map(h => h.textContent.trim())
    });
  }
}
