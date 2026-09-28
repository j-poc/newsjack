package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	investorHTMLCommentPattern = regexp.MustCompile(`(?s)<!--.*?-->`)
	investorScriptPattern      = regexp.MustCompile(`(?is)<script[^>]*>.*?</script>|<style[^>]*>.*?</style>|<svg[^>]*>.*?</svg>|<noscript[^>]*>.*?</noscript>`)
	investorTagPattern         = regexp.MustCompile(`(?s)<[^>]+>`)
)

type investorSECScanOptions struct {
	WatchlistPath         string
	Auto                  bool
	MaxIssuers            int
	Source                string
	Since                 string
	RunDir                string
	OutputPath            string
	UserAgent             string
	MaxFilings            int
	MaxCompanyNewsItems   int
	MaxCompanyNewsSymbols int
	MaxChars              int
	Concurrency           int
	Timeout               time.Duration
	FinnhubSymbolOffset   int
	CacheDir              string
	StreamMaxRecords      int
	StreamMaxDeep         int
}

type investorSubmission struct {
	Issuer             investorIssuer
	Form               string
	Accession          string
	PrimaryDocument    string
	PrimaryDescription string
	FiledAt            investorTime
	AvailableAt        investorTime
	AcceptanceRaw      string
	ReportDate         string
	NativeID           string
}

type investorSECScanResult struct {
	Filings            []investorFiling
	Failures           []investorSourceFailure
	RawSubmissionPaths []string
	Observed           string
}

func loadInvestorWatchlist(path string) (investorWatchlist, map[string]any, error) {
	if strings.TrimSpace(path) == "" {
		return investorWatchlist{}, nil, errors.New("--watchlist is required")
	}
	data, err := os.ReadFile(expandPath(path))
	if err != nil {
		return investorWatchlist{}, nil, err
	}
	var watchlist investorWatchlist
	if err := json.Unmarshal(data, &watchlist); err != nil {
		return investorWatchlist{}, nil, fmt.Errorf("watchlist is not valid JSON: %w", err)
	}
	if err := watchlist.validate(); err != nil {
		return investorWatchlist{}, nil, err
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return investorWatchlist{}, nil, err
	}
	if raw["schema_version"] == nil {
		raw["schema_version"] = investorSchemaVersion
	}
	return watchlist, raw, nil
}

func parseInvestorSince(raw string) (investorTime, time.Time, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		now := time.Now().UTC()
		start := now.Add(-24 * time.Hour)
		return investorTime{Value: start.Format(time.RFC3339Nano), Precision: "second"}, start, nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return investorTime{}, time.Time{}, fmt.Errorf("--since must be RFC3339, got %q", value)
	}
	parsed = parsed.UTC()
	return investorTime{Value: parsed.Format(time.RFC3339Nano), Precision: "second"}, parsed, nil
}

func scanInvestorSEC(watchlist investorWatchlist, since time.Time, opts investorSECScanOptions) investorSECScanResult {
	now := time.Now().UTC()
	result := investorSECScanResult{Observed: now.Format(time.RFC3339Nano)}
	workers := maxInt(1, opts.Concurrency)
	results := make([][]investorFiling, len(watchlist.Issuers))
	failures := make([][]investorSourceFailure, len(watchlist.Issuers))
	var wg sync.WaitGroup
	next := make(chan int)
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range next {
				filings, errs, rawPath := scanInvestorIssuer(watchlist.Issuers[index], watchlist.Screen, since, now, opts)
				results[index] = filings
				failures[index] = errs
				if rawPath != "" {
					result.RawSubmissionPaths = append(result.RawSubmissionPaths, rawPath)
				}
			}
		}()
	}
	for index := range watchlist.Issuers {
		next <- index
	}
	close(next)
	wg.Wait()
	for index := range results {
		result.Filings = append(result.Filings, results[index]...)
		result.Failures = append(result.Failures, failures[index]...)
	}
	sort.Slice(result.Filings, func(i, j int) bool {
		left, right := result.Filings[i], result.Filings[j]
		if left.AvailableAt.Value != right.AvailableAt.Value {
			return left.AvailableAt.Value > right.AvailableAt.Value
		}
		return left.NativeID < right.NativeID
	})
	return result
}

