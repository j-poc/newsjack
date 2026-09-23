package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	investorFinnhubCompanyNewsURL = "https://finnhub.io/api/v1/company-news"
	investorFinnhubSymbolsURL     = "https://finnhub.io/api/v1/stock/symbol"
	investorFinnhubRequestPacing  = 4 * time.Second
)

type finnhubNewsArticle struct {
	Category string `json:"category"`
	Datetime int64  `json:"datetime"`
	Headline string `json:"headline"`
	ID       int64  `json:"id"`
	Related  string `json:"related"`
	Source   string `json:"source"`
	Summary  string `json:"summary"`
	URL      string `json:"url"`
}

type finnhubSymbol struct {
	Description string `json:"description"`
	Display     string `json:"displaySymbol"`
	Exchange    string `json:"exchange"`
	MIC         string `json:"mic"`
	Symbol      string `json:"symbol"`
	Type        string `json:"type"`
}

type investorFinnhubScanResult struct {
	Filings           []investorFiling
	Failures          []investorSourceFailure
	Observed          string
	Coverage          map[string]any
	SymbolsScanned    int
	NextSymbolOffset  int
	HasDeferredRecord bool
	RawCaptures       []investorFinnhubRawCapture
	NewsBatchDigest   string
}

func scanInvestorFinnhub(since time.Time, watchlist investorWatchlist, opts investorSECScanOptions) investorFinnhubScanResult {
	if opts.Source == "watchlist" {
		return scanInvestorFinnhubBySymbol(since, watchlist, opts)
	}
	return scanInvestorFinnhubPublicUniverse(since, opts)
}

func scanInvestorFinnhubBySymbol(since time.Time, watchlist investorWatchlist, opts investorSECScanOptions) investorFinnhubScanResult {
	result := investorFinnhubScanResult{Observed: time.Now().UTC().Format(time.RFC3339Nano)}
	apiKey := strings.TrimSpace(getenv("FINNHUB_API_KEY", ""))
	if apiKey == "" {
		result.Failures = append(result.Failures, investorSourceFailure{Stage: "finnhub_news_auth", Error: "Finnhub API key not configured; set FINNHUB_API_KEY"})
		return result
	}
	symbols := investorFinnhubWatchlistSymbols(watchlist)
	companyNames := investorFinnhubWatchlistNames(watchlist)
	if len(symbols) == 0 {
		result.Failures = append(result.Failures, investorSourceFailure{Stage: "finnhub_symbols", Error: "the personal watchlist has no supported ticker symbols; add a company by name or ticker to receive company news"})
		return result
	}
	return scanInvestorFinnhubTickers(since, symbols, companyNames, apiKey, 0, len(symbols), opts)
}

func scanInvestorFinnhubPublicUniverse(since time.Time, opts investorSECScanOptions) investorFinnhubScanResult {
	result := investorFinnhubScanResult{Observed: time.Now().UTC().Format(time.RFC3339Nano), NextSymbolOffset: opts.FinnhubSymbolOffset}
	apiKey := strings.TrimSpace(getenv("FINNHUB_API_KEY", ""))
	if apiKey == "" {
		result.Failures = append(result.Failures, investorSourceFailure{Stage: "finnhub_news_auth", Error: "Finnhub API key not configured; set FINNHUB_API_KEY"})
		return result
	}
	symbols, companyNames, directoryPath, directoryDigest, err := fetchInvestorFinnhubSymbols(apiKey, opts)
	if err != nil {
		result.Failures = append(result.Failures, investorSourceFailure{Stage: "finnhub_symbols", Error: cleanError(err.Error()), RawPath: directoryPath, RawDigest: directoryDigest})
		return result
	}
	start := normalizeInvestorFinnhubOffset(opts.FinnhubSymbolOffset, len(symbols))
	batch, _ := investorFinnhubSymbolBatch(symbols, start, opts.MaxCompanyNewsSymbols)
	result = scanInvestorFinnhubTickers(since, batch, companyNames, apiKey, start, len(symbols), opts)
	articlesReceived := 0
	articlesLinked := map[string]bool{}
	symbolsLinked := map[string]bool{}
	for _, filing := range result.Filings {
		symbolsLinked[filing.SubjectCode] = true
		parts := strings.Split(filing.NativeID, ":")
		if len(parts) == 3 {
			articlesLinked[parts[2]] = true
		}
	}
	for _, capture := range result.RawCaptures {
		articlesReceived += capture.Articles
	}
	result.Coverage = map[string]any{
		"feed": "finnhub_company_news_by_symbol", "delivery_state": "network",
		"universe_provider": "finnhub_stock_symbols_us_nyse_nasdaq_common_stock",
		"eligible_symbols":  len(symbols), "symbols_scanned": result.SymbolsScanned,
		"symbol_offset_before": start, "symbol_offset_next": result.NextSymbolOffset,
		"articles_received": articlesReceived, "articles_linked_to_universe": len(articlesLinked),
		"symbols_linked": len(symbolsLinked), "records_screened": len(result.Filings),
		"has_deferred_records": result.HasDeferredRecord,
		"directory_digest":     directoryDigest, "directory_raw_path": directoryPath,
		"news_digest": result.NewsBatchDigest, "news_raw_captures": result.RawCaptures,
		"observed_at": result.Observed,
	}
	return result
}

