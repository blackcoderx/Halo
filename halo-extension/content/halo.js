/*
  Halo — content script
  Injects Squall sprite onto any page. Click sprite to toggle voice session.
  Adapted from gemini-live-ephemeral-tokens-websocket (geminilive.js + mediaUtils.js).
*/

// ── AudioStreamer ─────────────────────────────────────────────────────────────
// Captures mic at 16kHz PCM and calls onChunk(base64) for each audio buffer.

class AudioStreamer {
  constructor() {
    this.audioContext = null;
    this.audioWorklet = null;
    this.mediaStream = null;
    this.isStreaming = false;
  }

  async start(workletUrl, onChunk) {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.audioContext = new AudioContext({ sampleRate: 16000 });
    await this.audioContext.audioWorklet.addModule(workletUrl);

    this.audioWorklet = new AudioWorkletNode(
      this.audioContext,
      "audio-capture-processor",
    );
    this.audioWorklet.port.onmessage = (e) => {
      if (!this.isStreaming || e.data.type !== "audio") return;
      const pcm = this._toPCM16(e.data.data);
      onChunk(this._toBase64(pcm));
    };

    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    source.connect(this.audioWorklet);
    this.isStreaming = true;
  }

  stop() {
    this.isStreaming = false;
    this.audioWorklet?.disconnect();
    this.audioWorklet?.port.close();
    this.audioContext?.close();
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.audioWorklet = null;
    this.audioContext = null;
    this.mediaStream = null;
  }

  _toPCM16(float32) {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      int16[i] = Math.max(-1, Math.min(1, float32[i])) * 0x7fff;
    }
    return int16.buffer;
  }

  _toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = "";
    for (let i = 0; i < bytes.byteLength; i++)
      bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
}

// ── AudioPlayer ───────────────────────────────────────────────────────────────
// Plays 24kHz PCM audio chunks from Gemini.

class AudioPlayer {
  constructor() {
    this.audioContext = null;
    this.workletNode = null;
    this.gainNode = null;
    this.initialized = false;
  }

  async init(workletUrl) {
    if (this.initialized) return;
    this.audioContext = new AudioContext({ sampleRate: 24000 });
    await this.audioContext.audioWorklet.addModule(workletUrl);
    this.workletNode = new AudioWorkletNode(this.audioContext, "pcm-processor");
    this.gainNode = this.audioContext.createGain();
    this.workletNode.connect(this.gainNode);
    this.gainNode.connect(this.audioContext.destination);
    this.initialized = true;
  }

  async play(base64Audio) {
    if (!this.initialized) return;
    if (this.audioContext.state === "suspended")
      await this.audioContext.resume();
    const bin = atob(base64Audio);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    this.workletNode.port.postMessage(float32);
  }

  interrupt() {
    this.workletNode?.port.postMessage("interrupt");
  }

  destroy() {
    this.audioContext?.close();
    this.initialized = false;
  }
}

// ── Sprite state config (from pet-extension/shared/state-machine.js) ──────────

const STATE_CONFIG = {
  idle: { row: 8, frames: 6, durationMs: 150 },
  listening: { row: 3, frames: 4, durationMs: 120 },
  thinking: { row: 0, frames: 6, durationMs: 140 },
  speaking: { row: 7, frames: 6, durationMs: 120 },
  acting: { row: 1, frames: 8, durationMs: 100 },
};

const SPRITE_CELL_W = 192;
const SPRITE_CELL_H = 208;
const RENDER_W = 96;
const RENDER_H = 104;

// ── HaloSession ───────────────────────────────────────────────────────────────

class HaloSession {
  constructor() {
    this.ws = null;
    this.streamer = new AudioStreamer();
    this.player = new AudioPlayer();
    this.tools = new HaloTools(); // defined in tools.js, loaded before this file
    this.state = "idle";
    this.container = null;
    this.canvas = null;
    this.ctx = null;
    this.spritesheet = null;
    this.currentFrame = 0;
    this.frameTimer = null;
    this.tooltip = null;
    this._dragOffset = { x: 0, y: 0 };
    this._dragging = false;
    this._hasMoved = false;
    this.memory = new MemoryManager();
    window.__haloMemory = this.memory;
  }

  async init() {
    this._buildDOM();
    this._restorePosition();
    this._setupDrag();

    // Load spritesheet then start idle animation
    const img = new Image();
    img.src = chrome.runtime.getURL("assets/spritesheet.webp");
    await img.decode();
    this.spritesheet = img;
    await this.memory.load();
    this._setState("idle");

    // Restore visibility and auto-reconnect if session was active before refresh
    chrome.storage.sync.get("haloVisible", ({ haloVisible }) => {
      if (haloVisible) this.container.classList.add("halo-visible");
      if (sessionStorage.getItem("haloActive")) this._startSession();
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === "TOGGLE_HALO") this._toggleVisibility();
    });

