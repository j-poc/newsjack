package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

//go:embed investor_questions.json
var investorQuestionsJSON []byte

type investorScreenOptions struct {
	Model       string
	Concurrency int
	Timeout     time.Duration
	RunDir      string
}

type investorScreenBatch struct {
	Items    []map[string]any
	Filtered []map[string]any
	Failures []investorSourceFailure
	Engine   map[string]any
}

func loadInvestorQuestions() (map[string]any, error) {
	questions := map[string]any{}
	if err := unmarshalJSON(investorQuestionsJSON, &questions); err != nil {
		return nil, fmt.Errorf("investor TypeSafe questions are invalid: %w", err)
	}
	for _, key := range []string{"materiality", "novelty", "market_sensitivity", "thesis_link"} {
		question := valueOrEmptyMap(questions[key])
		if stringValue(question["type"]) != "score" || len(anySlice(question["criteria"])) != 5 {
			return nil, fmt.Errorf("investor TypeSafe AI question %s must be a score question with five criteria", key)
		}
	}
	category := valueOrEmptyMap(questions["category"])
	if stringValue(category["type"]) != "choice" || len(valueOrEmptyMap(category["criteria"])) != 5 {
		return nil, errors.New("investor TypeSafe AI category question must be a five-choice question")
	}
	companyRelevance := valueOrEmptyMap(questions["company_relevance"])
	if stringValue(companyRelevance["type"]) != "noul" || strings.TrimSpace(stringValue(companyRelevance["instructions"])) == "" {
		return nil, errors.New("investor TypeSafe AI company-relevance question must be a Noul question with instructions")
	}
	return questions, nil
}

