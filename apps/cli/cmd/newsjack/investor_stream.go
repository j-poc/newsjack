package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
)

// investorIndexRow is one line of the EDGAR daily master index:
// CIK|Company Name|Form|Date Filed|File Name. One index fetch exposes every
// filing of the day, which is what lets the wire carry the full stream instead
// of a bounded per-issuer sample.
// investorIndexCIKPattern accepts the unpadded CIKs the master index prints.
var investorIndexCIKPattern = regexp.MustCompile(`^[0-9]{1,10}$`)

type investorIndexRow struct {
	CIK       string
	Name      string
	Form      string
	Ticker    string
	DateFiled string
	Filename  string
	Accession string
	Document  string
}

// investorTickerFromDisplayNames harvests the listed ticker the full-text
// search feed prints inside its display name — "FIRST MERCHANTS CORP  (FRME,
// FRMEP)  (CIK 0000712534)" — so live stream records carry real tickers even
// before the directory enrichment lands.
func investorTickerFromDisplayNames(names []string) string {
	for _, candidate := range names {
		open := strings.Index(candidate, "(")
		if open < 0 {
			continue
		}
		close := strings.Index(candidate[open:], ")")
		if close < 0 {
			continue
		}
		inner := candidate[open+1 : open+close]
		if strings.HasPrefix(strings.ToUpper(inner), "CIK") {
			continue
		}
		for _, token := range strings.Split(inner, ",") {
			token = strings.TrimSpace(token)
			if token == "" || len(token) > 6 {
				continue
			}
			isTicker := true
			for _, r := range token {
				if !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9') && r != '.' {
					isTicker = false
					break
				}
			}
			if isTicker {
				return token
			}
		}
	}
	return ""
}

func parseInvestorDailyIndexRows(body []byte, forms map[string]bool) []investorIndexRow {
	var rows []investorIndexRow
	for _, line := range strings.Split(strings.ReplaceAll(string(body), "\r\n", "\n"), "\n") {
		parts := strings.Split(line, "|")
		if len(parts) < 5 {
			continue
		}
		rawCIK := strings.TrimSpace(parts[0])
		if !investorIndexCIKPattern.MatchString(rawCIK) {
			continue
		}
		form := strings.ToUpper(strings.TrimSpace(parts[2]))
		if !forms[form] {
			continue
		}
		// Master-index CIKs are unpadded ("1000275"); canonicalize to the
		// ten-digit form the rest of the pipeline identities on.
		cik := strings.Repeat("0", 10-len(rawCIK)) + rawCIK
		rows = append(rows, investorIndexRow{
			CIK:       cik,
			Name:      strings.TrimSpace(parts[1]),
			Form:      form,
			DateFiled: strings.TrimSpace(parts[3]),
			Filename:  strings.TrimSpace(parts[4]),
		})
	}
	return rows
}

// investorAccessionFromFilename converts an index filename such as
// "000110465926109821-adgm-20260923x8k.htm" into the dashed accession
// "0001104659-26-109821" and the primary document name.
func investorAccessionFromFilename(filename string) (accession, document string, ok bool) {
	if len(filename) < 19 || filename[18] != '-' {
		return "", "", false
	}
	digits := filename[:18]
	for _, r := range digits {
		if r < '0' || r > '9' {
			return "", "", false
		}
	}
	accession = digits[:10] + "-" + digits[10:12] + "-" + digits[12:18]
	return accession, filename[19:], true
}

