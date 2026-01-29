# Set up your Nebius API key

## Recommended (Vercel / Production)
Use **Vercel Environment Variables** (keeps the key off the client and out of your repo).

1) Vercel project → **Settings → Environment Variables**
2) Add:
- **Name:** `NEBIUS_API_KEY`
- **Value:** paste your key exactly (no quotes)
3) Apply to **Production** (and Preview/Development if you use them)
4) Redeploy

## Optional (Local only): API_KEY.txt file
If you want a simple file you can paste into for local testing:

1) Copy `API_KEY.txt.example` → `API_KEY.txt`
2) Put your key on **one line** in `API_KEY.txt` (no quotes)
3) Run locally using `vercel dev` so the `/api/*` functions work.

### Important security note
Do **NOT** deploy a real key inside `API_KEY.txt` for production.
Use Vercel env vars instead.

