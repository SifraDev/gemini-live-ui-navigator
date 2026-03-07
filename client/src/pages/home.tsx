import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Search, Play, Wallet, Plus, Check, Circle, FileText, FileDown, Monitor, CheckCircle2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence } from "framer-motion";
import { jsPDF } from "jspdf";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, ExternalHyperlink, BorderStyle, AlignmentType, Tab, TabStopPosition, TabStopType } from "docx";
import { saveAs } from "file-saver";

interface ChecklistItem {
  id: string;
  label: string;
  status: "pending" | "active" | "done";
}

interface ExtractedResult {
  caseTitle: string;
  court: string;
  date: string;
  url: string;
  snippet: string;
}

const INITIAL_CHECKLIST: ChecklistItem[] = [
  { id: "1", label: "Initializing Engine", status: "pending" },
  { id: "2", label: "Parsing Query Parameters", status: "pending" },
  { id: "3", label: "Navigating to CourtListener", status: "pending" },
  { id: "4", label: "Executing Search Query", status: "pending" },
  { id: "5", label: "Gemini Multimodal: Visually Analyzing Documents...", status: "pending" },
  { id: "6", label: "Analyzing Documents", status: "pending" },
  { id: "7", label: "Compiling Results", status: "pending" },
];

function CitadelleWallet({ balance }: { balance: number }) {
  return (
    <div className="flex items-center gap-2" data-testid="wallet-container">
      <div className="flex items-center gap-2 rounded-full bg-white dark:bg-card border border-border px-4 py-2 shadow-sm">
        <Wallet className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-semibold tracking-tight tabular-nums" data-testid="text-wallet-balance">
          ${balance.toFixed(2)}
        </span>
      </div>
      <Button
        size="sm"
        className="rounded-full bg-emerald-600 border-emerald-700 text-white font-medium px-4"
        data-testid="button-topup"
      >
        <Plus className="w-3.5 h-3.5 mr-1" />
        Top Up
      </Button>
    </div>
  );
}