func screenInvestorFilings(filings []investorFiling, watchlist investorWatchlist, opts investorScreenOptions) investorScreenBatch {
	apiKey, keySource := loadTypeSafeAPIKey()
	if apiKey == "" {
		return investorScreenBatch{
			Failures: []investorSourceFailure{{Stage: "typesafe_auth", Error: "TypeSafe API key not configured; run newsjack auth set-typesafe --key <key> or set TYPESAFE_API_KEY"}},
			Engine:   map[string]any{"name": "typesafe_ai", "model_requested": opts.Model, "configured": false, "calls": 0, "failures": len(filings)},
		}
	}
	questions, err := loadInvestorQuestions()
	if err != nil {
		return investorScreenBatch{Failures: []investorSourceFailure{{Stage: "typesafe_questions", Error: cleanError(err.Error())}}, Engine: map[string]any{"name": "typesafe_ai", "model_requested": opts.Model, "configured": true}}
	}
	if os.Getenv("NEWSJACK_AUTH_DEBUG") != "" {
		fmt.Fprintf(os.Stderr, "Loaded TypeSafe credentials from %s\n", keySource)
	}
	client := typesafeClient{BaseURL: typesafeBaseURL(), APIKey: apiKey, Model: opts.Model, Timeout: opts.Timeout}
	results := make([]investorScreenResult, len(filings))
	workers := maxInt(1, opts.Concurrency)
	var wg sync.WaitGroup
	next := make(chan int)
	started := time.Now()
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range next {
				filing := filings[index]
				state := investorStateFor(filing, watchlist.Screen)
				questionSet := questions
				if filing.SourceProvider != "finnhub_news" {
					questionSet = investorQuestionsWithoutCompanyRelevance(questions)
				}
				results[index] = investorScreenResultFromClient(client.judge(state, questionSet))
			}
		}()
	}
	for index := range filings {
		next <- index
	}
	close(next)
	wg.Wait()

	batch := investorScreenBatch{Engine: map[string]any{
		"name": "typesafe_ai", "model_requested": opts.Model, "base_url": client.BaseURL,
		"questions_sha256": sha256Hex(investorQuestionsJSON), "calls": len(filings),
		"concurrency": workers, "configured": true, "elapsed_ms": time.Since(started).Milliseconds(),
	}}
	var latencies []int64
	for index, result := range results {
		filing := filings[index]
		if result.Err != nil {
			batch.Failures = append(batch.Failures, investorSourceFailure{Stage: "typesafe_screen", Issuer: issuerDisplay(filing.Issuer), Identity: filing.NativeID, Error: cleanError(result.Err.Error())})
			continue
		}
		if filing.SourceProvider == "finnhub_news" {
			relevance, relevanceErr := investorCompanyRelevanceAnswer(result.Answers)
			if relevanceErr != nil {
				batch.Failures = append(batch.Failures, investorSourceFailure{Stage: "typesafe_validate", Issuer: issuerDisplay(filing.Issuer), Identity: filing.NativeID, Error: cleanError(relevanceErr.Error())})
				continue
			}
			if !investorCompanyNewsIsRelevant(relevance) {
				batch.Filtered = append(batch.Filtered, map[string]any{
					"native_id": filing.NativeID, "symbol": filing.SubjectCode, "company_name": filing.SubjectName,
					"provider_headline": filing.PrimaryDescription, "summary_excerpt": truncate(filing.SummaryText, 500),
					"relevance_probability": relevance, "typed_answer": result.Answers["company_relevance"],
					"raw_source_path": filing.RawSourcePath, "document_digest": filing.DocumentDigest,
					"reason": "below_company_attribution_threshold",
				})
				continue
			}
		}
		item, itemErr := investorItemFromScreen(filing, result, watchlist.Screen, opts.RunDir)
		if itemErr != nil {
			batch.Failures = append(batch.Failures, investorSourceFailure{Stage: "typesafe_validate", Issuer: issuerDisplay(filing.Issuer), Identity: filing.NativeID, Error: cleanError(itemErr.Error())})
			continue
		}
		batch.Items = append(batch.Items, item)
		batch.Engine["model_returned"] = firstString(result.Model, opts.Model)
		batch.Engine["input_tokens"] = intValue(batch.Engine["input_tokens"], 0) + result.InputTokens
		batch.Engine["output_tokens"] = intValue(batch.Engine["output_tokens"], 0) + result.OutputTokens
		latencies = append(latencies, result.LatencyMS)
	}
	batch.Engine["failures"] = len(batch.Failures)
	if len(latencies) > 0 {
		sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
		batch.Engine["latency_ms_p50"] = latencies[len(latencies)/2]
		batch.Engine["latency_ms_max"] = latencies[len(latencies)-1]
	}
	sort.Slice(batch.Items, func(i, j int) bool {
		left, right := batch.Items[i], batch.Items[j]
		leftScreen, rightScreen := valueOrEmptyMap(left["screening"]), valueOrEmptyMap(right["screening"])
		leftScore, rightScore := intValue(leftScreen["attention_score"], 0), intValue(rightScreen["attention_score"], 0)
		if leftScore != rightScore {
			return leftScore > rightScore
		}
		return stringValue(left["native_id"]) < stringValue(right["native_id"])
	})
	return batch
}

func investorQuestionsWithoutCompanyRelevance(questions map[string]any) map[string]any {
	filtered := make(map[string]any, len(questions)-1)
	for key, question := range questions {
		if key != "company_relevance" {
			filtered[key] = question
		}
	}
	return filtered
}

func investorCompanyRelevanceAnswer(answers map[string]any) (float64, error) {
	answer, ok := answers["company_relevance"]
	if !ok {
		return 0, errors.New("TypeSafe response is missing company_relevance")
	}
	fields := valueOrEmptyMap(answer)
	if stringValue(fields["type"]) != "noul" {
		return 0, errors.New("TypeSafe company_relevance answer is not a Noul")
	}
	probability, ok := numberValue(fields["noul"])
	if !ok || math.IsNaN(probability) || math.IsInf(probability, 0) || probability < 0 || probability > 1 {
		return 0, errors.New("TypeSafe company_relevance probability must be within [0,1]")
	}
	return probability, nil
}

func investorCompanyNewsIsRelevant(probability float64) bool {
	return probability >= investorCompanyNewsRelevanceThreshold
}

func investorScreenResultFromClient(result coarseCallResult) investorScreenResult {
	return investorScreenResult{Answers: result.Answers, InputTokens: result.InputTokens, OutputTokens: result.OutputTokens, Model: result.Model, LatencyMS: result.LatencyMS, Err: result.Err}
}

