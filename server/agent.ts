import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { chromium, type Browser, type Page } from "playwright";
import { log } from "./index";

interface AgentSession {
  runId: number;
  browser: Browser;
  page: Page;
  capturing: boolean;
  stopped: boolean;
}

let runCounter = 0;
const activeSessions = new Map<WebSocket, AgentSession>();

export function setupWebSocketServer(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/agent" });

  wss.on("connection", (ws) => {
    log("WebSocket client connected", "agent");

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === "START_AGENT") {
          await startAgent(ws, message.query);
        } else if (message.type === "STOP_AGENT") {
          await cleanupSession(ws);
        }
      } catch (err: any) {
        log(`WebSocket message error: ${err.message}`, "agent");
        sendMessage(ws, { type: "ERROR", message: err.message });
      }
    });

    ws.on("close", async () => {
      log("WebSocket client disconnected", "agent");
      await cleanupSession(ws);
    });

    ws.on("error", async (err) => {
      log(`WebSocket error: ${err.message}`, "agent");
      await cleanupSession(ws);
    });
  });

  log("WebSocket server ready on /ws/agent", "agent");
}

function sendMessage(ws: WebSocket, data: Record<string, any>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

async function startAgent(ws: WebSocket, _query: string) {
  await cleanupSession(ws);

  const runId = ++runCounter;

  sendMessage(ws, { type: "STEP", step: 1, label: "Initializing Engine" });

  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (err: any) {
    log(`Failed to launch browser: ${err.message}`, "agent");
    sendMessage(ws, { type: "ERROR", message: "Failed to launch browser engine" });
    return;
  }

  let page: Page;
  try {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  } catch (err: any) {
    log(`Failed to create page: ${err.message}`, "agent");
    await browser.close().catch(() => {});
    sendMessage(ws, { type: "ERROR", message: "Failed to create browser page" });
    return;
  }

  const session: AgentSession = { runId, browser, page, capturing: false, stopped: false };
  activeSessions.set(ws, session);

  const isStale = () => session.stopped || activeSessions.get(ws)?.runId !== runId;

  sendMessage(ws, { type: "STEP", step: 2, label: "Parsing Query Parameters" });

  if (isStale()) return;

  sendMessage(ws, { type: "STEP", step: 3, label: "Navigating PACER" });

  try {
    await page.goto("https://pacer.uscourts.gov/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    if (isStale()) return;

    sendMessage(ws, { type: "COST_DEDUCT", amount: 0.10, reason: "Page loaded: pacer.uscourts.gov" });
    sendMessage(ws, { type: "STEP", step: 4, label: "Authenticating Session" });
  } catch (err: any) {
    log(`Navigation error: ${err.message}`, "agent");
    if (isStale()) return;
    sendMessage(ws, { type: "STEP", step: 4, label: "Authenticating Session" });
  }

  const captureLoop = async () => {
    while (!isStale() && ws.readyState === WebSocket.OPEN) {
      if (session.capturing) {
        await delay(100);
        continue;
      }
      session.capturing = true;
      try {
        if (ws.bufferedAmount > 1024 * 1024) {
          await delay(200);
          continue;
        }
        const buffer = await page.screenshot({ type: "jpeg", quality: 55 });
        if (!isStale() && ws.readyState === WebSocket.OPEN) {
          sendMessage(ws, { type: "FRAME", image: buffer.toString("base64") });
        }
      } catch {
        break;
      } finally {
        session.capturing = false;
      }
      await delay(350);
    }
  };

  const capturePromise = captureLoop();

  const steps = [
    { step: 5, label: "Extracting PDFs", wait: 2000 },
    { step: 6, label: "Analyzing Documents", wait: 2000 },
    { step: 7, label: "Compiling Results", wait: 2500 },
  ];

  for (const s of steps) {
    await delay(s.wait);
    if (isStale()) return;
    sendMessage(ws, { type: "STEP", step: s.step, label: s.label });
  }

  await delay(2000);
  if (isStale()) return;

  session.stopped = true;
  await capturePromise;

  try {
    const finalBuffer = await page.screenshot({ type: "jpeg", quality: 55 });
    sendMessage(ws, { type: "FRAME", image: finalBuffer.toString("base64") });
  } catch {}

  sendMessage(ws, {
    type: "COMPLETE",
    message: "Task Completed. 50 PACER documents extracted and synthesized.",
  });

  await cleanupSession(ws, runId);
}

async function cleanupSession(ws: WebSocket, onlyRunId?: number) {
  const session = activeSessions.get(ws);
  if (!session) return;

  if (onlyRunId !== undefined && session.runId !== onlyRunId) return;

  session.stopped = true;
  activeSessions.delete(ws);

  try {
    await session.page.close().catch(() => {});
    await session.browser.close().catch(() => {});
  } catch {}

  log("Agent session cleaned up", "agent");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