type investorFinnhubRawCapture struct {
	Symbol   string `json:"symbol"`
	Digest   string `json:"digest"`
	RawPath  string `json:"raw_path"`
	Articles int    `json:"articles"`
	Failure  string `json:"failure,omitempty"`
}

func scanInvestorFinnhubTickers(since time.Time, symbols []string, companyNames map[string]string, apiKey string, startOffset, universeSize int, opts investorSECScanOptions) investorFinnhubScanResult {
	result := investorFinnhubScanResult{Observed: time.Now().UTC().Format(time.RFC3339Nano), NextSymbolOffset: startOffset}
	seen := map[string]bool{}
	var digestMaterial strings.Builder
	for index, symbol := range symbols {
		if len(result.Filings) >= maxInt(opts.MaxCompanyNewsItems, 1) {
			result.HasDeferredRecord = true
			break
		}
		if index > 0 {
			time.Sleep(investorFinnhubRequestPacing)
		}
		body, rawPath, err := fetchInvestorFinnhubNews(symbol, since, time.Now().UTC(), apiKey, opts)
		if err != nil {
			failure := investorSourceFailure{Stage: "finnhub_news_index", Identity: symbol, Error: cleanError(err.Error())}
			if len(body) > 0 && rawPath != "" {
				failure.RawPath = rawPath
				failure.RawDigest = sha256Hex(body)
				result.RawCaptures = append(result.RawCaptures, investorFinnhubRawCapture{Symbol: symbol, Digest: failure.RawDigest, RawPath: rawPath, Failure: failure.Error})
				digestMaterial.WriteString(symbol)
				digestMaterial.WriteByte(':')
				digestMaterial.WriteString(failure.RawDigest)
				digestMaterial.WriteByte('\n')
			}
			result.Failures = append(result.Failures, failure)
			result.SymbolsScanned++
			continue
		}
		var articles []finnhubNewsArticle
		if err := json.Unmarshal(body, &articles); err != nil {
			result.Failures = append(result.Failures, investorSourceFailure{Stage: "finnhub_news_parse", Identity: symbol, Error: cleanError(err.Error())})
			result.SymbolsScanned++
			continue
		}
		capture := investorFinnhubRawCapture{Symbol: symbol, Digest: sha256Hex(body), RawPath: rawPath, Articles: len(articles)}
		result.RawCaptures = append(result.RawCaptures, capture)
		digestMaterial.WriteString(symbol)
		digestMaterial.WriteByte(':')
		digestMaterial.WriteString(capture.Digest)
		digestMaterial.WriteByte('\n')
		result.SymbolsScanned++
		for _, article := range articles {
			filing, err := finnhubFilingFromArticle(article, body, rawPath, result.Observed, since, opts, symbol, companyNames[symbol])
			if err != nil {
				if err.Error() != "article is outside requested window" {
					result.Failures = append(result.Failures, investorSourceFailure{Stage: "finnhub_news_article", Identity: symbol, Error: cleanError(err.Error())})
				}
				continue
			}
			if seen[filing.NativeID] {
				continue
			}
			seen[filing.NativeID] = true
			result.Filings = append(result.Filings, filing)
			if len(result.Filings) >= maxInt(opts.MaxCompanyNewsItems, 1) {
				result.HasDeferredRecord = true
				break
			}
		}
		if result.HasDeferredRecord {
			break
		}
	}
	result.NextSymbolOffset = nextInvestorFinnhubSymbolOffset(startOffset, result.SymbolsScanned, universeSize)
	result.NewsBatchDigest = sha256Hex([]byte(digestMaterial.String()))
	sort.Slice(result.Filings, func(i, j int) bool {
		return result.Filings[i].AvailableAt.Value > result.Filings[j].AvailableAt.Value
	})
	return result
}

func investorFinnhubWatchlistSymbols(watchlist investorWatchlist) []string {
	seen := map[string]bool{}
	var symbols []string
	for _, issuer := range watchlist.Issuers {
		symbol := strings.ToUpper(strings.TrimSpace(issuer.Ticker))
		if symbol == "" || strings.HasPrefix(symbol, "CIK") || seen[symbol] {
			continue
		}
		seen[symbol] = true
		symbols = append(symbols, symbol)
	}
	sort.Strings(symbols)
	return symbols
}