func investorStateFor(filing investorFiling, screen investorScreenSettings) map[string]any {
	exhibitsNotCaptured := investorExhibitsNotCaptured(filing)
	evidenceComplete := investorEvidenceComplete(filing)
	subject := map[string]any{"kind": firstString(filing.SubjectKind, "issuer"), "code": filing.SubjectCode, "name": filing.SubjectName}
	state := map[string]any{
		"subject": subject,
		"filing": map[string]any{
			"form": filing.Form, "accession": filing.Accession, "primary_document": filing.PrimaryDocument,
			"primary_description": filing.PrimaryDescription, "filed_at": filing.FiledAt,
			"available_at": filing.AvailableAt, "report_date": filing.ReportDate,
			"document_text": filing.Text, "document_complete": evidenceComplete,
			"primary_document_complete": filing.TextComplete, "completeness_reason": investorEvidenceCompletenessReason(filing),
			"primary_document_completeness_reason": filing.CompletenessReason, "document_digest": filing.DocumentDigest,
			"normalized_digest": filing.NormalizedDigest,
		},
		"source": map[string]any{
			"provider": firstString(filing.SourceProvider, "sec"), "native_id": filing.NativeID, "url": filing.URL,
			"observed_at": filing.ObservedAt, "submission_digest": filing.SubmissionDigest,
		},
		"research_focus": nonNilStrings(screen.ResearchFocus), "thesis_context": screen.ThesisContext,
		"exhibits_not_captured": exhibitsNotCaptured,
	}
	if filing.Issuer.CIK != "" || filing.Issuer.Ticker != "" || filing.Issuer.Name != "" {
		state["issuer"] = map[string]any{"cik": filing.Issuer.CIK, "ticker": filing.Issuer.Ticker, "name": filing.Issuer.Name}
	}
	return state
}

func investorExhibitsNotCaptured(filing investorFiling) bool {
	return filing.SourceProvider == "sec"
}

func investorEvidenceComplete(filing investorFiling) bool {
	return filing.TextComplete && !investorExhibitsNotCaptured(filing)
}

func investorEvidenceCompletenessReason(filing investorFiling) string {
	reason := filing.CompletenessReason
	if investorExhibitsNotCaptured(filing) {
		if reason == "" || reason == "primary_document_captured" {
			return "sec_exhibits_not_captured"
		}
		return reason + ";sec_exhibits_not_captured"
	}
	return reason
}

// investorSummaryHeadline is intentionally extractive. TypeSafe supplies typed
// judgments for ranking and categorization; it is not a text-generation step.
// The headline therefore comes from captured source text, while the formal
// document title remains in primary_description as provenance.
func investorSummaryHeadline(filing investorFiling) string {
	text := strings.TrimSpace(firstString(filing.SummaryText, filing.Text))
	documentTitle := strings.TrimSpace(filing.PrimaryDescription)
	if text == "" {
		return firstString(documentTitle, fmt.Sprintf("%s filing", firstString(filing.Issuer.Ticker, filing.Form)))
	}
	if documentTitle != "" && strings.HasPrefix(strings.ToLower(text), strings.ToLower(documentTitle)) {
		text = strings.TrimSpace(text[len(documentTitle):])
	}
	text = investorStripWireDateline(text)
	if investorTextIsURL(text) {
		return firstString(documentTitle, fmt.Sprintf("%s company news", firstString(filing.SubjectCode, filing.Form)))
	}
	parts := investorSummarySentences(text)
	if filing.SourceProvider == "finnhub_news" {
		company := investorCompany{Symbol: filing.SubjectCode, Name: filing.SubjectName}
		if filing.Company != nil {
			company = *filing.Company
		}
		for _, raw := range parts {
			candidate := strings.TrimSpace(raw)
			if investorSummaryCandidate(candidate, documentTitle) && investorTextMentionsCompany(candidate, company) {
				return investorFinishSummaryHeadline(candidate)
			}
		}
	}
	for _, raw := range parts {
		candidate := strings.TrimSpace(raw)
		if investorSummaryCandidate(candidate, documentTitle) {
			return investorFinishSummaryHeadline(candidate)
		}
	}
	if documentTitle != "" {
		return truncate(documentTitle, 180)
	}
	return truncate(text, 180)
}