// investorFilingFromIndexRow builds a metadata-only filing. The master index
// filename is a submission path such as
// "edgar/data/1000275/0000950103-26-014365.txt": the dashed accession is the
// final segment, and the linked .txt is the filing's raw submission document.
func investorFilingFromIndexRow(row investorIndexRow, directory map[string]investorIssuer, observed time.Time) (investorFiling, bool) {
	if row.CIK == "" || row.Name == "" {
		return investorFiling{}, false
	}
	accession, submission := row.Accession, row.Document
	if accession == "" {
		segments := strings.Split(row.Filename, "/")
		submission = segments[len(segments)-1]
		accession = strings.TrimSuffix(submission, ".txt")
	}
	if !investorDashedAccessionPattern.MatchString(accession) || submission == "" {
		return investorFiling{}, false
	}
	filedAt := row.DateFiled
	if parsed, err := time.Parse("20060102", row.DateFiled); err == nil {
		filedAt = parsed.Format("2006-01-02") + "T00:00:00.000Z"
	}
	url := investorSECArchivesURL + "/" + strings.TrimLeft(row.CIK, "0") + "/" + strings.ReplaceAll(accession, "-", "") + "/" + submission
	passage := fmt.Sprintf(
		"Form %s filed %s by %s (CIK %s). This record was screened from EDGAR index metadata only; the primary document has not been captured yet.",
		row.Form, row.DateFiled, row.Name, row.CIK,
	)
	filing := investorFiling{
		Issuer:             investorIssuer{CIK: row.CIK, Ticker: firstString(row.Ticker, row.CIK), Name: row.Name},
		Form:               row.Form,
		Accession:          accession,
		PrimaryDocument:    submission,
		PrimaryDescription: "",
		FiledAt:            investorTime{Value: filedAt, Precision: "day"},
		AvailableAt:        investorTime{Value: observed.Format(time.RFC3339Nano), Precision: "second"},
		NativeID:           investorNativeID(row.CIK, accession, submission),
		ObservedAt:         observed.Format(time.RFC3339Nano),
		URL:                url,
		Text:               passage,
		SummaryText:        passage,
		TextComplete:       false,
		CompletenessReason: "index_metadata_only",
		DocumentDigest:     sha256Hex([]byte(passage)),
		NormalizedDigest:   sha256Hex([]byte(passage)),
		SourceProvider:     "sec",
		SubjectKind:        "issuer",
		SubjectCode:        firstString(row.Ticker, row.CIK),
		SubjectName:        row.Name,
	}
	if mapped, ok := directory[row.CIK]; ok && mapped.Ticker != "" {
		filing.Issuer.Ticker = mapped.Ticker
		filing.SubjectCode = mapped.Ticker
	}
	filing.Issuer.Name = firstString(filing.Issuer.Name, row.Name)
	filing.SubjectName = filing.Issuer.Name
	return filing, true
}

// investorFetchLiveIndex pulls the current trading day's filings from the
// EDGAR full-text search API. The master index for the in-progress day is not
// published until after close, so the live feed is the only same-day source.
func investorFetchLiveIndex(day time.Time, forms []string, opts investorSECScanOptions) ([]investorIndexRow, error) {
	formParam := url.QueryEscape(strings.Join(forms, ","))
	var rows []investorIndexRow
	seenAccessions := map[string]bool{}
	for from := 0; from < 3000; from += 100 {
		query := fmt.Sprintf("%s/LATEST/search-index?q=&forms=%s&dateRange=custom&startdt=%s&enddt=%s&from=%d", investorFTSBaseURL, formParam, day.Format("2006-01-02"), day.Format("2006-01-02"), from)
		body, err := investorHTTPGet(query, opts.UserAgent, opts.Timeout)
		if err != nil {
			return rows, err
		}
		var payload investorFTSResponse
		if err := json.Unmarshal(body, &payload); err != nil {
			return rows, err
		}
		for _, hit := range payload.Hits.Hits {
			if len(hit.Source.Ciks) == 0 {
				continue
			}
			form := strings.ToUpper(strings.TrimSpace(hit.Source.FileType))
			if _, wanted := investorWantedForms(form); !wanted {
				continue
			}
			accession, document, found := strings.Cut(hit.ID, ":")
			if !found || seenAccessions[accession] {
				continue
			}
			seenAccessions[accession] = true
			cik := hit.Source.Ciks[0]
			if len(cik) < 10 {
				cik = strings.Repeat("0", 10-len(cik)) + cik
			}
			name := ""
			for _, candidate := range hit.Source.DisplayNames {
				if strings.TrimSpace(candidate) != "" {
					name = strings.TrimSpace(candidate)
					break
				}
			}
			if index := strings.Index(name, "  ("); index > 0 {
				name = strings.TrimSpace(name[:index])
			}
			rows = append(rows, investorIndexRow{
				CIK: cik, Name: name, Form: form, Ticker: investorTickerFromDisplayNames(hit.Source.DisplayNames),
				DateFiled: strings.ReplaceAll(hit.Source.FileDate, "-", ""),
				Accession: accession, Document: document,
			})
		}
		if from+100 >= payload.Hits.Total.Value {
			break
		}
	}
	return rows, nil
}

func investorWantedForms(form string) (string, bool) {
	return form, investorStreamForms[form]
}

var investorStreamForms = map[string]bool{}

type investorFTSResponse struct {
	Hits struct {
		Total struct {
			Value int `json:"value"`
		} `json:"total"`
		Hits []struct {
			ID     string `json:"_id"`
			Source struct {
				Ciks         []string `json:"ciks"`
				DisplayNames []string `json:"display_names"`
				FileType     string   `json:"file_type"`
				FileDate     string   `json:"file_date"`
			} `json:"_source"`
		} `json:"hits"`
	} `json:"hits"`
}

