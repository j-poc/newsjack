import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { ApiRequestError, getSnapshot, refresh, reviewEvent, searchIssuers, updateWatchlist } from "./api";
import { WatchlistEntries } from "./WatchlistEntries";
import { eventsForScope, type SourceScope } from "./event-scope";
import {
  IssuerSchema,
  type AppSnapshot,
  type Event,
  type Issuer,
  type IssuerSearchResult,
  type ReviewStatus,
  type SourceHealth,
  type Subject,
  isReviewable,
} from "./domain";

type QueueView = "wire" | "read_now" | "monitor" | "reviewed";
type ScanSource = SourceScope;

const SOURCE_OPTIONS: readonly { value: ScanSource; label: string; note: string }[] = [
  { value: "all", label: "All sources", note: "SEC company filings + Federal Register records, screened by TypeSafe AI" },
  { value: "all_public", label: "All public issuers", note: "SEC exchange-listed issuer directory with a 1,000-issuer rolling filing scan" },
  { value: "watchlist", label: "My watchlist", note: "SEC filings for issuers you chose; search by company name or ticker" },
  { value: "federal", label: "Federal filings", note: "Federal Register public records; verify the official edition before legal reliance" },
];

function initialScanScope(): ScanSource {
  if (typeof window === "undefined") return "all";
  const stored = window.localStorage.getItem("newsjack.scanScope");
  const migration = window.localStorage.getItem("newsjack.scanScopeVersion");
  if (migration !== "sec-filings-v3") {
    window.localStorage.setItem("newsjack.scanScopeVersion", "sec-filings-v3");
    return "all";
  }
  return stored === "watchlist" || stored === "all_public" || stored === "federal" || stored === "all" ? stored : "all";
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
}

function shortTime(value: string): string {
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).valueOf()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function laneLabel(event: Event): string {
  if (event.screening.decision === "review") return event.screening.evidenceComplete ? "read now" : "human review";
  if (event.screening.decision === "watch") return "monitor";
  return "low priority";
}

function categoryLabel(value: Event["screening"]["category"]): string {
  return value.replaceAll("_", " ");
}

function subjectCode(subject: Subject): string {
  if (subject.kind === "issuer") return subject.ticker.value;
  if (subject.kind === "public_company") return `${subject.symbol}.${subject.exchange}`;
  return subject.code;
}

function filterEvents(events: readonly Event[], view: QueueView): Event[] {
  if (view === "read_now") return events.filter((event) => isReviewable(event));
  if (view === "monitor") return events.filter((event) => event.screening.decision === "watch");
  if (view === "reviewed") return events.filter((event) => event.review.status !== "unreviewed");
  return [...events];
}

function groupedByCategory(events: readonly Event[]): Map<Event["screening"]["category"], Event[]> {
  const groups = new Map<Event["screening"]["category"], Event[]>();
  for (const event of events) {
    const current = groups.get(event.screening.category) ?? [];
    current.push(event);
    groups.set(event.screening.category, current);
  }
  return groups;
}

