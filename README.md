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

Open http://localhost:3000, click **Sign up** to create an account, then click **Start a room**. To try the collaboration on one computer, open the room link in a private window and sign up as a second person there.

Without API keys the app runs in **demo mode**: a built-in stand-in model replies, so you can try the collaboration before setting anything up.

## Use it on your home network

The server already accepts connections from other devices on the same Wi-Fi. When it starts, it prints the address to share:

```
PromptCollab running at http://localhost:3000
  On your network:   http://192.168.1.23:3000
```

Open that address on another phone or laptop on the same network. **Copy invite link** uses the network address automatically, even when you opened the app as `localhost`.

If other devices can't connect, your computer's firewall is probably blocking Node.js. On Windows, allow Node.js on **Private** networks when asked, or under *Windows Defender Firewall → Allow an app*. On macOS, allow incoming connections for `node` under *System Settings → Network → Firewall → Options*.

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
  ├ editor.js               ├ accounts.js   sign up / sign in, password hashing, sessions
  │                         ├ rooms.js      one Room per link: shared text, thread, model, usage
  │  (textarea + cursors)   ├ doc.js        orders every edit (operational transformation)
  ├ doc-client.js           ├ providers.js  OpenAI / Anthropic / Gemini / OpenRouter / demo
  └ shared/ot.js ◄──────────┘ ws.js         minimal WebSocket server
```

- **Live editing** uses operational transformation (`public/shared/ot.js`). The server is the single source of truth: it puts concurrent edits in order and transforms each one so every person ends up with identical text. `npm test` fuzz-tests this with simulated clients editing at the same time.
- **Sending:** the server takes the shared prompt and the optional shared system prompt, adds the conversation so far, and streams the model's reply to everyone. Only one request runs per room at a time, so a team never pays twice for the same question.
- **Credit:** each sent message records who helped write it and who sent it.
- **Accounts:** everyone signs in before starting or joining a room, and their display name, color and picture come from their account. Passwords are stored only as salted `scrypt` hashes. Signing in sets an HttpOnly cookie that lasts 30 days, and the server keeps only a hash of it.
- **Hosts and sharing:** whoever creates a room hosts it. New rooms are *Restricted*: only the host and people they add can open them. The host's **Share** button adds people (contacts or any username), removes them, lets in people who asked for access, and can switch the room to *Anyone with the link*. Someone the host removes can't come back through the link until the host adds them again.
- **Contacts:** send a request by username from the account page (`/account`); the other person accepts or declines. Contacts appear as quick picks in Share.
- **Storage:** everything is saved in `data/` (never committed to git):
  - `data/rooms/<room>.json`: one file per room, including its host and who has access
  - `data/users.json`: accounts
  - `data/sessions.json`: who is signed in
  - `data/avatars/`: profile pictures

## Deploying

Any host that runs a long-lived Node process with WebSockets works, such as Render, Railway, Fly.io, or a small VPS. Set your API keys and `ACCESS_CODE` as environment variables there. Serverless platforms like Vercel or Netlify functions don't keep WebSocket connections open, so they won't work for this app as written.

## Ideas for next steps

- Viewer and editor roles, so some people can read a room without changing the prompt
- Letting the host hand the room over to someone else, or delete it
- Send one prompt to several models side by side and compare the answers
- Prompt version history and the ability to branch the conversation
- Comments and suggestions on parts of the prompt
- Per-team usage budgets