// investorDashedAccessionPattern matches the dashed accession EDGAR prints in
// master-index submission paths.
var investorDashedAccessionPattern = regexp.MustCompile(`^\d{10}-\d{2}-\d{6}$`)

type investorPendingDeep struct {
	At          string  `json:"at"`
	Materiality float64 `json:"materiality"`
	Surfaced    bool    `json:"surfaced"`
	Attempts    int     `json:"attempts"`
	CIK         string  `json:"cik"`
	Name        string  `json:"name"`
	Ticker      string  `json:"ticker"`
	Form        string  `json:"form"`
	Accession   string  `json:"accession"`
	Document    string  `json:"document"`
	URL         string  `json:"url"`
	FiledAt     string  `json:"filed_at"`
}

type investorStreamState struct {
	Version        int                            `json:"version"`
	Coarse         map[string]string              `json:"coarse"`
	Deep           map[string]string              `json:"deep"`
	ContractDigest string                         `json:"contract_digest"`
	PendingDeep    map[string]investorPendingDeep `json:"pending_deep"`
}

func investorStreamStatePath(cacheDir string) string {
	return cacheDir + "/stream-state.json"
}

func investorLoadStreamState(cacheDir, contractDigest string) investorStreamState {
	state := investorStreamState{Version: 1, ContractDigest: contractDigest, Coarse: map[string]string{}, Deep: map[string]string{}, PendingDeep: map[string]investorPendingDeep{}}
	if cacheDir == "" {
		return state
	}
	raw, err := os.ReadFile(investorStreamStatePath(cacheDir))
	if err != nil {
		return state
	}
	var parsed investorStreamState
	if json.Unmarshal(raw, &parsed) != nil || parsed.Coarse == nil || parsed.Deep == nil || parsed.PendingDeep == nil {
		return state
	}
	// A screening-contract change invalidates every prior verdict: the whole
	// stream re-screens under the new contract instead of trusting stale marks.
	if parsed.ContractDigest != contractDigest {
		return state
	}
	parsed.Version = 1
	return parsed
}

func investorSaveStreamState(cacheDir string, state investorStreamState) {
	if cacheDir == "" {
		return
	}
	// Bound the state: a rolling day window is enough to keep refreshes
	// incremental without growing the file forever.
	cutoff := time.Now().UTC().AddDate(0, 0, -3).Format(time.RFC3339Nano)
	for id, at := range state.Coarse {
		if at < cutoff {
			delete(state.Coarse, id)
		}
	}
	for id, at := range state.Deep {
		if at < cutoff {
			delete(state.Deep, id)
		}
	}
	for id, entry := range state.PendingDeep {
		if entry.At < cutoff {
			delete(state.PendingDeep, id)
		}
	}
	body, err := json.Marshal(state)
	if err != nil {
		return
	}
	investorAtomicWrite(investorStreamStatePath(cacheDir), body)
}

