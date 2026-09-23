package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// discoverInvestorWatchlist is deliberately bounded. “All public companies” is
// a source scope, not permission to issue an unbounded crawl from a browser.
// The SEC daily index supplies the current issuer universe; submissions remain
// the authoritative per-issuer filing endpoint used by the normal scanner.
func discoverInvestorWatchlist(since time.Time, opts investorSECScanOptions) (investorWatchlist, map[string]any, error) {
	if opts.MaxIssuers <= 0 {
		return investorWatchlist{}, nil, errors.New("max issuers must be positive")
	}
	forms := map[string]bool{}
	for _, form := range defaultInvestorForms() {
		forms[form] = true
	}
	var discovered []investorIssuer
	seen := map[string]bool{}
	tickerDirectory, tickerDirectoryCapture, tickerDirectoryErr := fetchInvestorTickerDirectory(opts)
	captures := make([]investorDiscoveryCapture, 0, 8)
	if tickerDirectoryCapture != nil {
		captures = append(captures, *tickerDirectoryCapture)
	}
	dailyIndexFailures := make([]error, 0)
	start := since.UTC().Truncate(24 * time.Hour)
	end := time.Now().UTC().Truncate(24 * time.Hour)
	for day := start; !day.After(end) && len(discovered) < opts.MaxIssuers; day = day.Add(24 * time.Hour) {
		indexURL := investorDailyIndexURL(day)
		body, err := investorHTTPGet(indexURL, opts.UserAgent, opts.Timeout)
		capture, captureErr := captureInvestorDiscovery(opts, "daily-index-"+day.Format("20060102"), indexURL, ".idx", body)
		if captureErr != nil {
			return investorWatchlist{}, nil, fmt.Errorf("could not capture SEC daily index %s: %w", day.Format("2006-01-02"), captureErr)
		}
		if capture != nil {
			captures = append(captures, *capture)
		}
		if err != nil {
			dailyIndexFailures = append(dailyIndexFailures, err)
			continue
		}
		for _, issuer := range parseInvestorDailyIndexWithDirectory(body, forms, tickerDirectory) {
			if seen[issuer.CIK] {
				continue
			}
			seen[issuer.CIK] = true
			discovered = append(discovered, issuer)
			if len(discovered) == opts.MaxIssuers {
				break
			}
		}
	}
	if len(discovered) == 0 && len(tickerDirectory) > 0 {
		// SEC's daily-index files are intermittently rate-limited independently
		// of the public issuer directory. Use the official directory as a
		// bounded issuer universe fallback; each issuer is still validated by
		// its live submissions endpoint before it becomes a record.
		fallback := make([]investorIssuer, 0, len(tickerDirectory))
		for _, issuer := range tickerDirectory {
			fallback = append(fallback, issuer)
		}
		sort.Slice(fallback, func(i, j int) bool { return fallback[i].Ticker < fallback[j].Ticker })
		for _, issuer := range fallback {
			if len(discovered) == opts.MaxIssuers {
				break
			}
			discovered = append(discovered, issuer)
		}
	}
	if len(discovered) == 0 {
		return investorWatchlist{}, nil, investorDiscoveryError(dailyIndexFailures, tickerDirectoryErr)
	}
	watchlist := investorWatchlist{
		SchemaVersion: investorSchemaVersion,
		Issuers:       discovered,
		Screen: investorScreenSettings{
			IncludeForms:  defaultInvestorForms(),
			ResearchFocus: []string{"material operating, financing, governance, or legal changes"},
		},
	}
	if err := watchlist.validate(); err != nil {
		return investorWatchlist{}, nil, err
	}
	raw := map[string]any{
		"schema_version": investorSchemaVersion,
		"scope":          "all_public",
		"discovery": map[string]any{
			"provider":      "sec_daily_index_or_issuer_directory",
			"url_template":  investorSECDailyIndexURL,
			"observed_at":   time.Now().UTC().Format(time.RFC3339Nano),
			"issuer_limit":  opts.MaxIssuers,
			"issuers_found": len(discovered),
			"raw_captures":  captures,
		},
		"issuers": discovered,
		"screen": map[string]any{
			"include_forms":  watchlist.Screen.IncludeForms,
			"research_focus": watchlist.Screen.ResearchFocus,
		},
	}
	if tickerDirectoryErr != nil {
		raw["discovery"].(map[string]any)["ticker_directory_warning"] = investorDiscoveryErrorText(tickerDirectoryErr)
	}
	if len(dailyIndexFailures) > 0 {
		raw["discovery"].(map[string]any)["daily_index_warning"] = summarizeInvestorDiscoveryErrors(dailyIndexFailures)
	}
	return watchlist, raw, nil
}

func defaultInvestorForms() []string {
	return []string{"8-K", "8-K/A", "10-Q", "10-Q/A", "10-K", "10-K/A"}
}

func investorDailyIndexURL(day time.Time) string {
	quarter := ((int(day.Month()) - 1) / 3) + 1
	return fmt.Sprintf("%s/%d/QTR%d/master.%s.idx", investorSECDailyIndexURL, day.Year(), quarter, day.Format("20060102"))
}

