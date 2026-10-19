"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  ArrowDown,
  ArrowLeft,
  Bot,
  Brain,
  ChevronRight,
  CircleSlash,
  Eye,
  EyeOff,
  FileDiff,
  FileText,
  Flag,
  Pause,
  Pencil,
  Play,
  Save,
  Search,
  SquareTerminal,
  User,
  Wrench,
  X,
  Check,
  Clock,
  Lock,
} from "lucide-react";
import { client, type SessionEvent, type SessionSummary } from "@/lib/api";
import { useBank } from "@/lib/bank-context";
import {
  buildTimeline,
  decisionPath,
  filterRows,
  formatDuration,
  isActive,
  isDelivered,
  isQuietCheck,
  nextPollDelay,
  noteLatencyMs,
  relativeTime,
  replayOffsets,
  type CheckPayload,
  type CheckRow,
  type DecisionRoute,
  type RowFilters,
  type TimelineRow,
  type ToolFamily,
} from "@/lib/session-timeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { HarnessLogo } from "@/components/ui/harness-logo";
import { resolveHarnessLogo } from "@/lib/harness-logo";
import { CompactMarkdown } from "@/components/compact-markdown";
import { DocumentChunkModal } from "@/components/document-chunk-modal";
import { MemoryDetailModal } from "@/components/memory-detail-modal";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { SessionStatusDot } from "./sessions-view";

const EVENTS_PAGE = 1000;
// Re-read the summary (acked_seq, saved_seq, counts) on every Nth poll even when no
// event arrived: a client acking a note or a save finishing changes it silently.
const SUMMARY_EVERY_N_POLLS = 5;
const ERROR_RETRY_MS = 5000;
const AT_BOTTOM_PX = 120;
const FLASH_MS = 1600;
const REPLAY_TICK_MS = 100;
const REPLAY_SPEEDS = [1, 2, 5] as const;

type Translate = ReturnType<typeof useTranslations<"sessionsView">>;

const TRIGGERS = new Set(["task", "plan", "command", "edit", "failure"]);
const OUTCOMES = new Set(["note", "silent", "repeat", "skipped", "error"]);

function triggerLabel(t: Translate, trigger: string | undefined) {
  return trigger && TRIGGERS.has(trigger)
    ? t(`trigger.${trigger as "task" | "plan" | "command" | "edit" | "failure"}`)
    : trigger || "";
}

function outcomeLabel(t: Translate, outcome: string | undefined) {
  return outcome && OUTCOMES.has(outcome)
    ? t(`outcome.${outcome as "note" | "silent" | "repeat" | "skipped" | "error"}`)
    : outcome || "";
}

const OUTCOME_STYLE: Record<string, string> = {
  note: "bg-primary/15 text-primary border-primary/30",
  silent: "bg-muted text-muted-foreground border-border",
  repeat: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
  skipped: "bg-transparent text-muted-foreground border-dashed border-border",
  error: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
};

const OUTCOME_TICK: Record<string, string> = {
  note: "bg-primary",
  silent: "bg-muted-foreground/40",
  repeat: "bg-amber-500",
  skipped: "bg-muted-foreground/25",
  error: "bg-red-500",
};

const ROUTE_STYLE: Record<DecisionRoute, string> = {
  silent: "text-muted-foreground",
  nothing: "text-muted-foreground",
  writer: "text-teal-700 dark:text-teal-400",
  llm: "text-violet-700 dark:text-violet-400",
  unknown: "text-muted-foreground",
};