func scanInvestorIssuer(issuer investorIssuer, screen investorScreenSettings, since, observed time.Time, opts investorSECScanOptions) ([]investorFiling, []investorSourceFailure, string) {
	submissionURL := investorSubmissionsURL(issuer.CIK)
	body, err := investorHTTPGet(submissionURL, opts.UserAgent, opts.Timeout)
	if err != nil {
		return nil, []investorSourceFailure{{Stage: "sec_submissions", Issuer: issuerDisplay(issuer), Error: cleanError(err.Error())}}, ""
	}
	submissionDigest := sha256Hex(body)
	rawPath, captureErr := writeInvestorRawSubmission(opts.RunDir, issuer.CIK, submissionDigest, body)
	if captureErr != nil {
		return nil, []investorSourceFailure{{Stage: "sec_capture", Issuer: issuerDisplay(issuer), Error: cleanError(captureErr.Error())}}, ""
	}
	parsed, err := parseInvestorSubmissions(body, issuer, submissionDigest, observed)
	if err != nil {
		return nil, []investorSourceFailure{{Stage: "sec_submissions", Issuer: issuerDisplay(issuer), Error: cleanError(err.Error())}}, rawPath
	}
	forms := stringSet(screen.IncludeForms)
	var eligible []investorSubmission
	for _, item := range parsed {
		if len(forms) > 0 && !forms[item.Form] {
			continue
		}
		available, err := time.Parse(time.RFC3339Nano, item.AvailableAt.Value)
		if err != nil || available.Before(since) {
			continue
		}
		if item.PrimaryDocument == "" {
			continue
		}
		eligible = append(eligible, item)
	}
	sort.Slice(eligible, func(i, j int) bool {
		if eligible[i].AvailableAt.Value != eligible[j].AvailableAt.Value {
			return eligible[i].AvailableAt.Value > eligible[j].AvailableAt.Value
		}
		return eligible[i].Accession > eligible[j].Accession
	})
	if len(eligible) > opts.MaxFilings {
		eligible = eligible[:opts.MaxFilings]
	}
	var filings []investorFiling
	var failures []investorSourceFailure
	for _, item := range eligible {
		docURL := investorDocumentURL(item.Issuer.CIK, item.Accession, item.PrimaryDocument)
		raw, fetchErr := investorHTTPGet(docURL, opts.UserAgent, opts.Timeout)
		if fetchErr != nil {
			failures = append(failures, investorSourceFailure{Stage: "sec_document", Issuer: issuerDisplay(issuer), Identity: item.NativeID, Error: cleanError(fetchErr.Error())})
			continue
		}
		text, complete, reason := normalizeInvestorDocument(raw, opts.MaxChars)
		if text == "" {
			failures = append(failures, investorSourceFailure{Stage: "sec_document", Issuer: issuerDisplay(issuer), Identity: item.NativeID, Error: "SEC document contained no readable text"})
			continue
		}
		filing := investorFiling{
			Issuer: item.Issuer, Form: item.Form, Accession: item.Accession,
			PrimaryDocument: item.PrimaryDocument, PrimaryDescription: item.PrimaryDescription,
			FiledAt: item.FiledAt, AvailableAt: item.AvailableAt, AcceptanceRaw: item.AcceptanceRaw,
			ReportDate: item.ReportDate, NativeID: item.NativeID, URL: docURL,
			SubmissionDigest: submissionDigest, DocumentDigest: sha256Hex(raw),
			NormalizedDigest: sha256Hex([]byte(text)), ObservedAt: observed.UTC().Format(time.RFC3339Nano),
			Text: text, TextComplete: complete, CompletenessReason: reason,
			RawBytes: len(body), DocumentBytes: len(raw),
			RawBody: raw, RawSubmissionPath: rawPath, SourceProvider: "sec",
		}
		filings = append(filings, filing)
	}
	return filings, failures, rawPath
}