// scanInvestorStream ingests every filing in the EDGAR daily index for the
// scan window, gives each new record a TypeSafe metadata verdict, and promotes
// the strongest surfaced records to full-document screening through the deep
// pass. Already-screened native IDs are skipped through the persisted stream
// state, so each refresh only pays for records that are actually new.
func scanInvestorStream(since time.Time, watchlist investorWatchlist, opts investorSECScanOptions, screen investorScreenOptions) (investorScreenBatch, map[string]any, investorStreamState) {
	observed := time.Now().UTC()
	engine := map[string]any{
		"stream_rows_considered": 0, "stream_rows_new": 0, "stream_deferred": 0,
		"stream_coarse_screened": 0, "stream_deep_screened": 0,
	}
	forms := map[string]bool{}
	for _, form := range watchlist.Screen.IncludeForms {
		forms[form] = true
	}
	investorStreamForms = forms
	formList := make([]string, 0, len(forms))
	for form := range forms {
		formList = append(formList, form)
	}
	sort.Strings(formList)
	directory, _, _ := fetchInvestorTickerDirectory(opts)

	state := investorLoadStreamState(opts.CacheDir, sha256Hex(investorQuestionsJSON))
	var rows []investorIndexRow
	var indexFailures []investorSourceFailure
	today := observed.Truncate(24 * time.Hour)
	liveRows, liveErr := investorFetchLiveIndex(today, formList, opts)
	if liveErr != nil {
		engine["stream_index_failures"] = intValue(engine["stream_index_failures"], 0) + 1
		indexFailures = append(indexFailures, investorSourceFailure{Stage: "sec_stream_index", Identity: today.Format("2006-01-02"), Error: cleanError(liveErr.Error())})
	}
	rows = append(rows, liveRows...)
	for day := since.UTC().Truncate(24 * time.Hour); day.Before(today); day = day.Add(24 * time.Hour) {
		body, err := investorHTTPGet(investorDailyIndexURL(day), opts.UserAgent, opts.Timeout)
		if err != nil {
			// The master index is served from www.sec.gov, whose edge blocks
			// more aggressively than the full-text API; fall back to the same
			// official feed for that day rather than losing it.
			fallback, fallbackErr := investorFetchLiveIndex(day, formList, opts)
			if fallbackErr != nil {
				engine["stream_index_failures"] = intValue(engine["stream_index_failures"], 0) + 1
				indexFailures = append(indexFailures, investorSourceFailure{Stage: "sec_stream_index", Identity: day.Format("2006-01-02"), Error: cleanError(err.Error())})
				continue
			}
			rows = append(rows, fallback...)
			continue
		}
		rows = append(rows, parseInvestorDailyIndexRows(body, forms)...)
	}

	var filings []investorFiling
	seen := map[string]bool{}
	for _, row := range rows {
		engine["stream_rows_considered"] = intValue(engine["stream_rows_considered"], 0) + 1
		filing, ok := investorFilingFromIndexRow(row, directory, observed)
		if !ok || seen[filing.NativeID] || seen["acc:"+filing.Accession] {
			continue
		}
		seen[filing.NativeID] = true
		seen["acc:"+filing.Accession] = true
		if _, coarse := state.Coarse[filing.NativeID]; coarse {
			continue
		}
		if len(filings) >= opts.StreamMaxRecords {
			engine["stream_deferred"] = intValue(engine["stream_deferred"], 0) + 1
			continue
		}
		filings = append(filings, filing)
		engine["stream_rows_new"] = intValue(engine["stream_rows_new"], 0) + 1
	}
	sort.Slice(filings, func(i, j int) bool { return filings[i].NativeID < filings[j].NativeID })

	batch := investorScreenBatch{Engine: engine, Failures: indexFailures}
	if len(filings) > 0 {
		screenOpts := screen
		screenOpts.KeepPassed = true
		batch = screenInvestorFilings(filings, watchlist, screenOpts)
		batch.Engine["stream_rows_considered"] = engine["stream_rows_considered"]
		batch.Engine["stream_rows_new"] = engine["stream_rows_new"]
		batch.Engine["stream_deferred"] = engine["stream_deferred"]
		batch.Failures = append(indexFailures, batch.Failures...)
	}

	// The deep queue: metadata screening alone cannot tell an actionable 8-K
	// from a routine one, so every coarse record that either passed the gate or
	// is an event-driven form waits here, and each refresh promotes the
	// highest-priority batch to full-document screening until it drains.
	filingsByID := make(map[string]investorFiling, len(filings))
	for _, filing := range filings {
		filingsByID[filing.NativeID] = filing
	}
	now := observed.Format(time.RFC3339Nano)
	for _, item := range batch.Items {
		nativeID := stringValue(item["native_id"])
		if nativeID == "" {
			continue
		}
		if stringValue(item["screening_level"]) == "coarse" {
			state.Coarse[nativeID] = now
		}
		screening, _ := item["screening"].(map[string]any)
		lane := stringValue(screening["lane"])
		if stringValue(item["screening_level"]) != "coarse" {
			continue
		}
		filing, known := filingsByID[nativeID]
		if !known {
			continue
		}
		materiality := 0.0
		if value, ok := screening["materiality"].(int); ok {
			materiality = float64(value)
		}
		if lane != "passed" || isEventDrivenForm(filing.Form) {
			if _, alreadyDeep := state.Deep[nativeID]; !alreadyDeep {
				state.PendingDeep[nativeID] = investorPendingDeep{
					At: now, Materiality: materiality, Surfaced: lane != "passed",
					CIK: filing.Issuer.CIK, Name: filing.Issuer.Name, Ticker: filing.Issuer.Ticker,
					Form: filing.Form, Accession: filing.Accession, Document: filing.PrimaryDocument,
					URL: filing.URL, FiledAt: filing.FiledAt.Value,
				}
			}
		}
	}

	deepFilings := investorDeepQueueToFilings(state, opts.StreamMaxDeep, opts.UserAgent, screen.MaxChars)
	deepScreened := 0
	if len(deepFilings) > 0 {
		deepOpts := screen
		deepOpts.KeepPassed = true
		deepBatch := screenInvestorFilings(deepFilings, watchlist, deepOpts)
		batch.Items = append(batch.Items, nonNilInvestorItems(deepBatch.Items)...)
		batch.Failures = append(batch.Failures, deepBatch.Failures...)
		for _, item := range deepBatch.Items {
			nativeID := stringValue(item["native_id"])
			if nativeID == "" {
				continue
			}
			state.Deep[nativeID] = now
			delete(state.PendingDeep, nativeID)
			deepScreened++
		}
		for _, filing := range deepFilings {
			if _, done := state.Deep[filing.NativeID]; !done {
				if entry, pending := state.PendingDeep[filing.NativeID]; pending {
					entry.Attempts++
					if entry.Attempts >= 3 {
						delete(state.PendingDeep, filing.NativeID)
					} else {
						state.PendingDeep[filing.NativeID] = entry
					}
				}
			}
		}
		batch.Engine["stream_deep_screened"] = deepScreened
		batch.Engine["stream_deep_pending"] = len(state.PendingDeep)
	}
	investorSaveStreamState(opts.CacheDir, state)
	return batch, batch.Engine, state
}

