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

      if (targetUrl && targetUrl.startsWith("http")) {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch((e) => {
          log(`Nav warning (${label}): ${e.message}`, "agent");
        });
      } else {
        await page.goto(`https://www.courtlistener.com/?q=${encodeURIComponent(targetTitle)}&type=o`, {
          waitUntil: "domcontentloaded",
          timeout: 25000,
        }).catch(() => {});
        await delay(1500);
        const link = page.locator("article a.visitable, .search-results a[href*='/opinion/'], h3 a").first();
        try {
          await link.waitFor({ state: "visible", timeout: 8000 });
          await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {}),
            link.click({ force: true }),
          ]);
        } catch {
          log(`Search navigation failed for ${label}, analyzing search results page instead`, "agent");
        }
      }

      await delay(1500);
      await injectCursor(page);
      await safeEval(page, () => window.scrollBy(0, 800));
      await delay(1000);

      const visionBuffer = await page.screenshot({ type: "jpeg", quality: 100 });
      const visionBase64 = visionBuffer.toString("base64");
      const currentUrl = page.url();

      log(`Gemini analyzing ${label}...`, "agent");

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
