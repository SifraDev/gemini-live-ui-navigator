import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { chromium, type Browser, type Page } from "playwright";
import { GoogleGenAI } from "@google/genai";
import { log } from "./index";

const ai = new GoogleGenAI({
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
  httpOptions: {
    apiVersion: "",
    baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
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
        await moveCursorTo(page, 100, 100);
        await delay(300);
        await moveCursorTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await delay(400);
      }

      await searchInput.click({ force: true });
      await page.waitForTimeout(500);
      if (isStale()) return;

      await searchInput.fill(searchQuery);
      await page.waitForTimeout(500);
      if (isStale()) return;

      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => {
          log(`Nav warning: ${e.message}`, "agent");
        }),
        searchInput.press("Enter"),
      ]);
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

    await moveCursorTo(page, 400, 300);
    await delay(800);
    await moveCursorTo(page, 600, 350);
    await delay(600);

    let extractedResults: Array<{ caseTitle: string; court: string; date: string; url: string; snippet: string }> = [];
    try {
      const visionBuffer = await page.screenshot({ type: "jpeg", quality: 100 });
      const visionBase64 = visionBuffer.toString("base64");

      log("Sending screenshot to Gemini for multimodal analysis...", "agent");

      const currentUrl = page.url();

      const geminiResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash",
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
                text: `You are a highly precise Legal UI Navigator AI. Look at this screenshot of a legal database search result page from CourtListener (${currentUrl}). Extract the top 3 to 5 legal cases you see on the screen. Return ONLY a strict JSON array of objects with the following keys: "title" (Case Title), "court" (Court Name), "date" (Filing Date), "citation" (Legal citation string), and "url" (reconstruct the CourtListener URL as https://www.courtlistener.com/opinion/[id]/[slug]/ if you can read the link, otherwise leave empty). Do not return markdown formatting, code fences, or any text before/after the JSON. Only output the raw JSON array.`,
              },
            ],
          },
        ],
        config: {
          maxOutputTokens: 2048,
        },
      });

      const responseText = geminiResponse.text?.trim() || "";
      log(`Gemini response received (${responseText.length} chars)`, "agent");

      let jsonText = responseText;
      const fenceMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) {
        jsonText = fenceMatch[1].trim();
      } else {
        const bracketMatch = responseText.match(/\[[\s\S]*\]/);
        if (bracketMatch) {
          jsonText = bracketMatch[0];
        }
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
        log(`Gemini extracted ${extractedResults.length} cases via vision`, "agent");
      } else {
        log("Gemini returned empty or non-array response", "agent");
      }
    } catch (err: any) {
      if (isNavigationError(err)) {
        log("Vision extraction skipped (page navigating)", "agent");
      } else {
        log(`Gemini vision extraction error: ${err.message}`, "agent");
      }
    }

    if (extractedResults.length > 0) {
      sendMessage(ws, { type: "RESULTS", payload: extractedResults });
    }

    sendMessage(ws, { type: "STEP", step: 6, label: "Tracing Precedent Chain..." });

    const MAX_DEPTH = 4;
    let chainDepth = 0;

    while (chainDepth < MAX_DEPTH && !isStale()) {
      chainDepth++;
      sendMessage(ws, {
        type: "STEP_DYNAMIC",
        label: `Tracing Precedent Chain (Depth ${chainDepth}/${MAX_DEPTH})...`,
      });

      if (chainDepth === 1) {
        const firstCaseLink = page.locator("article a.visitable, .search-results a[href*='/opinion/'], .result-title a, h3 a").first();
        let linkClicked = false;
        try {
          await firstCaseLink.waitFor({ state: "visible", timeout: 8000 });
          const linkBox = await firstCaseLink.boundingBox();
          if (linkBox) {
            await moveCursorTo(page, linkBox.x + linkBox.width / 2, linkBox.y + linkBox.height / 2);
            await delay(400);
          }
          await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => {
              log(`Nav warning (case click): ${e.message}`, "agent");
            }),
            firstCaseLink.click({ force: true }),
          ]);
          linkClicked = true;
        } catch (err: any) {
          log(`Failed to click first case: ${err.message}`, "agent");
        }

        if (!linkClicked) {
          if (extractedResults.length > 0 && extractedResults[0].url) {
            log("Falling back to direct URL navigation for first case", "agent");
            await page.goto(extractedResults[0].url, {
              waitUntil: "domcontentloaded",
              timeout: 20000,
            }).catch(() => {});
          } else {
            log("No case link available, ending precedent chain", "agent");
            break;
          }
        }
      }

      await delay(1500);
      if (isStale()) break;

      await injectCursor(page);

      await moveCursorTo(page, 400, 300);
      await delay(500);
      await safeEval(page, () => window.scrollBy(0, 800));
      await delay(1000);

      let caseData: { caseTitle: string; court: string; date: string; url: string; snippet: string } | null = null;
      let nextPrecedentUrl: string | null = null;
      let nextPrecedentTitle: string | null = null;

      const analyzeCasePage = async (attemptLabel: string) => {
        const visionBuffer = await page.screenshot({ type: "jpeg", quality: 100 });
        const visionBase64 = visionBuffer.toString("base64");
        const currentUrl = page.url();

        log(`Gemini analyzing case page (Depth ${chainDepth}, ${attemptLabel})...`, "agent");

        const geminiResponse = await ai.models.generateContent({
          model: "gemini-2.5-flash",
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

Task 1: Extract the details of THIS case from the page. Return:
- "title": the case name/title
- "court": the court
- "date": the filing/decision date
- "citation": any citation string visible
- "url": "${currentUrl}"

Task 2: Aggressively identify ANY cited precedent — a prior case referenced in this opinion. Search the ENTIRE visible text for:
- Standard legal citations (e.g., "Smith v. Jones", "123 F.3d 456")
- "Cited Authorities", "Cases Cited", or "References" sections
- Hyperlinked case names pointing to other CourtListener opinion pages
- Inline case mentions in the opinion body text using "v." format
Pick the MOST PROMINENT or first clearly identifiable prior case. Return:
- "precedent_title": the full case name (e.g., "Smith v. Jones") — return null ONLY if absolutely zero prior cases are mentioned anywhere on the visible page
- "precedent_url": if there is a clickable link to another CourtListener opinion page, provide the full URL (or null if no direct link)

Return ONLY a single JSON object (not an array) with these keys: title, court, date, citation, url, precedent_title, precedent_url. No markdown, no code fences, just raw JSON.`,
                },
              ],
            },
          ],
          config: {
            maxOutputTokens: 1024,
          },
        });

        const responseText = geminiResponse.text?.trim() || "";
        log(`Gemini precedent response (${responseText.length} chars, Depth ${chainDepth}, ${attemptLabel})`, "agent");

        let jsonText = responseText;
        const fenceMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) {
          jsonText = fenceMatch[1].trim();
        } else {
          const braceMatch = responseText.match(/\{[\s\S]*\}/);
          if (braceMatch) {
            jsonText = braceMatch[0];
          }
        }

        const parsed = JSON.parse(jsonText);

        if (!caseData) {
          caseData = {
            caseTitle: parsed.title || "Untitled Case",
            court: parsed.court || "",
            date: parsed.date || "",
            url: parsed.url || currentUrl,
            snippet: parsed.citation || "",
          };
        }

        return {
          precedentTitle: parsed.precedent_title || null,
          precedentUrl: parsed.precedent_url || null,
        };
      };

      try {
        const firstAttempt = await analyzeCasePage("scroll-1");
        nextPrecedentTitle = firstAttempt.precedentTitle;
        nextPrecedentUrl = firstAttempt.precedentUrl;

        if (!nextPrecedentTitle && !nextPrecedentUrl) {
          log(`No precedent on first scroll at Depth ${chainDepth}, scrolling deeper and retrying...`, "agent");
          await safeEval(page, () => window.scrollBy(0, 1000));
          await delay(1000);

          const secondAttempt = await analyzeCasePage("scroll-2");
          nextPrecedentTitle = secondAttempt.precedentTitle;
          nextPrecedentUrl = secondAttempt.precedentUrl;
        }

        log(`Depth ${chainDepth}: "${caseData?.caseTitle}" → precedent: "${nextPrecedentTitle || "NONE"}"`, "agent");
      } catch (err: any) {
        log(`Gemini precedent analysis error (Depth ${chainDepth}): ${err.message}`, "agent");
      }

      if (caseData) {
        extractedResults.push(caseData);
        sendMessage(ws, { type: "RESULTS", payload: extractedResults });
      }

      if (!nextPrecedentTitle && !nextPrecedentUrl) {
        log(`No precedent found at Depth ${chainDepth} after retry, ending chain`, "agent");
        break;
      }

      if (isStale()) break;

      let navigated = false;

      if (nextPrecedentUrl && nextPrecedentUrl.includes("courtlistener.com")) {
        log(`Navigating to precedent URL: ${nextPrecedentUrl}`, "agent");
        try {
          await page.goto(nextPrecedentUrl, {
            waitUntil: "domcontentloaded",
            timeout: 25000,
          });
          navigated = true;
        } catch (err: any) {
          log(`Direct precedent navigation failed: ${err.message}`, "agent");
        }
      }

      if (!navigated && nextPrecedentTitle) {
        log(`Searching for precedent: "${nextPrecedentTitle}"`, "agent");
        try {
          await page.goto(
            `https://www.courtlistener.com/?q=${encodeURIComponent(nextPrecedentTitle)}&type=o`,
            { waitUntil: "domcontentloaded", timeout: 25000 }
          );

          await delay(1500);

          const resultLink = page.locator("article a.visitable, .search-results a[href*='/opinion/'], h3 a").first();
          try {
            await resultLink.waitFor({ state: "visible", timeout: 8000 });
            await Promise.all([
              page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {}),
              resultLink.click({ force: true }),
            ]);
            navigated = true;
          } catch {
            log(`Could not find search result for precedent: "${nextPrecedentTitle}"`, "agent");
          }
        } catch (err: any) {
          log(`Precedent search navigation failed: ${err.message}`, "agent");
        }
      }

      if (!navigated) {
        log(`Failed to navigate to precedent at Depth ${chainDepth}, ending chain`, "agent");
        break;
      }
    }

    log(`Precedent chain complete: ${chainDepth} depth(s), ${extractedResults.length} total cases`, "agent");

    sendMessage(ws, { type: "STEP", step: 7, label: "Compiling Results" });

    await moveCursorTo(page, 640, 300);
    await delay(2000);
    if (isStale()) return;

    session.stopped = true;
    if (capturePromise) await capturePromise;

    const finalBuffer = await safeScreenshot(page);
    if (finalBuffer) {
      sendMessage(ws, { type: "FRAME", image: finalBuffer.toString("base64") });
    }

    sendMessage(ws, {
      type: "COMPLETE",
      message: `Task Completed. Traced ${chainDepth}-deep precedent chain with ${extractedResults.length} legal documents for "${searchQuery}".`,
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
