# Halo

A voice-powered browser AI agent that lives as a floating sprite on any web page. Uses the Gemini Live API for real-time voice conversations and the Chrome DevTools Protocol for automated page interaction.

## Features

- **Voice interaction** -- Bidirectional real-time audio conversations with an AI agent via Gemini Live API WebSocket
- **Page automation** -- Click, type, scroll, drag, navigate, and extract content from any web page using 7+ specialized tools
- **Per-page memory** -- Conversation history stored per hostname in `chrome.storage.local`, capped at 15 most recent turns per session (max 3 sessions per host)
- **Cross-page recall** -- Ask the agent about what you did on other pages via the `recall` tool
- **Sprite persona** -- Configurable character identity loaded from `assets/pet.json` (name, description, spritesheet)
- **Session continuity** -- Auto-reconnects on page refresh if a session was active

## Architecture

```
User clicks sprite
  -> HaloSession._startSession()
    -> GET_TOKEN via service worker -> Python server issues ephemeral token
    -> WebSocket opens to Gemini Live API
    -> Setup message sent with system prompt (Luffy persona + tools + memory context)
    -> Bidirectional audio streaming begins
      -> User speaks -> AudioStreamer (16kHz PCM) -> WebSocket -> Gemini
      -> Gemini responds -> AudioPlayer (24kHz PCM) -> speaker
      -> Gemini calls tools -> HaloTools.execute()
        -> Local tools: find_elements, get_page_content, get_page_info, save_memory, recall
        -> CDP tools: computer, navigate, javascript (via chrome.debugger API)
      -> toolResponse sent back via WebSocket
    -> Session ends -> memory.endSession() persists turns to chrome.storage.local
```

## Setup

### Prerequisites

- Google Chrome (Manifest V3)
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/)
- Python 3.10+ (for the token server)

### Install

1. **Clone the repo**

```
git clone <repo-url>
cd halo-extension
```

2. **Configure the backend server**

```
cd halo-extension
cp .env.example .env
```

Edit `.env` and set your Gemini API key:

```
GEMINI_API_KEY=your_key_here
PORT=8000
```

3. **Start the server**

```
cd halo-extension
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python server.py
```

4. **Load the extension in Chrome**

- Open `chrome://extensions/`
- Enable **Developer mode** (toggle top-right)
- Click **Load unpacked**
- Select the `halo-extension` directory

5. **Configure backend URL**

- Click the Halo icon in the Chrome toolbar
- Enter `http://localhost:8000` as the Backend URL
- Click **Save**

## Usage

### Starting a session

Click the floating sprite on any web page. A voice session begins -- you can speak naturally to the agent.

### Available voice commands

- "Scroll down" / "Scroll up"
- "Click the login button"
- "Type 'hello' in the search box"
- "What's on this page?" (reads page content)
- "Remember my name is Alex" (stores a fact)
- "What did I do on example.com?" (cross-page recall)
- "Save that for later" stores important facts

### Ending a session

Click the sprite again. The session ends and conversation turns are saved to storage.

### Dragging

Click and drag the sprite to reposition it anywhere on the page. Position persists across page loads.

### Cross-page memory

To recall past activity on a different site, say: "What did I do on khanacademy.org?" The agent will call the `recall` tool and return the last session summary for that domain.

## Tools

| Tool | Description |
| --- | --- |
| `computer` | Click, type, key press, scroll, hover, drag, wait, screenshot |
| `navigate` | Go to a URL or back/forward in history |
| `find_elements` | List all interactive elements with reference IDs and coordinates |
| `get_page_content` | Read the visible text on the current page |
| `get_page_info` | Get URL, title, meta description, and headings |
| `save_memory` | Store a fact (scope: "page" or "global") |
| `recall` | Recall past sessions by hostname |
| `javascript` | Execute arbitrary JavaScript on the page |
| `clear_memory` | Clear all stored memories (asks for confirmation) |

## Memory System

### Storage

All memory is stored in `chrome.storage.local` under the key `halo_memory`.

### Structure

```
halo_memory
  sessionsByHost
    hostname          (e.g. "x.com", "github.com")
      id              unique session ID
      date            ISO 8601 timestamp
      pageTitle       page title at session end
      url             full URL at session end
      turnCount       total turns in the session
      turns           array of { role, text, ts }
                        role: "user" | "assistant" | "tool_call" | "tool_result"
      summary         optional LLM-generated 1-2 sentence summary
      facts           array of extracted facts for this session
  userFacts           array of global facts (cross-page)
```

### Rules

- **15 turns max per session** -- only the most recent 15 turns are kept
- **3 sessions max per host** -- oldest sessions are pruned first
- **Last 5 turns injected on revisit** -- when returning to a page, the last 5 turns from the most recent session are included in the system prompt
- **Summary generation** -- if a session exceeds 15 turns, an optional LLM summary is generated via the Gemini REST API (requires API key)
- **Session cleanup** -- old data is automatically pruned on each new session save

## Project Structure

```
halo-extension/
  manifest.json           Chrome Extension Manifest V3
  server.py               Python backend (ephemeral token issuer)
  .env                    API key and port config

  content/
    halo.js               Main content script (HaloSession, AudioStreamer, AudioPlayer)
    memory.js             MemoryManager (chrome.storage.local persistence)
    tools.js              HaloTools (tool declarations + execution)
    prompt.js             PromptBuilder (system prompt generation from pet.json)
    halo.css              Floating sprite overlay styles

  background/
    service-worker.js     CDP bridge, token proxy, message router

  popup/
    popup.html            Extension popup UI
    popup.js              Backend URL config, show/hide toggle

  audio-processors/
    capture.worklet.js    AudioWorklet for mic capture at 16kHz PCM
    playback.worklet.js   AudioWorklet for PCM playback at 24kHz

  assets/
    pet.json              Sprite identity metadata (displayName, description)
    spritesheet.webp      Sprite animation frames
```

## Configuration

### Character identity (`assets/pet.json`)

```json
{
  "id": "luffy",
  "displayName": "Luffy",
  "description": "A tiny straw-hat pirate companion with cheerful rubbery energy.",
  "spritesheetPath": "spritesheet.webp"
}
```

The `displayName` and `description` are loaded at session start and injected into the system prompt. Change these to customize the agent persona.

### Backend server

The Python server runs on configurable port (default 8000). It issues single-use ephemeral Gemini tokens with a 30-minute expiry. The extension fetches a token before each session via the service worker.

## Development

### Adding a new tool

1. Add the declaration in `HaloTools.declarations()` in `tools.js`
2. Add execution logic in `HaloTools.execute()`
3. Add a description in `PromptBuilder.build()` in `prompt.js`
4. If CDP-based, add the command mapping in `service-worker.js`

### Modifying the sprite

Edit `STATE_CONFIG` in `halo.js` for animation timing. Replace `assets/spritesheet.webp` with a new spritesheet (each cell should be 192x208 pixels, 8 columns per row).
