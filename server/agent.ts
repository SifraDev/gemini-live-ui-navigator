import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { chromium, type Browser, type Page } from "playwright";
import { GoogleGenAI } from "@google/genai";
import { log } from "./index";

const ai = new GoogleGenAI({
  apiKey: process.env.GOOGLE_GEMINI_API_KEY,
  httpOptions: {
    apiVersion: "v1alpha",
  },
});

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
    await page.mouse.move(x, y, { steps: 40 });
    await delay(500);
  } catch (err: any) {
    if (isNavigationError(err)) {
      log("Cursor move skipped (page navigating)", "agent");
    }
  }
}

async function injectRedDot(page: Page, x: number, y: number) {
  try {
    await safeEval(page, ({ dx, dy }: { dx: number; dy: number }) => {
      const existing = document.getElementById("citadelle-reddot");
      if (existing) existing.remove();

      const dot = document.createElement("div");
      dot.id = "citadelle-reddot";
      dot.style.cssText = `
        position: fixed;
        left: ${dx - 12}px;
        top: ${dy - 12}px;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(239,68,68,0.9) 0%, rgba(239,68,68,0.4) 50%, transparent 70%);
        pointer-events: none;
        z-index: 2147483646;
        animation: citadelle-ripple 0.6s ease-out forwards;
      `;
      document.body.appendChild(dot);

      if (!document.getElementById("citadelle-ripple-style")) {
        const style = document.createElement("style");
        style.id = "citadelle-ripple-style";
        style.textContent = `
          @keyframes citadelle-ripple {
            0% { transform: scale(0.3); opacity: 1; }
            50% { transform: scale(1.8); opacity: 0.6; }
            100% { transform: scale(2.5); opacity: 0; }
          }
        `;
        document.head.appendChild(style);
      }

      setTimeout(() => dot.remove(), 700);
    }, { dx: x, dy: y });
  } catch (err: any) {
    if (!isNavigationError(err)) {
      log(`Red dot injection error: ${err.message}`, "agent");
    }
  }
}

async function moveCursorAndClick(page: Page, x: number, y: number) {
  await moveCursorTo(page, x, y);
  await delay(200);
  await injectRedDot(page, x, y);
  await delay(150);
  await page.mouse.click(x, y);
}

async function simulateReading(page: Page, durationMs: number, stopSignal: { stopped: boolean }) {
  const startTime = Date.now();
  let scrollY = 300;
  let direction = 1;
  try {
    while (Date.now() - startTime < durationMs && !stopSignal.stopped) {
      const baseX = 200 + Math.random() * 600;
      const baseY = scrollY + Math.random() * 100;
      await page.mouse.move(baseX, baseY, { steps: 15 }).catch(() => {});
      await delay(800 + Math.random() * 600);
      if (stopSignal.stopped) break;

      const sweepEndX = baseX + 200 + Math.random() * 300;
      await page.mouse.move(sweepEndX, baseY + (Math.random() * 20 - 10), { steps: 25 }).catch(() => {});
      await delay(600 + Math.random() * 500);
      if (stopSignal.stopped) break;

      if (Math.random() > 0.5) {
        const scrollAmount = 150 + Math.random() * 200;
        await page.mouse.wheel(0, scrollAmount * direction).catch(() => {});
        scrollY += scrollAmount * direction * 0.3;
        if (scrollY > 500) direction = -1;
        if (scrollY < 200) direction = 1;
        await delay(400 + Math.random() * 300);
      }
    }
  } catch {
  }
}

