#!/bin/bash
# Deploy ProspectFinder Backend Proxy
# Run from: workers/backend-proxy/

set -e

echo "═══════════════════════════════════════════════════════════════"
echo "  ProspectFinder Backend Proxy Setup"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Check prerequisites
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Install from https://nodejs.org"
    exit 1
fi

echo "Node version: $(node --version)"

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

# Create .env if it doesn't exist
if [ ! -f .env ]; then
    cp .env.example .env
    echo ""
    echo "📝 Created .env from .env.example"
    echo "   Edit .env with your Instagram session(s) and optional proxy"
    echo ""
    echo "   Required: IG_SESSIONS=your_sessionid_here"
    echo ""
    echo "   Get your sessionid from:"
    echo "   instagram.com → DevTools → Application → Cookies → sessionid"
    echo ""
    read -p "Press Enter after editing .env (or Ctrl+C to exit)..."
fi

# Create cache directory
mkdir -p .cache

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Starting server..."
echo "═══════════════════════════════════════════════════════════════"
echo ""

npm start
