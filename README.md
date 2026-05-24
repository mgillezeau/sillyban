# Repetition Ban — SillyTavern extension

Periodically asks an OpenRouter model to identify repetitive phrases in your recent chat history, then exposes the result as a `{{repetition_ban}}` macro you can drop anywhere in your preset.

## Install

Copy the entire `repetition-ban/` folder into your SillyTavern install at:

```
SillyTavern/public/scripts/extensions/third-party/repetition-ban/
```

Then in SillyTavern → Extensions, click **Reload** (or just refresh the page). The extension panel will appear under **Extensions** → **Repetition Ban**.

## Use

1. Make sure your active connection is **Chat Completion** with **OpenRouter** as the source. The extension reuses that connection (and its API key) for its own background calls.
2. Open the **Repetition Ban** drawer in the Extensions panel and configure:
   - **Run every N messages** — fires after every Nth message from any source (user or AI).
   - **Analyze last N messages** — window of recent messages sent to the analyzer.
   - **Model** — OpenRouter model ID (e.g. `anthropic/claude-haiku-4.5`). Leave blank to reuse your active OpenRouter model.
   - **Max tokens / Temperature** — for the analyzer call.
   - **Analyzer system prompt** — the instruction sent to the analyzer. Default outputs a sentence in the format `"Minimize use of the following terms and expressions: …"`.
3. Insert `{{repetition_ban}}` into your preset / system prompt / character notes wherever you want the instruction to appear at generation time. When empty, it expands to nothing.

## Behavior notes

- State is **per-chat** (stored in chat metadata). Switching chats gives you a fresh, empty ban list.
- Triggers run silently in the background after every Nth message. Use **Run now** in the panel to trigger manually.
- If the active backend isn't OpenRouter, scheduled runs are skipped silently and manual runs show a warning.
- The analyzer call goes through SillyTavern's own `/api/backends/chat-completions/generate` endpoint, so your OpenRouter API key never leaves the server-side secrets store.
