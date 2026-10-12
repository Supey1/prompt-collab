# PromptCollab

Write one AI prompt together, in real time, then send it to any model.

Teams share a room link. Everyone edits the same prompt live, like a shared doc, with name-tagged cursors. When the prompt is ready, anyone sends it to the model the room has picked, whether that's GPT, Claude, Gemini, or any of the hundreds of models on OpenRouter. The reply streams to everyone in the room at once.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer. There's nothing to install: the app has no dependencies.

```bash
git clone https://github.com/Supey1/prompt-collab
cd prompt-collab
npm start            # or: node server/index.js
```

Open http://localhost:3000 and click **Start a room**. To try the collaboration on one computer, open the room link in a second browser window.

Without API keys the app runs in **demo mode**: a built-in stand-in model replies, so you can try the collaboration before setting anything up.

## Add real models

Copy `.env.example` to `.env`, fill in any keys you have, and restart:

| Variable | Gives you |
| --- | --- |
| `OPENAI_API_KEY` | GPT models |
| `ANTHROPIC_API_KEY` | Claude models |
| `GEMINI_API_KEY` | Gemini models |
| `OPENROUTER_API_KEY` | Hundreds of models (Llama, Mistral, DeepSeek, and more) through one key |

The model menu is built from each provider's live model list when the server starts, so new models appear without code changes.

Other settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `ACCESS_CODE` | none | If set, people must enter this code to join a room. **Set this before putting the app online**, or anyone with a link can spend your API credits. |
| `DATA_DIR` | `./data` | Where rooms are saved as JSON files |
| `DISABLE_DEMO` | none | Set to `1` to hide the demo model |

## How it works

```
browser ── WebSocket ──► server/index.js
  │                         │
  ├ editor.js               ├ rooms.js      one Room per link: shared text, thread, model, usage
  │  (textarea + cursors)   ├ doc.js        orders every edit (operational transformation)
  ├ doc-client.js           ├ providers.js  OpenAI / Anthropic / Gemini / OpenRouter / demo
  └ shared/ot.js ◄──────────┘ ws.js         minimal WebSocket server
```

- **Live editing** uses operational transformation (`public/shared/ot.js`). The server is the single source of truth: it puts concurrent edits in order and transforms each one so every person ends up with identical text. `npm test` fuzz-tests this with simulated clients editing at the same time.
- **Sending:** the server takes the shared prompt and the optional shared system prompt, adds the conversation so far, and streams the model's reply to everyone. Only one request runs per room at a time, so a team never pays twice for the same question.
- **Credit:** each sent message records who helped write it and who sent it.
- **Storage:** rooms are kept in memory and saved to `data/<room>.json`, so they survive restarts.

## Deploying

Any host that runs a long-lived Node process with WebSockets works, such as Render, Railway, Fly.io, or a small VPS. Set your API keys and `ACCESS_CODE` as environment variables there. Serverless platforms like Vercel or Netlify functions don't keep WebSocket connections open, so they won't work for this app as written.

## Ideas for next steps

- Accounts and private rooms (instead of share-by-link)
- Send one prompt to several models side by side and compare the answers
- Prompt version history and the ability to branch the conversation
- Comments and suggestions on parts of the prompt
- Per-team usage budgets
