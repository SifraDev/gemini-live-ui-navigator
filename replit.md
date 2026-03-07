# Citadelle Web-Agent

## Overview
A B2B legal tech web application with a clean, minimalist Perplexity-style interface. AI-powered legal research agent UI with automated browser-based workflow visualization.

## Architecture
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui + Framer Motion
- **Backend**: Express.js (minimal - primarily a frontend-focused app)
- **Routing**: wouter
- **State Management**: React useState (local component state)
- **Icons**: lucide-react

## Key Features
- Central search bar with "Run Agent" functionality
- Citadelle Wallet component (top-right pill with balance + Top Up)
- Full-viewport command center workspace (25/75 split):
  - Left sidebar (25%): Agent progress checklist + export options
  - Right workspace (75%): Live Browser Sandbox - edge-to-edge dark panel
- Completion state: sandbox shows success screen, export buttons enable with emerald glow
- Smooth Framer Motion transitions between search landing and command center

## Project Structure
- `client/src/pages/home.tsx` - Main page with search, wallet, and workspace
- `client/src/App.tsx` - Router setup
- `client/src/index.css` - Theme variables (Inter font, JetBrains Mono)
- `tailwind.config.ts` - Custom animations (pulse-slow)

## Design Tokens
- Font: Inter (sans), JetBrains Mono (mono)
- Clean white/light-gray background
- Primary blue accent colors
- Emerald green for wallet/status/completion indicators
- Dark gray/black for sandbox area

## Running
- `npm run dev` starts Express backend + Vite frontend on port 5000