// isEventDrivenForm reports whether the form is the kind whose mere filing is
// news — an 8-K announces an event, while a 10-K or 424B mostly confirms one.
func isEventDrivenForm(form string) bool {
	upper := strings.ToUpper(strings.TrimSpace(form))
	return upper == "8-K" || upper == "8-K/A" || upper == "8-K12B" || upper == "8-K12G"
}

// investorDeepQueueToFilings takes the highest-priority pending records, fetches
// their primary documents through the paced SEC gate, and returns text-bearing
// filings ready for full screening. Priorities: gate-surfaced records by
// materiality, then event-driven filings newest first.
func investorDeepQueueToFilings(state investorStreamState, cap int, userAgent string, maxChars int) []investorFiling {
	type pendingCandidate struct {
		nativeID string
		entry    investorPendingDeep
		priority int
		material float64
	}
	candidates := make([]pendingCandidate, 0, len(state.PendingDeep))
	for nativeID, entry := range state.PendingDeep {
		priority := 1
		if entry.Surfaced {
			priority = 0
		}
		candidates = append(candidates, pendingCandidate{nativeID: nativeID, entry: entry, priority: priority, material: entry.Materiality})
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].priority != candidates[j].priority {
			return candidates[i].priority < candidates[j].priority
		}
		if candidates[i].priority == 0 && candidates[i].material != candidates[j].material {
			return candidates[i].material > candidates[j].material
		}
		return candidates[i].entry.At > candidates[j].entry.At
	})
	if len(candidates) > cap {
		candidates = candidates[:cap]
	}
	var filings []investorFiling
	for _, candidate := range candidates {
		entry := candidate.entry
		filing := investorFiling{
			Issuer:             investorIssuer{CIK: entry.CIK, Ticker: firstString(entry.Ticker, entry.CIK), Name: entry.Name},
			Form:               entry.Form,
			Accession:          entry.Accession,
			PrimaryDocument:    entry.Document,
			FiledAt:            investorTime{Value: entry.FiledAt, Precision: "day"},
			AvailableAt:        investorTime{Value: time.Now().UTC().Format(time.RFC3339Nano), Precision: "second"},
			NativeID:           candidate.nativeID,
			URL:                entry.URL,
			ObservedAt:         time.Now().UTC().Format(time.RFC3339Nano),
			TextComplete:       false,
			CompletenessReason: "index_metadata_only",
			SourceProvider:     "sec",
			SubjectKind:        "issuer",
			SubjectCode:        firstString(entry.Ticker, entry.CIK),
			SubjectName:        entry.Name,
		}
		raw, err := investorHTTPGet(entry.URL, userAgent, 30*time.Second)
		if err != nil {
			continue
		}
		text, complete, reason := normalizeInvestorDocument(raw, maxChars)
		if text == "" {
			continue
		}
		filing.Text = text
		filing.SummaryText = text
		filing.TextComplete = complete
		filing.CompletenessReason = reason
		filing.DocumentDigest = sha256Hex(raw)
		filing.NormalizedDigest = sha256Hex([]byte(text))
		filing.DocumentBytes = len(raw)
		filing.RawBody = raw
		filings = append(filings, filing)
	}
	return filings
}