func parseInvestorSubmissions(body []byte, issuer investorIssuer, digest string, observed time.Time) ([]investorSubmission, error) {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("SEC submissions JSON is malformed: %w", err)
	}
	filings := valueOrEmptyMap(payload["filings"])
	recent := valueOrEmptyMap(filings["recent"])
	accessions := toInvestorStringArray(recent["accessionNumber"])
	forms := toInvestorStringArray(recent["form"])
	filingDates := toInvestorStringArray(recent["filingDate"])
	acceptanceDates := toInvestorStringArray(recent["acceptanceDateTime"])
	primaryDocs := toInvestorStringArray(recent["primaryDocument"])
	primaryDescriptions := toInvestorStringArray(recent["primaryDocDescription"])
	reportDates := toInvestorStringArray(recent["reportDate"])
	if len(accessions) == 0 || len(forms) != len(accessions) || len(filingDates) != len(accessions) || len(primaryDocs) != len(accessions) {
		return nil, errors.New("SEC submissions recent arrays are missing or have inconsistent lengths")
	}
	items := make([]investorSubmission, 0, len(accessions))
	for index, accession := range accessions {
		filed, err := parseSECInvestorTime(filingDates[index], "day")
		if err != nil {
			return nil, fmt.Errorf("SEC filing %s has invalid filingDate: %w", accession, err)
		}
		acceptance := ""
		if index < len(acceptanceDates) {
			acceptance = strings.TrimSpace(acceptanceDates[index])
		}
		available := filed
		if acceptance != "" {
			if parsed, parseErr := parseSECInvestorTime(acceptance, "second"); parseErr == nil {
				available = parsed
			} else {
				return nil, fmt.Errorf("SEC filing %s has invalid acceptanceDateTime: %w", accession, parseErr)
			}
		}
		form := strings.ToUpper(strings.TrimSpace(forms[index]))
		primary := strings.TrimSpace(primaryDocs[index])
		items = append(items, investorSubmission{
			Issuer: issuer, Form: form, Accession: strings.TrimSpace(accession), PrimaryDocument: primary,
			PrimaryDescription: valueAtInvestor(primaryDescriptions, index), FiledAt: filed, AvailableAt: available,
			AcceptanceRaw: acceptance, ReportDate: valueAtInvestor(reportDates, index),
		})
		items[len(items)-1].NativeID = investorNativeID(issuer.CIK, accession, primary)
	}
	_ = digest
	_ = observed
	return items, nil
}

func parseSECInvestorTime(raw, fallbackPrecision string) (investorTime, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return investorTime{}, errors.New("empty time")
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return investorTime{Value: parsed.UTC().Format(time.RFC3339Nano), Precision: fallbackPrecision}, nil
	}
	for _, layout := range []string{"20060102150405", "20060102150405-0700", "20060102", "2006-01-02"} {
		if parsed, err := time.ParseInLocation(layout, value, time.UTC); err == nil {
			precision := fallbackPrecision
			if len(layout) <= len("20060102") {
				precision = "day"
			}
			return investorTime{Value: parsed.UTC().Format(time.RFC3339Nano), Precision: precision}, nil
		}
	}
	return investorTime{}, fmt.Errorf("unsupported SEC time %q", value)
}

func normalizeInvestorDocument(raw []byte, maxChars int) (string, bool, string) {
	value := string(raw)
	// Full submission files begin with envelope metadata — an <SEC-HEADER>
	// block (accession numbers, .hdr.sgml filenames, acceptance stamps) or
	// bare <ACCEPTANCE-DATETIME>/<ACCESSION-NUMBER> headers — before the
	// first <DOCUMENT>. Everything before the first document is envelope,
	// not content.
	if document := strings.Index(value, "<DOCUMENT>"); document >= 0 && document <= 8000 {
		value = value[document:]
	} else if header := strings.Index(value, "<SEC-HEADER"); header >= 0 {
		if end := strings.Index(value[header:], "</SEC-HEADER>"); end >= 0 {
			value = value[header+end+len("</SEC-HEADER>"):]
		}
	}
	value = investorHTMLCommentPattern.ReplaceAllString(value, " ")
	value = investorScriptPattern.ReplaceAllString(value, " ")
	value = investorTagPattern.ReplaceAllString(value, " ")
	value = html.UnescapeString(value)
	// Entities decode here: EDGAR encodes zero-width spaces and the private-use
	// checkbox glyphs (&#8203;, &#61514;) numerically, so the glyph strip must
	// run after unescaping or the characters re-enter the text.
	value = investorStripInvisibleGlyphs(value)
	value = strings.Join(strings.Fields(value), " ")
	if value == "" {
		return "", false, "empty_document"
	}
	if len(value) > maxChars {
		return strings.TrimSpace(value[:maxChars]), false, "character_cap"
	}
	return value, true, "primary_document_captured"
}

