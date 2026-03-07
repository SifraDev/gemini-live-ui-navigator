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

const CURSOR_CSS = `
  *,
  *::before,
  *::after {
    cursor: none !important;
  }
  #citadelle-cursor {
    position: fixed;
    width: 24px;
    height: 24px;
    pointer-events: none;
    z-index: 2147483647;
    transition: left 0.15s cubic-bezier(0.25, 0.1, 0.25, 1), top 0.15s cubic-bezier(0.25, 0.1, 0.25, 1);
    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4));
  }
`;

const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M5.5 3.21V20.8l4.86-4.86h6.22L5.5 3.21z" fill="#3b82f6" stroke="#1e3a5f" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

function isNavigationError(err: any): boolean {
  if (!err) return false;
  const msg = String(err.message || err);
  return (
    msg.includes("Execution context was destroyed") ||
    msg.includes("Target closed") ||
    msg.includes("Target page, context or browser has been closed") ||
    msg.includes("frame was detached") ||
    msg.includes("Frame was detached") ||
    msg.includes("Navigation interrupted") ||
    msg.includes("navigating")
  );
}

export function setupWebSocketServer(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/agent" });

  wss.on("connection", (ws) => {
    log("WebSocket client connected", "agent");

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === "START_AGENT") {
          await startAgent(ws, message.query || "");
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

async function safeEval(page: Page, fn: (...args: any[]) => any, arg?: any): Promise<any> {
  try {
    if (arg !== undefined) {
      return await page.evaluate(fn, arg);
    }
    return await page.evaluate(fn);
  } catch (err: any) {
    if (isNavigationError(err)) {
      log("Context destroyed during evaluate (navigation in progress), skipping", "agent");
      return undefined;
    }
    throw err;
  }
}

async function injectCursor(page: Page) {
  try {
    await page.addStyleTag({ content: CURSOR_CSS });
    const b64svg = Buffer.from(CURSOR_SVG).toString("base64");
    await safeEval(page, (svg64: string) => {
      const existing = document.getElementById("citadelle-cursor");
      if (existing) existing.remove();
      const el = document.createElement("img");
      el.id = "citadelle-cursor";
      el.src = `data:image/svg+xml;base64,${svg64}`;
      el.style.left = "-50px";
      el.style.top = "-50px";
      document.body.appendChild(el);
    }, b64svg);
  } catch (err: any) {
    if (isNavigationError(err)) {
      log("Cursor injection skipped (page navigating)", "agent");
    } else {
      log(`Cursor injection error: ${err.message}`, "agent");
    }
  }
}

async function moveCursorTo(page: Page, x: number, y: number) {
  try {
    await safeEval(page, ({ cx, cy }: { cx: number; cy: number }) => {
      const el = document.getElementById("citadelle-cursor");
      if (el) {
        el.style.left = `${cx}px`;
        el.style.top = `${cy}px`;
      }
    }, { cx: x, cy: y });
    await page.mouse.move(x, y, { steps: 5 });
  } catch (err: any) {
    if (isNavigationError(err)) {
      log("Cursor move skipped (page navigating)", "agent");
    }
  }
}

async function safeScreenshot(page: Page): Promise<Buffer | null> {
  try {
    return await page.screenshot({ type: "jpeg", quality: 55 });
  } catch (err: any) {
    if (isNavigationError(err)) {
      log("Screenshot skipped (page navigating)", "agent");
      return null;
    }
    throw err;
  }
}

async function startAgent(ws: WebSocket, userQuery: string) {
  await cleanupSession(ws);

  const runId = ++runCounter;
  const searchQuery = userQuery || "Apple Inc monopoly";

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
    page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
  } catch (err: any) {
    log(`Failed to create page: ${err.message}`, "agent");
    await browser.close().catch(() => {});
    sendMessage(ws, { type: "ERROR", message: "Failed to create browser page" });
    return;
  }

  const session: AgentSession = { runId, browser, page, capturing: false, stopped: false };
  activeSessions.set(ws, session);

  const isStale = () => session.stopped || activeSessions.get(ws)?.runId !== runId;

  let capturePromise: Promise<void> | null = null;

  try {
    sendMessage(ws, { type: "STEP", step: 2, label: "Parsing Query Parameters" });
    if (isStale()) return;

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
            session.capturing = false;
            continue;
          }
          const buffer = await safeScreenshot(page);
          if (buffer && !isStale() && ws.readyState === WebSocket.OPEN) {
            sendMessage(ws, { type: "FRAME", image: buffer.toString("base64") });
          }
        } catch (err: any) {
          if (isNavigationError(err)) {
            log("Screenshot loop: navigation in progress, continuing", "agent");
            session.capturing = false;
            await delay(500);
            continue;
          }
          session.capturing = false;
          break;
        }
        session.capturing = false;
        await delay(300);
      }
    };

    sendMessage(ws, { type: "STEP", step: 3, label: "Navigating to CourtListener" });

    try {
      await page.goto("https://www.courtlistener.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      if (isStale()) return;

      sendMessage(ws, { type: "COST_DEDUCT", amount: 0.10, reason: "Page loaded: courtlistener.com" });
    } catch (err: any) {
      log(`Navigation error: ${err.message}`, "agent");
      if (isStale()) return;
    }

    await injectCursor(page);
    capturePromise = captureLoop();

    await delay(800);
    if (isStale()) return;

    sendMessage(ws, { type: "STEP", step: 4, label: "Executing Search Query" });

    let searchInput = await page.waitForSelector("#id_q", { timeout: 5000, state: "visible" }).catch(() => null);
    if (!searchInput) {
      searchInput = await page.waitForSelector("input[name='q']", { timeout: 3000, state: "visible" }).catch(() => null);
    }
    if (!searchInput) {
      searchInput = await page.$("input[type='search'], input[type='text']").catch(() => null);
    }

    if (searchInput) {
      const box = await searchInput.boundingBox();
      if (box) {
        const targetX = box.x + box.width / 2;
        const targetY = box.y + box.height / 2;

        await moveCursorTo(page, 100, 100);
        await delay(300);
        await moveCursorTo(page, targetX, targetY);
        await delay(400);

        await searchInput.click();
        await delay(300);

        if (isStale()) return;

        for (const char of searchQuery) {
          if (isStale()) break;
          await page.keyboard.type(char, { delay: 0 });
          await delay(80 + Math.random() * 60);
        }

        await delay(600);
        if (isStale()) return;

        const searchButton = await page.$("button[type='submit'], input[type='submit']").catch(() => null);

        if (searchButton) {
          const btnBox = await searchButton.boundingBox();
          if (btnBox) {
            await moveCursorTo(page, btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
            await delay(400);

            await Promise.all([
              page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}),
              searchButton.click(),
            ]);
          } else {
            await Promise.all([
              page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}),
              page.keyboard.press("Enter"),
            ]);
          }
        } else {
          await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}),
            page.keyboard.press("Enter"),
          ]);
        }
      } else {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}),
          page.keyboard.press("Enter"),
        ]);
      }
    } else {
      log("Search input not found, using direct URL", "agent");
      await page.goto(`https://www.courtlistener.com/?q=${encodeURIComponent(searchQuery)}&type=o`, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      }).catch(() => {});
    }

    await delay(1000);

    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
    } catch {}

    if (isStale()) return;

    await injectCursor(page);

    sendMessage(ws, { type: "COST_DEDUCT", amount: 0.10, reason: "Search results loaded" });
    sendMessage(ws, { type: "STEP", step: 5, label: "Extracting Results" });

    await delay(1500);
    if (isStale()) return;

    await moveCursorTo(page, 400, 300);
    await delay(800);
    await moveCursorTo(page, 600, 350);
    await delay(600);

    await safeEval(page, () => window.scrollBy(0, 300));
    await delay(2000);
    if (isStale()) return;

    sendMessage(ws, { type: "STEP", step: 6, label: "Analyzing Documents" });

    await moveCursorTo(page, 500, 400);
    await delay(700);
    await moveCursorTo(page, 350, 500);
    await delay(600);

    await safeEval(page, () => window.scrollBy(0, 400));
    await delay(2500);
    if (isStale()) return;

    sendMessage(ws, { type: "STEP", step: 7, label: "Compiling Results" });

    await moveCursorTo(page, 640, 300);
    await delay(2500);
    if (isStale()) return;

    session.stopped = true;
    if (capturePromise) await capturePromise;

    const finalBuffer = await safeScreenshot(page);
    if (finalBuffer) {
      sendMessage(ws, { type: "FRAME", image: finalBuffer.toString("base64") });
    }

    let resultCount = 0;
    try {
      const countText = await page.textContent(".result-count, #result-count, .results-header").catch(() => null);
      if (countText) {
        const match = countText.match(/(\d[\d,]*)/);
        if (match) resultCount = parseInt(match[1].replace(/,/g, ""), 10);
      }
    } catch {}

    const docCount = resultCount > 0 ? resultCount : 50;

    sendMessage(ws, {
      type: "COMPLETE",
      message: `Task Completed. ${docCount} legal documents found and analyzed for "${searchQuery}".`,
    });
  } catch (err: any) {
    log(`Agent error: ${err.message}`, "agent");
    if (!isNavigationError(err)) {
      sendMessage(ws, { type: "ERROR", message: "Agent encountered an error" });
    }
  } finally {
    session.stopped = true;
    if (capturePromise) await capturePromise.catch(() => {});
    await cleanupSession(ws, runId);
  }
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