func investorSummaryCandidate(candidate, documentTitle string) bool {
	return len(candidate) >= 45 && !strings.EqualFold(candidate, documentTitle) && !isInvestorBoilerplate(candidate) && !investorTextIsURL(candidate)
}

func investorFinishSummaryHeadline(candidate string) string {
	punctuation := strings.TrimRight(candidate, "\"'’”)]}")
	if strings.HasSuffix(punctuation, ".") || strings.HasSuffix(punctuation, "!") || strings.HasSuffix(punctuation, "?") {
		return truncate(candidate, 180)
	}
	return truncate(candidate+".", 180)
}

func investorTextIsURL(text string) bool {
	trimmed := strings.TrimSpace(text)
	lower := strings.ToLower(trimmed)
	return (strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "http://")) && !strings.ContainsAny(trimmed, " \t\r\n")
}

func investorStripWireDateline(text string) string {
	lower := strings.ToLower(text)
	for _, marker := range []string{"globe newswire", "business wire", "pr newswire", "accesswire", "newsfile"} {
		markerAt := strings.Index(lower, marker)
		if markerAt < 0 {
			continue
		}
		separatorAt := strings.Index(text[markerAt+len(marker):], "--")
		if separatorAt >= 0 {
			return strings.TrimSpace(text[markerAt+len(marker)+separatorAt+2:])
		}
	}
	return strings.TrimSpace(text)
}

func investorTextMentionsCompany(text string, company investorCompany) bool {
	if symbol := strings.TrimSpace(company.Symbol); symbol != "" && investorHasExactToken(text, symbol) {
		return true
	}
	name := investorNormalizedCompanyName(company.Name)
	if name == "" {
		return false
	}
	normalizedText := investorNormalizeWords(text)
	return strings.Contains(" "+normalizedText+" ", " "+name+" ")
}

func investorHasExactToken(text, token string) bool {
	upperText, upperToken := strings.ToUpper(text), strings.ToUpper(token)
	for start := 0; start < len(upperText); {
		found := strings.Index(upperText[start:], upperToken)
		if found < 0 {
			return false
		}
		found += start
		end := found + len(upperToken)
		leftBoundary := found == 0 || !isInvestorWordRune(rune(upperText[found-1]))
		rightBoundary := end == len(upperText) || !isInvestorWordRune(rune(upperText[end]))
		if leftBoundary && rightBoundary {
			return true
		}
		start = found + 1
	}
	return false
}

func investorNormalizedCompanyName(name string) string {
	words := strings.Fields(investorNormalizeWords(name))
	for len(words) > 1 {
		last := words[len(words)-1]
		if last == "a" || last == "b" || last == "c" || last == "d" || last == "class" || last == "series" {
			words = words[:len(words)-1]
			continue
		}
		switch last {
		case "inc", "incorporated", "corp", "corporation", "company", "co", "ltd", "limited", "llc", "plc", "lp":
			words = words[:len(words)-1]
		default:
			if words[0] == "the" {
				words = words[1:]
			}
			return strings.Join(words, " ")
		}
	}
	return strings.Join(words, " ")
}

func investorNormalizeWords(text string) string {
	var normalized strings.Builder
	space := true
	for _, r := range strings.ToLower(text) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			normalized.WriteRune(r)
			space = false
		} else if !space {
			normalized.WriteByte(' ')
			space = true
		}
	}
	return strings.TrimSpace(normalized.String())
}

func isInvestorWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}

func investorSummarySentences(text string) []string {
	var sentences []string
	start := 0
	for index := 0; index < len(text); index++ {
		punctuation := text[index]
		if punctuation != '.' && punctuation != '!' && punctuation != '?' {
			continue
		}
		if punctuation == '.' && investorPeriodFollowsAbbreviation(text, index) {
			continue
		}
		end := index + 1
		for end < len(text) && strings.ContainsRune("\"'’”)]}", rune(text[end])) {
			end++
		}
		if end < len(text) && text[end] != ' ' && text[end] != '\n' && text[end] != '\t' && text[end] != '\r' {
			continue
		}
		if sentence := strings.TrimSpace(text[start:end]); sentence != "" {
			sentences = append(sentences, sentence)
		}
		start = end
		for start < len(text) && (text[start] == ' ' || text[start] == '\n' || text[start] == '\t' || text[start] == '\r') {
			start++
		}
		index = end - 1
	}
	if remainder := strings.TrimSpace(text[start:]); remainder != "" {
		sentences = append(sentences, remainder)
	}
	return sentences
}

