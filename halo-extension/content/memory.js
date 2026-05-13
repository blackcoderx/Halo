function _uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

const MAX_TURNS_PER_SESSION = 15
const MAX_SESSIONS_PER_HOST = 3

class MemoryManager {
  constructor() {
    this._storageKey = 'halo_memory'
    this.data = { sessionsByHost: {}, userFacts: [] }
    this._turns = []
    this._sessionStartTime = null
    this._loaded = false
  }

  async load() {
    try {
      const result = await chrome.storage.local.get(this._storageKey)
      if (result[this._storageKey]) {
        this.data = result[this._storageKey]
      }
      if (this.data.conversations && !this.data.sessionsByHost) {
        const migrated = {}
        for (const conv of this.data.conversations) {
          try {
            const host = new URL(conv.url).hostname
            if (!migrated[host]) migrated[host] = []
            migrated[host].push({
              id: _uid(),
              date: conv.date,
              pageTitle: conv.pageTitle || '',
              url: conv.url || '',
              turnCount: 0,
              turns: [],
              summary: conv.snippet || '',
              facts: conv.facts || []
            })
          } catch { }
        }
        this.data.sessionsByHost = migrated
        delete this.data.conversations
      }
      if (!this.data.userFacts) this.data.userFacts = []
      this._loaded = true
    } catch (e) {
      console.warn('[Memory] Failed to load:', e)
      this._loaded = true
    }
  }

  async save() {
    try {
      await chrome.storage.local.set({ [this._storageKey]: this.data })
    } catch (e) {
      console.warn('[Memory] Failed to save:', e)
    }
  }

  addTurn(role, textOrData, extra = {}) {
    if (role === 'user' && (!textOrData || !textOrData.trim())) return
    const turn = { role, ts: Date.now() }
    if (role === 'tool_call') {
      turn.name = extra.name || ''
      turn.args = extra.args || {}
      turn.text = `Called ${turn.name}(${JSON.stringify(turn.args)})`
    } else if (role === 'tool_result') {
      turn.name = extra.name || ''
      turn.result = typeof extra.result === 'string'
        ? extra.result.slice(0, 200)
        : JSON.stringify(extra.result).slice(0, 200)
      turn.text = `${turn.name} returned: ${turn.result}`
    } else {
      turn.text = textOrData
    }
    this._turns.push(turn)
  }

  addToTranscript(role, text) {
    this.addTurn(role, text)
  }

  getContextForPrompt(currentUrl) {
    const parts = []

    if (this.data.userFacts.length > 0) {
      parts.push('## Things I know about you')
      for (const fact of this.data.userFacts) {
        parts.push(`- ${fact}`)
      }
    }

    let hostname
    try {
      hostname = new URL(currentUrl).hostname
    } catch {
      hostname = ''
    }
    const sessions = hostname ? (this.data.sessionsByHost[hostname] || []) : []

    if (sessions.length > 0) {
      parts.push(`\n## From previous visits to ${hostname}`)
      for (const s of sessions) {
        let dateStr = ''
        try { dateStr = new Date(s.date).toLocaleDateString() } catch { dateStr = s.date || '' }
        if (s.summary) {
          parts.push(`- ${dateStr}: ${s.summary}`)
        } else {
          parts.push(`- ${dateStr}: ${s.turnCount} interactions on ${s.pageTitle}`)
        }
        if (s.facts && s.facts.length > 0) {
          for (const f of s.facts) {
            parts.push(`  > ${f}`)
          }
        }
      }

      const last = sessions[0]
      if (last && last.turns && last.turns.length > 0) {
        const recent = last.turns.slice(-5)
        parts.push('\nLast things you did before you left off:')
        for (const t of recent) {
          const label = t.role === 'user' ? 'You said' : t.role === 'assistant' ? 'Luffy replied' : t.role
          parts.push(`- ${label}: ${t.text}`)
        }
      }
    }

    return parts.join('\n')
  }

  getPageContext(hostname) {
    const sessions = this.data.sessionsByHost[hostname]
    if (!sessions || sessions.length === 0) {
      return `No past sessions found for ${hostname}.`
    }
    return sessions.map(s => {
      let dateStr = ''
      try { dateStr = new Date(s.date).toLocaleDateString() } catch { dateStr = s.date || '' }
      const summary = s.summary || `${s.turnCount} interactions on ${s.pageTitle}`
      return `[${dateStr}] ${s.pageTitle}: ${summary}`
    }).join('\n')
  }

  async saveMemory(note, scope = 'page', hostname = null) {
    if (!note || !note.trim()) return
    const trimmed = note.trim()
    if (scope === 'global') {
      if (!this.data.userFacts.includes(trimmed)) {
        this.data.userFacts.push(trimmed)
        await this.save()
      }
    } else if (hostname) {
      const sessions = this.data.sessionsByHost[hostname]
      if (sessions && sessions.length > 0) {
        if (!sessions[0].facts.includes(trimmed)) {
          sessions[0].facts.push(trimmed)
          await this.save()
        }
      }
    }
  }

  async endSession(pageUrl, pageTitle, apiKey) {
    try {
      let hostname = ''
      try { hostname = new URL(pageUrl).hostname } catch { }

      const session = {
        id: _uid(),
        date: new Date().toISOString(),
        pageTitle: pageTitle || '',
        url: pageUrl || '',
        turnCount: this._turns.length,
        turns: this._turns.slice(-MAX_TURNS_PER_SESSION),
        summary: null,
        facts: []
      }

      if (!this.data.sessionsByHost[hostname]) {
        this.data.sessionsByHost[hostname] = []
      }
      this.data.sessionsByHost[hostname].unshift(session)

      if (this.data.sessionsByHost[hostname].length > MAX_SESSIONS_PER_HOST) {
        this.data.sessionsByHost[hostname] = this.data.sessionsByHost[hostname].slice(0, MAX_SESSIONS_PER_HOST)
      }

      if (this._turns.length > MAX_TURNS_PER_SESSION && apiKey) {
        this._generateSummary(session, apiKey).catch(() => { })
      }

      this._turns = []
      this._sessionStartTime = null
      await this.save()
      console.log(`[Memory] Session saved: ${hostname} (${session.turnCount} turns)`)
    } catch (e) {
      console.error('[Memory] endSession failed:', e)
    }
  }

  async _generateSummary(session, apiKey) {
    const transcriptText = session.turns.map(t => `${t.role}: ${t.text}`).join('\n')
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [{
                text: `Summarize this web browsing conversation in 1-2 sentences. Focus on what the user accomplished and what they were interested in:\n\n${transcriptText}`
              }]
            }],
            generationConfig: { maxOutputTokens: 100 }
          })
        }
      )
      const data = await resp.json()
      session.summary = data.candidates?.[0]?.content?.parts?.[0]?.text || null
      await this.save()
    } catch (e) {
      console.warn('[Memory] Summary generation failed:', e)
    }
  }

  async clearMemory() {
    this.data = { sessionsByHost: {}, userFacts: [] }
    this._turns = []
    return this.save()
  }
}
