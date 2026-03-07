# Citadelle Web-Agent

## Overview
A B2B legal tech web application with a clean, minimalist Perplexity-style interface. AI-powered legal research agent with a real Playwright-based backend that dynamically navigates CourtListener, performs visible mouse movements and human-like typing, uses Gemini multimodal vision to extract case data from screenshots, and generates professional PDF/DOCX exports.

## Architecture
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui + Framer Motion
- **Backend**: Express.js + WebSocket (ws) + Playwright (Chromium)
- **AI Vision**: Google Gemini 2.5 Flash (multimodal) via Replit AI Integrations
- **Export**: jsPDF (PDF generation), docx + file-saver (Word document generation)
- **Routing**: wouter
- **State Management**: React useState (local component state)
- **Icons**: lucide-react
- **Real-time**: WebSocket streaming of browser screenshots at ~3 fps

## Key Features
- Central search bar with "Run Agent" functionality
- Citadelle Wallet component with live balance deduction ($0.10 per page load)
- Real Playwright browser navigates to CourtListener (courtlistener.com)
- Visible blue cursor SVG injected into page, animated mouse movements
- Human-like character-by-character typing with random delays
- **Gemini multimodal vision extraction**: takes high-quality screenshot of results page, sends to Gemini 2.5 Flash to visually read and extract case data (no DOM scraping)
- Professional PDF export with branded header, blue accents, clickable links
- Professional Word (.docx) export with headings, hyperlinks, styled formatting
- Live screenshot streaming via WebSocket to frontend sandbox
- Full-viewport command center workspace (25/75 split)
- Navigation-safe screenshot loop (handles context destruction errors)
- try/finally cleanup ensures no browser/resource leaks

## Agent Flow (server/agent.ts)
1. Initialize Engine - launch Chromium
2. Parse Query Parameters - extract user query
3. Navigate to CourtListener - go to courtlistener.com, inject cursor
4. Execute Search Query - move cursor to input, click, type query, submit with waitForNavigation
5. **Gemini Multimodal: Visually Analyzing Documents** - screenshot → Gemini vision → JSON extraction
6. Analyze Documents - scroll through results with mouse simulation
7. Compile Results - finalize and send completion with result count

## Project Structure
- `client/src/pages/home.tsx` - Main page with search, wallet, WebSocket client, workspace, PDF/DOCX export
- `client/src/App.tsx` - Router setup
- `server/agent.ts` - WebSocket server + Playwright browser agent + Gemini vision extraction
- `server/routes.ts` - Route registration (wires up WebSocket server)
- `server/index.ts` - Express + HTTP server setup
- `server/replit_integrations/` - Gemini AI integration boilerplate (batch, chat, image)

## WebSocket Protocol
Messages from server to client:
- `STEP` - { type, step, label } - Advances checklist to step N
- `FRAME` - { type, image } - Base64 JPEG screenshot
- `COST_DEDUCT` - { type, amount, reason } - Deduct from wallet
- `RESULTS` - { type, payload } - Array of extracted case data (caseTitle, court, date, url, snippet)
- `COMPLETE` - { type, message } - Agent finished
- `ERROR` - { type, message } - Error occurred

Messages from client to server:
- `START_AGENT` - { type, query } - Start agent with search query
- `STOP_AGENT` - { type } - Stop current agent

## Gemini Vision Extraction
- Takes JPEG screenshot at 100% quality of CourtListener results page
- Sends to gemini-2.5-flash with structured prompt requesting JSON array
- Parses response with fence-stripping and bracket-extraction fallbacks
- Extracts: title, court, date, citation, url per case
- Maps to frontend format: caseTitle, court, date, snippet, url
- Uses Replit AI Integrations (AI_INTEGRATIONS_GEMINI_API_KEY, AI_INTEGRATIONS_GEMINI_BASE_URL)

## System Dependencies
Requires Nix packages for Playwright Chromium: glib, nss, nspr, atk, cups, libdrm, gtk3, pango, cairo, mesa, dbus, libxkbcommon, and X11 libs.

## Running
- `npm run dev` starts Express backend + Vite frontend on port 5000
- WebSocket endpoint: `/ws/agent`
