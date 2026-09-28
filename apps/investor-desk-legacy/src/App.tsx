import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import {
  Activity,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  ExternalLink,
  FileSearch,
  Filter,
  ListFilter,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import { getSnapshot, refresh, reviewEvent, updateWatchlist } from "./api";
import {
  type AppSnapshot,
  type Event,
  type ReviewStatus,
  formatIssuer,
  isReviewable,
} from "./domain";

type QueueFilter = "all" | "review" | "watch" | "reviewed" | "watchlist";

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).valueOf();
  const minutes = Math.max(0, Math.round(elapsed / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function scoreLabel(score: number): string {
  if (score >= 80) return "High attention";
  if (score >= 60) return "Worth a read";
  return "Watch";
}

function signalKindLabel(kind: Event["kind"]): string {
  const labels: Record<Event["kind"], string> = {
    filing: "Filing",
    earnings: "Earnings",
    guidance: "Guidance",
    regulatory: "Regulatory",
    corporate_action: "Corporate action",
    news: "News",
  };
  return labels[kind];
}

function filterLabel(filter: QueueFilter): string {
  const labels: Record<QueueFilter, string> = {
    all: "All signals",
    review: "Needs review",
    watch: "Watch lane",
    reviewed: "Reviewed",
    watchlist: "Watchlist only",
  };
  return labels[filter];
}

function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [tickerFilter, setTickerFilter] = useState<string>("all");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"loading" | "sec" | "review" | "watchlist" | null>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSnapshot()
      .then((next) => setSnapshot(next))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load the desk."))
      .finally(() => setBusy(null));
  }, []);

  const watchlistTickers = useMemo(() => new Set(snapshot?.watchlist.map((entry) => entry.issuer.ticker.value) ?? []), [snapshot]);
  const filteredEvents = useMemo(() => {
    if (snapshot === null) return [];
    return snapshot.events.filter((event) => {
      if (tickerFilter !== "all" && event.issuer.ticker.value !== tickerFilter) return false;
      if (filter === "review") return isReviewable(event);
      if (filter === "watch") return event.screening.decision === "watch";
      if (filter === "reviewed") return event.review.status !== "unreviewed";
      if (filter === "watchlist") return watchlistTickers.has(event.issuer.ticker.value);
      return true;
    });
  }, [filter, snapshot, tickerFilter, watchlistTickers]);

  const selectedEvent = useMemo(() => {
    if (snapshot === null) return null;
    return snapshot.events.find((event) => event.id === selectedId) ?? filteredEvents[0] ?? snapshot.events[0] ?? null;
  }, [filteredEvents, selectedId, snapshot]);

  useEffect(() => {
    if (selectedEvent !== null && selectedEvent.id !== selectedId) setSelectedId(selectedEvent.id);
    if (selectedEvent !== null) setNote(selectedEvent.review.note);
  }, [selectedEvent, selectedId]);

  async function runRefresh(): Promise<void> {
    setBusy("sec");
    setError(null);
    try {
      const next = await refresh();
      setSnapshot(next);
      const nextSelected = next.events.find((event) => event.id === selectedId) ?? next.events[0];
      setSelectedId(nextSelected?.id ?? null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Refresh failed.");
    } finally {
      setBusy(null);
    }
  }

  async function saveReview(status: ReviewStatus): Promise<void> {
    if (selectedEvent === null) return;
    setBusy("review");
    setError(null);
    try {
      const next = await reviewEvent(selectedEvent.id, status, note);
      setSnapshot(next);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not save the review.");
    } finally {
      setBusy(null);
    }
  }

  async function toggleWatchlist(): Promise<void> {
    if (selectedEvent === null || snapshot === null) return;
    setBusy("watchlist");
    setError(null);
    try {
      const action = watchlistTickers.has(selectedEvent.issuer.ticker.value) ? "remove" : "add";
      const next = await updateWatchlist(action, selectedEvent.issuer);
      setSnapshot(next);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not update the watchlist.");
    } finally {
      setBusy(null);
    }
  }

  const secHealth = snapshot?.sourceHealth.find((health) => health.provider === "sec");
  const jevHealth = snapshot?.sourceHealth.find((health) => health.provider === "jev");
  const reviewCount = snapshot?.events.filter(isReviewable).length ?? 0;
  const freshCount = snapshot?.events.filter((event) => Date.now() - new Date(event.availableAt).valueOf() < 24 * 60 * 60 * 1000).length ?? 0;
  const sourceLabel = secHealth?.status === "healthy" && jevHealth?.status === "healthy" ? "SEC + JEv live" : jevHealth?.status === "offline" ? "Configure JEv" : "Ready for refresh";
  const sourceNote = jevHealth?.message ?? "Set a JEv key, then refresh SEC.";

  if (snapshot === null) {
    return <main className="loading-screen"><LoaderCircle className="spin" size={22} /><span>Opening your signal desk</span>{error !== null && <p>{error}</p>}</main>;
  }

  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="brand-lockup">
          <div className="brand-mark"><Activity size={19} strokeWidth={2.4} /></div>
          <div><p className="eyebrow">Research system</p><h1>Signal Desk</h1></div>
        </div>
        <div className="rail-section">
          <p className="rail-label">Workspace</p>
          <button className="rail-link active"><span className="rail-link-icon"><RadarIcon /></span><span>Signal queue</span><span className="rail-count">{reviewCount}</span></button>
          <button className="rail-link"><span className="rail-link-icon"><FileSearch size={15} /></span><span>Evidence log</span></button>
        </div>
        <div className="rail-section watchlist-section">
          <div className="section-title-row"><p className="rail-label">Watchlist</p><span className="tiny-count">{snapshot.watchlist.length}</span></div>
          <div className="watchlist-list">
            {snapshot.watchlist.map((entry) => (
              <button key={entry.issuer.cik.value} className={`watch-item ${tickerFilter === entry.issuer.ticker.value ? "selected" : ""}`} onClick={() => setTickerFilter(tickerFilter === entry.issuer.ticker.value ? "all" : entry.issuer.ticker.value)}>
                <span className="ticker-dot">{entry.issuer.ticker.value.slice(0, 1)}</span>
                <span><strong>{entry.issuer.ticker.value}</strong><small>{entry.issuer.name.replace(/,? (Inc\.|Corporation|Corp\.|Company|Ltd\.).*$/, "")}</small></span>
                <ChevronRight size={13} />
              </button>
            ))}
          </div>
        </div>
        <div className="rail-footer">
          <div className="privacy-note"><ShieldCheck size={15} /><span>Private by default<br /><small>Local review state</small></span></div>
          <div className="version-chip">v0.1 · decision support</div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-title"><p className="eyebrow">Public-equity monitoring</p><h2>What deserves your attention?</h2></div>
          <div className="topbar-actions">
            <div className="source-state"><span className={`status-dot ${sourceLabel === "SEC + JEv live" ? "live" : ""}`} /><span>{sourceLabel}</span><small>{snapshot.lastRefreshAt === null ? "Not refreshed" : `Updated ${relativeTime(snapshot.lastRefreshAt)}`}</small></div>
            <button className="button primary" onClick={() => void runRefresh()} disabled={busy !== null}><Database size={15} className={busy === "sec" ? "spin" : ""} />Refresh SEC</button>
          </div>
        </header>

        {error !== null && <div className="error-banner"><CircleAlert size={16} /><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss error"><X size={15} /></button></div>}

        <section className="metric-row">
          <div className="metric-card"><span className="metric-icon amber"><Target size={17} /></span><div><span className="metric-label">Needs review</span><strong>{reviewCount}</strong><small>High-attention signals</small></div></div>
          <div className="metric-card"><span className="metric-icon mint"><Clock3 size={17} /></span><div><span className="metric-label">Fresh window</span><strong>{freshCount}</strong><small>Observed in the last 24h</small></div></div>
          <div className="metric-card"><span className="metric-icon blue"><Database size={17} /></span><div><span className="metric-label">Evidence sources</span><strong>{snapshot.sourceHealth.length}</strong><small>{sourceNote}</small></div></div>
          <div className="metric-card metric-note"><span className="metric-icon violet"><Sparkles size={17} /></span><div><span className="metric-label">Screening posture</span><strong>JEv typed triage</strong><small>JEv scores. Code ranks. Human decides.</small></div></div>
        </section>

        <section className="workspace-grid">
          <div className="queue-panel panel">
            <div className="panel-header queue-header"><div><p className="eyebrow">Incoming evidence</p><h3>{filterLabel(filter)}</h3></div><div className="queue-tools"><button className="icon-button" aria-label="Filter signals"><Filter size={16} /></button><span className="result-count">{filteredEvents.length} signals</span></div></div>
            <div className="filter-tabs" role="tablist" aria-label="Signal filters">
              {(["all", "review", "watch", "reviewed", "watchlist"] as const).map((item) => <button key={item} className={filter === item ? "selected" : ""} onClick={() => setFilter(item)} role="tab" aria-selected={filter === item}>{filterLabel(item)}</button>)}
            </div>
            <div className="queue-list">
              {filteredEvents.length === 0 && <div className="empty-queue"><ListFilter size={22} /><strong>No SEC signals yet</strong><span>Set a JEv key, then refresh SEC to load live filings.</span></div>}
              {filteredEvents.map((event) => <SignalCard key={event.id} event={event} selected={selectedEvent?.id === event.id} onSelect={() => setSelectedId(event.id)} />)}
            </div>
          </div>

          <div className="detail-panel panel">
            {selectedEvent === null ? <div className="empty-detail"><FileSearch size={24} /><h3>Select a signal</h3><p>Choose an item from the queue to inspect its evidence and record a review.</p></div> : <SignalDetail event={selectedEvent} snapshot={snapshot} note={note} onNoteChange={setNote} onReview={(status) => void saveReview(status)} onToggleWatchlist={() => void toggleWatchlist()} isWatched={watchlistTickers.has(selectedEvent.issuer.ticker.value)} busy={busy !== null} />}
          </div>
        </section>
      </main>
    </div>
  );
}