func investorPeriodFollowsAbbreviation(text string, index int) bool {
	start := index - 1
	for start >= 0 && unicode.IsLetter(rune(text[start])) {
		start--
	}
	token := strings.ToLower(text[start+1 : index])
	switch token {
	case "inc", "incorporated", "corp", "corporation", "co", "ltd", "llc", "plc", "lp", "mr", "mrs", "ms", "dr", "jr", "sr", "dept", "approx", "vs", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec":
		return true
	default:
		return false
	}
}

func isInvestorBoilerplate(value string) bool {
	letters := 0
	upper := 0
	for _, r := range value {
		if r >= 'A' && r <= 'Z' {
			upper++
			letters++
		} else if r >= 'a' && r <= 'z' {
			letters++
		}
	}
	if letters > 10 && float64(upper)/float64(letters) > 0.88 {
		return true
	}
	lower := strings.ToLower(value)
	for _, marker := range []string{"united states securities and exchange commission", "current report pursuant", "commission file number", "annual report pursuant"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func investorItemFromScreen(filing investorFiling, result investorScreenResult, screen investorScreenSettings, runDir string) (map[string]any, error) {
	if len(result.Answers) == 0 {
		return nil, errors.New("TypeSafe returned no typed answers")
	}
	score, err := investorScoreFromAnswers(result.Answers)
	if err != nil {
		return nil, err
	}
	category, err := investorCategoryFromAnswers(result.Answers)
	if err != nil {
		return nil, err
	}
	companyRelevance := 0.0
	if filing.SourceProvider == "finnhub_news" {
		companyRelevance, err = investorCompanyRelevanceAnswer(result.Answers)
		if err != nil {
			return nil, err
		}
		if !investorCompanyNewsIsRelevant(companyRelevance) {
			return nil, errors.New("Finnhub story is below the company-attribution threshold")
		}
	}
	if err := writeInvestorEvidence(runDir, filing); err != nil {
		return nil, fmt.Errorf("write evidence: %w", err)
	}
	exhibitsApplicable := investorExhibitsNotCaptured(filing)
	evidenceComplete := investorEvidenceComplete(filing)
	var exhibitsCaptured any
	if exhibitsApplicable {
		exhibitsCaptured = false
	}
	materiality := int(score.Materiality/4*100 + 0.5)
	novelty := int(score.Novelty/4*100 + 0.5)
	marketSensitivity := int(score.MarketSensitivity/4*100 + 0.5)
	thesisLink := int(score.ThesisLink/4*100 + 0.5)
	sourceReliability := 100
	if filing.SourceProvider == "finnhub_news" {
		sourceReliability = 75
	}
	if !evidenceComplete {
		sourceReliability = minInt(sourceReliability, 70)
	}
	attention := investorAttentionScore(score, evidenceComplete)
	lane := investorLane(attention, score.Confidence, evidenceComplete)
	providerLabel := "SEC"
	if filing.SourceProvider == "federal_register" {
		providerLabel = "Federal Register"
	} else if filing.SourceProvider == "finnhub_news" {
		providerLabel = "Finnhub company news"
	}
	title := investorSummaryHeadline(filing)
	rationale := []string{
		fmt.Sprintf("TypeSafe typed scores: materiality %.1f/4, novelty %.1f/4, market sensitivity %.1f/4, thesis link %.1f/4.", score.Materiality, score.Novelty, score.MarketSensitivity, score.ThesisLink),
		fmt.Sprintf("TypeSafe categorized this filing as %s.", category),
		fmt.Sprintf("Aggregate TypeSafe confidence is %d/100; source reliability is %d/100.", int(score.Confidence*100+0.5), sourceReliability),
		fmt.Sprintf("This is a reproducible screening priority, not a return forecast. Open the primary %s record before making a research judgment.", providerLabel),
	}
	if lane == "human_review" && score.Confidence < 0.50 {
		rationale = append(rationale, "Low TypeSafe confidence forces human review.")
	}
	if lane == "incomplete" {
		var reasons []string
		if !filing.TextComplete {
			reason := "The primary document exceeded the capture bound, so it cannot be treated as complete evidence."
			if filing.CompletenessReason == "abstract_only" {
				reason = "Only the provider abstract was available; the full primary document was not captured, so this cannot be treated as complete evidence."
			}
			reasons = append(reasons, reason)
		}
		if exhibitsApplicable {
			reasons = append(reasons, "SEC filing exhibits were not captured; review the full filing before treating the evidence as complete.")
		}
		rationale = append(rationale, reasons...)
	}
	if filing.SourceProvider == "finnhub_news" {
		rationale = append(rationale, "Finnhub is a secondary company-news feed; verify consequential claims against the linked source or a primary filing.")
		rationale = append(rationale, fmt.Sprintf("TypeSafe estimated %.0f%% probability that this story substantively concerns %s; the desk requires at least %.0f%% before assigning the ticker.", companyRelevance*100, filing.SubjectName, investorCompanyNewsRelevanceThreshold*100))
	}
	htmlPath, textPath := investorEvidencePaths(runDir, filing)
	item := map[string]any{
		"native_id": filing.NativeID, "form": filing.Form,
		"subject_kind": firstString(filing.SubjectKind, "issuer"), "subject_code": filing.SubjectCode, "subject_name": filing.SubjectName,
		"accession": filing.Accession, "primary_document": filing.PrimaryDocument,
		"primary_description": filing.PrimaryDescription, "filed_at": filing.FiledAt,
		"available_at": filing.AvailableAt, "report_date": filing.ReportDate,
		"title": title,
		"source": map[string]any{
			"provider": firstString(filing.SourceProvider, "sec"), "url": filing.URL, "native_id": filing.NativeID,
			"observed_at": filing.ObservedAt, "submission_digest": filing.SubmissionDigest,
			"document_digest": filing.DocumentDigest, "normalized_digest": filing.NormalizedDigest, "raw_submission_path": filing.RawSubmissionPath, "raw_source_path": filing.RawSourcePath,
		},
		"evidence": map[string]any{
			"excerpt": truncate(filing.Text, 1200), "complete": evidenceComplete,
			"primary_document_complete": filing.TextComplete, "completeness_reason": investorEvidenceCompletenessReason(filing),
			"primary_document_completeness_reason": filing.CompletenessReason, "document_bytes": filing.DocumentBytes,
			"exhibits_applicable": exhibitsApplicable, "exhibits_captured": exhibitsCaptured,
			"exhibits_not_captured": exhibitsApplicable, "raw_path": nullableStringIfExists(htmlPath), "text_path": nullableStringIfExists(textPath),
		},
		"screening": map[string]any{
			"engine": "typesafe_ai", "model": firstString(result.Model, investorDefaultModel),
			"model_confidence": int(score.Confidence*100 + 0.5), "typed_answers": result.Answers,
			"materiality": materiality, "novelty": novelty, "market_sensitivity": marketSensitivity,
			"thesis_link": thesisLink, "category": category, "source_reliability": sourceReliability,
			"attention_score": attention, "lane": lane, "rationale": rationale,
		},
	}
	if filing.Company != nil {
		item["company"] = filing.Company
	} else {
		item["issuer"] = filing.Issuer
	}
	return item, nil
}

func writeInvestorAudit(runDir, outputPath string, audit investorAudit) error {
	data := marshalJSON(audit)
	if strings.TrimSpace(runDir) != "" {
		dir := expandPath(runDir)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		if err := atomicWriteInvestorFile(filepath.Join(dir, "audit.json"), data); err != nil {
			return err
		}
	}
	if strings.TrimSpace(outputPath) != "" {
		return atomicWriteInvestorFile(expandPath(outputPath), data)
	}
	return nil
}

func atomicWriteInvestorFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".newsjack-investor-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func unmarshalJSON(data []byte, target any) error {
	return json.Unmarshal(data, target)
}
