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
- Live Agent Workspace with split-screen layout:
  - Left: Agent progress checklist + export options
  - Right: Live Browser Sandbox placeholder
- Smooth animated transition from search landing to workspace view

## Project Structure
- `client/src/pages/home.tsx` - Main page with search, wallet, and workspace
- `client/src/App.tsx` - Router setup
- `client/src/index.css` - Theme variables (Inter font, JetBrains Mono)
- `tailwind.config.ts` - Custom animations (pulse-slow)

## Design Tokens
- Font: Inter (sans), JetBrains Mono (mono)
- Clean white/light-gray background
- Primary blue accent colors
- Emerald green for wallet/status indicators
- Dark gray/black for sandbox area

## Running
- `npm run dev` starts Express backend + Vite frontend on port 5000