func normalizeInvestorFinnhubOffset(offset, universeSize int) int {
	if universeSize <= 0 || offset < 0 {
		return 0
	}
	return offset % universeSize
}

func nextInvestorFinnhubSymbolOffset(startOffset, symbolsScanned, universeSize int) int {
	if universeSize <= 0 {
		return 0
	}
	start := normalizeInvestorFinnhubOffset(startOffset, universeSize)
	scanned := maxInt(symbolsScanned, 0) % universeSize
	return (start + scanned) % universeSize
}

func investorFinnhubSymbolBatch(symbols []string, offset, limit int) ([]string, int) {
	if len(symbols) == 0 || limit <= 0 {
		return []string{}, 0
	}
	start := normalizeInvestorFinnhubOffset(offset, len(symbols))
	count := minInt(limit, len(symbols))
	batch := make([]string, 0, count)
	for i := 0; i < count; i++ {
		batch = append(batch, symbols[(start+i)%len(symbols)])
	}
	return batch, (start + count) % len(symbols)
}

func investorFinnhubWatchlistNames(watchlist investorWatchlist) map[string]string {
	names := map[string]string{}
	for _, issuer := range watchlist.Issuers {
		symbol := strings.ToUpper(strings.TrimSpace(issuer.Ticker))
		name := strings.TrimSpace(issuer.Name)
		if symbol != "" && name != "" {
			names[symbol] = name
		}
	}
	return names
}

func fetchInvestorFinnhubSymbols(apiKey string, opts investorSECScanOptions) ([]string, map[string]string, string, string, error) {
	query := url.Values{"exchange": {"US"}, "token": {apiKey}}
	body, err := investorHTTPGet(investorFinnhubSymbolsURL+"?"+query.Encode(), "newsjack-investor-desk/1.0", opts.Timeout)
	if err != nil {
		if len(body) == 0 {
			return nil, nil, "", "", err
		}
		body = redactInvestorResponse(body, apiKey)
		rawPath, captureErr := captureInvestorFinnhubRaw(opts.RunDir, "finnhub-symbols-errors", "US", body)
		if captureErr != nil {
			return nil, nil, "", "", fmt.Errorf("%s; could not retain error response: %w", redactInvestorSecret(err.Error(), apiKey), captureErr)
		}
		return nil, nil, rawPath, sha256Hex(body), errors.New(redactInvestorSecret(err.Error(), apiKey))
	}
	rawPath, err := captureInvestorFinnhubRaw(opts.RunDir, "finnhub-symbols", "US", body)
	if err != nil {
		return nil, nil, "", "", fmt.Errorf("capture Finnhub symbol directory: %w", err)
	}
	symbols, names, err := parseInvestorFinnhubSymbols(body)
	if err != nil {
		return nil, nil, rawPath, sha256Hex(body), err
	}
	return symbols, names, rawPath, sha256Hex(body), nil
}

func parseInvestorFinnhubSymbols(body []byte) ([]string, map[string]string, error) {
	var raw []finnhubSymbol
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, nil, fmt.Errorf("Finnhub symbol directory JSON is malformed: %w", err)
	}
	var symbols []string
	seen := map[string]bool{}
	names := map[string]string{}
	for _, item := range raw {
		exchange := strings.ToUpper(strings.TrimSpace(item.Exchange + " " + item.MIC))
		if strings.EqualFold(strings.TrimSpace(item.Type), "Common Stock") && (strings.Contains(exchange, "NASDAQ") || strings.Contains(exchange, "NYSE") || strings.Contains(exchange, "XNAS") || strings.Contains(exchange, "XNYS")) && strings.TrimSpace(item.Symbol) != "" {
			symbol := strings.ToUpper(strings.TrimSpace(item.Symbol))
			if seen[symbol] {
				continue
			}
			seen[symbol] = true
			symbols = append(symbols, symbol)
			if strings.TrimSpace(item.Description) != "" {
				names[symbol] = strings.TrimSpace(item.Description)
			}
		}
	}
	sort.Slice(symbols, func(i, j int) bool {
		left, right := sha256Hex([]byte("newsjack-company-universe:"+symbols[i])), sha256Hex([]byte("newsjack-company-universe:"+symbols[j]))
		if left != right {
			return left < right
		}
		return symbols[i] < symbols[j]
	})
	if len(symbols) == 0 {
		return nil, nil, errors.New("Finnhub returned no supported US common-stock symbols")
	}
	return symbols, names, nil
}

func captureInvestorFinnhubRaw(runDir, directory, identity string, body []byte) (string, error) {
	if strings.TrimSpace(runDir) == "" {
		return "", errors.New("run directory is required for raw Finnhub capture")
	}
	digest := sha256Hex(body)
	fileName := strings.ReplaceAll(strings.ToUpper(identity), "/", "_") + "-" + digest + ".json"
	rawPath := filepath.Join(expandPath(runDir), "raw", directory, fileName)
	if err := atomicWriteInvestorFile(rawPath, body); err != nil {
		return "", err
	}
	return rawPath, nil
}