/** The element that scrolls the page: the bank page's `main`, or the document. */
function scrollParent(el: HTMLElement | null): HTMLElement {
  let node = el?.parentElement ?? null;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function SessionDetail({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const t = useTranslations("sessionsView");
  const { currentBank } = useBank();
  const now = useNow(5000);

  const [session, setSession] = useState<SessionSummary | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [liveState, setLiveState] = useState<{ status: "open" | "closed"; checking: boolean }>({
    status: "open",
    checking: false,
  });
  const [loaded, setLoaded] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollNonce, setPollNonce] = useState(0);

  const [filters, setFilters] = useState<RowFilters>({
    tools: true,
    silent: true,
    hindsightOnly: false,
    query: "",
  });
  const [replay, setReplay] = useState<{ speed: number; playing: boolean; elapsed: number } | null>(
    null
  );
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [openDocId, setOpenDocId] = useState<string | null>(null);
  const [openMemoryId, setOpenMemoryId] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closing, setClosing] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // Seq of the last event at first load: only rows after it animate in.
  const firstLoadSeqRef = useRef<number | null>(null);

  // ---- Live follow -------------------------------------------------------------
  useEffect(() => {
    if (!currentBank) return;
    let cancelled = false;
    let timer: number | undefined;
    let inFlight = false;
    let polls = 0;
    let lastSeq = 0;
    let lastEventAt = 0;

    setEvents([]);
    setSession(null);
    setLoaded(false);
    setNotFound(false);

    const refreshSummary = async () => {
      try {
        const s = await client.getSession(currentBank, sessionId);
        if (!cancelled) setSession(s);
      } catch {
        // The events poll reports the error; a stale header is fine meanwhile.
      }
    };

    const poll = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      window.clearTimeout(timer);
      let gotNew = false;
      let status: "open" | "closed" = "open";
      let checking = false;
      try {
        // Catch up page by page: a long session (or a tab that was hidden for a
        // while) can be thousands of events behind.
        for (;;) {
          const res = await client.getSessionEvents(currentBank, sessionId, lastSeq, EVENTS_PAGE);
          if (cancelled) return;
          status = res.status;
          checking = res.checking;
          if (res.items.length > 0) {
            gotNew = true;
            const batch = res.items;
            lastSeq = batch[batch.length - 1].seq;
            lastEventAt = Date.parse(batch[batch.length - 1].created_at);
            setEvents((prev) => [...prev, ...batch]);
          }
          if (res.items.length < EVENTS_PAGE) break;
        }
        setLiveState({ status, checking });
        setPollError(null);
        if (polls === 0) firstLoadSeqRef.current = lastSeq;
        if (polls === 0 || gotNew || polls % SUMMARY_EVERY_N_POLLS === 0) await refreshSummary();
        setLoaded(true);
      } catch (e) {
        inFlight = false;
        if (cancelled) return;
        if ((e as { status?: number }).status === 404) {
          setNotFound(true);
          setLoaded(true);
          return;
        }
        setPollError(e instanceof Error ? e.message : String(e));
        timer = window.setTimeout(poll, ERROR_RETRY_MS);
        return;
      }
      inFlight = false;
      polls++;
      const delay = nextPollDelay({
        visible: document.visibilityState === "visible",
        status,
        checking,
        gotNew,
        idleMs: lastEventAt ? Math.max(0, Date.now() - lastEventAt) : Infinity,
      });
      if (delay !== null && !cancelled) timer = window.setTimeout(poll, delay);
    };

    // Coming back to the tab polls at once instead of waiting out the hidden backoff
    // (and restarts a poll that stopped on a closed session, in case it reopened).
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [currentBank, sessionId, pollNonce]);

  // ---- Replay ------------------------------------------------------------------
  const offsets = useMemo(() => replayOffsets(events), [events]);
  const replayEnd = offsets.length ? offsets[offsets.length - 1] : 0;
  useEffect(() => {
    if (!replay?.playing) return;
    const id = window.setInterval(() => {
      setReplay((r) => {
        if (!r) return r;
        const elapsed = r.elapsed + REPLAY_TICK_MS * r.speed;
        return elapsed >= replayEnd
          ? { ...r, elapsed: replayEnd, playing: false }
          : { ...r, elapsed };
      });
    }, REPLAY_TICK_MS);
    return () => window.clearInterval(id);
  }, [replay?.playing, replayEnd]);

  const visibleEvents = useMemo(() => {
    if (!replay) return events;
    let n = 0;
    while (n < offsets.length && offsets[n] <= replay.elapsed) n++;
    return events.slice(0, n);
  }, [events, offsets, replay]);

  const timeline = useMemo(() => buildTimeline(visibleEvents), [visibleEvents]);
  const rows = useMemo(() => filterRows(timeline.rows, filters), [timeline.rows, filters]);
  const noteKeys = useMemo(() => rows.filter((r) => r.kind === "note").map((r) => r.key), [rows]);

  // ---- Scrolling ---------------------------------------------------------------
  const scroller = useCallback(() => scrollParent(rootRef.current), []);

  const scrollToBottom = useCallback(
    (smooth: boolean) => {
      const el = scroller();
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
      setNewCount(0);
    },
    [scroller]
  );

  const flashRow = useCallback((key: string) => {
    const el = document.querySelector(`[data-row-key="${key}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlashKey(key);
    window.setTimeout(() => setFlashKey((k) => (k === key ? null : k)), FLASH_MS);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const el = scroller();
    const target: HTMLElement | Window =
      el === document.scrollingElement || el === document.documentElement ? window : el;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
      atBottomRef.current = atBottom;
      if (atBottom) setNewCount(0);
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [loaded, scroller]);

  // New entries: follow them when the reader is at the bottom, otherwise count
  // them on the "N new" pill instead of yanking the page away from what they read.
  const shownCount = visibleEvents.length;
  const prevShownRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!loaded) return;
    const prev = prevShownRef.current;
    prevShownRef.current = shownCount;
    if (prev === null) {
      // First paint: a live session opens at its newest entry, a finished one at its start.
      if (session && isActive(session, Date.now())) scrollToBottom(false);
      else atBottomRef.current = false;
      return;
    }
    if (shownCount <= prev) return;
    if (atBottomRef.current) scrollToBottom(true);
    else setNewCount((n) => n + (shownCount - prev));
  }, [shownCount, loaded, session, scrollToBottom]);

  // Keyboard: j / k step through Hindsight's notes.
  const noteCursorRef = useRef(-1);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key !== "j" && e.key !== "k") || noteKeys.length === 0) return;
      const step = e.key === "j" ? 1 : -1;
      const next = Math.min(noteKeys.length - 1, Math.max(0, noteCursorRef.current + step));
      noteCursorRef.current = next;
      flashRow(noteKeys[next]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [noteKeys, flashRow]);

  const handleClose = async () => {
    if (!currentBank) return;
    setClosing(true);
    try {
      setSession(await client.closeSession(currentBank, sessionId));
      setConfirmClose(false);
      // Restart the follow loop: it may have slowed down on an idle session.
      setPollNonce((n) => n + 1);
    } catch {
      // fetchApi already toasted the failure.
    } finally {
      setClosing(false);
    }
  };

  if (!loaded) {
    return (
      <div ref={rootRef} className="flex justify-center py-24">
        <Spinner size="lg" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div ref={rootRef} className="flex flex-col items-center gap-4 py-24 text-center">
        <CircleSlash className="h-8 w-8 text-muted-foreground/60" />
        <div className="text-sm font-medium">{t("notFound")}</div>
        <div className="font-mono text-xs text-muted-foreground break-all px-4">{sessionId}</div>
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft />
          {t("backToSessions")}
        </Button>
      </div>
    );
  }

  const status = session?.status ?? liveState.status;
  const checking = liveState.checking || !!session?.checking;
  const live = session ? isActive({ ...session, status }, now) : false;
  const lastStateKey = [...timeline.rows].reverse().find((r) => r.kind === "state")?.key;

  return (
    <div ref={rootRef} className="relative pb-24">
      <SessionHeader
        t={t}
        session={session}
        sessionId={sessionId}
        status={status}
        checking={checking}
        live={live}
        now={now}
        onBack={onBack}
        onOpenDocument={setOpenDocId}
        onJumpToChange={lastStateKey ? () => flashRow(lastStateKey) : undefined}
        onClose={() => setConfirmClose(true)}
      />

      {/* The control strip stays pinned while the conversation scrolls under it —
          from sm up only: on a phone it wraps to ~170px, a fifth of the screen. */}
      <div className="sm:sticky top-0 z-20 -mx-4 sm:-mx-6 mb-4 border-b border-border/60 bg-background/90 px-4 py-2 backdrop-blur sm:px-6">
        {/* Scaled on the whole log, so during a replay the ticks fill in along a fixed strip. */}
        <Minimap events={events} rows={timeline.rows} onJump={flashRow} t={t} />
        <Toolbar
          t={t}
          filters={filters}
          setFilters={setFilters}
          replay={replay}
          setReplay={setReplay}
          replayEnd={replayEnd}
          canReplay={events.length > 1}
          shown={rows.length}
          noteCount={noteKeys.length}
        />
      </div>

      {pollError && (
        <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {t("pollError", { message: pollError })}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          {events.length === 0 ? t("noEvents") : t("noMatches")}
        </div>
      ) : (
        <ol className="space-y-2.5" aria-live="polite" aria-relevant="additions">
          {rows.map((row) => (
            <li
              key={row.key}
              data-row-key={row.key}
              className={cn(
                "scroll-mt-40 rounded-xl transition-[box-shadow,background-color] duration-300",
                firstLoadSeqRef.current !== null &&
                  row.seq > firstLoadSeqRef.current &&
                  "animate-list-row-enter",
                flashKey === row.key && "bg-primary/5 ring-2 ring-primary/40",
                hoverKey === row.key && "bg-primary/5 ring-1 ring-primary/30"
              )}
            >
              <RowView
                row={row}
                t={t}
                source={session?.source ?? null}
                ackedSeq={session?.acked_seq ?? 0}
                timeline={timeline}
                onJump={flashRow}
                onHoverHost={setHoverKey}
                onOpenDocument={setOpenDocId}
                onOpenMemory={setOpenMemoryId}
              />
            </li>
          ))}
        </ol>
      )}

      {checking && !replay && <CheckingIndicator t={t} />}

      {status === "closed" && !replay && events.length > 0 && (
        <div className="mt-6 flex items-center gap-3 text-xs text-muted-foreground">
          <div className="h-px flex-1 bg-border" />
          <Lock className="h-3.5 w-3.5" />
          {t("sessionClosed")}
          <div className="h-px flex-1 bg-border" />
        </div>
      )}

      {newCount > 0 && (
        <button
          type="button"
          onClick={() => scrollToBottom(true)}
          className="fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 z-30 inline-flex -translate-x-1/2 items-center gap-2 rounded-full bg-primary-gradient px-4 py-2 text-sm font-medium text-white shadow-lg animate-soft-fade-in"
        >
          <ArrowDown className="h-4 w-4" />
          {t("newEntries", { count: newCount })}
        </button>
      )}

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("closeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("closeDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={closing}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={closing}
              onClick={(e) => {
                e.preventDefault();
                handleClose();
              }}
            >
              {closing ? <Spinner size="sm" /> : t("closeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DocumentChunkModal type="document" id={openDocId} onClose={() => setOpenDocId(null)} />
      <MemoryDetailModal memoryId={openMemoryId} onClose={() => setOpenMemoryId(null)} />
    </div>
  );
}

// ---- Header ----------------------------------------------------------------------

function SessionHeader({
  t,
  session,
  sessionId,
  status,
  checking,
  live,
  now,
  onBack,
  onOpenDocument,
  onJumpToChange,
  onClose,
}: {
  t: Translate;
  session: SessionSummary | null;
  sessionId: string;
  status: "open" | "closed";
  checking: boolean;
  live: boolean;
  now: number;
  onBack: () => void;
  onOpenDocument: (id: string) => void;
  onJumpToChange?: () => void;
  onClose: () => void;
}) {
  const locale = useLocale();
  const end = session
    ? live
      ? now
      : Date.parse(session.last_event_at ?? session.updated_at)
    : now;
  const duration = session ? Math.max(0, end - Date.parse(session.created_at)) : 0;
  const savedPct =
    session && session.last_seq > 0
      ? Math.min(100, Math.round((session.saved_seq / session.last_seq) * 100))
      : 0;

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={onBack}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t("backToSessions")}
      </button>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <HarnessLogo harness={session?.source} size={22} />
            <h1 className="min-w-0 break-words text-2xl font-bold text-foreground sm:text-3xl">
              {session?.title || sessionId}
            </h1>
            {live ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                <span className="relative inline-flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-70" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                {t("live")}
              </span>
            ) : (
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs",
                  status === "open"
                    ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-400"
                    : "border-border text-muted-foreground"
                )}
              >
                {status === "open" ? t("statusIdle") : t("statusClosed")}
              </span>
            )}
            {checking && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                <SessionStatusDot session={{ status, last_event_at: null, checking }} now={now} />
                {t("checking")}
              </span>
            )}
          </div>
          {session?.title && (
            <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{sessionId}</div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onJumpToChange && (
            <Button variant="outline" size="sm" onClick={onJumpToChange}>
              <FileDiff />
              {t("changeSoFar")}
            </Button>
          )}
          {session && session.saved_seq > 0 && (
            <Button variant="outline" size="sm" onClick={() => onOpenDocument(session.document_id)}>
              <FileText />
              {t("openDocument")}
            </Button>
          )}
          {status === "open" && (
            <Button variant="outline" size="sm" onClick={onClose}>
              <Lock />
              {t("closeSession")}
            </Button>
          )}
        </div>
      </div>

      {session && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat
            label={t("statDuration")}
            value={formatDuration(duration)}
            hint={t("startedAt", { when: relativeTime(session.created_at, locale, now) })}
          />
          <Stat
            label={t("statActivity")}
            value={t("eventCount", { count: session.event_count })}
            hint={t("checkCount", { count: session.check_count })}
          />
          <Stat
            label={t("statNotes")}
            value={String(session.note_count)}
            hint={session.watch ? t("watchOnLong") : t("watchOffLong")}
            accent={session.note_count > 0}
          />
          <div className="min-w-0 rounded-xl border border-border/60 bg-card px-3 py-2">
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("statSaved")}
            </div>
            <div className="mt-1 text-sm font-semibold tabular-nums">
              {session.retain === "off"
                ? t("retainOff")
                : `${session.saved_seq} / ${session.last_seq}`}
            </div>
            {session.retain !== "off" && (
              <div
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={savedPct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t("statSaved")}
              >
                <div
                  className="h-full rounded-full bg-primary-gradient transition-[width] duration-500"
                  style={{ width: `${savedPct}%` }}
                />
              </div>
            )}
            <div className="mt-1 truncate text-[11px] text-muted-foreground">
              {session.retain === "turns"
                ? t("retainTurns")
                : session.retain === "close"
                  ? t("retainClose")
                  : t("retainOffHint")}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border/60 bg-card px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-1 text-sm font-semibold tabular-nums", accent && "text-primary")}>
        {value}
      </div>
      {hint && <div className="mt-1 truncate text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

// ---- Minimap -----------------------------------------------------------------------

/**
 * The whole session on one strip, by time: the conversation on the top lane,
 * Hindsight's checks and notes on the bottom lane. Clicking a tick jumps to it.
 */
function Minimap({
  events,
  rows,
  onJump,
  t,
}: {
  events: SessionEvent[];
  rows: TimelineRow[];
  onJump: (key: string) => void;
  t: Translate;
}) {
  if (events.length < 2) return null;
  const start = Date.parse(events[0].created_at);
  const span = Math.max(1, Date.parse(events[events.length - 1].created_at) - start);
  const pos = (ev: SessionEvent) => `${((Date.parse(ev.created_at) - start) / span) * 100}%`;

  const ticks: { key: string; jump: string; left: string; cls: string; title: string }[] = [];
  for (const row of rows) {
    if (row.kind === "message") {
      ticks.push({
        key: row.key,
        jump: row.key,
        left: pos(row.event),
        cls:
          row.role === "user"
            ? "top-0.5 h-3.5 w-1 rounded-sm bg-indigo-500"
            : "top-1 h-2.5 w-1 rounded-sm bg-foreground/60",
        title: row.role === "user" ? t("voiceUser") : t("voiceAgent"),
      });
    } else if (row.kind === "tool" && (row.call || row.result)) {
      ticks.push({
        key: row.key,
        jump: row.key,
        left: pos((row.call ?? row.result)!),
        cls: cn("top-1 h-2.5 w-0.5", row.isError ? "bg-red-500" : "bg-foreground/30"),
        title: `${row.tool} ${row.target}`,
      });
    } else if (row.kind === "note") {
      ticks.push({
        key: row.key,
        jump: row.key,
        left: pos(row.event),
        cls: "bottom-0 h-3.5 w-1.5 rounded-sm bg-primary-gradient shadow-sm",
        title: t("voiceHindsightNote"),
      });
    }
    for (const c of [...row.checks, ...(row.kind === "check" ? [row] : [])]) {
      if (c.check.outcome === "note") continue; // its note tick says it louder
      ticks.push({
        key: c.key,
        jump: row.key,
        left: pos(c.event),
        cls: cn("bottom-1 h-2 w-2 rounded-full", OUTCOME_TICK[c.check.outcome ?? "silent"]),
        title: `${triggerLabel(t, c.check.trigger)} · ${outcomeLabel(t, c.check.outcome)}`,
      });
    }
  }

  return (
    <div className="relative mb-2 h-9 rounded-md bg-muted/50" aria-label={t("minimap")}>
      {/* Lane divider: the conversation above, Hindsight below. */}
      <div className="absolute inset-x-0 top-1/2 h-px bg-border/60" />
      <div className="absolute inset-x-1.5 inset-y-0">
        {ticks.map((tk) => (
          <button
            key={tk.key}
            type="button"
            title={tk.title}
            aria-label={tk.title}
            onClick={() => onJump(tk.jump)}
            className={cn("absolute -translate-x-1/2 hover:scale-150 transition-transform", tk.cls)}
            style={{ left: tk.left }}
          />
        ))}
      </div>
    </div>
  );
}

// ---- Toolbar -------------------------------------------------------------------------

function ToggleChip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs transition-colors",
        pressed
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-accent"
      )}
    >
      {children}
    </button>
  );
}

function Toolbar({
  t,
  filters,
  setFilters,
  replay,
  setReplay,
  replayEnd,
  canReplay,
  shown,
  noteCount,
}: {
  t: Translate;
  filters: RowFilters;
  setFilters: React.Dispatch<React.SetStateAction<RowFilters>>;
  replay: { speed: number; playing: boolean; elapsed: number } | null;
  setReplay: React.Dispatch<
    React.SetStateAction<{ speed: number; playing: boolean; elapsed: number } | null>
  >;
  replayEnd: number;
  canReplay: boolean;
  shown: number;
  noteCount: number;
}) {
  const set = (patch: Partial<RowFilters>) => setFilters((f) => ({ ...f, ...patch }));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-56">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.query}
          onChange={(e) => set({ query: e.target.value })}
          placeholder={t("searchInSession")}
          aria-label={t("searchInSession")}
          className="h-8 pl-8 text-xs"
        />
      </div>
      <ToggleChip pressed={filters.tools} onClick={() => set({ tools: !filters.tools })}>
        <Wrench className="h-3.5 w-3.5" />
        {t("filterTools")}
      </ToggleChip>
      <ToggleChip pressed={filters.silent} onClick={() => set({ silent: !filters.silent })}>
        {filters.silent ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        {t("filterSilent")}
      </ToggleChip>
      <ToggleChip
        pressed={filters.hindsightOnly}
        onClick={() => set({ hindsightOnly: !filters.hindsightOnly })}
      >
        <Brain className="h-3.5 w-3.5" />
        {t("filterHindsightOnly")}
      </ToggleChip>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {noteCount > 0 && (
          <span className="hidden text-[11px] text-muted-foreground lg:inline">
            {t("keyboardHint")}
          </span>
        )}
        {replay ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              aria-label={replay.playing ? t("replayPause") : t("replayPlay")}
              title={replay.playing ? t("replayPause") : t("replayPlay")}
              onClick={() =>
                setReplay((r) =>
                  r
                    ? {
                        ...r,
                        playing: !r.playing,
                        elapsed: !r.playing && r.elapsed >= replayEnd ? 0 : r.elapsed,
                      }
                    : r
                )
              }
            >
              {replay.playing ? <Pause /> : <Play />}
            </Button>
            {REPLAY_SPEEDS.map((s) => (
              <ToggleChip
                key={s}
                pressed={replay.speed === s}
                onClick={() => setReplay((r) => (r ? { ...r, speed: s } : r))}
              >
                {s}×
              </ToggleChip>
            ))}
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {formatDuration(replay.elapsed)} / {formatDuration(replayEnd)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              aria-label={t("replayExit")}
              title={t("replayExit")}
              onClick={() => setReplay(null)}
            >
              <X />
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={!canReplay}
            onClick={() => setReplay({ speed: 1, playing: true, elapsed: 0 })}
          >
            <Play />
            {t("replay")}
          </Button>
        )}
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {t("shownCount", { count: shown })}
        </span>
      </div>
    </div>
  );
}

// ---- Rows -----------------------------------------------------------------------------

interface RowProps {
  row: TimelineRow;
  t: Translate;
  source: string | null;
  ackedSeq: number;
  timeline: ReturnType<typeof buildTimeline>;
  onJump: (key: string) => void;
  onHoverHost: (key: string | null) => void;
  onOpenDocument: (id: string) => void;
  onOpenMemory: (id: string) => void;
}

function RowView(props: RowProps) {
  const { row } = props;
  return (
    <>
      <RowBody {...props} />
      {row.checks.length > 0 && (
        <div className="mt-1.5 space-y-1 pl-9 sm:pl-11">
          {row.checks.map((c) => (
            <CheckMarker
              key={c.key}
              check={c}
              t={props.t}
              onHover={(on) => props.onHoverHost(on ? row.key : null)}
              onOpenMemory={props.onOpenMemory}
            />
          ))}
        </div>
      )}
    </>
  );
}

function Avatar({
  kind,
  source,
}: {
  kind: "user" | "agent" | "hindsight";
  source?: string | null;
}) {
  // An unknown source has no logo: fall back to the generic agent mark.
  if (kind === "agent" && resolveHarnessLogo(source)) {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-card">
        <HarnessLogo harness={source} size={16} />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
        kind === "user" && "bg-indigo-500 text-white",
        kind === "agent" && "border border-border bg-card text-muted-foreground",
        kind === "hindsight" && "bg-primary-gradient text-white"
      )}
    >
      {kind === "user" ? (
        <User className="h-4 w-4" />
      ) : kind === "agent" ? (
        <Bot className="h-4 w-4" />
      ) : (
        <Brain className="h-4 w-4" />
      )}
    </span>
  );
}

function Time({ iso }: { iso: string }) {
  const locale = useLocale();
  const d = new Date(iso);
  return (
    <time
      dateTime={iso}
      title={d.toLocaleString(locale)}
      className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
    >
      {d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
    </time>
  );
}

function RowBody(props: RowProps) {
  const { row, t } = props;
  switch (row.kind) {
    case "message":
      if (row.role === "user") {
        return (
          <div className="flex items-start justify-end gap-2.5">
            <div className="min-w-0 max-w-[88%] sm:max-w-[80%]">
              <div className="mb-1 flex items-center justify-end gap-2">
                <Time iso={row.event.created_at} />
                <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                  {t("voiceUser")}
                </span>
              </div>
              <div className="rounded-2xl rounded-tr-sm bg-indigo-500/10 px-3.5 py-2.5 ring-1 ring-indigo-500/20">
                <ExpandableText text={row.text} t={t} markdown />
              </div>
            </div>
            <Avatar kind="user" />
          </div>
        );
      }
      if (row.role === "system") {
        return (
          <div className="px-9 text-center text-xs text-muted-foreground sm:px-11">
            <ExpandableText text={row.text} t={t} />
          </div>
        );
      }
      return (
        <div className="flex items-start gap-2.5">
          <Avatar kind="agent" source={props.source} />
          <div className="min-w-0 max-w-[88%] sm:max-w-[80%]">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground/80">{t("voiceAgent")}</span>
              <Time iso={row.event.created_at} />
            </div>
            <div className="rounded-2xl rounded-tl-sm border border-border/60 bg-card px-3.5 py-2.5">
              <ExpandableText text={row.text} t={t} markdown />
            </div>
          </div>
        </div>
      );
    case "tool":
      return <ToolLine row={row} t={t} />;
    case "state":
      return <StateLine row={row} t={t} />;
    case "turn_end":
      return (
        <div className="flex items-center gap-2 pl-9 text-[11px] text-muted-foreground sm:pl-11">
          <Flag className="h-3 w-3" />
          {t("turnEnd")}
          <div className="h-px flex-1 bg-border/60" />
        </div>
      );
    case "note":
      return <NoteCard {...props} row={row} />;
    case "save":
      return (
        <div className="flex flex-wrap items-center gap-2 pl-9 text-[11px] text-muted-foreground sm:pl-11">
          <Save className="h-3.5 w-3.5 text-primary" />
          <span>
            {t("saved", {
              from: row.save.from_seq ?? 0,
              to: row.save.to_seq ?? 0,
              turns: row.save.turns ?? 0,
            })}
          </span>
          {row.save.document_id && (
            <button
              type="button"
              className="font-mono text-primary hover:underline"
              onClick={() => props.onOpenDocument(row.save.document_id!)}
            >
              {row.save.document_id}
            </button>
          )}
          <Time iso={row.event.created_at} />
        </div>
      );
    case "check":
      // Its moment is not in the log: the marker stands alone at its own time.
      return (
        <div className="pl-9 sm:pl-11">
          <CheckMarker
            check={row}
            t={t}
            onHover={() => undefined}
            onOpenMemory={props.onOpenMemory}
          />
        </div>
      );
    default:
      return (
        <div className="pl-9 font-mono text-[11px] text-muted-foreground sm:pl-11">
          {row.event.source}/{row.event.kind}
        </div>
      );
  }
}

const LONG_TEXT = 900;

function ExpandableText({ text, t, markdown }: { text: string; t: Translate; markdown?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_TEXT;
  const shown = long && !open ? `${text.slice(0, LONG_TEXT).trimEnd()}…` : text;
  return (
    <div className="min-w-0 break-words">
      {markdown ? (
        <CompactMarkdown>{shown}</CompactMarkdown>
      ) : (
        <span className="whitespace-pre-wrap">{shown}</span>
      )}
      {long && (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-primary hover:underline"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? t("showLess") : t("showMore")}
        </button>
      )}
    </div>
  );
}

const TOOL_ICON: Record<ToolFamily, typeof Pencil> = {
  edit: Pencil,
  command: SquareTerminal,
  read: Search,
  other: Wrench,
};

function ToolLine({ row, t }: { row: Extract<TimelineRow, { kind: "tool" }>; t: Translate }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICON[row.family];
  const quiet = row.family === "read" && !row.isError;
  const input = (row.call?.payload.input ?? null) as Record<string, unknown> | null;
  const resultText = typeof row.result?.payload.text === "string" ? row.result.payload.text : "";
  const oldStr = typeof input?.old_string === "string" ? input.old_string : null;
  const newStr = typeof input?.new_string === "string" ? input.new_string : null;

  return (
    <div className="pl-9 sm:pl-11">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "group flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-muted/60",
          quiet ? "text-muted-foreground" : "text-foreground",
          row.isError && "bg-red-500/5 text-red-700 dark:text-red-400"
        )}
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 opacity-50 transition-transform", open && "rotate-90")}
        />
        <Icon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            row.family === "edit" && !row.isError && "text-amber-600 dark:text-amber-400",
            row.family === "command" && !row.isError && "text-sky-600 dark:text-sky-400"
          )}
        />
        <span className={cn("shrink-0 text-xs", quiet ? "font-normal" : "font-semibold")}>
          {row.tool || t("toolResult")}
        </span>
        <span className="min-w-0 truncate font-mono text-xs opacity-80">{row.target}</span>
        {row.isError && (
          <span className="shrink-0 rounded-full bg-red-500/15 px-1.5 text-[10px] font-semibold uppercase">
            {t("error")}
          </span>
        )}
        {!row.result && row.call && (
          <span className="ml-auto shrink-0">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 space-y-2 rounded-lg border border-border/60 bg-muted/30 p-2.5 animate-soft-fade-in">
          {oldStr !== null && newStr !== null ? (
            <DiffBlock diff={toDiff(oldStr, newStr)} />
          ) : input ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
              {typeof input.command === "string" ? input.command : JSON.stringify(input, null, 2)}
            </pre>
          ) : null}
          {row.result && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("toolResult")}
              </div>
              <pre
                className={cn(
                  "max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-2 font-mono text-[11px] leading-5",
                  row.isError && "text-red-700 dark:text-red-400"
                )}
              >
                {resultText || "—"}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function toDiff(oldStr: string, newStr: string): string {
  const minus = oldStr.split("\n").map((l) => `-${l}`);
  const plus = newStr.split("\n").map((l) => `+${l}`);
  return [...minus, ...plus].join("\n");
}

function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-md bg-background font-mono text-[11px] leading-5">
      {diff.split("\n").map((line, i) => (
        <div
          key={i}
          className={cn(
            "whitespace-pre-wrap break-words px-2",
            line.startsWith("+") &&
              !line.startsWith("+++") &&
              "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
            line.startsWith("-") &&
              !line.startsWith("---") &&
              "bg-red-500/10 text-red-800 dark:text-red-300",
            line.startsWith("@@") && "text-sky-700 dark:text-sky-400",
            (line.startsWith("diff ") || line.startsWith("index ")) && "text-muted-foreground"
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function StateLine({ row, t }: { row: Extract<TimelineRow, { kind: "state" }>; t: Translate }) {
  const [open, setOpen] = useState(false);
  const lines = row.diff.split("\n");
  const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  const files = lines.filter((l) => l.startsWith("diff --git")).length;
  return (
    <div className="pl-9 sm:pl-11">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/60"
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 opacity-50 transition-transform", open && "rotate-90")}
        />
        <FileDiff className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium text-foreground/80">{t("changeSoFar")}</span>
        <span>{t("filesChanged", { count: files })}</span>
        <span className="font-mono text-emerald-600 dark:text-emerald-400">+{added}</span>
        <span className="font-mono text-red-600 dark:text-red-400">−{removed}</span>
      </button>
      {open && (
        <div className="mt-1 animate-soft-fade-in">
          {row.diff ? (
            <DiffBlock diff={row.diff} />
          ) : (
            <div className="px-2 text-xs text-muted-foreground">{t("noChanges")}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Hindsight ---------------------------------------------------------------------------

function routeLabel(t: Translate, route: DecisionRoute) {
  switch (route) {
    case "silent":
      return t("routeSilent");
    case "nothing":
      return t("routeNothing");
    case "writer":
      return t("routeWriter");
    case "llm":
      return t("routeLlm");
    default:
      return t("routeUnknown");
  }
}

/** `decision none=0.02 · kept 1/8 → writer words it → abstain answer 1.2s` */
function DecisionPathLine({ check, t }: { check: CheckPayload; t: Translate }) {
  const path = decisionPath(check.llm_calls);
  if (!path.pick && path.after.length === 0) return null;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px]">
      {path.pick && (
        <>
          <span className="text-muted-foreground">
            {t("decision")}{" "}
            {path.pick.none !== null && (
              // The decision model's own wording, kept as-is.
              <span className="font-mono">{`none=${path.pick.none.toFixed(2)}`}</span>
            )}
            {path.pick.kept !== null && path.pick.offered !== null && (
              <span className="font-mono">
                {" "}
                · {path.pick.kept}/{path.pick.offered}
              </span>
            )}
          </span>
          <span className="text-muted-foreground/60">→</span>
          <span className={cn("font-medium", ROUTE_STYLE[path.pick.route])}>
            {routeLabel(t, path.pick.route)}
          </span>
        </>
      )}
      {path.after.map((c, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          <span className="text-muted-foreground/60">→</span>
          <span className="text-foreground/80">{c.scope.replace(/_/g, " ")}</span>
          {typeof c.duration_ms === "number" && (
            <span className="font-mono text-muted-foreground">{formatDuration(c.duration_ms)}</span>
          )}
        </span>
      ))}
    </span>
  );
}

function CheckMarker({
  check,
  t,
  onHover,
  onOpenMemory,
}: {
  check: CheckRow;
  t: Translate;
  onHover: (on: boolean) => void;
  onOpenMemory: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const c = check.check;
  const outcome = c.outcome ?? "silent";
  const quiet = isQuietCheck(c);
  return (
    <div
      className={cn(
        "border-l-2 pl-2",
        outcome === "note"
          ? "border-primary"
          : outcome === "error"
            ? "border-red-500"
            : outcome === "repeat"
              ? "border-amber-500"
              : "border-border",
        quiet && "opacity-75 hover:opacity-100"
      )}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-1.5 py-1 text-left hover:bg-muted/60"
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 opacity-50 transition-transform", open && "rotate-90")}
        />
        <Brain className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="text-[11px] font-medium text-foreground/80">
          {t("checkedOn", { trigger: triggerLabel(t, c.trigger) })}
        </span>
        <span
          className={cn(
            "rounded-full border px-1.5 text-[10px] font-semibold uppercase tracking-wide",
            OUTCOME_STYLE[outcome] ?? OUTCOME_STYLE.silent
          )}
        >
          {outcomeLabel(t, outcome)}
        </span>
        {typeof c.ms === "number" && (
          <span className="inline-flex items-center gap-0.5 font-mono text-[11px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            {formatDuration(c.ms)}
          </span>
        )}
        {outcome === "skipped" && c.reason ? (
          <span className="text-[11px] text-muted-foreground">{c.reason}</span>
        ) : (
          <DecisionPathLine check={c} t={t} />
        )}
      </button>
      {open && <CheckDetails check={c} t={t} onOpenMemory={onOpenMemory} />}
    </div>
  );
}

function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function CheckDetails({
  check: c,
  t,
  onOpenMemory,
}: {
  check: CheckPayload;
  t: Translate;
  onOpenMemory: (id: string) => void;
}) {
  const path = decisionPath(c.llm_calls);
  return (
    <div className="mb-1 ml-1 mt-1 space-y-3 rounded-lg border border-border/60 bg-muted/30 p-3 text-xs animate-soft-fade-in">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {c.question && (
          <DetailSection label={t("detailQuestion")}>
            <span>
              {c.question === "headsup"
                ? t("questionHeadsup")
                : c.question === "conflict"
                  ? t("questionConflict")
                  : c.question}
            </span>
          </DetailSection>
        )}
        {c.usage && (
          <DetailSection label={t("detailTokens")}>
            <span className="font-mono">
              {t("tokens", {
                input: c.usage.input_tokens ?? 0,
                output: c.usage.output_tokens ?? 0,
              })}
            </span>
          </DetailSection>
        )}
        {path.pick?.ms != null && (
          <DetailSection label={t("detailDecisionTime")}>
            <span className="font-mono">{formatDuration(path.pick.ms)}</span>
          </DetailSection>
        )}
      </div>
      {c.error && (
        <DetailSection label={t("error")}>
          <pre className="whitespace-pre-wrap break-words font-mono text-red-600 dark:text-red-400">
            {c.error}
          </pre>
        </DetailSection>
      )}
      {c.reason && <DetailSection label={t("detailReason")}>{c.reason}</DetailSection>}
      {c.moment && (
        <DetailSection label={t("detailMoment")}>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
            {c.moment}
          </pre>
        </DetailSection>
      )}
      {(c.search_queries?.length ?? 0) > 0 && (
        <DetailSection label={t("detailSearchQueries")}>
          <ol className="list-decimal space-y-1 pl-4">
            {c.search_queries!.map((q, i) => (
              <li key={i} className="whitespace-pre-wrap break-words font-mono text-[11px]">
                {q}
              </li>
            ))}
          </ol>
        </DetailSection>
      )}
      {c.context && (
        <DetailSection label={t("detailContext")}>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-2 font-mono text-[11px] leading-5">
            {c.context}
          </pre>
        </DetailSection>
      )}
      <DetailSection label={t("detailAnswer")}>
        {c.answer ? (
          <div className="whitespace-pre-wrap break-words">{c.answer}</div>
        ) : (
          <span className="text-muted-foreground">
            {c.abstained ? t("abstained") : t("noAnswer")}
          </span>
        )}
      </DetailSection>
      {(c.memory_ids?.length ?? 0) > 0 && (
        <DetailSection label={t("detailMemories")}>
          <MemoryChips ids={c.memory_ids!} onOpen={onOpenMemory} />
        </DetailSection>
      )}
    </div>
  );
}

function MemoryChips({ ids, onOpen }: { ids: string[]; onOpen: (id: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onOpen(id)}
          className="rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary/40 hover:text-primary"
          title={id}
        >
          {id.slice(0, 8)}
        </button>
      ))}
    </div>
  );
}

function NoteCard({
  row,
  t,
  ackedSeq,
  timeline,
  onJump,
  onOpenDocument,
  onOpenMemory,
}: RowProps & { row: Extract<TimelineRow, { kind: "note" }> }) {
  const locale = useLocale();
  const n = row.note;
  const delivered = isDelivered(row.seq, ackedSeq);
  const latency = noteLatencyMs(row.event, timeline.eventBySeq);
  const check = n.check_seq !== undefined ? timeline.eventBySeq.get(n.check_seq) : undefined;
  const momentSeq = check ? (check.payload as CheckPayload).moment_seq : undefined;
  const momentKey = momentSeq !== undefined ? timeline.rowKeyBySeq.get(momentSeq) : undefined;
  const momentText = check ? (check.payload as CheckPayload).moment : undefined;
  const src = n.source;

  return (
    <div className="flex items-start gap-2.5">
      <Avatar kind="hindsight" />
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm bg-primary-gradient p-px shadow-md shadow-primary/10">
        <div className="rounded-[15px] rounded-tl-[3px] bg-card px-4 py-3">
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-bold text-primary">{t("voiceHindsight")}</span>
            <span className="text-[11px] text-muted-foreground">{t("toAgent")}</span>
            {n.trigger && (
              <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                {triggerLabel(t, n.trigger)}
              </span>
            )}
            {latency !== null && (
              <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground">
                <Clock className="h-3 w-3" />
                {t("latency", { duration: formatDuration(latency) })}
              </span>
            )}
            <span className="ml-auto inline-flex items-center gap-2">
              {delivered ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                  <Check className="h-3 w-3" />
                  {t("delivered")}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                  <Clock className="h-3 w-3" />
                  {t("pending")}
                </span>
              )}
              <Time iso={row.event.created_at} />
            </span>
          </div>

          <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-foreground">
            {n.text}
          </div>

          {src?.quote && (
            <blockquote className="mt-3 border-l-2 border-primary/40 pl-3 text-[13px] italic leading-relaxed text-foreground/75">
              “{src.quote}”
              <footer className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] not-italic text-muted-foreground">
                {src.document_id && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 font-mono text-primary hover:underline"
                    onClick={() => onOpenDocument(src.document_id!)}
                  >
                    <FileText className="h-3 w-3" />
                    {src.document_id}
                  </button>
                )}
                {src.mentioned_at && (
                  <span>
                    {t("mentionedAt", {
                      when: new Date(src.mentioned_at).toLocaleDateString(locale, {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      }),
                    })}
                  </span>
                )}
              </footer>
            </blockquote>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
            {momentKey && (
              <button
                type="button"
                onClick={() => onJump(momentKey)}
                className="inline-flex min-w-0 max-w-full items-center gap-1 hover:text-primary"
              >
                <span className="shrink-0">{t("inReplyTo")}</span>
                <span className="truncate italic">{(momentText || "").split("\n")[0]}</span>
              </button>
            )}
            {(n.memory_ids?.length ?? 0) > 0 && (
              <MemoryChips ids={n.memory_ids!} onOpen={onOpenMemory} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A typing indicator for the third voice: shown while a watcher check runs. */
function CheckingIndicator({ t }: { t: Translate }) {
  return (
    <div className="mt-3 flex items-center gap-2.5 animate-soft-fade-in">
      <Avatar kind="hindsight" />
      <div className="inline-flex items-center gap-2 rounded-2xl rounded-tl-sm border border-primary/20 bg-primary/5 px-3.5 py-2 text-xs text-primary">
        <span className="inline-flex gap-1">
          {[0, 150, 300].map((d) => (
            <span
              key={d}
              className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary"
              style={{ animationDelay: `${d}ms` }}
            />
          ))}
        </span>
        {t("checkingLong")}
      </div>
    </div>
  );
}