// investorRateLimitCooldown matches the SEC's published fair-access policy: a
// blocked client may resume once its request rate has stayed under the cap for
// roughly ten minutes, so retrying earlier only extends the block.
const investorRateLimitCooldown = 10 * time.Minute

const investorRateLimitStateFile = "rate-limit-state.json"

// investorSECFetchGate serializes every SEC fetch: a global request pace well
// inside the 10-requests-per-second fair-access cap, a persistent cross-run
// capture cache (filing documents are immutable; list endpoints have short
// TTLs), and a persisted cooldown that stops all SEC traffic after a 429 or a
// rate-limit 403 instead of hammering through the block.
type investorSECFetchGate struct {
	mu            sync.Mutex
	pacing        time.Duration
	lastRequest   time.Time
	cooldownUntil time.Time
	cacheDir      string
}

var investorSECFetch = &investorSECFetchGate{pacing: 300 * time.Millisecond}

// investorConfigureSECFetch wires the gate to the run's cache directory and
// request spacing. The cooldown state file makes the backoff survive the
// short-lived scan process, so the next refresh honors it too.
func investorConfigureSECFetch(cacheDir string, pacing time.Duration) {
	investorSECFetch.mu.Lock()
	defer investorSECFetch.mu.Unlock()
	investorSECFetch.cacheDir = cacheDir
	if pacing > 0 {
		investorSECFetch.pacing = pacing
	}
	investorSECFetch.cooldownUntil = investorReadRateLimitState(cacheDir, time.Now())
}

func (g *investorSECFetchGate) cacheLookup(rawURL string, now time.Time) ([]byte, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.cacheDir == "" {
		return nil, false
	}
	meta, ok := investorReadCacheMeta(g.cacheDir, rawURL)
	if !ok {
		return nil, false
	}
	if meta.TTLSeconds > 0 && now.Sub(meta.fetchedTime) > time.Duration(meta.TTLSeconds)*time.Second {
		return nil, false
	}
	body, err := os.ReadFile(filepath.Join(g.cacheDir, investorCacheKey(rawURL)+".body"))
	if err != nil {
		return nil, false
	}
	return body, true
}

func (g *investorSECFetchGate) cacheStore(rawURL string, body []byte, ttl time.Duration, now time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.cacheDir == "" || ttl < 0 {
		return
	}
	if err := os.MkdirAll(g.cacheDir, 0o755); err != nil {
		return
	}
	key := investorCacheKey(rawURL)
	meta, _ := json.Marshal(investorCacheMeta{
		URL:        rawURL,
		FetchedAt:  now.Format(time.RFC3339Nano),
		TTLSeconds: int64(ttlSeconds(ttl)),
	})
	investorAtomicWrite(filepath.Join(g.cacheDir, key+".meta"), meta)
	investorAtomicWrite(filepath.Join(g.cacheDir, key+".body"), body)
}

func ttlSeconds(ttl time.Duration) int64 {
	if ttl <= 0 {
		return 0
	}
	return int64(ttl / time.Second)
}

func investorAtomicWrite(path string, body []byte) {
	tmp := path + ".tmp"
	if os.WriteFile(tmp, body, 0o644) != nil {
		return
	}
	_ = os.Rename(tmp, path)
}

type investorCacheMeta struct {
	URL        string `json:"url"`
	FetchedAt  string `json:"fetched_at"`
	TTLSeconds int64  `json:"ttl_seconds"`

	fetchedTime time.Time
}

