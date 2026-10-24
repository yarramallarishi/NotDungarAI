# not dungarAI

Try it out: https://not-dungar-ai.yarramallarishi.workers.dev/

A Cloudflare Workers chat app using Groq for AI responses, D1 for chat history, and Auth0 for public user sign-in. Each account can access only its own chats. The Groq API key stays in the Worker secret store, and each account is limited to 50 AI requests per day by default.

An API key only authenticates requests; it does not fine-tune or train the provider's model. This app uses the Groq model configured in `src/worker.ts` and adds chat history and prompt generation around it.

## Requirements

- Node.js and npm
- A Cloudflare account with Workers and D1 enabled
- A Groq API key
- An Auth0 application (Single Page Application) and API

## Configure Auth0

The browser app uses the official Auth0 React SDK. It reads the domain, client ID, and API audience from the Worker configuration; do not put a secret or Groq key in the browser.

The Auth0 tenant is configured with the `My App` Single Page Application, the SPA token endpoint method is **None**, and the local URL `http://localhost:5173` is saved under **Allowed Callback URLs**, **Allowed Logout URLs**, and **Allowed Web Origins**. The app is authorized for user-delegated access to the custom `not dungarAI API`.

`wrangler.toml` is set to that SPA's client ID and the API audience `https://not-dungar-ai-api`. Do not change the audience to the Auth0 Management API. Once the Cloudflare site is deployed, add its full Workers/custom-domain URL to all three Auth0 URL allowlists. Enable sign-ups only if you intend the site to be open to the public; configure email verification and abuse-prevention controls in Auth0.

## Create and configure Cloudflare resources

From PowerShell in this directory:

The existing D1 database is named `dungaai`; its ID is configured in `wrangler.toml`. Apply the schema to that database:

```powershell
npx.cmd wrangler d1 migrations apply dungaai --remote
```

Set the Groq key as a Cloudflare secret (not in `wrangler.toml` or client-side code):

```powershell
npx.cmd wrangler secret put GROQ_API_KEY
```

Paste the key when prompted. The Worker uses it to call Groq; browsers never receive it.

## Run locally

For local Worker development, create a `.dev.vars` file (ignored by Git) containing:

```text
GROQ_API_KEY=your-groq-api-key
```

Apply the migration to the local D1 database before first use:

```powershell
npx.cmd wrangler d1 migrations apply dungaai --local
```

Run the Worker and Vite frontend in two PowerShell terminals. The Vite server is pinned to port 5173 and proxies `/api` requests to the local Worker on port 8787:

```powershell
npx.cmd wrangler dev --local --port 8787
```

In the second terminal:

```powershell
npm.cmd run dev
```

Open `http://localhost:5173`. If port 5173 is already in use, Vite exits rather than switching to a port that Auth0 does not allow.

## Deploy

```powershell
npm.cmd run deploy
```

After deployment, add the assigned `*.workers.dev` URL to the Auth0 allowed callback, logout, and web-origin lists. A custom domain can be attached in Cloudflare.

`DAILY_REQUEST_LIMIT` in `wrangler.toml` controls the per-account daily budget (default `50`). The D1 usage counter includes both chat replies and generated prompts.

## Python terminal assistant

The optional `finetune.py` script is a separate terminal chat assistant using the same Groq API key. It can use Groq's built-in browser search and sandboxed code execution when useful, asks for clarification when important details are missing, and saves local conversation history under the ignored `chat_history/` directory.

Set the key in PowerShell and run it from this project folder:

```powershell
python -m pip install -r requirements.txt
$env:GROQ_API_KEY = "your-groq-api-key"
python .\finetune.py
```

Use `/help` in the assistant to see commands for researching, listing saved chats, reopening conversations, and starting a new chat. Normal questions let the model choose whether search or code execution is useful; `/research <question>` requires a web search. The Groq API key must be available in the same terminal session and is never written to chat history.
