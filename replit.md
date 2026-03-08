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
4. Execute Search Query - locator-based fill + press Enter on input
5. **Gemini Multimodal: Visually Analyzing Documents** - screenshot → Gemini vision → JSON extraction of search results
6. **Strategic Analysis: Newest, Precedent, and Original Case** - sorts results by date, navigates to newest case (Gemini extracts summary + finds cited precedent), navigates to precedent URL (Gemini summarizes), navigates to oldest case (Gemini summarizes). Pure page.goto navigation, no DOM clicking
7. Compile Results - finalize and send completion with full chain data

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
- `STEP_DYNAMIC` - { type, label } - Updates step 6 label dynamically (precedent chain depth progress)
- `FRAME` - { type, image } - Base64 JPEG screenshot

- `RESULTS` - { type, payload } - Array of extracted case data (caseTitle, court, date, url, snippet); sent incrementally as chain grows
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

## Cloud Deployment (GCP Cloud Run)
- `Dockerfile` - Uses `mcr.microsoft.com/playwright:v1.52.0-noble` base image with all Chromium deps
- `cloudbuild.yaml` - Infrastructure-as-Code for Google Cloud Build → Cloud Run automated deployment
- `.dockerignore` - Excludes node_modules, .git, .env from Docker context
- `DEPLOYMENT.md` - Full deployment instructions with gcloud CLI commands
- Cloud Run config: 2 vCPU, 2GB RAM, port 8080, session affinity for WebSocket, 300s timeout

## System Dependencies (Replit)
Requires Nix packages for Playwright Chromium: glib, nss, nspr, atk, cups, libdrm, gtk3, pango, cairo, mesa, dbus, libxkbcommon, and X11 libs.

## Running
- **Dev (Replit)**: `npm run dev` starts Express backend + Vite frontend on port 5000
- **Production (Cloud Run)**: `npm run build` then `npm start` on port 8080
- WebSocket endpoint: `/ws/agent`