async function injectAnchorGrid(page: Page) {
  try {
    await safeEval(page, () => {
      const existing = document.getElementById("citadelle-grid");
      if (existing) existing.remove();

      const overlay = document.createElement("div");
      overlay.id = "citadelle-grid";
      overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483640;";

      const cols = 8;
      const rows = 5;
      const cellW = 1280 / cols;
      const cellH = 800 / rows;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const marker = document.createElement("div");
          const cx = Math.round(c * cellW + cellW / 2);
          const cy = Math.round(r * cellH + cellH / 2);
          marker.textContent = `[${cx},${cy}]`;
          marker.style.cssText = `position:absolute;left:${cx - 20}px;top:${cy - 8}px;font-size:9px;color:rgba(255,0,0,0.35);font-family:monospace;pointer-events:none;`;
          overlay.appendChild(marker);
        }
      }
      document.body.appendChild(overlay);
    });
  } catch {}
}

async function removeAnchorGrid(page: Page) {
  try {
    await safeEval(page, () => {
      const el = document.getElementById("citadelle-grid");
      if (el) el.remove();
    });
  } catch {}
}

function extractCoords(raw: string): { x: number; y: number } | null {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  const startBrace = text.indexOf('{');
  const endBrace = text.lastIndexOf('}');
  if (startBrace !== -1 && endBrace !== -1) {
    try {
      const parsed = JSON.parse(text.substring(startBrace, endBrace + 1));
      if (typeof parsed.x === "number" && typeof parsed.y === "number") {
        return clampCoords(parsed.x, parsed.y);
      }
    } catch {}
  }

  const regex = /["']?x["']?\s*[:=]\s*(\d+(?:\.\d+)?)\s*[,}\s]\s*["']?y["']?\s*[:=]\s*(\d+(?:\.\d+)?)/i;
  const match = text.match(regex);
  if (match) {
    return clampCoords(parseFloat(match[1]), parseFloat(match[2]));
  }

  const numRegex = /(\d{2,4})\s*[,\s]\s*(\d{2,4})/;
  const numMatch = text.match(numRegex);
  if (numMatch) {
    const x = parseFloat(numMatch[1]);
    const y = parseFloat(numMatch[2]);
    if (x <= 1280 && y <= 800) {
      return clampCoords(x, y);
    }
  }

  return null;
}

function clampCoords(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(10, Math.min(1270, Math.round(x))),
    y: Math.max(10, Math.min(790, Math.round(y))),
  };
}