func parseInvestorDailyIndex(body []byte, forms map[string]bool) []investorIssuer {
	return parseInvestorDailyIndexWithDirectory(body, forms, nil)
}

func parseInvestorDailyIndexWithDirectory(body []byte, forms map[string]bool, directory map[string]investorIssuer) []investorIssuer {
	lines := strings.Split(strings.ReplaceAll(string(body), "\r\n", "\n"), "\n")
	var out []investorIssuer
	for _, line := range lines {
		parts := strings.Split(line, "|")
		if len(parts) < 5 || parts[0] == "CIK" || !investorCIKPattern.MatchString(strings.TrimSpace(parts[0])) {
			continue
		}
		form := strings.ToUpper(strings.TrimSpace(parts[2]))
		if !forms[form] {
			continue
		}
		cik := strings.TrimSpace(parts[0])
		name := strings.TrimSpace(parts[1])
		issuer := investorIssuer{CIK: cik, Ticker: "CIK" + cik[len(cik)-4:], Name: name}
		if mapped, ok := directory[cik]; ok {
			issuer.Ticker = mapped.Ticker
			issuer.Name = firstString(mapped.Name, name)
		}
		out = append(out, issuer)
	}
	return out
}

type investorDiscoveryCapture struct {
	Source     string `json:"source"`
	URL        string `json:"url"`
	Path       string `json:"path"`
	SHA256     string `json:"sha256"`
	ObservedAt string `json:"observed_at"`
}

func captureInvestorDiscovery(opts investorSECScanOptions, source, sourceURL, extension string, body []byte) (*investorDiscoveryCapture, error) {
	if len(body) == 0 {
		return nil, nil
	}
	if strings.TrimSpace(opts.RunDir) == "" {
		return nil, errors.New("run directory is required for raw SEC discovery capture")
	}
	digest := sha256Hex(body)
	path := filepath.Join(expandPath(opts.RunDir), "raw", "sec-discovery", source+"-"+digest+extension)
	if err := atomicWriteInvestorFile(path, body); err != nil {
		return nil, err
	}
	return &investorDiscoveryCapture{
		Source: source, URL: sourceURL, Path: path, SHA256: digest,
		ObservedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}

func fetchInvestorTickerDirectory(opts investorSECScanOptions) (map[string]investorIssuer, *investorDiscoveryCapture, error) {
	body, err := investorHTTPGet(investorSECTickerURL, opts.UserAgent, opts.Timeout)
	capture, captureErr := captureInvestorDiscovery(opts, "issuer-directory", investorSECTickerURL, ".json", body)
	if captureErr != nil {
		return nil, capture, captureErr
	}
	if err != nil {
		return nil, capture, err
	}
	var payload struct {
		Fields []string `json:"fields"`
		Data   [][]any  `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, capture, fmt.Errorf("SEC ticker directory JSON is malformed: %w", err)
	}
	indexes := map[string]int{}
	for index, field := range payload.Fields {
		indexes[field] = index
	}
	for _, field := range []string{"cik", "name", "ticker"} {
		if _, ok := indexes[field]; !ok {
			return nil, capture, fmt.Errorf("SEC ticker directory is missing %s", field)
		}
	}
	directory := make(map[string]investorIssuer, len(payload.Data))
	for _, row := range payload.Data {
		if len(row) <= indexes["ticker"] {
			continue
		}
		cikValue, ok := numberValue(row[indexes["cik"]])
		if !ok || cikValue < 1 {
			continue
		}
		cik := fmt.Sprintf("%010d", int64(cikValue))
		ticker := strings.ToUpper(strings.TrimSpace(stringValue(row[indexes["ticker"]])))
		if ticker == "" {
			continue
		}
		directory[cik] = investorIssuer{CIK: cik, Ticker: ticker, Name: strings.TrimSpace(stringValue(row[indexes["name"]]))}
	}
	return directory, capture, nil
}

func investorDiscoveryError(dailyIndexFailures []error, tickerDirectoryErr error) error {
	parts := []string{}
	if tickerDirectoryErr != nil {
		parts = append(parts, "issuer directory: "+investorDiscoveryErrorText(tickerDirectoryErr))
	}
	if len(dailyIndexFailures) > 0 {
		parts = append(parts, fmt.Sprintf("daily index failed on %d date(s): %s", len(dailyIndexFailures), summarizeInvestorDiscoveryErrors(dailyIndexFailures)))
	}
	if len(parts) == 0 {
		return errors.New("SEC returned no eligible public issuers in the requested filing window")
	}
	return fmt.Errorf("SEC could not discover a public issuer; %s", strings.Join(parts, "; "))
}

func summarizeInvestorDiscoveryErrors(failures []error) string {
	counts := make(map[string]int)
	for _, failure := range failures {
		counts[investorDiscoveryErrorText(failure)] += 1
	}
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf("%s × %d", key, counts[key]))
	}
	return strings.Join(parts, ", ")
}

func investorDiscoveryErrorText(err error) string {
	if err == nil {
		return "unknown source failure"
	}
	message := cleanError(err.Error())
	if index := strings.Index(message, ":"); index >= 0 && strings.HasPrefix(message, "HTTP ") {
		message = message[:index]
	}
	if len(message) > 120 {
		message = message[:120]
	}
	return message
}