function RadarIcon(): ReactElement {
  return <span className="radar-icon"><span /><span /><span /></span>;
}

function SignalCard({ event, selected, onSelect }: { event: Event; selected: boolean; onSelect: () => void }): ReactElement {
  return (
    <button className={`signal-card ${selected ? "selected" : ""}`} onClick={onSelect} aria-pressed={selected}>
      <div className="signal-card-top"><span className="ticker-label">{event.issuer.ticker.value}</span><span className="source-label"><span className={`source-dot ${event.source.provider}`} />SEC</span><span className="time-label">{relativeTime(event.availableAt)}</span></div>
      <div className="signal-card-body"><h4>{event.title}</h4><p>{event.summary}</p></div>
      <div className="signal-card-footer"><span className={`decision-pill ${event.screening.decision}`}>{event.screening.decision === "review" ? "Review" : event.screening.decision === "watch" ? "Watch" : "Low priority"}</span><span className="kind-label">{signalKindLabel(event.kind)}</span><span className="score-inline"><span className="score-track"><span style={{ width: `${event.screening.attentionScore}%` }} /></span><strong>{event.screening.attentionScore}</strong></span></div>
    </button>
  );
}

function SignalDetail({ event, snapshot, note, onNoteChange, onReview, onToggleWatchlist, isWatched, busy }: { event: Event; snapshot: AppSnapshot; note: string; onNoteChange: (value: string) => void; onReview: (status: ReviewStatus) => void; onToggleWatchlist: () => void; isWatched: boolean; busy: boolean }): ReactElement {
  const related = snapshot.events.filter((candidate) => candidate.issuer.ticker.value === event.issuer.ticker.value && candidate.id !== event.id).slice(0, 3);
  const saved = event.review.status !== "unreviewed";
  return (
    <div className="detail-scroll">
      <div className="detail-heading"><div className="detail-kicker"><span className="ticker-label large">{event.issuer.ticker.value}</span><span className="kind-label">{signalKindLabel(event.kind)}</span><span className="source-label"><span className={`source-dot ${event.source.provider}`} />Primary SEC source</span></div><button className={`watch-button ${isWatched ? "saved" : ""}`} onClick={onToggleWatchlist} disabled={busy} aria-label={isWatched ? "Remove from watchlist" : "Add to watchlist"}>{isWatched ? <Bookmark size={16} fill="currentColor" /> : <Bookmark size={16} />} {isWatched ? "On watchlist" : "Track issuer"}</button><h3>{event.title}</h3><p className="detail-summary">{event.summary}</p><div className="detail-meta"><span><Clock3 size={14} /> Available {formatDate(event.availableAt)}</span><span><FileSearch size={14} /> {event.source.availabilityPrecision === "second" ? "Timestamped source" : "Date-level source"}</span></div></div>

      <div className="attention-banner"><div className="attention-score"><strong>{event.screening.attentionScore}</strong><span>{scoreLabel(event.screening.attentionScore)}</span></div><div className="attention-copy"><span className="eyebrow">Why this surfaced</span><p>{event.screening.rationale[0]}</p></div><ArrowUpRight size={19} /></div>

      <section className="detail-section"><div className="section-heading"><div><p className="eyebrow">Screening breakdown</p><h4>Attention drivers</h4></div><span className="engine-badge">{event.screening.engine}</span></div><div className="driver-grid"><Driver label="Materiality" value={event.screening.materiality} tone="amber" /><Driver label="Novelty" value={event.screening.novelty} tone="mint" /><Driver label="Market sensitivity" value={event.screening.marketSensitivity} tone="blue" /><Driver label="Thesis link" value={event.screening.thesisMatch} tone="violet" /></div><p className="muted-note"><ShieldCheck size={14} /> JEv confidence {event.screening.modelConfidence}/100. Evidence capture {event.screening.evidenceComplete ? "complete" : "incomplete"}. Source reliability {event.screening.sourceReliability}/100. This is a reproducible screening priority, not a return forecast.</p></section>

      <section className="detail-section"><div className="section-heading"><div><p className="eyebrow">Source trail</p><h4>Evidence to inspect</h4></div><span className="reference-state">{event.evidence[0].capture === "content" ? "Captured" : "Reference only"}</span></div><div className="evidence-list">{event.evidence.map((evidence) => <a key={evidence.sourceNativeId} className="evidence-row" href={evidence.url} target="_blank" rel="noreferrer"><span className="evidence-icon"><ExternalLink size={15} /></span><span><strong>{evidence.label}</strong><small>{evidence.excerpt}</small></span><ArrowUpRight size={14} /></a>)}</div><div className="lineage-grid"><div><span>Provider</span><strong>{event.source.provider.toUpperCase()}</strong></div><div><span>Native ID</span><strong>{event.source.nativeId}</strong></div><div><span>Observed</span><strong>{formatDate(event.source.observedAt)}</strong></div><div><span>Digest</span><strong>{event.source.digest.slice(0, 12)}…</strong></div></div></section>

      <section className="detail-section"><div className="section-heading"><div><p className="eyebrow">Issuer context</p><h4>Recent signals for {event.issuer.ticker.value}</h4></div><span className="context-count">{related.length} related</span></div>{related.length > 0 ? <div className="related-list">{related.map((relatedEvent) => <div key={relatedEvent.id} className="related-row"><span className="related-time">{relativeTime(relatedEvent.availableAt)}</span><span>{relatedEvent.title}</span><span className={`decision-pill ${relatedEvent.screening.decision}`}>{relatedEvent.screening.decision}</span></div>)}</div> : <p className="empty-context">No earlier signal in the local corpus. A live refresh will build issuer context over time.</p>}</section>

      <section className="review-box"><div className="review-heading"><div><p className="eyebrow">Analyst action</p><h4>{saved ? "Review recorded" : "Record your read"}</h4></div>{saved && <span className="reviewed-badge"><Check size={13} /> {event.review.status}</span>}</div><textarea value={note} onChange={(input) => onNoteChange(input.target.value)} placeholder="What changed? What would make this worth escalating?" rows={3} aria-label="Analyst note" /><div className="review-actions"><button className="button ghost" onClick={() => onReview("snoozed")} disabled={busy}>Snooze</button><button className="button ghost danger-text" onClick={() => onReview("dismissed")} disabled={busy}>Dismiss</button><button className="button primary" onClick={() => onReview("reviewed")} disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}Save review</button></div></section>
    </div>
  );
}

function Driver({ label, value, tone }: { label: string; value: number; tone: string }): ReactElement {
  return <div className="driver"><div className="driver-label"><span>{label}</span><strong>{value}</strong></div><div className="driver-track"><span className={tone} style={{ width: `${value}%` }} /></div></div>;
}

export default App;