func redactInvestorSecret(value, secret string) string {
	if secret == "" {
		return value
	}
	return strings.ReplaceAll(value, secret, "[REDACTED]")
}

func redactInvestorResponse(body []byte, secret string) []byte {
	if secret == "" {
		return body
	}
	return []byte(redactInvestorSecret(string(body), secret))
}

func fetchInvestorFinnhubNews(symbol string, since, now time.Time, apiKey string, opts investorSECScanOptions) ([]byte, string, error) {
	query := url.Values{"symbol": {symbol}, "from": {since.UTC().Format("2006-01-02")}, "to": {now.UTC().Format("2006-01-02")}, "token": {apiKey}}
	body, err := investorHTTPGet(investorFinnhubCompanyNewsURL+"?"+query.Encode(), "newsjack-investor-desk/1.0", opts.Timeout)
	if err != nil {
		if len(body) == 0 {
			return nil, "", errors.New(redactInvestorSecret(err.Error(), apiKey))
		}
		body = redactInvestorResponse(body, apiKey)
		rawPath, captureErr := captureInvestorFinnhubRaw(opts.RunDir, "finnhub-news-errors", symbol, body)
		if captureErr != nil {
			return body, "", fmt.Errorf("%s; could not retain error response: %w", redactInvestorSecret(err.Error(), apiKey), captureErr)
		}
		return body, rawPath, errors.New(redactInvestorSecret(err.Error(), apiKey))
	}
	if strings.TrimSpace(opts.RunDir) == "" {
		return nil, "", errors.New("run directory is required for raw Finnhub capture")
	}
	rawPath := filepath.Join(expandPath(opts.RunDir), "raw", "finnhub-news", symbol+"-"+sha256Hex(body)+".json")
	if err := atomicWriteInvestorFile(rawPath, body); err != nil {
		return nil, "", fmt.Errorf("capture Finnhub response: %w", err)
	}
	return body, rawPath, nil
}

func finnhubFilingFromArticle(article finnhubNewsArticle, raw []byte, rawPath, observed string, since time.Time, opts investorSECScanOptions, symbol, companyName string) (investorFiling, error) {
	if article.Datetime <= 0 {
		return investorFiling{}, errors.New("article has no publication time")
	}
	date := time.Unix(article.Datetime, 0).UTC()
	if date.Before(since) {
		return investorFiling{}, errors.New("article is outside requested window")
	}
	link := strings.TrimSpace(article.URL)
	if link == "" {
		return investorFiling{}, errors.New("article has no source link")
	}
	headline := strings.TrimSpace(article.Headline)
	content := strings.TrimSpace(article.Summary)
	text := strings.TrimSpace(content)
	complete := false
	reason := "provider_summary_only"
	if text == "" {
		text = headline
		reason = "headline_only"
	}
	normalized, bounded, boundReason := normalizeInvestorDocument([]byte(text), opts.MaxChars)
	if normalized == "" {
		return investorFiling{}, errors.New("article has no readable text")
	}
	if !bounded {
		complete = false
		reason = boundReason
	}
	company := investorCompany{Symbol: strings.ToUpper(strings.TrimSpace(symbol)), Exchange: "US", Name: firstString(strings.TrimSpace(companyName), strings.ToUpper(strings.TrimSpace(symbol)))}
	nativeID := fmt.Sprintf("FINNHUB:%s:%d", company.Symbol, article.ID)
	value := investorTime{Value: date.Format(time.RFC3339Nano), Precision: "second"}
	observedTime, err := time.Parse(time.RFC3339Nano, observed)
	if err != nil {
		return investorFiling{}, fmt.Errorf("Finnhub observation time is invalid: %w", err)
	}
	availability := investorTime{Value: observedTime.UTC().Format(time.RFC3339Nano), Precision: "second"}
	return investorFiling{
		Company: &company, Form: "NEWS", Accession: nativeID, PrimaryDocument: link, PrimaryDescription: headline,
		FiledAt: value, AvailableAt: availability, ReportDate: date.Format(time.RFC3339), NativeID: nativeID, URL: link,
		SubmissionDigest: sha256Hex(raw), DocumentDigest: sha256Hex([]byte(content)), NormalizedDigest: sha256Hex([]byte(normalized)), ObservedAt: observed,
		Text: normalized, SummaryText: normalized, TextComplete: complete, CompletenessReason: reason, RawBytes: len(raw), DocumentBytes: len([]byte(content)), RawBody: []byte(content), RawSourcePath: rawPath,
		SourceProvider: "finnhub_news", SubjectKind: "company", SubjectCode: company.Symbol, SubjectName: company.Name,
	}, nil
}
