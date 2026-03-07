# Citadelle Web-Agent

## Overview
A B2B legal tech web application with a clean, minimalist Perplexity-style interface. AI-powered legal research agent UI with a real Playwright-based backend that streams live browser screenshots over WebSocket.

## Architecture
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui + Framer Motion
- **Backend**: Express.js + WebSocket (ws) + Playwright (Chromium)
- **Routing**: wouter
- **State Management**: React useState (local component state)
- **Icons**: lucide-react
- **Real-time**: WebSocket streaming of browser screenshots

## Key Features
- Central search bar with "Run Agent" functionality
- Citadelle Wallet component with live balance deduction ($0.10 per page load)
- Real Playwright browser engine on backend navigates to PACER (pacer.uscourts.gov)
- Live screenshot streaming at ~2.5 fps via WebSocket to frontend sandbox
- Full-viewport command center workspace (25/75 split)
- Completion state with success screen and enabled export buttons

## Project Structure
- `client/src/pages/home.tsx` - Main page with search, wallet, WebSocket client, and workspace
- `client/src/App.tsx` - Router setup
- `server/agent.ts` - WebSocket server + Playwright browser agent
- `server/routes.ts` - Route registration (wires up WebSocket server)
- `server/index.ts` - Express + HTTP server setup
- `client/src/index.css` - Theme variables (Inter font, JetBrains Mono)
- `tailwind.config.ts` - Custom animations (pulse-slow)

## WebSocket Protocol
Messages from server to client:
- `STEP` - { type, step, label } - Advances checklist to step N
- `FRAME` - { type, image } - Base64 JPEG screenshot
- `COST_DEDUCT` - { type, amount, reason } - Deduct from wallet
- `COMPLETE` - { type, message } - Agent finished
- `ERROR` - { type, message } - Error occurred

Messages from client to server:
- `START_AGENT` - { type, query } - Start agent with search query
- `STOP_AGENT` - { type } - Stop current agent

## System Dependencies
Requires Nix packages for Playwright Chromium: glib, nss, nspr, atk, cups, libdrm, gtk3, pango, cairo, mesa, dbus, libxkbcommon, and X11 libs.

## Running
- `npm run dev` starts Express backend + Vite frontend on port 5000
- WebSocket endpoint: `/ws/agent`
