#!/bin/bash
# Deploy the Instagram profile proxy to Cloudflare Workers
# Run from: prospect-finder-chrome/workers/profile-proxy/

set -e

echo "═══════════════════════════════════════════════════════════════"
echo "  ProspectFinder — Cloudflare Worker Proxy Setup"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Check prerequisites
if ! command -v npx &> /dev/null; then
    echo "❌ Node.js/npm not found. Install from https://nodejs.org"
    exit 1
fi

if ! command -v wrangler &> /dev/null; then
    echo "📦 Installing wrangler..."
    npm install -g wrangler
fi

# Login to Cloudflare
echo "🔐 Login to Cloudflare (opens browser)..."
npx wrangler login

# Create KV namespace
echo ""
echo "📦 Creating KV namespace for profile cache..."
KV_OUTPUT=$(npx wrangler kv:namespace create PROFILE_CACHE 2>&1)
echo "$KV_OUTPUT"

# Extract the ID
KV_ID=$(echo "$KV_OUTPUT" | grep -oP 'id = "\K[^"]+' || echo "")
if [ -z "$KV_ID" ]; then
    echo "⚠️  Could not auto-extract KV ID. Please copy it from above and paste:"
    read -p "KV ID: " KV_ID
fi

# Update wrangler.toml with the real ID
if [ -n "$KV_ID" ]; then
    sed -i "s/REPLACE_ME_AFTER_WRANGLER_KV_NAMESPACE_CREATE/$KV_ID/" wrangler.toml
    echo "✅ Updated wrangler.toml with KV ID: $KV_ID"
fi

# Deploy
echo ""
echo "🚀 Deploying worker..."
npx wrangler deploy

# Get the worker URL
WORKER_URL=$(npx wrangler deployments list 2>&1 | head -5 | grep -oP 'https://[^\s]+' || echo "")
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ✅ Worker deployed!"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo ""
echo "1. Add your Instagram session cookie(s):"
echo ""
echo "   # Get sessionid from: instagram.com → DevTools → Cookies → sessionid"
echo "   echo 'YOUR_SESSIONID' | npx wrangler secret put IG_SESSION_1"
echo ""
echo "   # Optional: add more sessions for higher throughput"
echo "   echo 'SESSION_2' | npx wrangler secret put IG_SESSION_2"
echo "   echo 'SESSION_3' | npx wrangler secret put IG_SESSION_3"
echo ""
echo "2. Set the proxy URL in the extension:"
if [ -n "$WORKER_URL" ]; then
    echo "   chrome.storage.local.set({ 'pf-proxy-url': '$WORKER_URL' })"
else
    echo "   chrome.storage.local.set({ 'pf-proxy-url': 'https://pf-profile-proxy.YOUR_SUBDOMAIN.workers.dev' })"
fi
echo ""
echo "3. Test it:"
if [ -n "$WORKER_URL" ]; then
    echo "   curl '$WORKER_URL/health'"
    echo "   curl '$WORKER_URL/profile?username=instagram'"
else
    echo "   curl 'https://YOUR_WORKER_URL/health'"
    echo "   curl 'https://YOUR_WORKER_URL/profile?username=instagram'"
fi
echo ""
echo "═══════════════════════════════════════════════════════════════"
