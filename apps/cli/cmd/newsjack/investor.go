package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"
)

func cmdInvestor(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		printInvestorHelp(stdout)
		return 0
	}
	switch args[0] {
	case "scan":
		return cmdInvestorScan(args[1:], stdout, stderr)
	default:
		return failf(stderr, "unknown investor command: %s", args[0])
	}
}

func cmdInvestorScan(args []string, stdout, stderr io.Writer) int {
	var opts investorSECScanOptions
	var model string
	var concurrency int
	var timeout time.Duration
	var auto bool
	var maxIssuers int
	var maxCompanyNewsItems int
	var maxCompanyNewsSymbols int
	var finnhubSymbolOffset int
	var source string
	var secCacheDir string
	var secSpacingMS int
	fs := flag.NewFlagSet("investor scan", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&opts.WatchlistPath, "watchlist", "", "Explicit watchlist JSON with ten-digit CIK issuer identities")
	fs.BoolVar(&auto, "auto", false, "Discover current public issuers from the SEC daily index")
	fs.IntVar(&maxIssuers, "max-issuers", investorDefaultMaxIssuers, "Bound the active SEC public-issuer discovery fan-out")
	fs.IntVar(&maxCompanyNewsItems, "max-company-news-items", investorDefaultMaxCompanyNewsItems, "Bound TypeSafe-screened Finnhub company-news records per run")
	fs.IntVar(&maxCompanyNewsSymbols, "max-company-news-symbols", investorDefaultCompanyNewsSymbols, "Bound ticker-specific Finnhub requests per broad refresh")
	fs.IntVar(&finnhubSymbolOffset, "finnhub-symbol-offset", 0, "Finnhub public-universe rotation cursor")
	fs.StringVar(&source, "source", "watchlist", "Source scope: watchlist, all_public, company_news, federal, or all")
	fs.StringVar(&opts.Since, "since", "", "Earliest SEC availability to include (RFC3339; default: last 24 hours)")
	fs.StringVar(&opts.RunDir, "run-dir", "", "Persist audit.json and content-addressed evidence under this directory")
	fs.StringVar(&opts.OutputPath, "output", "", "Also write the complete audit JSON to this path")
	fs.StringVar(&opts.UserAgent, "user-agent", investorSECUserAgentFromEnv(), "Descriptive SEC User-Agent; required for live SEC requests")
	fs.StringVar(&secCacheDir, "sec-cache-dir", "", "Persistent cache for immutable SEC captures and the rate-limit cooldown state")
	fs.IntVar(&secSpacingMS, "sec-request-spacing-ms", 300, "Minimum spacing between SEC requests in milliseconds (SEC fair access: at most 10 requests per second)")
	fs.IntVar(&opts.StreamMaxRecords, "stream-max-records", 1500, "Maximum EDGAR index records coarse-screened per run; the rest are deferred to the next refresh")
	fs.IntVar(&opts.StreamMaxDeep, "stream-max-deep", 24, "Maximum surfaced records promoted to full-document screening per run")
	fs.IntVar(&opts.MaxFilings, "max-filings-per-issuer", investorDefaultMaxFilings, "Maximum eligible filings captured per issuer")
	fs.IntVar(&opts.MaxChars, "max-document-chars", investorDefaultDocumentSize, "Maximum normalized primary-document characters sent to TypeSafe AI")
	fs.IntVar(&concurrency, "concurrency", investorDefaultConcurrency, "Parallel source and TypeSafe AI calls")
	fs.DurationVar(&timeout, "timeout", investorDefaultTimeout, "Per-request HTTP timeout")
	fs.StringVar(&model, "model", investorDefaultModel, "TypeSafe AI model id")
	if err := fs.Parse(reorderIntermixedFlags(args, investorScanValueFlags())); err != nil {
		return 2
	}
	if fs.NArg() != 0 {
		return fail(stderr, errors.New("usage: newsjack investor scan --watchlist watchlist.json | --auto | --source federal [--since RFC3339]"))
	}
	if opts.MaxFilings <= 0 || opts.MaxChars <= 0 || concurrency <= 0 || timeout <= 0 || maxIssuers <= 0 || maxCompanyNewsItems <= 0 || maxCompanyNewsSymbols <= 0 || finnhubSymbolOffset < 0 {
		return fail(stderr, errors.New("max issuers, company-news items, company-news symbols, max filings, max document chars, concurrency, and timeout must be positive; Finnhub symbol offset cannot be negative"))
	}
	source = strings.ToLower(strings.TrimSpace(source))
	if auto {
		source = "all_public"
	}
	if !stringSet([]string{"watchlist", "all_public", "company_news", "federal", "all"})[source] {
		return failf(stderr, "unsupported --source %q; use watchlist, all_public, company_news, federal, or all", source)
	}
	finnhubProcessingApproved := strings.EqualFold(strings.TrimSpace(getenv("NEWSJACK_FINNHUB_PROCESSING_APPROVED", "")), "true")
	if source == "company_news" && !finnhubProcessingApproved {
		return fail(stderr, errors.New("Finnhub company news is disabled until written approval permits third-party TypeSafe processing; no Finnhub request was made"))
	}
	needsSEC := source == "watchlist" || source == "all_public" || source == "all"
	apiKey, _ := loadTypeSafeAPIKey()
	if apiKey == "" {
		return fail(stderr, errors.New("TypeSafe API key not configured; investor screening is fail-closed. Run: newsjack auth set-typesafe --key <key> or set TYPESAFE_API_KEY"))
	}
	if source == "watchlist" && strings.TrimSpace(opts.WatchlistPath) == "" {
		return fail(stderr, errors.New("--watchlist is required for --source watchlist"))
	}
	since, sinceTime, err := parseInvestorSince(opts.Since)
	if err != nil {
		return fail(stderr, err)
	}
	opts.Concurrency, opts.Timeout, opts.Auto, opts.MaxIssuers, opts.Source = concurrency, timeout, auto, maxIssuers, source
	opts.MaxCompanyNewsItems, opts.MaxCompanyNewsSymbols, opts.FinnhubSymbolOffset = maxCompanyNewsItems, maxCompanyNewsSymbols, finnhubSymbolOffset
	if secSpacingMS < 0 {
		return fail(stderr, errors.New("--sec-request-spacing-ms cannot be negative"))
	}
	if opts.StreamMaxRecords < 0 || opts.StreamMaxDeep < 0 {
		return fail(stderr, errors.New("--stream-max-records and --stream-max-deep cannot be negative"))
	}
	opts.CacheDir = secCacheDir
	investorConfigureSECFetch(secCacheDir, time.Duration(secSpacingMS)*time.Millisecond)
	if strings.TrimSpace(opts.RunDir) == "" {
		opts.RunDir = fmt.Sprintf("runs/investor-%s", scanTimestamp())
	}
	var watchlist investorWatchlist
	var rawWatchlist map[string]any
	var discoveryFailure string
	if source == "watchlist" {
		watchlist, rawWatchlist, err = loadInvestorWatchlist(opts.WatchlistPath)
		if err != nil {
			return fail(stderr, err)
		}
	} else if source == "all_public" || source == "all" {
		watchlist, rawWatchlist, err = discoverInvestorWatchlist(sinceTime, opts)
		if err != nil {
			// Preserve the SEC discovery failure in the audit without discarding
			// any records from another explicitly requested scope.
			discoveryFailure = cleanError(err.Error())
			watchlist = investorWatchlist{SchemaVersion: investorSchemaVersion, Screen: investorScreenSettings{IncludeForms: defaultInvestorForms(), ResearchFocus: []string{"material public-company operating, financing, governance, or legal changes"}}}
			rawWatchlist = map[string]any{"schema_version": investorSchemaVersion, "scope": source, "issuers": []investorIssuer{}, "screen": map[string]any{"include_forms": defaultInvestorForms(), "research_focus": watchlist.Screen.ResearchFocus}}
		}
	} else if source == "company_news" {
		watchlist = investorWatchlist{SchemaVersion: investorSchemaVersion, Screen: investorScreenSettings{ResearchFocus: []string{"material public-company operating, financing, governance, or legal changes"}}}
		rawWatchlist = map[string]any{"schema_version": investorSchemaVersion, "scope": "company_news", "issuers": []investorIssuer{}, "screen": map[string]any{"research_focus": watchlist.Screen.ResearchFocus}}
	} else {
		watchlist = investorFederalWatchlist()
		rawWatchlist = map[string]any{"schema_version": investorSchemaVersion, "scope": "federal", "issuers": []investorIssuer{}, "screen": map[string]any{"research_focus": []string{"material public-policy, regulatory, or economic changes"}}}
	}
	var scan investorSECScanResult
	var finnhubCoverage map[string]any
	if needsSEC && opts.UserAgent == "" {
		scan.Failures = append(scan.Failures, investorSourceFailure{Stage: "sec_auth", Error: "SEC User-Agent is missing; SEC records were skipped. Pass --user-agent or set NEWSJACK_SEC_USER_AGENT with a contactable identifier."})
	}
	if discoveryFailure != "" {
		scan.Failures = append(scan.Failures, investorSourceFailure{Stage: "sec_discovery", Error: discoveryFailure})
	}
	var streamBatch *investorScreenBatch
	if source == "watchlist" {
		if opts.UserAgent != "" {
			secScan := scanInvestorSEC(watchlist, sinceTime, opts)
			scan.Filings = append(scan.Filings, secScan.Filings...)
			scan.Failures = append(scan.Failures, secScan.Failures...)
			scan.RawSubmissionPaths = append(scan.RawSubmissionPaths, secScan.RawSubmissionPaths...)
			scan.Observed = secScan.Observed
		}
	}
	if source == "all_public" || source == "all" {
		if opts.UserAgent != "" {
			batch, _, _ := scanInvestorStream(sinceTime, watchlist, opts, investorScreenOptions{Model: model, Concurrency: concurrency, Timeout: timeout, RunDir: opts.RunDir, MaxChars: opts.MaxChars})
			streamBatch = &batch
		}
	}
	if source == "federal" || source == "all" {
		federal := scanInvestorFederal(sinceTime, opts)
		scan.Filings = append(scan.Filings, federal.Filings...)
		scan.Failures = append(scan.Failures, federal.Failures...)
		if scan.Observed == "" {
			scan.Observed = federal.Observed
		}
	}
	if shouldQueryInvestorFinnhub(source, finnhubProcessingApproved) {
		companyNews := scanInvestorFinnhub(sinceTime, watchlist, opts)
		scan.Filings = append(scan.Filings, companyNews.Filings...)
		finnhubCoverage = companyNews.Coverage
		scan.Failures = append(scan.Failures, companyNews.Failures...)
		if scan.Observed == "" {
			scan.Observed = companyNews.Observed
		}
	}
	screen := screenInvestorFilings(scan.Filings, watchlist, investorScreenOptions{Model: model, Concurrency: concurrency, Timeout: timeout, RunDir: opts.RunDir, MaxChars: opts.MaxChars, KeepPassed: true})
	failures := append(scan.Failures, screen.Failures...)
	engine := screen.Engine
	if engine == nil {
		engine = map[string]any{"name": "typesafe_ai", "model_requested": model}
	}
	engine["failures"] = len(screen.Failures)
	finnhubNewsKept := 0
	for _, item := range screen.Items {
		if stringValue(valueOrEmptyMap(item["source"])["provider"]) == "finnhub_news" {
			finnhubNewsKept++
		}
	}
	provider := source
	if source == "all" {
		provider = "mixed"
	}
	sourceDetails := map[string]any{
		"provider": provider, "submissions_base_url": strings.TrimRight(getenv("NEWSJACK_SEC_SUBMISSIONS_BASE_URL", investorSECSubmissionsURL), "/") + "/", "archives_base_url": getenv("NEWSJACK_SEC_ARCHIVES_BASE_URL", investorSECArchivesURL),
		"user_agent_configured": opts.UserAgent != "", "observed_at": scan.Observed,
		"scope": source, "filings_considered": len(scan.Filings), "sec_filings": countInvestorProvider(scan.Filings, "sec"), "federal_register_filings": countInvestorProvider(scan.Filings, "federal_register"), "finnhub_news": finnhubNewsKept, "finnhub_news_candidates": countInvestorProvider(scan.Filings, "finnhub_news"), "finnhub_attribution_excluded": nonNilInvestorItems(screen.Filtered), "failures": len(scan.Failures),
	}
	if finnhubProcessingApproved {
		sourceDetails["finnhub_processing_state"] = "enabled_by_explicit_approval"
	} else {
		sourceDetails["finnhub_processing_state"] = "disabled_pending_written_approval"
	}
	if finnhubCoverage != nil {
		acceptedArticles := map[string]bool{}
		acceptedSymbols := map[string]bool{}
		for _, item := range screen.Items {
			if stringValue(valueOrEmptyMap(item["source"])["provider"]) != "finnhub_news" {
				continue
			}
			acceptedArticles[stringValue(item["native_id"])] = true
			acceptedSymbols[stringValue(item["subject_code"])] = true
		}
		finnhubCoverage["articles_linked_to_universe"] = len(acceptedArticles)
		finnhubCoverage["symbols_linked"] = len(acceptedSymbols)
		finnhubCoverage["records_excluded_as_unrelated"] = len(screen.Filtered)
		sourceDetails["finnhub_coverage"] = finnhubCoverage
	}
	items := nonNilInvestorItems(screen.Items)
	if streamBatch != nil {
		items = append(items, nonNilInvestorItems(streamBatch.Items)...)
		failures = append(failures, streamBatch.Failures...)
		for key, value := range streamBatch.Engine {
			if existing, ok := engine[key].(int); ok {
				if add, ok := value.(int); ok {
					engine[key] = existing + add
					continue
				}
			}
			if _, exists := engine[key]; !exists {
				engine[key] = value
			}
		}
		surfaced, passed := 0, 0
		for _, item := range streamBatch.Items {
			if screening, ok := item["screening"].(map[string]any); ok && stringValue(screening["lane"]) == "passed" {
				passed++
				continue
			}
			surfaced++
		}
		sourceDetails["sec_stream_considered"] = streamBatch.Engine["stream_rows_considered"]
		sourceDetails["sec_stream_new"] = streamBatch.Engine["stream_rows_new"]
		sourceDetails["sec_stream_surfaced"] = surfaced
		sourceDetails["sec_stream_passed"] = passed
		sourceDetails["sec_filings"] = len(streamBatch.Items)
	}
	audit := investorAudit{
		Version: investorSchemaVersion, GeneratedAt: scan.Observed, Since: since,
		Watchlist: rawWatchlist,
		Source:    sourceDetails,
		Engine:    engine, Items: items, Failures: nonNilInvestorFailures(failures),
	}
	if err := writeInvestorAudit(opts.RunDir, opts.OutputPath, audit); err != nil {
		return fail(stderr, err)
	}
	writeJSON(stdout, audit)
	if len(failures) > 0 {
		warn(stderr, "investor scan completed with %d disclosed failures; affected filings were not scored", len(failures))
		return 3
	}
	return 0
}

