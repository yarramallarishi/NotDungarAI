# not dungarAI

A Cloudflare Workers chat app using Groq for AI responses, D1 for chat history, and Auth0 for public user sign-in. Each account can access only its own chats. The Groq API key stays in the Worker secret store, and each account is limited to 50 AI requests per day by default.

An API key only authenticates requests; it does not fine-tune or train the provider's model. This app uses the Groq model configured in `src/worker.ts` and adds chat history and prompt generation around it.

## Requirements

- Node.js and npm
- A Cloudflare account with Workers and D1 enabled
- A Groq API key
- An Auth0 application (Single Page Application) and API

## Configure Auth0

1. Create an Auth0 Single Page Application.
2. Create an Auth0 API and choose an API identifier; use that exact identifier as `AUTH0_AUDIENCE`.
3. In the SPA settings, allow your deployed site's URL in **Allowed Callback URLs**, **Allowed Logout URLs**, and **Allowed Web Origins**. For local development, also add `http://localhost:5173`.
4. Set `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, and `AUTH0_AUDIENCE` in `wrangler.toml`. The domain is usually `your-tenant.region.auth0.com`, without `https://`.
5. Enable sign-ups only if you intend the site to be open to the public. Configure email verification and any abuse-prevention controls in Auth0.

## Create and configure Cloudflare resources

From PowerShell in this directory:

```powershell
npm.cmd install
npx.cmd wrangler d1 create not-dungar-ai
```

Copy the returned database ID into `wrangler.toml` in place of `REPLACE_WITH_YOUR_D1_DATABASE_ID`, then create the schema:

```powershell
npx.cmd wrangler d1 migrations apply not-dungar-ai --remote
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

Then run:

```powershell
npm.cmd run cf:dev
```

Apply the migration to the local D1 database before first use:

```powershell
npx.cmd wrangler d1 migrations apply not-dungar-ai --local
```

## Deploy

```powershell
npm.cmd run deploy
```

After deployment, add the assigned `*.workers.dev` URL to the Auth0 allowed callback, logout, and web-origin lists. A custom domain can be attached in Cloudflare.

`DAILY_REQUEST_LIMIT` in `wrangler.toml` controls the per-account daily budget (default `50`). The D1 usage counter includes both chat replies and generated prompts.
