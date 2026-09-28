import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { ApiRequestError, getEventPage, getSnapshot, refresh, reviewEvent, searchIssuers, updateWatchlist } from "./api";
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
  sortEvents,
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
  if (event.screening.decision === "review") return "review";
  if (event.screening.decision === "watch") return "monitor";
  return "passed";
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


function mergeSnapshot(current: AppSnapshot | null, incoming: AppSnapshot): AppSnapshot {
  if (current === null || current.eventsScope !== incoming.eventsScope) return incoming;
  if (incoming.eventsRevision < current.eventsRevision) return current;
  if (current.eventsRevision !== incoming.eventsRevision) return incoming;
  const byId = new Map(current.events.map((event) => [event.id, event]));
  for (const event of incoming.events) byId.set(event.id, mergeEventReview(byId.get(event.id), event));
  return { ...incoming, events: sortEvents([...byId.values()]), eventsCursor: current.eventsCursor };
}

function mergeEventReview(current: Event | undefined, incoming: Event): Event {
  if (current === undefined) return incoming;
  const currentAt = current.review.updatedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(current.review.updatedAt);
  const incomingAt = incoming.review.updatedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(incoming.review.updatedAt);
  const keepCurrent = currentAt > incomingAt
    || (currentAt === incomingAt && (current.review.status !== incoming.review.status || current.review.note !== incoming.review.note));
  return keepCurrent ? { ...incoming, review: current.review } : incoming;
}

function mergeReviewedEvent(snapshot: AppSnapshot, event: Event): AppSnapshot {
  const byId = new Map(snapshot.events.map((item) => [item.id, item]));
  const current = byId.get(event.id);
  byId.set(event.id, current === undefined ? event : { ...current, review: mergeEventReview(current, event).review });
  return { ...snapshot, events: sortEvents([...byId.values()]) };
}

