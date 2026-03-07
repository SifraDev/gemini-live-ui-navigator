import { useState, useCallback, useRef, useEffect } from "react";
import { Search, Play, Wallet, Plus, Check, Circle, FileText, Sheet, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence } from "framer-motion";

interface ChecklistItem {
  id: string;
  label: string;
  status: "pending" | "active" | "done";
}

const INITIAL_CHECKLIST: ChecklistItem[] = [
  { id: "1", label: "Initializing Engine", status: "pending" },
  { id: "2", label: "Parsing Query Parameters", status: "pending" },
  { id: "3", label: "Navigating PACER", status: "pending" },
  { id: "4", label: "Authenticating Session", status: "pending" },
  { id: "5", label: "Extracting PDFs", status: "pending" },
  { id: "6", label: "Analyzing Documents", status: "pending" },
  { id: "7", label: "Compiling Results", status: "pending" },
];

function CitadelleWallet() {
  return (
    <div className="flex items-center gap-2" data-testid="wallet-container">
      <div className="flex items-center gap-2 rounded-full bg-white dark:bg-card border border-border px-4 py-2 shadow-sm">
        <Wallet className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-semibold tracking-tight" data-testid="text-wallet-balance">$100.00</span>
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

function AgentChecklist({ items }: { items: ChecklistItem[] }) {
  return (
    <div className="space-y-1" data-testid="agent-checklist">
      {items.map((item) => (
        <div
          key={item.id}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-md transition-colors ${
            item.status === "active"
              ? "bg-primary/5"
              : item.status === "done"
              ? "opacity-60"
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
            <Circle className="w-4 h-4 text-muted-foreground/40 shrink-0" />
          )}
          <span
            className={`text-sm ${
              item.status === "active"
                ? "font-medium text-foreground"
                : item.status === "done"
                ? "text-muted-foreground line-through"
                : "text-muted-foreground"
            }`}
          >
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function LiveSandbox() {
  return (
    <div
      className="bg-gray-950 rounded-lg border border-gray-800 flex flex-col h-full min-h-[400px]"
      data-testid="live-sandbox"
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
        <Monitor className="w-4 h-4 text-gray-400" />
        <span className="text-sm font-medium text-gray-300">Live Browser Sandbox</span>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
          <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
          <div className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 rounded-full border-2 border-gray-700 border-t-gray-400 animate-spin mx-auto" />
          <p
            className="text-gray-500 text-sm font-mono animate-pulse-slow"
            data-testid="text-sandbox-status"
          >
            Awaiting server connection...
          </p>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [isWorkspaceActive, setIsWorkspaceActive] = useState(false);
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [checklist, setChecklist] = useState<ChecklistItem[]>(INITIAL_CHECKLIST);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const simulateProgress = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    let step = 0;
    intervalRef.current = setInterval(() => {
      setChecklist((prev) =>
        prev.map((item, idx) => {
          if (idx === step) return { ...item, status: "active" as const };
          if (idx < step) return { ...item, status: "done" as const };
          return item;
        })
      );
      step++;
      if (step > INITIAL_CHECKLIST.length) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }, 1800);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSubmittedQuery(query.trim());
    setIsWorkspaceActive(true);
    setChecklist(INITIAL_CHECKLIST);
    simulateProgress();
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="flex items-center justify-between gap-4 px-6 py-4 border-b border-border/50">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-sm">C</span>
          </div>
          <span className="font-semibold text-foreground tracking-tight text-lg" data-testid="text-brand">
            Citadelle
          </span>
        </div>
        <CitadelleWallet />
      </header>

      <main className="flex-1 flex flex-col">
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

                <div className="flex items-center justify-center gap-6 text-xs text-muted-foreground/50">
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
              className="flex-1 flex flex-col"
            >
              <div className="border-b border-border/50 bg-muted/30 px-6 py-3">
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

              <div className="flex-1 flex flex-col lg:flex-row min-h-0">
                <div className="w-full lg:w-[340px] border-r border-border/50 flex flex-col bg-background">
                  <div className="px-5 pt-5 pb-3">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse-slow" />
                      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Agent Progress
                      </h2>
                    </div>
                    <p className="text-xs text-muted-foreground/60 mt-1 truncate" data-testid="text-active-query">
                      {submittedQuery}
                    </p>
                  </div>
                  <div className="flex-1 px-3 pb-4">
                    <AgentChecklist items={checklist} />
                  </div>
                  <div className="border-t border-border/50 p-4 space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                      Export Options
                    </h3>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled
                      className="w-full justify-start gap-2 text-xs"
                      data-testid="button-export-docs"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      Export to Google Docs
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled
                      className="w-full justify-start gap-2 text-xs"
                      data-testid="button-export-sheets"
                    >
                      <Sheet className="w-3.5 h-3.5" />
                      Export to Google Sheets
                    </Button>
                  </div>
                </div>

                <div className="flex-1 p-4 lg:p-6 bg-muted/20 min-h-0">
                  <LiveSandbox />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