function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<QueueView>("wire");
  const [scope, setScope] = useState<ScanSource>(initialScanScope);
  const [busy, setBusy] = useState<"loading" | "refresh" | "review" | "watchlist" | "add" | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [issuerQuery, setIssuerQuery] = useState("");
  const [issuerMatches, setIssuerMatches] = useState<IssuerSearchResult[]>([]);
  const [issuerChoice, setIssuerChoice] = useState<IssuerSearchResult | null>(null);
  const [showAllWire, setShowAllWire] = useState(false);

  async function runRefresh(nextScope = scope): Promise<void> {
    setBusy("refresh");
    setError(null);
    try {
      const next = await refresh(nextScope);
      setSnapshot(next);
      setSelectedId(next.events[0]?.id ?? null);
    } catch (reason: unknown) {
      if (reason instanceof ApiRequestError && reason.snapshot !== null) setSnapshot(reason.snapshot);
      setError(reason instanceof Error ? reason.message : "The wire could not be refreshed.");
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    let active = true;
    getSnapshot()
      .then((initial) => {
        if (!active) return;
        setSnapshot(initial);
        setBusy(null);
        void runRefresh(scope);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Could not open the investor desk.");
          setBusy(null);
        }
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("newsjack.scanScope", scope);
  }, [scope]);

  useEffect(() => {
    if (snapshot === null) return;
    const timer = window.setInterval(() => void runRefresh(scope), 10 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [scope, snapshot]);

  const watchedCiks = useMemo(() => new Set(snapshot?.watchlist.map((entry) => entry.issuer.cik.value) ?? []), [snapshot]);
  const scopedEvents = useMemo(() => eventsForScope(snapshot?.events ?? [], scope, watchedCiks), [snapshot, scope, watchedCiks]);
  const filteredEvents = useMemo(() => filterEvents(scopedEvents, view), [scopedEvents, view]);
  const selectedEvent = useMemo(() => filteredEvents.find((event) => event.id === selectedId) ?? filteredEvents[0] ?? null, [filteredEvents, selectedId]);
  const secHealth = snapshot?.sourceHealth.find((health) => health.provider === "sec");
  const federalHealth = snapshot?.sourceHealth.find((health) => health.provider === "federal_register");
  const companyNewsHealth = snapshot?.sourceHealth.find((health) => health.provider === "finnhub_news");
  const typesafeHealth = snapshot?.sourceHealth.find((health) => health.provider === "typesafe_ai");
  const activeSourceHealth: readonly { label: string; health: SourceHealth | undefined }[] = scope === "federal"
    ? [{ label: "Federal Register", health: federalHealth }]
    : scope === "all"
      ? [{ label: "SEC EDGAR", health: secHealth }, { label: "Federal Register", health: federalHealth }]
      : [{ label: "SEC EDGAR", health: secHealth }];
  const activeSourcesHealthy = activeSourceHealth.every(({ health }) => health?.status === "healthy" && health.freshness === "live");
  const typesafeHealthy = typesafeHealth?.status === "healthy" && typesafeHealth.freshness === "live";
  const reviewCount = scopedEvents.filter(isReviewable).length;
  const categories = useMemo(() => groupedByCategory(filteredEvents), [filteredEvents]);
  const status = busy === "refresh"
    ? "reading the wire"
    : snapshot === null || snapshot.lastRefreshAt === null
      ? "awaiting first read"
      : scope === "watchlist" && snapshot.watchlist.length === 0
        ? "watchlist empty"
        : activeSourcesHealthy && typesafeHealthy
          ? "live wire"
          : "partial wire";

  useEffect(() => {
    const query = issuerQuery.trim();
    if (query.length < 2 || issuerChoice !== null) {
      setIssuerMatches([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void searchIssuers(query)
        .then((matches) => { if (active) setIssuerMatches(matches); })
        .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "The SEC issuer directory could not be searched."); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [issuerChoice, issuerQuery]);

  useEffect(() => {
    if (selectedEvent !== null) {
      setSelectedId(selectedEvent.id);
      setNote(selectedEvent.review.note);
    }
  }, [selectedEvent]);

  async function saveReview(nextStatus: ReviewStatus): Promise<void> {
    if (selectedEvent === null) return;
    setBusy("review");
    setError(null);
    try {
      setSnapshot(await reviewEvent(selectedEvent.id, nextStatus, note));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "The review could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function toggleWatchlist(): Promise<void> {
    if (selectedEvent === null || selectedEvent.subject.kind !== "issuer") return;
    setBusy("watchlist");
    setError(null);
    try {
      const issuer = selectedEvent.subject;
      setSnapshot(await updateWatchlist(watchedCiks.has(issuer.cik.value) ? "remove" : "add", issuer));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "The watchlist could not be updated.");
    } finally {
      setBusy(null);
    }
  }

  async function addIssuer(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (issuerChoice === null) {
      setError("Choose a company from the SEC issuer search before adding it.");
      return;
    }
    const parsed = IssuerSchema.safeParse({ kind: "issuer", name: issuerChoice.name, ticker: { kind: "ticker", value: issuerChoice.ticker }, cik: { kind: "cik", value: issuerChoice.cik } });
    if (!parsed.success) {
      setError("The selected SEC issuer identity was invalid.");
      return;
    }
    setBusy("add");
    setError(null);
    try {
      const next = await updateWatchlist("add", parsed.data);
      setSnapshot(next);
      setIssuerQuery("");
      setIssuerChoice(null);
      if (scope === "watchlist") void runRefresh("watchlist");
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "The issuer could not be added.");
    } finally {
      setBusy(null);
    }
  }

  async function removeIssuer(issuer: Issuer): Promise<void> {
    setBusy("watchlist");
    setError(null);
    try {
      setSnapshot(await updateWatchlist("remove", issuer));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "The issuer could not be removed from your watchlist.");
    } finally {
      setBusy(null);
    }
  }

  function chooseScope(next: ScanSource): void {
    setScope(next);
    void runRefresh(next);
  }

  if (snapshot === null) {
    return <main className="loading-page"><span className="loading-mark">N</span><p>Reading the real public wire…</p>{error !== null && <span className="error-copy">{error}</span>}</main>;
  }

  const selectedIssuer = selectedEvent?.subject.kind === "issuer" ? selectedEvent.subject : null;
  return (
    <div className="page">
      <header className="masthead">
        <div className="masthead-row">
          <div className="masthead-left"><h1>News Desk Dealer</h1><span className="byline">by <b>Newsjack</b></span><span className="edition">Investor edition</span></div>
          <div className="controls"><span className={`wire-status ${status.replaceAll(" ", "-")}`}><span className="status-dot" />{status}</span><button className="btn" onClick={() => void runRefresh()} disabled={busy !== null}>{busy === "refresh" ? "Reading…" : "Read the wire"}</button></div>
        </div>
        <p className="dateline">Edition of {shortDate(new Date().toISOString())} · {scopedEvents.length} categorized records · {snapshot.publicIssuerCoverage === null ? "SEC issuer universe not yet loaded" : `${snapshot.publicIssuerCoverage.activeCoverageIssuers.toLocaleString()} issuers in the active SEC coverage pool`} · {snapshot.watchlist.length} personal issuers</p>
      </header>

      <section className="model-strip" aria-label="TypeSafe AI pipeline status">
        <div className="model-mark">TS</div><div className="model-copy"><strong>TypeSafe AI</strong><span>typed screening + sorting</span></div>
        <Metric label="captured" value={scopedEvents.length} /><Metric label="categorized" value={categories.size} /><Metric label="read now" value={reviewCount} /><Metric label="my list" value={snapshot.watchlist.length} /><Metric label="SEC issuers" value={snapshot.publicIssuerCoverage?.eligibleIssuers.toLocaleString() ?? "—"} /><Metric label="live sources" value={[secHealth, federalHealth].filter((health) => health?.freshness === "live").length} /><Metric label="last read" value={snapshot.lastRefreshAt === null ? "—" : shortTime(snapshot.lastRefreshAt)} />
      </section>

      <section className="source-health-strip" aria-label="Active provider health">
        {[...activeSourceHealth, { label: "TypeSafe AI", health: typesafeHealth }].map(({ label, health }) => (
          <div className={`source-health-item ${health?.status ?? "offline"}`} key={label}>
            <strong>{label}</strong>
            <span>{health === undefined ? "not checked · delivery unavailable" : `${health.status} · ${health.freshness} · ${health.freshness === "live" ? "network delivery" : "no current delivery"} · checked ${shortTime(health.checkedAt)}`}</span>
            <small>{health?.message ?? "No accepted live source result has been recorded yet."}</small>
          </div>
        ))}
      </section>

      {(scope === "all" || scope === "federal") && <p className="legal-source-note">FederalRegister.gov records are informational renditions. For legal reliance, check the official edition in <a href="https://www.govinfo.gov/app/collection/fr" target="_blank" rel="noreferrer">govinfo</a>.</p>}

      {error !== null && <div className="error-bar" role="alert"><strong>Desk note</strong><span>{error}</span><button onClick={() => setError(null)} aria-label="Dismiss desk note">×</button></div>}

      <section className="briefing">
        <div><span className="section-label">The investor desk</span><h2>Which records deserve a first read?</h2><p>TypeSafe AI screens official SEC filings and Federal Register records. Code preserves identity, timing, freshness, and ranking. You decide what matters.</p></div>
        <div className="scope-panel"><span className="section-label">Read scope</span><div className="scope-tabs" role="tablist" aria-label="Source scope">{SOURCE_OPTIONS.map((option) => <button key={option.value} className={scope === option.value ? "selected" : ""} onClick={() => chooseScope(option.value)} role="tab" aria-selected={scope === option.value}>{option.label}</button>)}</div><span className="scope-note">{SOURCE_OPTIONS.find((option) => option.value === scope)?.note}</span></div>
      </section>

      <section className="watchbar">
        <div className="watchbar-copy"><span className="section-label">Personal watchlist</span><strong>{snapshot.watchlist.length === 0 ? "No issuers on your list" : `${snapshot.watchlist.length} issuer${snapshot.watchlist.length === 1 ? "" : "s"} on your list`}</strong><span>Search by company or ticker; the SEC identity is resolved and stored automatically.</span></div>
        <WatchlistEntries entries={snapshot.watchlist} busy={busy !== null} onRemove={(issuer) => void removeIssuer(issuer)} />
        <div className="coverage-readout" aria-live="polite"><span className="section-label">Public-company universe · separate from your personal list</span><strong>{snapshot.publicIssuerCoverage === null ? "Awaiting live SEC issuer directory" : `${snapshot.publicIssuerCoverage.eligibleIssuers.toLocaleString()} SEC-listed issuers · ${snapshot.publicIssuerCoverage.activeCoverageIssuers.toLocaleString()} in the rolling scan`}</strong><span>{snapshot.publicIssuerCoverage === null ? "The official SEC exchange directory powers broad company search and a separate, rotating filing scan. Your personal watchlist stays curated." : `${snapshot.publicIssuerCoverage.issuersScanned} checked this pass · next position ${snapshot.publicIssuerCoverage.activeCoverageIssuers === 0 ? "—" : (snapshot.publicIssuerCoverage.offsetAfter % snapshot.publicIssuerCoverage.activeCoverageIssuers + 1).toLocaleString()} of ${snapshot.publicIssuerCoverage.activeCoverageIssuers.toLocaleString()} · ${snapshot.publicIssuerCoverage.recentFilingsFound} recent filings found · ${snapshot.publicIssuerCoverage.recordsScreened} sent through TypeSafe AI · ${snapshot.publicIssuerCoverage.recordsPlaced} records placed · directory retrieved ${shortTime(snapshot.publicIssuerCoverage.retrievedAt)}. The scan is bounded and resumes at its stored cursor; it does not mean every issuer was checked in this pass.`}</span></div>
        <form className="watchlist-form" onSubmit={(event) => void addIssuer(event)}><div className="watchlist-fields"><div className="issuer-picker"><input aria-label="Search public company" role="combobox" aria-expanded={issuerMatches.length > 0} placeholder="Search company or ticker" value={issuerQuery} onChange={(event) => { setIssuerQuery(event.target.value); setIssuerChoice(null); }} />{issuerMatches.length > 0 && <div className="issuer-dropdown" role="listbox">{issuerMatches.map((match) => <button key={match.cik} type="button" role="option" onClick={() => { setIssuerChoice(match); setIssuerQuery(`${match.name} · ${match.ticker}`); setIssuerMatches([]); }}><strong>{match.name}</strong><span>{match.ticker} · {match.exchange}</span></button>)}</div>}{issuerChoice !== null && <small className="issuer-resolved">SEC identity resolved · {issuerChoice.exchange}</small>}</div><button className="btn small" type="submit" disabled={busy !== null || issuerChoice === null}>Add issuer</button></div></form>
      </section>

      <main className="newsroom">
        <section className="wire-section" aria-label="Investor filing wire">
          <div className="section-heading"><div><span className="vendor">A / {scope === "federal" ? "FEDERAL REGISTER" : scope === "watchlist" ? "SEC WATCHLIST FILINGS" : scope === "all_public" ? "SEC EDGAR · PUBLIC ISSUERS" : "SEC EDGAR + FEDERAL REGISTER"}</span><h2>The wire <span>{filteredEvents.length} placed</span></h2></div><div className="queue-tabs" role="tablist" aria-label="Record queue views">{(["wire", "read_now", "monitor", "reviewed"] as const).map((item) => <button key={item} className={view === item ? "selected" : ""} onClick={() => setView(item)} role="tab" aria-selected={view === item}>{item === "wire" ? "All" : item.replace("_", " ")}</button>)}</div></div>
          <div className="wire-strip">{filteredEvents.slice(0, showAllWire ? undefined : 6).map((event) => <WireCard key={event.id} event={event} selected={selectedEvent?.id === event.id} onSelect={() => setSelectedId(event.id)} />)}{filteredEvents.length === 0 && <EmptyWire scope={scope} />}</div>
          {filteredEvents.length > 6 && <button className="wire-expand" type="button" aria-expanded={showAllWire} onClick={() => setShowAllWire((current) => !current)}>{showAllWire ? "Show the lead six" : `Show all ${filteredEvents.length} records`}</button>}
        </section>

        <section className="sorting-card"><div><span className="section-label">B / The desks</span><h2>Sorted by TypeSafe AI</h2><p>{categories.size === 0 ? "The live wire is empty or unavailable." : `${filteredEvents.length} records placed into ${categories.size} semantic desks.`} Read the primary source before making a research judgment.</p></div><div className="sorting-readout"><span>source state</span><strong>{typesafeHealth?.freshness ?? "unavailable"}</strong><small>{typesafeHealth?.message ?? "Waiting for a real TypeSafe AI run."}</small></div></section>

        <section className="desks" aria-label="Categorized filing desks">{(["operations", "capital_allocation", "governance_legal", "risk_disclosure", "routine_disclosure"] as const).map((category) => <DeskPile key={category} category={category} events={categories.get(category) ?? []} selectedId={selectedEvent?.id ?? null} onSelect={setSelectedId} />)}</section>

        <section className="detail-section" aria-label="Selected filing detail"><DeskDetail event={selectedEvent} snapshot={snapshot} note={note} setNote={setNote} watched={selectedIssuer !== null && watchedCiks.has(selectedIssuer.cik.value)} onWatchlist={() => void toggleWatchlist()} onReview={(nextStatus) => void saveReview(nextStatus)} onSelect={setSelectedId} busy={busy !== null} /></section>
      </main>

      <footer className="colophon">Source health: SEC {secHealth?.freshness ?? "unavailable"} · Federal Register {federalHealth?.freshness ?? "unavailable"} · TypeSafe AI {typesafeHealth?.freshness ?? "unavailable"} · Finnhub company news {companyNewsHealth?.freshness ?? "not enabled"}. {companyNewsHealth?.message ?? "Finnhub is disabled pending written approval for third-party TypeSafe processing."} Screening is research priority, not a valuation, return forecast, or trade instruction.</footer>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }): ReactElement {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function WireCard({ event, selected, onSelect }: { event: Event; selected: boolean; onSelect: () => void }): ReactElement {
  const sourceLabel = event.source.provider === "sec" ? "SEC" : event.source.provider === "finnhub_news" ? "FINNHUB" : "FEDERAL";
  return <button className={`wire-card ${selected ? "selected" : ""}`} onClick={onSelect} aria-pressed={selected}><div className="card-face"><div className="card-type"><div className="card-mast"><b>{subjectCode(event.subject)}</b><span>{sourceLabel} / {event.form}</span><time>{relativeTime(event.availableAt)}</time></div><h4>{event.title}</h4><p>{event.summary}</p><span className="card-number">{String(event.screening.attentionScore).padStart(2, "0")}</span></div></div><div className="card-stamps"><b>{laneLabel(event)}</b><em>{categoryLabel(event.screening.category)}</em><span>{event.screening.attentionScore}/100</span></div></button>;
}

function DeskPile({ category, events, selectedId, onSelect }: { category: Event["screening"]["category"]; events: Event[]; selectedId: string | null; onSelect: (id: string) => void }): ReactElement {
  const [showAll, setShowAll] = useState(false);
  return <section className="desk-pile"><div className="pile-heading"><span className="pile-icon">{category === "capital_allocation" ? "◆" : category === "governance_legal" ? "§" : category === "risk_disclosure" ? "△" : category === "routine_disclosure" ? "·" : "✦"}</span><h3>{categoryLabel(category)}</h3><b>{events.length}</b></div>{events.slice(0, showAll ? undefined : 4).map((event) => <button key={event.id} className={`pile-card ${selectedId === event.id ? "selected" : ""}`} onClick={() => onSelect(event.id)}><span className="pile-source">{subjectCode(event.subject)} · {event.form}</span><strong>{event.title}</strong><span className="pile-foot"><em>read {event.screening.attentionScore}</em><small>{relativeTime(event.availableAt)}</small></span></button>)}{events.length === 0 && <div className="pile-empty">No live records</div>}{events.length > 4 && <button className="pile-expand" type="button" aria-expanded={showAll} onClick={() => setShowAll((current) => !current)}>{showAll ? "Show fewer" : `Show all ${events.length}`}</button>}</section>;
}

function EmptyWire({ scope }: { scope: ScanSource }): ReactElement {
  return <div className="empty-wire"><span className="empty-glyph">∅</span><strong>{scope === "watchlist" ? "Your watchlist wire is empty" : "No live records placed"}</strong><p>Refresh requires the configured official source and TypeSafe AI credentials. The desk never fills this space with demo data.</p></div>;
}

function DeskDetail({ event, snapshot, note, setNote, watched, onWatchlist, onReview, onSelect, busy }: { event: Event | null; snapshot: AppSnapshot; note: string; setNote: (value: string) => void; watched: boolean; onWatchlist: () => void; onReview: (status: ReviewStatus) => void; onSelect: (id: string) => void; busy: boolean }): ReactElement {
  if (event === null) return <div className="detail-empty"><span className="empty-glyph">↳</span><h2>Select a record</h2><p>Choose a record from the wire to inspect its source trail and leave a human review note.</p></div>;
  const related = snapshot.events.filter((candidate) => candidate.subject.kind === event.subject.kind && candidate.subject.name === event.subject.name && candidate.id !== event.id).slice(0, 3);
  const canWatch = event.subject.kind === "issuer";
  return <div className="desk-detail"><div className="detail-kicker"><span>{subjectCode(event.subject)}</span><span>{event.form}</span><span>{categoryLabel(event.screening.category)}</span><span>{event.screening.engine === "typesafe_ai" ? "TypeSafe AI" : event.screening.engine}</span>{canWatch && <button className={watched ? "watch-link active" : "watch-link"} onClick={onWatchlist}>{watched ? "on watchlist" : "track issuer"}</button>}</div><h2>{event.title}</h2><p className="detail-summary">{event.summary}</p><div className="detail-dates"><span><b>{event.kind === "news" ? "published" : "filed"}</b>{shortDate(event.publishedAt)}</span><span><b>available</b>{shortDate(event.availableAt)} · {shortTime(event.availableAt)}</span><span><b>observed</b>{shortDate(event.source.observedAt)} · {shortTime(event.source.observedAt)}</span><span><b>freshness</b>{event.source.freshness}</span></div><div className="attention-strip"><div><span className="section-label">Attention score</span><strong>{event.screening.attentionScore}<small>/100</small></strong></div><p>{event.screening.rationale[0]}</p><span className="lane-stamp">{laneLabel(event)}</span></div><section className="detail-block"><div className="block-heading"><h3>Typed screen</h3><span>{event.screening.modelConfidence}/100 confidence · {categoryLabel(event.screening.category)}</span></div><div className="driver-grid"><Driver label="Materiality" value={event.screening.materiality} /><Driver label="Novelty" value={event.screening.novelty} /><Driver label="Market sensitivity" value={event.screening.marketSensitivity} /><Driver label="Thesis link" value={event.screening.thesisMatch} /></div><p className="fine-print">Source reliability {event.screening.sourceReliability}/100 · evidence {event.screening.evidenceComplete ? "complete" : "incomplete"}. TypeSafe AI screens; code ranks; a person decides.</p></section><section className="detail-block"><div className="block-heading"><h3>Source evidence</h3><span>{event.evidence[0].capture === "content" ? "captured" : "reference only"}</span></div><a className="source-link" href={event.source.url} target="_blank" rel="noreferrer"><span>{event.evidence[0].label}</span><b>Open source ↗</b></a><p className="excerpt">“{event.evidence[0].excerpt}”</p><div className="lineage"><span>native ID <b>{event.source.nativeId}</b></span><span>digest <b>{event.source.digest.slice(0, 16)}…</b></span></div></section>{related.length > 0 && <section className="detail-block related"><div className="block-heading"><h3>Same subject, nearby</h3><span>{related.length} records</span></div>{related.map((candidate) => <button key={candidate.id} onClick={() => onSelect(candidate.id)}><span>{candidate.title}</span><b>{candidate.screening.attentionScore}</b></button>)}</section>}<section className="review-block"><div className="block-heading"><h3>Human review</h3><span>{event.review.status}</span></div><textarea aria-label="Review note" value={note} onChange={(entry) => setNote(entry.target.value)} placeholder="What does this change in your research question?" /><div className="review-actions"><button className="btn ghost" disabled={busy} onClick={() => onReview("snoozed")}>Snooze</button><button className="btn ghost" disabled={busy} onClick={() => onReview("dismissed")}>Dismiss</button><button className="btn" disabled={busy} onClick={() => onReview("reviewed")}>Save review</button></div></section></div>;
}

function Driver({ label, value }: { label: string; value: number }): ReactElement {
  return <div className="driver"><span>{label}</span><div><i style={{ width: `${value}%` }} /><b>{value}</b></div></div>;
}

export default App;