function AgentChecklist({ items, isComplete }: { items: ChecklistItem[]; isComplete: boolean }) {
  return (
    <div className="space-y-0.5" data-testid="agent-checklist">
      {items.map((item) => (
        <div
          key={item.id}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-md transition-all duration-300 ${
            item.status === "active"
              ? "bg-primary/5"
              : item.status === "done" && !isComplete
              ? "opacity-50"
              : item.status === "done" && isComplete
              ? "opacity-70"
              : ""
          }`}
          data-testid={`checklist-item-${item.id}`}
        >
          {item.status === "done" ? (
            <Check className="w-4 h-4 text-emerald-500 shrink-0" />
          ) : item.status === "active" ? (
            <div className="w-4 h-4 shrink-0 relative flex items-center justify-center">
              <div className="w-2.5 h-2.5 rounded-full bg-primary animate-pulse-slow" />
            </div>
          ) : (
            <Circle className="w-4 h-4 text-muted-foreground/30 shrink-0" />
          )}
          <span
            className={`text-sm ${
              item.status === "active"
                ? "font-medium text-foreground"
                : item.status === "done"
                ? "text-muted-foreground"
                : "text-muted-foreground/60"
            }`}
          >
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function LiveSandbox({ isComplete, frameUrl, completionMessage }: { isComplete: boolean; frameUrl: string | null; completionMessage: string }) {
  return (
    <div
      className="bg-gray-950 flex flex-col h-full"
      data-testid="live-sandbox"
    >
      <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-800/80 shrink-0">
        <div className="flex items-center gap-1.5 mr-3">
          <div className="w-3 h-3 rounded-full bg-red-500/70" />
          <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
          <div className="w-3 h-3 rounded-full bg-green-500/70" />
        </div>
        <Monitor className="w-4 h-4 text-gray-500" />
        <span className="text-sm font-medium text-gray-400 tracking-tight">Live Browser Sandbox</span>
        {isComplete && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20"
          >
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="text-xs font-medium text-emerald-400">Complete</span>
          </motion.div>
        )}
        {!isComplete && frameUrl && (
          <div className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/20">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse-slow" />
            <span className="text-xs font-medium text-blue-400">Live</span>
          </div>
        )}
      </div>
      <div className="flex-1 flex items-center justify-center min-h-0 relative">
        <AnimatePresence mode="wait">
          {isComplete ? (
            <motion.div
              key="complete"
              initial={{ opacity: 0, scale: 0.9, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.5, ease: "easeOut" }}
              className="text-center space-y-6"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.2, type: "spring", stiffness: 200, damping: 15 }}
              >
                <CheckCircle2 className="w-16 h-16 text-emerald-400 mx-auto" />
              </motion.div>
              <div className="space-y-2">
                <p
                  className="text-white text-lg font-semibold tracking-tight"
                  data-testid="text-sandbox-status"
                >
                  Task Completed
                </p>
                <p className="text-gray-400 text-sm font-mono" data-testid="text-sandbox-result">
                  {completionMessage}
                </p>
              </div>
              <div className="flex items-center justify-center gap-3 pt-2">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/60" />
                <span className="text-xs text-gray-600 font-mono">Session terminated successfully</span>
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/60" />
              </div>
            </motion.div>
          ) : frameUrl ? (
            <motion.div
              key="frame"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
              className="w-full h-full"
            >
              <img
                src={frameUrl}
                alt="Live browser view"
                className="w-full h-full object-contain"
                data-testid="img-sandbox-frame"
              />
            </motion.div>
          ) : (
            <motion.div
              key="loading"
              initial={{ opacity: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.3 }}
              className="text-center space-y-4"
            >
              <div className="w-12 h-12 rounded-full border-2 border-gray-700 border-t-gray-400 animate-spin mx-auto" />
              <p
                className="text-gray-500 text-sm font-mono animate-pulse-slow"
                data-testid="text-sandbox-status"
              >
                Awaiting server connection...
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function generatePdfReport(results: ExtractedResult[], queryText: string) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageWidth, 45, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.text("CITADELLE", margin, 20);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(148, 163, 184);
  doc.text("Legal Research Report", margin, 28);

  doc.setFontSize(8);
  doc.text(`Generated: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`, margin, 36);
  doc.text(`Report ID: CIT-${Date.now().toString(36).toUpperCase()}`, pageWidth - margin - 50, 36);

  y = 55;

  doc.setDrawColor(59, 130, 246);
  doc.setLineWidth(0.5);
  doc.line(margin, y, margin + contentWidth, y);
  y += 8;

  doc.setTextColor(30, 41, 59);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Research Query", margin, y);
  y += 6;

  doc.setFillColor(241, 245, 249);
  doc.roundedRect(margin, y - 3, contentWidth, 12, 2, 2, "F");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(51, 65, 85);
  doc.text(`"${queryText}"`, margin + 4, y + 4);
  y += 16;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(30, 41, 59);
  doc.text("Source", margin, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text("CourtListener — Free Law Project", margin + 18, y);
  y += 5;
  doc.text(`${results.length} case${results.length !== 1 ? "s" : ""} extracted`, margin + 18, y);
  y += 10;

  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.3);
  doc.line(margin, y, margin + contentWidth, y);
  y += 8;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(15, 23, 42);
  doc.text("Extracted Cases", margin, y);
  y += 10;

  results.forEach((result, index) => {
    if (y > 250) {
      doc.addPage();
      y = margin;
    }

    doc.setFillColor(index % 2 === 0 ? 248 : 255, index % 2 === 0 ? 250 : 255, index % 2 === 0 ? 252 : 255);
    doc.roundedRect(margin, y - 4, contentWidth, result.snippet ? 38 : 26, 2, 2, "F");

    doc.setDrawColor(59, 130, 246);
    doc.setLineWidth(0.8);
    doc.line(margin, y - 4, margin, y + (result.snippet ? 34 : 22));

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(15, 23, 42);
    const titleLines = doc.splitTextToSize(`${index + 1}. ${result.caseTitle}`, contentWidth - 8);
    doc.text(titleLines[0], margin + 4, y + 2);
    y += 7;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);

    const metaParts: string[] = [];
    if (result.court) metaParts.push(result.court);
    if (result.date) metaParts.push(result.date);
    if (metaParts.length > 0) {
      doc.text(metaParts.join("  |  "), margin + 4, y + 2);
      y += 5;
    }

    if (result.url) {
      doc.setTextColor(59, 130, 246);
      doc.setFontSize(7);
      const displayUrl = result.url.length > 80 ? result.url.slice(0, 77) + "..." : result.url;
      doc.textWithLink(displayUrl, margin + 4, y + 2, { url: result.url });
      y += 5;
    }

    if (result.snippet) {
      doc.setTextColor(71, 85, 105);
      doc.setFontSize(8);
      const snippetLines = doc.splitTextToSize(result.snippet, contentWidth - 12);
      doc.text(snippetLines.slice(0, 2), margin + 4, y + 2);
      y += snippetLines.slice(0, 2).length * 4;
    }

    y += 10;
  });

  y += 5;
  if (y > 260) {
    doc.addPage();
    y = margin;
  }
  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.3);
  doc.line(margin, y, margin + contentWidth, y);
  y += 8;

  doc.setFont("helvetica", "italic");
  doc.setFontSize(7);
  doc.setTextColor(148, 163, 184);
  doc.text("This report was generated by Citadelle Web-Agent. Data sourced from CourtListener (Free Law Project).", margin, y);
  y += 4;
  doc.text("For informational purposes only. Not intended as legal advice.", margin, y);

  doc.save("Citadelle_Report.pdf");
}

function generateDocxReport(results: ExtractedResult[], queryText: string) {
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: "Calibri",
            size: 22,
            color: "1E293B",
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1200,
              bottom: 1200,
              left: 1200,
              right: 1200,
            },
          },
        },
        children: [
          new Paragraph({
            children: [
              new TextRun({
                text: "CITADELLE",
                bold: true,
                size: 44,
                color: "0F172A",
                font: "Calibri",
              }),
            ],
            spacing: { after: 80 },
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: "Legal Research Report",
                size: 24,
                color: "64748B",
                font: "Calibri",
              }),
            ],
            spacing: { after: 40 },
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: `Generated: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`,
                size: 18,
                color: "94A3B8",
                font: "Calibri",
              }),
              new TextRun({
                text: `    Report ID: CIT-${Date.now().toString(36).toUpperCase()}`,
                size: 18,
                color: "94A3B8",
                font: "Calibri",
              }),
            ],
            spacing: { after: 300 },
          }),
          new Paragraph({
            children: [],
            border: {
              bottom: {
                color: "3B82F6",
                space: 1,
                style: BorderStyle.SINGLE,
                size: 6,
              },
            },
            spacing: { after: 200 },
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: "Research Query",
                bold: true,
                size: 24,
                color: "0F172A",
              }),
            ],
            heading: HeadingLevel.HEADING_2,
            spacing: { after: 120 },
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: `"${queryText}"`,
                italics: true,
                size: 22,
                color: "334155",
              }),
            ],
            spacing: { after: 80 },
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: "Source: ",
                bold: true,
                size: 20,
                color: "64748B",
              }),
              new TextRun({
                text: `CourtListener — Free Law Project  |  ${results.length} case${results.length !== 1 ? "s" : ""} extracted`,
                size: 20,
                color: "64748B",
              }),
            ],
            spacing: { after: 300 },
          }),
          new Paragraph({
            children: [],
            border: {
              bottom: {
                color: "E2E8F0",
                space: 1,
                style: BorderStyle.SINGLE,
                size: 4,
              },
            },
            spacing: { after: 200 },
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: "Extracted Cases",
                bold: true,
                size: 28,
                color: "0F172A",
              }),
            ],
            heading: HeadingLevel.HEADING_1,
            spacing: { after: 200 },
          }),
          ...results.flatMap((result, index) => {
            const paragraphs: Paragraph[] = [];

            paragraphs.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: `${index + 1}. ${result.caseTitle}`,
                    bold: true,
                    size: 22,
                    color: "0F172A",
                  }),
                ],
                spacing: { before: 200, after: 80 },
                border: {
                  left: {
                    color: "3B82F6",
                    space: 5,
                    style: BorderStyle.SINGLE,
                    size: 12,
                  },
                },
              })
            );

            const metaParts: TextRun[] = [];
            if (result.court) {
              metaParts.push(
                new TextRun({ text: result.court, size: 18, color: "64748B", bold: true })
              );
            }
            if (result.date) {
              metaParts.push(
                new TextRun({ text: result.court ? "  |  " : "", size: 18, color: "94A3B8" }),
                new TextRun({ text: result.date, size: 18, color: "64748B" })
              );
            }
            if (metaParts.length > 0) {
              paragraphs.push(
                new Paragraph({
                  children: metaParts,
                  spacing: { after: 60 },
                  indent: { left: 200 },
                })
              );
            }

            if (result.url) {
              paragraphs.push(
                new Paragraph({
                  children: [
                    new ExternalHyperlink({
                      children: [
                        new TextRun({
                          text: result.url,
                          size: 16,
                          color: "3B82F6",
                          underline: {},
                          font: "Calibri",
                        }),
                      ],
                      link: result.url,
                    }),
                  ],
                  spacing: { after: 80 },
                  indent: { left: 200 },
                })
              );
            }

            if (result.snippet) {
              paragraphs.push(
                new Paragraph({
                  children: [
                    new TextRun({
                      text: result.snippet,
                      size: 18,
                      color: "475569",
                      italics: true,
                    }),
                  ],
                  spacing: { after: 160 },
                  indent: { left: 200 },
                })
              );
            }

            return paragraphs;
          }),
          new Paragraph({
            children: [],
            border: {
              bottom: {
                color: "E2E8F0",
                space: 1,
                style: BorderStyle.SINGLE,
                size: 4,
              },
            },
            spacing: { before: 400, after: 200 },
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: "This report was generated by Citadelle Web-Agent. Data sourced from CourtListener (Free Law Project). For informational purposes only. Not intended as legal advice.",
                size: 16,
                color: "94A3B8",
                italics: true,
              }),
            ],
            alignment: AlignmentType.LEFT,
          }),
        ],
      },
    ],
  });

  Packer.toBlob(doc).then((blob) => {
    saveAs(blob, "Citadelle_Report.docx");
  });
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [isWorkspaceActive, setIsWorkspaceActive] = useState(false);
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [checklist, setChecklist] = useState<ChecklistItem[]>(INITIAL_CHECKLIST);
  const [balance, setBalance] = useState(100.0);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [completionMessage, setCompletionMessage] = useState("");
  const [isComplete, setIsComplete] = useState(false);
  const [extractedResults, setExtractedResults] = useState<ExtractedResult[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  const updateChecklistToStep = useCallback((step: number) => {
    setChecklist((prev) =>
      prev.map((item, idx) => {
        if (idx === step - 1) return { ...item, status: "active" as const };
        if (idx < step - 1) return { ...item, status: "done" as const };
        return item;
      })
    );
  }, []);

  const markAllDone = useCallback(() => {
    setChecklist((prev) => prev.map((item) => ({ ...item, status: "done" as const })));
    setIsComplete(true);
  }, []);

  const startAgent = useCallback((searchQuery: string) => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setFrameUrl(null);
    setIsComplete(false);
    setCompletionMessage("");
    setChecklist(INITIAL_CHECKLIST);
    setExtractedResults([]);

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/agent`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "START_AGENT", query: searchQuery }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case "STEP":
            updateChecklistToStep(msg.step);
            break;
          case "FRAME":
            setFrameUrl(`data:image/jpeg;base64,${msg.image}`);
            break;
          case "COST_DEDUCT":
            setBalance((prev) => Math.max(0, parseFloat((prev - msg.amount).toFixed(2))));
            break;
          case "RESULTS":
            if (msg.payload && Array.isArray(msg.payload)) {
              setExtractedResults(msg.payload);
            }
            break;
          case "COMPLETE":
            markAllDone();
            setCompletionMessage(msg.message);
            break;
          case "ERROR":
            console.error("Agent error:", msg.message);
            break;
        }
      } catch {
      }
    };

    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
    };

    ws.onerror = () => {
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [updateChecklistToStep, markAllDone]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSubmittedQuery(query.trim());
    setIsWorkspaceActive(true);
    startAgent(query.trim());
  };

  const handleExportPdf = useCallback(() => {
    if (extractedResults.length > 0) {
      generatePdfReport(extractedResults, submittedQuery);
    }
  }, [extractedResults, submittedQuery]);

  const handleExportDocx = useCallback(() => {
    if (extractedResults.length > 0) {
      generateDocxReport(extractedResults, submittedQuery);
    }
  }, [extractedResults, submittedQuery]);

  return (
    <div className="h-screen bg-background flex flex-col">
      <header className="flex items-center justify-between gap-4 px-6 py-3 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-sm">C</span>
          </div>
          <span className="font-semibold text-foreground tracking-tight text-lg" data-testid="text-brand">
            Citadelle
          </span>
        </div>
        <CitadelleWallet balance={balance} />
      </header>

      <main className="flex-1 flex flex-col min-h-0">
        <AnimatePresence mode="wait">
          {!isWorkspaceActive ? (
            <motion.div
              key="search-landing"
              initial={{ opacity: 1 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
              className="flex-1 flex flex-col items-center justify-center px-6 pb-24"
            >
              <div className="w-full max-w-2xl space-y-8 text-center">
                <div className="space-y-3">
                  <h1 className="text-3xl font-semibold tracking-tight text-foreground" data-testid="text-heading">
                    Citadelle Web-Agent
                  </h1>
                  <p className="text-muted-foreground text-base" data-testid="text-subheading">
                    AI-powered legal research, executed autonomously.
                  </p>
                </div>

                <form onSubmit={handleSubmit} className="w-full" data-testid="form-search">
                  <div className="relative group">
                    <div className="flex items-center w-full rounded-xl border border-border bg-white dark:bg-card shadow-sm transition-shadow focus-within:shadow-md focus-within:border-primary/30">
                      <Search className="w-5 h-5 text-muted-foreground ml-4 shrink-0" />
                      <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="What legal research should I execute today?"
                        aria-label="Legal research query"
                        className="flex-1 bg-transparent border-0 outline-none text-sm text-foreground placeholder:text-muted-foreground/60 px-3 py-4"
                        data-testid="input-search"
                      />
                      <Button
                        type="submit"
                        size="sm"
                        className="mr-2 rounded-lg font-medium px-4 gap-1.5"
                        disabled={!query.trim()}
                        data-testid="button-run-agent"
                      >
                        <Play className="w-3.5 h-3.5" />
                        Run Agent
                      </Button>
                    </div>
                  </div>
                </form>

                <div className="flex items-center justify-center gap-6 flex-wrap text-xs text-muted-foreground/50">
                  <span>PACER Search</span>
                  <span className="w-1 h-1 rounded-full bg-muted-foreground/20" />
                  <span>Court Filings</span>
                  <span className="w-1 h-1 rounded-full bg-muted-foreground/20" />
                  <span>Case Law</span>
                  <span className="w-1 h-1 rounded-full bg-muted-foreground/20" />
                  <span>Document Extraction</span>
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="workspace"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4, delay: 0.1 }}
              className="flex-1 flex flex-col min-h-0"
            >
              <div className="border-b border-border/50 bg-muted/30 px-6 py-2.5 shrink-0">
                <form onSubmit={handleSubmit} className="max-w-3xl mx-auto" data-testid="form-search-active">
                  <div className="flex items-center w-full rounded-lg border border-border bg-white dark:bg-card shadow-sm">
                    <Search className="w-4 h-4 text-muted-foreground ml-3 shrink-0" />
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="What legal research should I execute today?"
                      aria-label="Legal research query"
                      className="flex-1 bg-transparent border-0 outline-none text-sm text-foreground placeholder:text-muted-foreground/60 px-3 py-2.5"
                      data-testid="input-search-active"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      className="mr-1.5 rounded-md font-medium px-3 gap-1.5 text-xs"
                      disabled={!query.trim()}
                      data-testid="button-run-agent-active"
                    >
                      <Play className="w-3 h-3" />
                      Run Agent
                    </Button>
                  </div>
                </form>
              </div>

              <div className="flex-1 flex min-h-0">
                <div className="w-1/4 border-r border-border/50 flex flex-col bg-background shrink-0">
                  <div className="px-4 pt-4 pb-2 shrink-0">
                    <div className="flex items-center gap-2 mb-1">
                      {isComplete ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                      ) : (
                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse-slow" />
                      )}
                      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {isComplete ? "Agent Complete" : "Agent Progress"}
                      </h2>
                    </div>
                    <p className="text-xs text-muted-foreground/60 mt-1 truncate" data-testid="text-active-query">
                      {submittedQuery}
                    </p>
                  </div>

                  <div className="flex-1 px-2 pb-3 overflow-y-auto">
                    <AgentChecklist items={checklist} isComplete={isComplete} />
                  </div>

                  <div className="border-t border-border/50 p-4 space-y-2 shrink-0">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                      Export Options
                    </h3>
                    {isComplete && extractedResults.length > 0 ? (
                      <>
                        <motion.div
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.1 }}
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full justify-start gap-2 text-xs border-emerald-500/30 text-emerald-700 dark:text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.12)]"
                            onClick={handleExportPdf}
                            data-testid="button-export-pdf"
                          >
                            <Sparkles className="w-3.5 h-3.5 text-emerald-500" />
                            Export to PDF
                          </Button>
                        </motion.div>
                        <motion.div
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.2 }}
                        >
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full justify-start gap-2 text-xs border-emerald-500/30 text-emerald-700 dark:text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.12)]"
                            onClick={handleExportDocx}
                            data-testid="button-export-docx"
                          >
                            <Sparkles className="w-3.5 h-3.5 text-emerald-500" />
                            Export to Word (.docx)
                          </Button>
                        </motion.div>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled
                          className="w-full justify-start gap-2 text-xs"
                          data-testid="button-export-pdf"
                        >
                          <FileText className="w-3.5 h-3.5" />
                          Export to PDF
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled
                          className="w-full justify-start gap-2 text-xs"
                          data-testid="button-export-docx"
                        >
                          <FileDown className="w-3.5 h-3.5" />
                          Export to Word (.docx)
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex-1 min-h-0">
                  <LiveSandbox isComplete={isComplete} frameUrl={frameUrl} completionMessage={completionMessage} />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