func investorReadCacheMeta(cacheDir, rawURL string) (investorCacheMeta, bool) {
	raw, err := os.ReadFile(filepath.Join(cacheDir, investorCacheKey(rawURL)+".meta"))
	if err != nil {
		return investorCacheMeta{}, false
	}
	var meta investorCacheMeta
	if json.Unmarshal(raw, &meta) != nil || meta.URL != rawURL {
		return investorCacheMeta{}, false
	}
	fetchedAt, err := time.Parse(time.RFC3339Nano, meta.FetchedAt)
	if err != nil {
		return investorCacheMeta{}, false
	}
	meta.fetchedTime = fetchedAt
	return meta, true
}

func investorCacheKey(rawURL string) string {
	return sha256Hex([]byte(rawURL))
}

func (g *investorSECFetchGate) pace(now time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.pacing > 0 {
		if earliest := g.lastRequest.Add(g.pacing); now.Before(earliest) {
			time.Sleep(earliest.Sub(now))
			now = earliest
		}
	}
	g.lastRequest = now
}

func (g *investorSECFetchGate) rateLimitActive(now time.Time) (time.Time, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.cooldownUntil, now.Before(g.cooldownUntil)
}

func (g *investorSECFetchGate) tripRateLimit(now time.Time) time.Time {
	g.mu.Lock()
	defer g.mu.Unlock()
	candidate := now.Add(investorRateLimitCooldown)
	if candidate.After(g.cooldownUntil) {
		g.cooldownUntil = candidate
		investorWriteRateLimitState(g.cacheDir, candidate)
	}
	return g.cooldownUntil
}

func investorReadRateLimitState(cacheDir string, now time.Time) time.Time {
	if cacheDir == "" {
		return time.Time{}
	}
	raw, err := os.ReadFile(filepath.Join(cacheDir, investorRateLimitStateFile))
	if err != nil {
		return time.Time{}
	}
	var state struct {
		CooldownUntil string `json:"cooldown_until"`
	}
	if json.Unmarshal(raw, &state) != nil {
		return time.Time{}
	}
	until, err := time.Parse(time.RFC3339, state.CooldownUntil)
	if err != nil || !until.After(now) {
		return time.Time{}
	}
	return until
}

func investorWriteRateLimitState(cacheDir string, until time.Time) {
	if cacheDir == "" {
		return
	}
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return
	}
	body, err := json.Marshal(map[string]string{"cooldown_until": until.Format(time.RFC3339)})
	if err != nil {
		return
	}
	investorAtomicWrite(filepath.Join(cacheDir, investorRateLimitStateFile), body)
}

// investorCacheTTLFor assigns a lifetime by URL class. Filing documents are
// immutable and cached forever; list endpoints change intraday and carry short
// TTLs; unknown classes are never cached.
func investorCacheTTLFor(rawURL string) time.Duration {
	if strings.Contains(rawURL, "/daily-index/") {
		return investorSecondsEnv("NEWSJACK_SEC_CACHE_TTL_SUBMISSIONS_SECONDS", 5*time.Minute)
	}
	if strings.Contains(rawURL, "company_tickers") {
		return investorSecondsEnv("NEWSJACK_SEC_CACHE_TTL_DIRECTORY_SECONDS", 24*time.Hour)
	}
	if strings.Contains(rawURL, "/submissions/") {
		return investorSecondsEnv("NEWSJACK_SEC_CACHE_TTL_SUBMISSIONS_SECONDS", 5*time.Minute)
	}
	if strings.Contains(rawURL, "/Archives/") {
		return 0
	}
	return -1
}

func investorSecondsEnv(name string, fallback time.Duration) time.Duration {
	raw := getenv(name, "")
	if raw == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed < 0 {
		return fallback
	}
	return time.Duration(parsed) * time.Second
}