function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<QueueView>("wire");
  const [categoryFilter, setCategoryFilter] = useState<"all" | Event["screening"]["category"]>("all");
  const [scope, setScope] = useState<ScanSource>(initialScanScope);
  const [busy, setBusy] = useState<"loading" | "refresh" | "review" | "watchlist" | "add" | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [conflictingReview, setConflictingReview] = useState<Event["review"] | null>(null);
  const noteDrafts = useRef(new Map<string, string>());
  const dirtyNoteDrafts = useRef(new Set<string>());
  const scopeRequestGeneration = useRef(0);
  const [issuerQuery, setIssuerQuery] = useState("");
  const [issuerMatches, setIssuerMatches] = useState<IssuerSearchResult[]>([]);
  const [issuerChoice, setIssuerChoice] = useState<IssuerSearchResult | null>(null);
  const [showAllWire, setShowAllWire] = useState(false);
  const [paginationStale, setPaginationStale] = useState(false);
  const [pageBusy, setPageBusy] = useState(false);

  async function runRefresh(nextScope = scope, generation = scopeRequestGeneration.current): Promise<void> {
    if (generation !== scopeRequestGeneration.current) return;
    setBusy("refresh");
    setError(null);
    try {
      const next = await refresh(nextScope);
      if (generation !== scopeRequestGeneration.current) return;
      setSnapshot((current) => mergeSnapshot(current, next));
      setPaginationStale(false);
      setSelectedId((current) => current ?? next.events[0]?.id ?? null);
    } catch (reason: unknown) {
      if (generation !== scopeRequestGeneration.current) return;
      if (reason instanceof ApiRequestError) {
        const failedSnapshot = reason.snapshot;
        if (failedSnapshot !== null) setSnapshot((current) => mergeSnapshot(current, failedSnapshot));
      }
      setError(reason instanceof Error ? reason.message : "The wire could not be refreshed.");
    } finally {
      if (generation === scopeRequestGeneration.current) setBusy(null);
    }
  }

  useEffect(() => {
    let active = true;
    const generation = ++scopeRequestGeneration.current;
    getSnapshot(scope)
      .then((initial) => {
        if (!active || generation !== scopeRequestGeneration.current) return;
        setSnapshot(initial);
        setBusy(null);
        void runRefresh(scope, generation);
      })
      .catch((reason: unknown) => {
        if (active && generation === scopeRequestGeneration.current) {
          setError(reason instanceof Error ? reason.message : "Could not open the investor desk.");
          setBusy(null);
        }
      });
    return () => {
      active = false;
      if (scopeRequestGeneration.current === generation) scopeRequestGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("newsjack.scanScope", scope);
  }, [scope]);

  useEffect(() => {
    if (snapshot === null) return;
    const timer = window.setInterval(() => void runRefresh(scope), 3 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [scope, snapshot]);

  const watchedCiks = useMemo(() => new Set(snapshot?.watchlist.map((entry) => entry.issuer.cik.value) ?? []), [snapshot]);
  const scopedEvents = useMemo(() => eventsForScope(snapshot?.events ?? [], scope, watchedCiks), [snapshot, scope, watchedCiks]);
  const filteredEvents = useMemo(() => filterEvents(scopedEvents, view).filter((event) => categoryFilter === "all" || event.screening.category === categoryFilter), [scopedEvents, view, categoryFilter]);
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
    }
  }, [selectedEvent?.id]);

  useEffect(() => {
    setConflictingReview(null);
  }, [selectedId]);

  useEffect(() => {
    if (selectedId === null) return;
    const selected = snapshot?.events.find((event) => event.id === selectedId);
    if (selected !== undefined) {
      if (dirtyNoteDrafts.current.has(selectedId)) setNote(noteDrafts.current.get(selectedId) ?? selected.review.note);
      else {
        noteDrafts.current.delete(selectedId);
        setNote(selected.review.note);
      }
    }
  }, [selectedId, snapshot?.events.find((event) => event.id === selectedId)?.review.note, snapshot?.events.find((event) => event.id === selectedId)?.review.updatedAt]);

  function editNote(value: string): void {
    setNote(value);
    if (selectedId !== null) {
      noteDrafts.current.set(selectedId, value);
      if (value === selectedEvent?.review.note) dirtyNoteDrafts.current.delete(selectedId);
      else dirtyNoteDrafts.current.add(selectedId);
    }
  }

  async function loadOlderRecords(): Promise<void> {
    if (snapshot?.eventsCursor === null || snapshot === null || pageBusy || paginationStale) return;
    const requestedScope = snapshot.eventsScope;
    const generation = scopeRequestGeneration.current;
    setPageBusy(true);
    try {
      const page = await getEventPage(snapshot.eventsCursor);
      setSnapshot((current) => {
        if (generation !== scopeRequestGeneration.current || current === null || current.eventsScope !== requestedScope || current.eventsRevision !== page.eventsRevision) return current;
        const byId = new Map(current.events.map((event) => [event.id, event]));
        for (const event of page.events) byId.set(event.id, event);
        return { ...current, events: sortEvents([...byId.values()]), eventsCursor: page.eventsCursor };
      });
    } catch (reason: unknown) {
      if (generation === scopeRequestGeneration.current) {
        if (reason instanceof ApiRequestError && reason.status === 409) setPaginationStale(true);
        setError(reason instanceof Error ? reason.message : "Older records could not be loaded.");
      }
    } finally {
      if (generation === scopeRequestGeneration.current) setPageBusy(false);
    }
  }

  async function reloadRecordList(): Promise<void> {
    const generation = scopeRequestGeneration.current;
    setPageBusy(true);
    try {
      const next = await getSnapshot(scope);
      if (generation !== scopeRequestGeneration.current) return;
      setSnapshot((current) => mergeSnapshot(current, next));
      setPaginationStale(false);
      setError(null);
    } catch (reason: unknown) {
      if (generation === scopeRequestGeneration.current) setError(reason instanceof Error ? reason.message : "The records list could not be reloaded.");
    } finally {
      if (generation === scopeRequestGeneration.current) setPageBusy(false);
    }
  }

  async function saveReview(nextStatus: ReviewStatus): Promise<void> {
    if (selectedEvent === null) return;
    const event = selectedEvent;
    const generation = scopeRequestGeneration.current;
    setBusy("review");
    setError(null);
    try {
      const result = await reviewEvent(event.id, nextStatus, note, event.review, scope);
      if (generation !== scopeRequestGeneration.current) return;
      noteDrafts.current.delete(event.id);
      dirtyNoteDrafts.current.delete(event.id);
      setConflictingReview(null);
      setSnapshot((current) => mergeReviewedEvent(mergeSnapshot(current, result.snapshot), result.event));
    } catch (reason: unknown) {
      if (generation !== scopeRequestGeneration.current) return;
      if (reason instanceof ApiRequestError && reason.status === 409) {
        if (reason.event !== null) {
          setSnapshot((current) => current === null ? current : mergeReviewedEvent(current, reason.event!));
          setConflictingReview(reason.event.review);
        }
        try {
          const latest = await getSnapshot(scope);
          if (generation === scopeRequestGeneration.current) setSnapshot((current) => mergeSnapshot(current, latest));
        } catch {
          // Keep the user's draft intact; the original conflict remains visible below.
        }
        setError("This review changed elsewhere. Your draft is preserved. Compare it with the updated saved note, then save again only if you intend to replace that version.");
      } else {
        setError(reason instanceof Error ? reason.message : "The review could not be saved.");
      }
    } finally {
      if (generation === scopeRequestGeneration.current) setBusy(null);
    }
  }

  async function toggleWatchlist(): Promise<void> {
    if (selectedEvent === null || selectedEvent.subject.kind !== "issuer") return;
    const generation = scopeRequestGeneration.current;
    setBusy("watchlist");
    setError(null);
    try {
      const issuer = selectedEvent.subject;
      const next = await updateWatchlist(watchedCiks.has(issuer.cik.value) ? "remove" : "add", issuer, scope);
      if (generation === scopeRequestGeneration.current) setSnapshot((current) => mergeSnapshot(current, next));
    } catch (reason: unknown) {
      if (generation === scopeRequestGeneration.current) setError(reason instanceof Error ? reason.message : "The watchlist could not be updated.");
    } finally {
      if (generation === scopeRequestGeneration.current) setBusy(null);
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
    const generation = scopeRequestGeneration.current;
    setBusy("add");
    setError(null);
    try {
      const next = await updateWatchlist("add", parsed.data, scope);
      if (generation !== scopeRequestGeneration.current) return;
      setSnapshot((current) => mergeSnapshot(current, next));
      setIssuerQuery("");
      setIssuerChoice(null);
      if (scope === "watchlist") void runRefresh("watchlist");
    } catch (reason: unknown) {
      if (generation === scopeRequestGeneration.current) setError(reason instanceof Error ? reason.message : "The issuer could not be added.");
    } finally {
      if (generation === scopeRequestGeneration.current) setBusy(null);
    }
  }

  async function removeIssuer(issuer: Issuer): Promise<void> {
    const generation = scopeRequestGeneration.current;
    setBusy("watchlist");
    setError(null);
    try {
      const next = await updateWatchlist("remove", issuer, scope);
      if (generation === scopeRequestGeneration.current) setSnapshot((current) => mergeSnapshot(current, next));
    } catch (reason: unknown) {
      if (generation === scopeRequestGeneration.current) setError(reason instanceof Error ? reason.message : "The issuer could not be removed from your watchlist.");
    } finally {
      if (generation === scopeRequestGeneration.current) setBusy(null);
    }
  }

  function chooseScope(next: ScanSource): void {
    const generation = ++scopeRequestGeneration.current;
    setScope(next);
    setError(null);
    void runRefresh(next, generation);
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
        <p className="dateline">{snapshot.eventsTotal.toLocaleString()} records in scope · auto-refreshes every 3 minutes</p>
      </header>

      

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

      

      

      <main className="newsroom">
        <section className="wire-section" aria-label="Investor filing wire">
          <div className="section-heading"><div><span className="vendor">A / {scope === "federal" ? "FEDERAL REGISTER" : scope === "watchlist" ? "SEC WATCHLIST FILINGS" : scope === "all_public" ? "SEC EDGAR · PUBLIC ISSUERS" : "SEC EDGAR + FEDERAL REGISTER"}</span><h2>The wire <span>{filteredEvents.length} loaded · {snapshot.eventsTotal} in scope</span></h2></div><div className="wire-toolbar"><div className="scope-tabs" role="tablist" aria-label="Source scope">{SOURCE_OPTIONS.map((option) => <button key={option.value} className={scope === option.value ? "selected" : ""} onClick={() => chooseScope(option.value)} role="tab" aria-selected={scope === option.value}>{option.label}</button>)}</div><div className="queue-tabs" role="tablist" aria-label="Record queue views">{(["wire", "read_now", "monitor", "reviewed"] as const).map((item) => <button key={item} className={view === item ? "selected" : ""} onClick={() => setView(item)} role="tab" aria-selected={view === item}>{item === "wire" ? "All" : item.replace("_", " ")}</button>)}</div><div className="queue-tabs category-tabs" role="tablist" aria-label="Category desks">{(["all", "operations", "capital_allocation", "governance_legal", "risk_disclosure", "routine_disclosure"] as const).map((item) => <button key={item} className={categoryFilter === item ? "selected" : ""} onClick={() => setCategoryFilter(item)} role="tab" aria-selected={categoryFilter === item}>{item === "all" ? "All desks" : categoryLabel(item)}</button>)}</div></div></div>
          <div className="wire-grid">{filteredEvents.slice(0, showAllWire ? undefined : 120).map((event) => <WireCard key={event.id} event={event} selected={selectedEvent?.id === event.id} onSelect={() => setSelectedId(event.id)} />)}{filteredEvents.length === 0 && <EmptyWire scope={scope} hasOlder={snapshot.eventsCursor !== null} />}{filteredEvents.length > 120 && <button className="wire-tile wire-more" type="button" onClick={() => setShowAllWire(true)}>Show all {filteredEvents.length.toLocaleString()} loaded records</button>}{(snapshot.eventsCursor !== null || paginationStale) && <div className="wire-foot">{paginationStale
            ? <button className="wire-expand" type="button" onClick={() => void reloadRecordList()} disabled={pageBusy}>Reload the records list</button>
            : <button className="wire-expand" type="button" onClick={() => void loadOlderRecords()} disabled={pageBusy}>{pageBusy ? "Loading older records…" : `Load older records · ${Math.max(0, snapshot.eventsTotal - scopedEvents.length).toLocaleString()} remain`}</button>}</div>}</div>
                    {snapshot.eventsCursor !== null && (paginationStale
            ? <button className="wire-expand" type="button" onClick={() => void reloadRecordList()} disabled={pageBusy}>Reload the records list</button>
            : <button className="wire-expand" type="button" onClick={() => void loadOlderRecords()} disabled={pageBusy}>{pageBusy ? "Loading older records…" : `Load older records · ${Math.max(0, snapshot.eventsTotal - scopedEvents.length).toLocaleString()} remain`}</button>)}
        </section>

        

        

      <aside className="detail-sidebar" aria-label="Record detail and watchlist"><section className="detail-section" aria-label="Selected filing detail"><DeskDetail event={selectedEvent} snapshot={snapshot} note={note} conflictingReview={conflictingReview} setNote={editNote} watched={selectedIssuer !== null && watchedCiks.has(selectedIssuer.cik.value)} onWatchlist={() => void toggleWatchlist()} onReview={(nextStatus) => void saveReview(nextStatus)} onSelect={setSelectedId} busy={busy !== null} /></section><section className="sidebar-watchlist" aria-label="Personal watchlist">
        <div className="watchbar-copy"><span className="section-label">Personal watchlist</span><strong>{snapshot.watchlist.length === 0 ? "No issuers on your list" : `${snapshot.watchlist.length} issuer${snapshot.watchlist.length === 1 ? "" : "s"} on your list`}</strong><span>Search by company or ticker; the SEC identity is resolved and stored automatically.</span></div>
        <WatchlistEntries entries={snapshot.watchlist} busy={busy !== null} onRemove={(issuer) => void removeIssuer(issuer)} />
        <div className="coverage-readout" aria-live="polite"><span className="section-label">Public-company universe · separate from your personal list</span><strong>{snapshot.publicIssuerCoverage === null ? "Awaiting live SEC issuer directory" : `${snapshot.publicIssuerCoverage.eligibleIssuers.toLocaleString()} SEC-listed issuers · ${snapshot.publicIssuerCoverage.activeCoverageIssuers.toLocaleString()} in the rolling scan`}</strong><span>{snapshot.publicIssuerCoverage === null ? "The official SEC exchange directory powers broad company search and a separate, rotating filing scan. Your personal watchlist stays curated." : `${snapshot.publicIssuerCoverage.issuersScanned} checked this pass · next position ${snapshot.publicIssuerCoverage.activeCoverageIssuers === 0 ? "—" : (snapshot.publicIssuerCoverage.offsetAfter % snapshot.publicIssuerCoverage.activeCoverageIssuers + 1).toLocaleString()} of ${snapshot.publicIssuerCoverage.activeCoverageIssuers.toLocaleString()} · ${snapshot.publicIssuerCoverage.recentFilingsFound} recent filings found · ${snapshot.publicIssuerCoverage.recordsScreened} sent through TypeSafe AI · ${snapshot.publicIssuerCoverage.recordsPlaced} records placed · directory retrieved ${shortTime(snapshot.publicIssuerCoverage.retrievedAt)}. The scan is bounded and resumes at its stored cursor; it does not mean every issuer was checked in this pass.`}</span></div>
        <form className="watchlist-form" onSubmit={(event) => void addIssuer(event)}><div className="watchlist-fields"><div className="issuer-picker"><input aria-label="Search public company" role="combobox" aria-expanded={issuerMatches.length > 0} placeholder="Search company or ticker" value={issuerQuery} onChange={(event) => { setIssuerQuery(event.target.value); setIssuerChoice(null); }} />{issuerMatches.length > 0 && <div className="issuer-dropdown" role="listbox">{issuerMatches.map((match) => <button key={match.cik} type="button" role="option" onClick={() => { setIssuerChoice(match); setIssuerQuery(`${match.name} · ${match.ticker}`); setIssuerMatches([]); }}><strong>{match.name}</strong><span>{match.ticker} · {match.exchange}</span></button>)}</div>}{issuerChoice !== null && <small className="issuer-resolved">SEC identity resolved · {issuerChoice.exchange}</small>}</div><button className="btn small" type="submit" disabled={busy !== null || issuerChoice === null}>Add issuer</button></div></form>
      </section></aside>
      </main>

      <footer className="colophon">Source health: SEC {secHealth?.freshness ?? "unavailable"} · Federal Register {federalHealth?.freshness ?? "unavailable"} · TypeSafe AI {typesafeHealth?.freshness ?? "unavailable"} · Finnhub company news {companyNewsHealth?.freshness ?? "not enabled"}. {companyNewsHealth?.message ?? "Finnhub is disabled pending written approval for third-party TypeSafe processing."} Screening is research priority, not a valuation, return forecast, or trade instruction.</footer>
    </div>
  );
}


