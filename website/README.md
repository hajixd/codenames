# Codenames Tournament Website

Simple static HTML website for Codenames Tournament registration.

## ⚠️ IMPORTANT: Fix 404 Error on Vercel

Your files are in the `website/` folder, but Vercel is looking at the repo root. Here's how to fix it:

### Step-by-Step Fix:

1. **Go to Vercel Dashboard** → Your Project → **Settings**
2. Click **General** in the left sidebar
3. Scroll down to **Root Directory**
4. Click **Edit** and set it to: `website`
5. Click **Save**
6. Go to **Deployments** tab and click **Redeploy** (or push a new commit)

This tells Vercel where to find your `index.html` file.

### Build Settings (should be):
- **Framework Preset**: Other
- **Build Command**: (leave empty)
- **Output Directory**: (leave empty)
- **Install Command**: (leave empty)

## Files

- `index.html` - Home page
- `register.html` - Team registration  
- `teams.html` - View registered teams
- `styles.css` - All styles
- `app.js` - JavaScript functionality

## Local Testing

Simply open `index.html` in your browser to test locally.