func shouldQueryInvestorFinnhub(source string, writtenProcessingApproval bool) bool {
	return writtenProcessingApproval && (source == "company_news" || source == "all")
}

func investorScanValueFlags() map[string]bool {
	return stringSet([]string{"watchlist", "max-issuers", "max-company-news-items", "max-company-news-symbols", "finnhub-symbol-offset", "source", "since", "run-dir", "output", "user-agent", "sec-cache-dir", "sec-request-spacing-ms", "stream-max-records", "stream-max-deep", "max-filings-per-issuer", "max-document-chars", "concurrency", "timeout", "model"})
}

func investorSECUserAgentFromEnv() string {
	return firstString(
		getenv("NEWSJACK_SEC_USER_AGENT", ""),
		getenv("SEC_USER_AGENT", ""),
		getenv("ALETHEIA_SEC_USER_AGENT", ""),
	)
}

func nonNilInvestorItems(items []map[string]any) []map[string]any {
	if items == nil {
		return []map[string]any{}
	}
	return items
}

func nonNilInvestorFailures(failures []investorSourceFailure) []investorSourceFailure {
	if failures == nil {
		return []investorSourceFailure{}
	}
	return failures
}

func printInvestorHelp(w io.Writer) {
	uiProduct(w, "investor", "primary-source public-company and federal monitoring with TypeSafe AI typed screening and deterministic review lanes.")
	fmt.Fprintln(w)
	uiSection(w, "usage")
	fmt.Fprintln(w, "  newsjack investor scan --watchlist watchlist.json | --auto | --source federal [--since RFC3339]")
	fmt.Fprintln(w)
	uiSection(w, "watchlist")
	uiKV(w, "identity", "CIK is the issuer key; ticker and name are display metadata")
	uiKV(w, "screen.include_forms", "default: 8-K, 8-K/A, 10-Q, 10-Q/A, 10-K, 10-K/A")
	uiKV(w, "screen.thesis_context", "optional analyst-written context; never inferred from filings")
	fmt.Fprintln(w)
	uiSection(w, "output")
	uiKV(w, "audit.json", "versioned source, evidence, raw TypeSafe typed answers, scores, lanes, and failures")
	uiKV(w, "lanes", "read_now, monitor, human_review, incomplete; code routes, human decides")
	uiKV(w, "evidence", "content-addressed normalized text under <run-dir>/evidence")
	uiKV(w, "partial runs", "exit 3 with affected filings disclosed and never silently scored")
	uiKV(w, "scope", "watchlist, all_public (up to 500 issuers), company_news (rotating broad universe), federal, or all")
	fmt.Fprintln(w)
	uiSection(w, "live requirements")
	uiKV(w, "SEC", "NEWSJACK_SEC_USER_AGENT or --user-agent with a descriptive contact")
	uiKV(w, "company news", "FINNHUB_API_KEY; ticker-specific requests rotate through the live US common-stock directory at a conservative pace; display rights are account-controlled")
	uiKV(w, "TypeSafe AI", "TYPESAFE_API_KEY or: newsjack auth set-typesafe --key <key>")
	uiKV(w, "base URL", envTypeSafeBaseURL+" overrides "+typesafeDefaultBaseURL)
	uiNote(w, "This workflow produces research priority, not a valuation, return forecast, trade instruction, or performance claim.")
}