function WireCard({ event, selected, onSelect }: { event: Event; selected: boolean; onSelect: () => void }): ReactElement {
  const route = event.screening.decision === "review" ? "review" : event.screening.decision === "watch" ? "monitor" : "passed";
  return (
    <button className={`wire-tile ${selected ? "selected" : ""}`} onClick={onSelect} aria-pressed={selected}>
      <span className="tile-top"><i className={`tile-route ${route}`}>{route}</i><span className="tile-cat">{categoryLabel(event.screening.category)}</span><b className="tile-score">{event.screening.attentionScore}</b></span>
      <h4>{event.title}</h4>
      <span className="tile-meta"><b>{subjectCode(event.subject)}</b><span>{event.form}</span><time>{relativeTime(event.availableAt)}</time>{event.screening.level === "coarse" && <em>first pass</em>}</span>
    </button>
  );
}


function EmptyWire({ scope, hasOlder }: { scope: ScanSource; hasOlder: boolean }): ReactElement {
  return <div className="empty-wire"><span className="empty-glyph">∅</span><strong>{hasOlder ? "No matching records on this page" : scope === "watchlist" ? "Your watchlist wire is empty" : "No live records placed"}</strong><p>{hasOlder ? "Load older records to continue searching this queue; matching counts apply to records loaded so far." : "Refresh requires the configured official source and TypeSafe AI credentials. The desk never fills this space with demo data."}</p></div>;
}