// investorHTTPGet fetches an SEC resource politely: the persistent cache is
// checked first, the global pace is applied before every network request, and
// a 429 (or a rate-limit 403) trips the persisted cooldown so the rest of the
// run — and the next run — stop asking instead of extending the block.
func investorHTTPGet(rawURL, userAgent string, timeout time.Duration) ([]byte, error) {
	if body, ok := investorSECFetch.cacheLookup(rawURL, time.Now()); ok {
		return body, nil
	}
	if until, active := investorSECFetch.rateLimitActive(time.Now()); active {
		return nil, fmt.Errorf("SEC rate-limit cooldown active until %s; no request sent", until.Format(time.RFC3339))
	}
	investorSECFetch.pace(time.Now())
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json, text/html;q=0.9, */*;q=0.1")
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, int64(50*1024*1024)))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 429 || (resp.StatusCode == 403 && bytes.Contains(body, []byte("Request Rate Threshold Exceeded"))) {
		until := investorSECFetch.tripRateLimit(time.Now())
		return body, fmt.Errorf("HTTP %d (SEC rate limit; backing off until %s)", resp.StatusCode, until.Format(time.RFC3339))
	}
	if resp.StatusCode >= 400 {
		return body, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	investorSECFetch.cacheStore(rawURL, body, investorCacheTTLFor(rawURL), time.Now())
	return body, nil
}

func investorSubmissionsURL(cik string) string {
	base := strings.TrimRight(getenv("NEWSJACK_SEC_SUBMISSIONS_BASE_URL", investorSECSubmissionsURL), "/") + "/"
	return base + "CIK" + cik + ".json"
}

func investorDocumentURL(cik, accession, primary string) string {
	numericCIK := strings.TrimLeft(cik, "0")
	if numericCIK == "" {
		numericCIK = "0"
	}
	accessionPath := strings.ReplaceAll(accession, "-", "")
	base := strings.TrimRight(getenv("NEWSJACK_SEC_ARCHIVES_BASE_URL", investorSECArchivesURL), "/")
	return base + "/" + numericCIK + "/" + accessionPath + "/" + url.PathEscape(primary)
}

func investorNativeID(cik, accession, primary string) string {
	return cik + ":" + strings.TrimSpace(accession) + ":" + strings.TrimSpace(primary)
}

func investorEvidencePaths(runDir string, filing investorFiling) (string, string) {
	if strings.TrimSpace(runDir) == "" {
		return "", ""
	}
	digest := filing.DocumentDigest
	return filepath.Join(runDir, "evidence", digest+".html"), filepath.Join(runDir, "evidence", filing.NormalizedDigest+".txt")
}

func writeInvestorRawSubmission(runDir, cik, digest string, body []byte) (string, error) {
	if strings.TrimSpace(runDir) == "" {
		return "", errors.New("run directory is required for raw SEC capture")
	}
	path := filepath.Join(expandPath(runDir), "raw", "submissions", cik+"-"+digest+".json")
	if err := atomicWriteInvestorFile(path, body); err != nil {
		return "", err
	}
	return path, nil
}

func writeInvestorEvidence(runDir string, filing investorFiling) error {
	if strings.TrimSpace(runDir) == "" {
		return nil
	}
	dir := filepath.Join(expandPath(runDir), "evidence")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	htmlPath, textPath := investorEvidencePaths(expandPath(runDir), filing)
	if err := atomicWriteInvestorFile(htmlPath, filing.RawBody); err != nil {
		return err
	}
	if err := atomicWriteInvestorFile(textPath, []byte(filing.Text+"\n")); err != nil {
		return err
	}
	return nil
}

func toInvestorStringArray(v any) []string {
	var out []string
	for _, item := range anySlice(v) {
		out = append(out, stringValue(item))
	}
	return out
}

func valueAtInvestor(values []string, index int) string {
	if index < 0 || index >= len(values) {
		return ""
	}
	return values[index]
}

func issuerDisplay(issuer investorIssuer) string {
	if issuer.Ticker != "" {
		return issuer.Ticker
	}
	if issuer.Name != "" {
		return issuer.Name
	}
	return issuer.CIK
}

func parseInvestorJSONNumber(v any) (float64, bool) {
	if value, ok := numberValue(v); ok {
		if _, err := strconv.ParseFloat(fmt.Sprint(value), 64); err == nil {
			return value, true
		}
	}
	return 0, false
}