async function geminiLocateElement(page: Page, description: string, retryCount = 0): Promise<{ x: number; y: number } | null> {
  try {
    await injectAnchorGrid(page);
    const buffer = await page.screenshot({ type: "jpeg", quality: 90 });
    await removeAnchorGrid(page);
    const base64 = buffer.toString("base64");

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: { mimeType: "image/jpeg", data: base64 },
            },
            {
              text: `You see a 1280x800 screenshot with faint red coordinate markers [x,y] for reference. Find the element: "${description}". Return ONLY raw JSON: {"x": NUMBER, "y": NUMBER} with the pixel coordinates of its center. No explanation, no markdown.`,
            },
          ],
        },
      ],
      config: { maxOutputTokens: 256 },
    });

    const text = response.text?.trim() || "";
    const coords = extractCoords(text);

    if (coords) {
      log(`Gemini located "${description}" at (${coords.x}, ${coords.y})`, "agent");
      return coords;
    }

    log(`Gemini returned unparseable coords for "${description}": ${text.substring(0, 100)}`, "agent");

    if (retryCount < 1) {
      log(`Retrying geminiLocateElement for "${description}"...`, "agent");
      return geminiLocateElement(page, description, retryCount + 1);
    }

    return null;
  } catch (err: any) {
    log(`Gemini locate failed for "${description}": ${err.message}`, "agent");
    if (retryCount < 1) {
      return geminiLocateElement(page, description, retryCount + 1);
    }
    return null;
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
          log(`Screenshot loop error (non-fatal): ${err.message?.substring(0, 80)}`, "agent");
          session.capturing = false;
          await delay(500);
          continue;
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

    } catch (err: any) {
      log(`Navigation error: ${err.message}`, "agent");
      if (isStale()) return;
    }

    await injectCursor(page);
    capturePromise = captureLoop();

    await delay(800);
    if (isStale()) return;

    sendMessage(ws, { type: "STEP", step: 4, label: "Executing Search Query" });

    const searchInput = page.locator('input[type="search"], input[name="q"], input[id="search-query"], input[id="id_q"], input[type="text"]').first();

    let inputFound = false;
    try {
      await searchInput.waitFor({ state: "visible", timeout: 15000 });
      inputFound = true;
    } catch {
      log("Search input not visible via locator, falling back to direct URL", "agent");
    }

    if (inputFound) {
      const box = await searchInput.boundingBox();
      if (box) {
        const targetX = box.x + box.width / 2;
        const targetY = box.y + box.height / 2;
        await moveCursorTo(page, 100, 100);
        await delay(300);
        await moveCursorAndClick(page, targetX, targetY);
        await delay(400);
      } else {
        await searchInput.click({ force: true });
      }

      await page.waitForTimeout(500);
      if (isStale()) return;

      for (const char of searchQuery) {
        await searchInput.type(char, { delay: 0 });
        await delay(60 + Math.random() * 80);
      }
      await page.waitForTimeout(500);
      if (isStale()) return;

      const submitBtn = page.locator('button[type="submit"], input[type="submit"], button.btn-primary, #search-button, button[aria-label="Search"], form button').first();
      let submitClicked = false;
      try {
        await submitBtn.waitFor({ state: "visible", timeout: 5000 });
        const btnBox = await submitBtn.boundingBox();
        if (btnBox) {
          log("Moving cursor to search submit button...", "agent");
          await moveCursorTo(page, btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
          await delay(300);
          await injectRedDot(page, btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
          await delay(200);
          await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => {
              log(`Nav warning: ${e.message}`, "agent");
            }),
            page.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2),
          ]);
          submitClicked = true;
        }
      } catch {
        log("Submit button not found via locator", "agent");
      }

      if (!submitClicked) {
        log("Falling back to Enter key submit", "agent");
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => {
            log(`Nav warning: ${e.message}`, "agent");
          }),
          searchInput.press("Enter"),
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

    sendMessage(ws, { type: "STEP", step: 5, label: "Gemini Multimodal: Visually Analyzing Documents..." });

    await delay(1500);
    if (isStale()) return;

    const firstResultCoords = await geminiLocateElement(page, "the first search result title link on this legal search results page");
    if (firstResultCoords) {
      await moveCursorTo(page, 200, 150);
      await delay(300);
      await moveCursorTo(page, firstResultCoords.x, firstResultCoords.y);
      await injectRedDot(page, firstResultCoords.x, firstResultCoords.y);
      await delay(500);
    } else {
      await moveCursorTo(page, 400, 300);
      await delay(500);
    }

    let extractedResults: Array<{ caseTitle: string; court: string; date: string; url: string; snippet: string }> = [];
    try {
      log("Extracting search results from DOM...", "agent");

      const domResults = await page.evaluate(() => {
        const cases: Array<{ title: string; url: string; date: string; court: string; citation: string }> = [];
        const articles = document.querySelectorAll("article");

        articles.forEach((article) => {
          if (cases.length >= 5) return;

          const linkEl = article.querySelector("a.visitable") || article.querySelector("h3 a") || article.querySelector("a[href*='/opinion/']");
          const title = linkEl?.textContent?.trim() || "";
          let url = linkEl?.getAttribute("href") || "";
          if (url && !url.startsWith("http")) {
            url = `https://www.courtlistener.com${url}`;
          }

          const timeEl = article.querySelector("time[datetime]");
          const date = timeEl?.getAttribute("datetime") || timeEl?.textContent?.trim() || "";

          let court = "";
          const metaValues = article.querySelectorAll(".meta-data-value");
          metaValues.forEach((mv) => {
            const label = mv.previousElementSibling;
            if (label && label.textContent?.toLowerCase().includes("court")) {
              court = mv.textContent?.trim() || "";
            }
          });
          if (!court) {
            const titleText = linkEl?.textContent || "";
            const courtMatch = titleText.match(/\(([^)]+)\)\s*$/);
            if (courtMatch) court = courtMatch[1];
          }

          let citation = "";
          const citationHeaders = article.querySelectorAll(".meta-data-header");
          citationHeaders.forEach((ch) => {
            if (ch.textContent?.toLowerCase().includes("citation")) {
              const val = ch.nextElementSibling;
              if (val) citation = val.textContent?.trim() || "";
            }
          });

          if (title && url) {
            cases.push({ title, url, date, court, citation });
          }
        });

        if (cases.length === 0) {
          const links = document.querySelectorAll("a[href*='/opinion/']");
          links.forEach((link) => {
            if (cases.length >= 5) return;
            const title = link.textContent?.trim() || "";
            let url = link.getAttribute("href") || "";
            if (url && !url.startsWith("http")) {
              url = `https://www.courtlistener.com${url}`;
            }
            if (title && url && title.length > 5) {
              cases.push({ title, url, date: "", court: "", citation: "" });
            }
          });
        }

        return cases;
      });

      log(`DOM extracted ${domResults.length} cases with absolute URLs`, "agent");

      if (domResults.length > 0) {
        extractedResults = domResults.slice(0, 5).map((item) => ({
          caseTitle: item.title,
          court: item.court,
          date: item.date,
          url: item.url,
          snippet: item.citation,
        }));
        log(`Cases: ${extractedResults.map(r => `"${r.caseTitle}" (${r.url})`).join(", ")}`, "agent");
      }

      if (extractedResults.length === 0) {
        log("DOM extraction returned 0 results, falling back to Gemini Vision...", "agent");

        const visionBuffer = await page.screenshot({ type: "jpeg", quality: 100 });
        const visionBase64 = visionBuffer.toString("base64");
        const currentUrl = page.url();

        const geminiResponse = await ai.models.generateContent({
          model: "gemini-3.1-pro-preview",
          contents: [
            {
              role: "user",
              parts: [
                {
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: visionBase64,
                  },
                },
                {
                  text: `You are a highly precise Legal UI Navigator AI. Look at this screenshot of a legal database search result page from CourtListener (${currentUrl}). Extract the top 3 to 5 legal cases you see on the screen. Return ONLY a strict JSON array of objects with the following keys: "title" (Case Title), "court" (Court Name), "date" (Filing Date), "citation" (Legal citation string), and "url" (leave empty if unknown). Do not return markdown formatting, code fences, or any text before/after the JSON. Only output the raw JSON array.`,
                },
              ],
            },
          ],
          config: {
            maxOutputTokens: 4096,
          },
        });

        const responseText = geminiResponse.text?.trim() || "";
        log(`Gemini vision fallback response (${responseText.length} chars)`, "agent");

        let jsonText = responseText.trim();
        jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const startBracket = jsonText.indexOf('[');
        const endBracket = jsonText.lastIndexOf(']');
        if (startBracket !== -1 && endBracket !== -1) {
          jsonText = jsonText.substring(startBracket, endBracket + 1);
        }

        const parsed = JSON.parse(jsonText);

        if (Array.isArray(parsed) && parsed.length > 0) {
          extractedResults = parsed.slice(0, 5).map((item: any) => ({
            caseTitle: item.title || item.caseTitle || "Untitled Case",
            court: item.court || "",
            date: item.date || "",
            url: item.url || "",
            snippet: item.citation || item.snippet || "",
          }));
          log(`Gemini vision fallback extracted ${extractedResults.length} cases`, "agent");
        }
      }
    } catch (err: any) {
      if (isNavigationError(err)) {
        log("Extraction skipped (page navigating)", "agent");
      } else {
        log(`Extraction error: ${err.message}`, "agent");
      }
    }

    if (extractedResults.length > 0) {
      sendMessage(ws, { type: "RESULTS", payload: extractedResults });
    }

    sendMessage(ws, { type: "STEP", step: 6, label: "Strategic Analysis: Newest, Precedent, and Original Case" });

    const parseDate = (d: string): number => {
      const ts = Date.parse(d);
      return isNaN(ts) ? 0 : ts;
    };

    const sorted = [...extractedResults].sort((a, b) => parseDate(b.date) - parseDate(a.date));
    const newestCase = sorted[0] || extractedResults[0] || null;
    const oldestCase = sorted.length > 1
      ? (sorted[sorted.length - 1] || extractedResults[extractedResults.length - 1])
      : null;

    log(`Strategic analysis targets: newest="${newestCase?.caseTitle}" (url=${newestCase?.url || "MISSING"}), oldest="${oldestCase?.caseTitle}" (url=${oldestCase?.url || "MISSING"})`, "agent");
    log(`extractedResults has ${extractedResults.length} entries`, "agent");

    const analyzeCase = async (targetTitle: string, targetUrl: string | null, promptTask: string, label: string): Promise<{
      summary: string;
      precedentTitle: string | null;
      precedentUrl: string | null;
    }> => {
      log(`Navigating to ${label}: "${targetTitle}" (url=${targetUrl || "MISSING"})`, "agent");

      let navigated = false;

      if (targetUrl && targetUrl.startsWith("http")) {
        const linkSelector = `a[href="${new URL(targetUrl).pathname}"], a[href="${targetUrl}"]`;
        const domLink = page.locator(linkSelector).first();
        try {
          await domLink.waitFor({ state: "visible", timeout: 5000 });
          const linkBox = await domLink.boundingBox();
          if (linkBox) {
            log(`Found DOM link for ${label}, clicking at (${linkBox.x + linkBox.width / 2}, ${linkBox.y + linkBox.height / 2})`, "agent");
            await moveCursorTo(page, 200, 150);
            await delay(300);
            await moveCursorTo(page, linkBox.x + linkBox.width / 2, linkBox.y + linkBox.height / 2);
            await delay(500);
            await injectRedDot(page, linkBox.x + linkBox.width / 2, linkBox.y + linkBox.height / 2);
            await delay(300);
            await Promise.all([
              page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {}),
              page.mouse.click(linkBox.x + linkBox.width / 2, linkBox.y + linkBox.height / 2),
            ]);
            navigated = true;
          }
        } catch {
          log(`DOM link not found for ${label}, trying Gemini locate...`, "agent");
        }
      }

      if (!navigated) {
        const caseCoords = await geminiLocateElement(page, `the search result link titled "${targetTitle}" or the closest matching case name`);
        if (caseCoords) {
          await moveCursorTo(page, 200, 150);
          await delay(300);
          await moveCursorTo(page, caseCoords.x, caseCoords.y);
          await delay(500);
          await injectRedDot(page, caseCoords.x, caseCoords.y);
          await delay(300);
          await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {}),
            page.mouse.click(caseCoords.x, caseCoords.y),
          ]);
          navigated = true;
        }
      }

      if (!navigated) {
        log(`First visual scan failed for ${label}, scrolling and retrying...`, "agent");
        await safeEval(page, () => window.scrollTo(0, 0));
        await delay(800);
        await injectCursor(page);

        const retryCoords = await geminiLocateElement(page, `a clickable link for the case "${targetTitle}" — look for blue/underlined text with that case name`);
        if (retryCoords) {
          await moveCursorTo(page, 200, 150);
          await delay(300);
          await moveCursorTo(page, retryCoords.x, retryCoords.y);
          await delay(500);
          await injectRedDot(page, retryCoords.x, retryCoords.y);
          await delay(300);
          await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {}),
            page.mouse.click(retryCoords.x, retryCoords.y),
          ]);
          navigated = true;
        }
      }

      if (!navigated) {
        log(`Visual navigation exhausted for ${label}, clicking first visible result link`, "agent");
        const anyLink = page.locator("article a.visitable, a[href*='/opinion/']").first();
        try {
          await anyLink.waitFor({ state: "visible", timeout: 5000 });
          const anyBox = await anyLink.boundingBox();
          if (anyBox) {
            await moveCursorTo(page, anyBox.x + anyBox.width / 2, anyBox.y + anyBox.height / 2);
            await delay(400);
            await injectRedDot(page, anyBox.x + anyBox.width / 2, anyBox.y + anyBox.height / 2);
            await delay(200);
            await Promise.all([
              page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {}),
              page.mouse.click(anyBox.x + anyBox.width / 2, anyBox.y + anyBox.height / 2),
            ]);
          }
        } catch {
          log(`No clickable links found for ${label}`, "agent");
        }
      }

      await delay(1500);
      await injectCursor(page);
      const headingCoords = await geminiLocateElement(page, "the main case title or heading on this legal opinion page");
      if (headingCoords) {
        await moveCursorTo(page, headingCoords.x, headingCoords.y);
        await injectRedDot(page, headingCoords.x, headingCoords.y);
        await delay(400);
      }
      await safeEval(page, () => window.scrollBy(0, 800));
      await delay(1000);

      const visionBuffer = await page.screenshot({ type: "jpeg", quality: 100 });
      const visionBase64 = visionBuffer.toString("base64");
      const currentUrl = page.url();

      log(`Gemini analyzing ${label}...`, "agent");

      const readingStop = { stopped: false };
      const readingAnimation = simulateReading(page, 60000, readingStop);

      const geminiResponse = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: visionBase64,
                },
              },
              {
                text: `You are a Legal Case Analyst AI. You are looking at a legal case/opinion page from CourtListener (${currentUrl}).

${promptTask}

Return ONLY a single JSON object with these keys: title, court, date, citation, summary, precedent_title, precedent_url. No markdown, no code fences, just raw JSON.`,
              },
            ],
          },
        ],
        config: {
          maxOutputTokens: 4096,
        },
      });

      readingStop.stopped = true;
      await readingAnimation.catch(() => {});

      const responseText = geminiResponse.text?.trim() || "";
      log(`Gemini response for ${label} (${responseText.length} chars)`, "agent");

      let jsonText = responseText.trim();
      jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const startBrace = jsonText.indexOf('{');
      const endBrace = jsonText.lastIndexOf('}');
      if (startBrace !== -1 && endBrace !== -1) {
        jsonText = jsonText.substring(startBrace, endBrace + 1);
      }

      let parsed: any = {};
      try {
        parsed = JSON.parse(jsonText);
      } catch (parseError) {
        log(`JSON Parse failed. Fallback to raw text extraction.`, "agent");
        const summaryMatch = responseText.match(/"summary"\s*:\s*"([^"]*)/i);
        parsed = {
          summary: summaryMatch ? summaryMatch[1] + "..." : "Analysis generated but formatting failed. " + responseText.substring(0, 100),
          precedent_title: null,
          precedent_url: null,
        };
      }
      return {
        summary: parsed.summary || "",
        precedentTitle: parsed.precedent_title || parsed.precedentTitle || null,
        precedentUrl: parsed.precedent_url || parsed.precedentUrl || null,
      };
    };

    const newestPrompt = `Extract the case details and provide a 2-3 sentence legal summary of the ruling/opinion visible on this page.
Return:
- "title": case name
- "court": court name
- "date": filing/decision date
- "citation": any citation string
- "summary": a concise 2-3 sentence summary of the case's legal significance

Also identify the MOST PROMINENT cited precedent in the visible text. Look for "v." case names, legal citations (e.g., "123 F.3d 456"), "Cited Authorities" sections, or hyperlinked case references.
- "precedent_title": the full case name (e.g., "Smith v. Jones") or null if none found
- "precedent_url": full CourtListener URL if a link is visible, or null`;

    const precedentPrompt = `Extract the case details and provide a 2-3 sentence legal summary of the ruling/opinion visible on this page.
Return:
- "title": case name
- "court": court name
- "date": filing/decision date
- "citation": any citation string
- "summary": a concise 2-3 sentence summary of this precedent's legal significance
- "precedent_title": null
- "precedent_url": null`;

    const oldestPrompt = `Extract the case details and provide a 2-3 sentence legal summary of the ruling/opinion visible on this page.
Return:
- "title": case name
- "court": court name
- "date": filing/decision date
- "citation": any citation string
- "summary": a concise 2-3 sentence summary of this foundational case's legal significance
- "precedent_title": null
- "precedent_url": null`;

    let precedentUrl: string | null = null;
    let precedentTitle: string | null = null;
    let analysisCount = 0;

    if (newestCase) {
      sendMessage(ws, { type: "STEP_DYNAMIC", label: "Analyzing Newest Case..." });
      try {
        const result = await analyzeCase(newestCase.caseTitle, newestCase.url || null, newestPrompt, "Newest Case");
        analysisCount++;
        newestCase.snippet = result.summary || newestCase.snippet;
        precedentUrl = result.precedentUrl;
        precedentTitle = result.precedentTitle;
        log(`Newest case analyzed. Precedent found: "${precedentTitle || "NONE"}" (URL: ${precedentUrl || "NONE"})`, "agent");

        sendMessage(ws, { type: "RESULTS", payload: extractedResults });
      } catch (err: any) {
        log(`Newest case analysis error: ${err.message}`, "agent");
      }
      if (isStale()) return;
    }

    if (precedentTitle || precedentUrl) {
      sendMessage(ws, { type: "STEP_DYNAMIC", label: "Analyzing Cited Precedent..." });
      try {
        const result = await analyzeCase(precedentTitle || "cited precedent", precedentUrl || null, precedentPrompt, "Cited Precedent");
        analysisCount++;
        extractedResults.push({
          caseTitle: `[Precedent] ${result.summary ? result.summary.split(".")[0] : "Cited Case"}`,
          court: "",
          date: "",
          url: page.url(),
          snippet: result.summary || "",
        });
        sendMessage(ws, { type: "RESULTS", payload: extractedResults });
        log("Cited precedent analyzed successfully", "agent");
      } catch (err: any) {
        log(`Precedent analysis error: ${err.message}`, "agent");
      }
      if (isStale()) return;
    }

    if (oldestCase && oldestCase.caseTitle !== newestCase?.caseTitle) {
      sendMessage(ws, { type: "STEP_DYNAMIC", label: "Analyzing Original/Oldest Case..." });
      try {
        const result = await analyzeCase(oldestCase.caseTitle, oldestCase.url || null, oldestPrompt, "Oldest Case");
        analysisCount++;
        oldestCase.snippet = result.summary || oldestCase.snippet;
        sendMessage(ws, { type: "RESULTS", payload: extractedResults });
        log("Oldest case analyzed successfully", "agent");
      } catch (err: any) {
        log(`Oldest case analysis error: ${err.message}`, "agent");
      }
      if (isStale()) return;
    }

    log(`Strategic analysis complete: ${analysisCount} cases analyzed, ${extractedResults.length} total results`, "agent");

    sendMessage(ws, { type: "STEP", step: 7, label: "Compiling Results" });

    sendMessage(ws, { type: "RESULTS", payload: extractedResults });

    sendMessage(ws, {
      type: "COMPLETE",
      message: `Task Completed. Strategically analyzed ${extractedResults.length} cases.`,
    });

    session.stopped = true;
    if (capturePromise) await capturePromise.catch(() => {});
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