function DeskDetail({ event, snapshot, note, conflictingReview, setNote, watched, onWatchlist, onReview, onSelect, busy }: { event: Event | null; snapshot: AppSnapshot; note: string; conflictingReview: Event["review"] | null; setNote: (value: string) => void; watched: boolean; onWatchlist: () => void; onReview: (status: ReviewStatus) => void; onSelect: (id: string) => void; busy: boolean }): ReactElement {
  if (event === null) return <div className="detail-empty"><span className="empty-glyph">↳</span><h2>Select a record</h2><p>Choose a record from the wire to inspect its source trail and leave a human review note.</p></div>;
  const related = snapshot.events.filter((candidate) => candidate.subject.kind === event.subject.kind && candidate.subject.name === event.subject.name && candidate.id !== event.id).slice(0, 3);
  const canWatch = event.subject.kind === "issuer";
  const drivers: Array<{ label: string; value: number }> = [
    { label: "materiality", value: event.screening.materiality },
    { label: "novelty", value: event.screening.novelty },
    { label: "market sensitivity", value: event.screening.marketSensitivity },
    { label: "thesis match", value: event.screening.thesisMatch },
  ].sort((left, right) => right.value - left.value).slice(0, 2);
  const whySurfaced = `Strongest signals: ${drivers.map((driver) => `${driver.value >= 75 ? "high" : driver.value >= 50 ? "elevated" : "low"} ${driver.label}`).join(", ")}.`;
  const clarityNote = event.screening.level === "coarse"
    ? "First pass — judged on filing metadata only. Open the source for the full document."
    : event.screening.evidenceComplete ? "" : "The captured document text was cut short; the full filing contains more.";
  return <div className="desk-detail"><div className="detail-kicker"><span>{subjectCode(event.subject)}</span><span>{event.form}</span><span>{categoryLabel(event.screening.category)}</span>{canWatch && <button className={watched ? "watch-link active" : "watch-link"} onClick={onWatchlist}>{watched ? "on watchlist" : "track issuer"}</button>}</div><h2>{event.title}</h2><div className="detail-dates"><span><b>{event.kind === "news" ? "published" : "filed"}</b>{shortDate(event.publishedAt)} · {shortTime(event.availableAt)}</span></div>{event.marketContext && <p className="market-check"><b>Market check</b> shares {event.marketContext.changePercent > 0 ? "+" : ""}{event.marketContext.changePercent.toFixed(1)}% from the {shortDate(event.marketContext.baselineDate)} close to the {shortDate(event.marketContext.latestDate)} close · Yahoo Finance</p>}<div className="attention-strip"><div><span className="section-label">Attention score</span><strong>{event.screening.attentionScore}<small>/100</small></strong></div><p>{whySurfaced}</p><span className="lane-stamp">{laneLabel(event)}</span></div>{clarityNote && <p className="screening-limitations" aria-label="Screening limitations">{clarityNote}</p>}<section className="detail-block"><div className="block-heading"><h3>Why this surfaced</h3><span>{event.screening.modelConfidence}% confidence</span></div><div className="driver-grid"><Driver label="Materiality" value={event.screening.materiality} /><Driver label="Novelty" value={event.screening.novelty} /><Driver label="Market sensitivity" value={event.screening.marketSensitivity} /><Driver label="Thesis link" value={event.screening.thesisMatch} /></div></section><section className="detail-block source"><div className="block-heading"><h3>Primary source</h3></div><a className="source-link" href={event.source.url} target="_blank" rel="noreferrer"><span>{event.evidence[0].label}</span><b>Open source ↗</b></a></section>{related.length > 0 && <section className="detail-block related"><div className="block-heading"><h3>Same subject, nearby</h3><span>{related.length} records</span></div>{related.map((candidate) => <button key={candidate.id} onClick={() => onSelect(candidate.id)}><span>{candidate.title}</span><b>{candidate.screening.attentionScore}</b></button>)}</section>}<section className="review-block"><div className="block-heading"><h3>Human review</h3><span>{event.review.status}</span></div><textarea aria-label="Review note" value={note} onChange={(entry) => setNote(entry.target.value)} placeholder="What does this change in your research question?" />{conflictingReview !== null && <p className="review-conflict">Saved elsewhere ({conflictingReview.status}): {conflictingReview.note || "No note"}. Your draft remains above.</p>}<div className="review-actions"><button className="btn ghost" disabled={busy} onClick={() => onReview("snoozed")}>Snooze</button><button className="btn ghost" disabled={busy} onClick={() => onReview("dismissed")}>Dismiss</button><button className="btn" disabled={busy} onClick={() => onReview("reviewed")}>Save review</button></div></section></div>;
}

function Driver({ label, value }: { label: string; value: number }): ReactElement {
  return <div className="driver"><span>{label}</span><div><i style={{ width: `${value}%` }} /><b>{value}</b></div></div>;
}

export default App;
