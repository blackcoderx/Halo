class MemoryManager {
  constructor() {
    this._storageKey = 'halo_memory';
    this._maxConversations = 5;
    this._maxFacts = 10;
    this._maxTranscript = 50;
    this.data = { conversations: [], userFacts: [] };
    this._transcript = [];
    this._loaded = false;
  }

  async load() {
    try {
      const result = await chrome.storage.local.get(this._storageKey);
      if (result[this._storageKey]) {
        this.data = result[this._storageKey];
      }
      this._loaded = true;
    } catch (e) {
      console.warn('[Memory] Failed to load:', e);
      this._loaded = true;
    }
  }

  async save() {
    try {
      await chrome.storage.local.set({ [this._storageKey]: this.data });
    } catch (e) {
      console.warn('[Memory] Failed to save:', e);
    }
  }

  addToTranscript(role, text) {
    if (!text || !text.trim()) return;
    this._transcript.push({
      role,
      text: text.trim(),
      timestamp: Date.now(),
    });
    if (this._transcript.length > this._maxTranscript) {
      this._transcript = this._transcript.slice(-this._maxTranscript);
    }
  }

  getContextString() {
    const parts = [];

    if (this.data.userFacts.length > 0) {
      parts.push('USER FACTS:');
      for (const fact of this.data.userFacts.slice(-this._maxFacts)) {
        parts.push(`- ${fact}`);
      }
      parts.push('');
    }

    if (this.data.conversations.length > 0) {
      parts.push('PREVIOUS SESSION MEMORY:');
      for (const c of this.data.conversations.slice(-this._maxConversations)) {
        const page = c.pageTitle || c.url || 'unknown page';
        parts.push(`- ${c.date} on "${page}": ${c.snippet}`);
        if (c.facts && c.facts.length > 0) {
          for (const f of c.facts) {
            parts.push(`  → ${f}`);
          }
        }
      }
      parts.push('');
    }

    if (parts.length === 0) return '';

    return (
      'PREVIOUS CONTEXT (this is what I remember about the user):\n' +
      parts.join('\n')
    );
  }

  async saveMemory(note) {
    if (!note || !note.trim()) return;
    const trimmed = note.trim();
    if (!this.data.userFacts.includes(trimmed)) {
      this.data.userFacts.push(trimmed);
      if (this.data.userFacts.length > this._maxFacts * 2) {
        this.data.userFacts = this.data.userFacts.slice(-this._maxFacts);
      }
      await this.save();
    }
  }

  async endSession(pageUrl, pageTitle) {
    const snippet = this._generateSnippet();
    const facts = this._extractFactsFromTranscript();

    if (!snippet) {
      this._transcript = [];
      return;
    }

    this.data.conversations.push({
      date: new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
      pageTitle: pageTitle || '',
      url: pageUrl || '',
      snippet,
      facts,
    });

    if (this.data.conversations.length > this._maxConversations * 2) {
      this.data.conversations = this.data.conversations.slice(-this._maxConversations);
    }

    this._transcript = [];
    await this.save();
  }

  clearMemory() {
    this.data = { conversations: [], userFacts: [] };
    this._transcript = [];
    return this.save();
  }

  _generateSnippet() {
    if (this._transcript.length === 0) return '';
    const userLines = this._transcript
      .filter((e) => e.role === 'user')
      .slice(0, 3)
      .map((e) => e.text);
    const combined = userLines.join('; ');
    return combined.length > 200 ? combined.slice(0, 197) + '...' : combined;
  }

  _extractFactsFromTranscript() {
    return [];
  }
}