    chrome.storage.onChanged.addListener((changes) => {
      if (!changes.haloPosition) return;
      const pos = changes.haloPosition.newValue;
      if (!pos) return;
      this.container.style.left = `${pos.left}px`;
      this.container.style.top = `${pos.top}px`;
      this.container.style.right = "auto";
      this.container.style.bottom = "auto";
    });
  }

  _buildDOM() {
    document.getElementById("halo-container")?.remove();

    this.container = document.createElement("div");
    this.container.id = "halo-container";

    this.canvas = document.createElement("canvas");
    this.canvas.width = RENDER_W;
    this.canvas.height = RENDER_H;
    this.ctx = this.canvas.getContext("2d");

    this.tooltip = document.createElement("div");
    this.tooltip.id = "halo-tooltip";

    this.container.appendChild(this.canvas);
    this.container.appendChild(this.tooltip);
    document.body.appendChild(this.container);

    // Click = toggle session (only if not dragging)
    this.canvas.addEventListener("click", () => {
      if (this._hasMoved) return;
      this.ws ? this._endSession() : this._startSession();
    });
  }

  _restorePosition() {
    chrome.storage.sync.get("haloPosition", ({ haloPosition }) => {
      if (!haloPosition) return;
      const { left, top, vw, vh } = haloPosition;
      if (left === undefined || top === undefined) return;
      if (vw && vh && (Math.abs(vw - window.innerWidth) > 100 || Math.abs(vh - window.innerHeight) > 100)) {
        this.container.style.left = `${(left / vw) * window.innerWidth}px`;
        this.container.style.top = `${(top / vh) * window.innerHeight}px`;
      } else {
        this.container.style.left = `${left}px`;
        this.container.style.top = `${top}px`;
      }
      this.container.style.right = "auto";
      this.container.style.bottom = "auto";
    });
  }

  _setState(state) {
    this.state = state;
    this.currentFrame = 0;
    clearInterval(this.frameTimer);
    const cfg = STATE_CONFIG[state];
    if (!cfg) return;
    this._renderFrame();
    this.frameTimer = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % cfg.frames;
      this._renderFrame();
    }, cfg.durationMs);
  }

  _renderFrame() {
    const cfg = STATE_CONFIG[this.state];
    if (!cfg || !this.ctx || !this.spritesheet) return;
    this.ctx.clearRect(0, 0, RENDER_W, RENDER_H);
    this.ctx.drawImage(
      this.spritesheet,
      this.currentFrame * SPRITE_CELL_W,
      cfg.row * SPRITE_CELL_H,
      SPRITE_CELL_W,
      SPRITE_CELL_H,
      0,
      0,
      RENDER_W,
      RENDER_H,
    );
  }

  _showTooltip(text, duration = 3000) {
    this.tooltip.textContent = text;
    this.tooltip.classList.add("visible");
    clearTimeout(this._tooltipTimer);
    if (duration > 0) {
      this._tooltipTimer = setTimeout(
        () => this.tooltip.classList.remove("visible"),
        duration,
      );
    }
  }

  _toggleVisibility() {
    this.container.classList.toggle("halo-visible");
  }

  // ── Session ──────────────────────────────────────────────────────────────

  async _startSession() {
    this._setState("thinking");
    this._showTooltip("Connecting…", 0);

    // 1. Fetch ephemeral token via service worker
    let token;
    try {
      const resp = await chrome.runtime.sendMessage({ type: "GET_TOKEN" });
      if (resp.error) throw new Error(resp.error);
      token = resp.token;
    } catch (e) {
      this._showTooltip(`Error: ${e.message}`);
      this._setState("idle");
      return;
    }

    sessionStorage.setItem("haloActive", "1");

    // 2. Init audio player (one-time)
    const playerUrl = chrome.runtime.getURL(
      "audio-processors/playback.worklet.js",
    );
    try {
      await this.player.init(playerUrl);
    } catch (e) {
      console.error("[Halo] AudioPlayer init failed:", e);
    }

      // 3. Record start time
    this._sessionStartTime = Date.now();

    // 4. Open WebSocket to Gemini
    const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${token}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => this._sendSetup();
    this.ws.onmessage = (e) => this._onMessage(e);
    this.ws.onerror = (e) => {
      console.error("[Halo] WebSocket error", e);
      this._showTooltip("Connection error");
      this._endSession();
    };
    this.ws.onclose = () => {
      this._setState("idle");
      this.ws = null;
    };
  }

  async _sendSetup() {
    await PromptBuilder.init()
    const pageInfo = {
      title: document.title,
      url: location.href
    }
    const memoryContext = this.memory.getContextForPrompt(location.href)
    const systemInstruction = PromptBuilder.build(pageInfo, memoryContext)

    const setup = {
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
          },
        },
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        tools: [{ functionDeclarations: this.tools.declarations() }],
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            silenceDurationMs: 1500,
            prefixPaddingMs: 300,
          },
          turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
        },
      },
    };

    this.ws.send(JSON.stringify(setup));
  }

  async _onMessage(event) {
    let data;
    try {
      const text =
        event.data instanceof Blob
          ? await event.data.text()
          : event.data instanceof ArrayBuffer
            ? new TextDecoder().decode(event.data)
            : event.data;
      data = JSON.parse(text);
    } catch {
      return;
    }

    // Setup acknowledged — start mic
    if (data.setupComplete) {
      this._showTooltip("Listening…", 2000);
      this._setState("listening");
      const captureUrl = chrome.runtime.getURL(
        "audio-processors/capture.worklet.js",
      );
      try {
        await this.streamer.start(captureUrl, (b64) => this._sendAudio(b64));
      } catch (e) {
        this._showTooltip(`Mic error: ${e.message}`);
        this._endSession();
      }
      return;
    }

    // Tool call
    if (data.toolCall) {
      this._setState("acting");
      const responses = [];
      for (const fc of data.toolCall.functionCalls) {
        this.memory.addTurn('tool_call', null, { name: fc.name, args: fc.args })
        const result = await this.tools.execute(fc.name, fc.args);
        this.memory.addTurn('tool_result', null, { name: fc.name, result })
        responses.push({
          id: fc.id,
          name: fc.name,
          response: { result: String(result) },
        });
      }
      this.ws?.send(
        JSON.stringify({ toolResponse: { functionResponses: responses } }),
      );
      this._setState("listening");
      return;
    }

    const content = data.serverContent;
    if (!content) return;

    // Audio from model
    if (content.modelTurn?.parts) {
      this._setState("speaking");
      for (const part of content.modelTurn.parts) {
        if (part.inlineData) {
          await this.player.play(part.inlineData.data);
        }
        if (part.text) {
          this.memory.addTurn('assistant', part.text);
        }
      }
    }

    if (content.input_transcription?.text) {
      this.memory.addToTranscript('user', content.input_transcription.text);
    }

    if (content.output_transcription?.text) {
      this.memory.addToTranscript('assistant', content.output_transcription.text);
    }

    if (content.interrupted) {
      this.player.interrupt();
      this._setState("listening");
    }

    if (content.turnComplete) {
      this._setState("listening");
    }
  }

  _sendAudio(base64) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: { mimeType: "audio/pcm;rate=16000", data: base64 },
        },
      }),
    );
  }

  async _endSession() {
    this.streamer.stop();
    this.player.interrupt();
    this.ws?.close();
    this.ws = null;
    this.tools.sendDetach();
    clearInterval(this.frameTimer);
    sessionStorage.removeItem("haloActive");
    this._setState("idle");
    this._showTooltip("Session ended", 2000);
    await this.memory.endSession(location.href, document.title);
  }

  // ── Drag ─────────────────────────────────────────────────────────────────

  _setupDrag() {
    this.container.addEventListener("mousedown", (e) => {
      this._dragging = true;
      this._hasMoved = false;
      const rect = this.container.getBoundingClientRect();
      this._dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!this._dragging) return;
      this._hasMoved = true;
      this.container.style.left = `${e.clientX - this._dragOffset.x}px`;
      this.container.style.top = `${e.clientY - this._dragOffset.y}px`;
      this.container.style.right = "auto";
      this.container.style.bottom = "auto";
    });

    document.addEventListener("mouseup", () => {
      if (!this._dragging) return;
      this._dragging = false;
      const rect = this.container.getBoundingClientRect();
      chrome.storage.sync.set({
        haloPosition: {
          left: rect.left,
          top: rect.top,
          vw: window.innerWidth,
          vh: window.innerHeight,
        },
      });
      // Reset hasMoved after a tick so the click handler sees it
      setTimeout(() => {
        this._hasMoved = false;
      }, 0);
    });
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const halo = new HaloSession();
halo.init();
