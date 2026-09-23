package main

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	investorSchemaVersion                 = 1
	investorDefaultModel                  = typesafeDefaultModel
	investorDefaultMaxFilings             = 12
	investorDefaultMaxCompanyNewsItems    = 500
	investorDefaultCompanyNewsSymbols     = 50
	investorDefaultDocumentSize           = 20000
	investorDefaultConcurrency            = 4
	investorDefaultTimeout                = 30 * time.Second
	investorDefaultMaxIssuers             = 500
	investorSECSubmissionsURL             = "https://data.sec.gov/submissions/"
	investorSECArchivesURL                = "https://www.sec.gov/Archives/edgar/data"
	investorSECDailyIndexURL              = "https://www.sec.gov/Archives/edgar/daily-index"
	investorSECTickerURL                  = "https://www.sec.gov/files/company_tickers_exchange.json"
	investorFederalRegisterURL            = "https://www.federalregister.gov/api/v1/documents.json"
	investorMaxThesisChars                = 3000
	investorMaxFocusItems                 = 12
	investorScoreEpsilon                  = 0.02
	investorCompanyNewsRelevanceThreshold = 0.80
)

var investorCIKPattern = regexp.MustCompile(`^[0-9]{10}$`)

type investorWatchlist struct {
	SchemaVersion int                    `json:"schema_version"`
	Issuers       []investorIssuer       `json:"issuers"`
	Screen        investorScreenSettings `json:"screen,omitempty"`
}

func investorFederalWatchlist() investorWatchlist {
	return investorWatchlist{
		SchemaVersion: investorSchemaVersion,
		Issuers:       []investorIssuer{{CIK: "0000000000", Ticker: "FED", Name: "Federal Register"}},
		Screen:        investorScreenSettings{ResearchFocus: []string{"material public-policy, regulatory, or economic changes"}},
	}
}

func countInvestorProvider(filings []investorFiling, provider string) int {
	count := 0
	for _, filing := range filings {
		if filing.SourceProvider == provider {
			count++
		}
	}
	return count
}

func scanTimestamp() string {
	return time.Now().UTC().Format("20060102T150405Z")
}

type investorIssuer struct {
	CIK    string `json:"cik"`
	Ticker string `json:"ticker,omitempty"`
	Name   string `json:"name,omitempty"`
}

type investorCompany struct {
	Symbol   string `json:"symbol"`
	Exchange string `json:"exchange"`
	Name     string `json:"name"`
}

type investorScreenSettings struct {
	IncludeForms  []string `json:"include_forms,omitempty"`
	ResearchFocus []string `json:"research_focus,omitempty"`
	ThesisContext string   `json:"thesis_context,omitempty"`
}

type investorFiling struct {
	Issuer             investorIssuer
	Company            *investorCompany
	Form               string
	Accession          string
	PrimaryDocument    string
	PrimaryDescription string
	FiledAt            investorTime
	AvailableAt        investorTime
	AcceptanceRaw      string
	ReportDate         string
	NativeID           string
	URL                string
	SubmissionDigest   string
	DocumentDigest     string
	NormalizedDigest   string
	ObservedAt         string
	Text               string
	SummaryText        string
	TextComplete       bool
	CompletenessReason string
	RawBytes           int
	DocumentBytes      int
	RawBody            []byte `json:"-"`
	RawSubmissionPath  string
	RawSourcePath      string
	SourceProvider     string
	SubjectKind        string
	SubjectCode        string
	SubjectName        string
}

type investorTime struct {
	Value     string `json:"value"`
	Precision string `json:"precision"`
}

type investorSourceFailure struct {
	Stage     string `json:"stage"`
	Issuer    string `json:"issuer,omitempty"`
	Identity  string `json:"identity,omitempty"`
	Error     string `json:"error"`
	RawPath   string `json:"raw_path,omitempty"`
	RawDigest string `json:"raw_digest,omitempty"`
}

type investorScreenResult struct {
	Answers      map[string]any
	Model        string
	InputTokens  int
	OutputTokens int
	LatencyMS    int64
	Err          error
}

type investorScore struct {
	Materiality       float64
	Novelty           float64
	MarketSensitivity float64
	ThesisLink        float64
	Confidence        float64
}

var investorCategories = map[string]bool{
	"operations":         true,
	"capital_allocation": true,
	"governance_legal":   true,
	"risk_disclosure":    true,
	"routine_disclosure": true,
}

func investorCategoryFromAnswers(answers map[string]any) (string, error) {
	raw, ok := answers["category"]
	if !ok {
		return "", errors.New("TypeSafe response is missing category")
	}
	answer := valueOrEmptyMap(raw)
	choice := strings.TrimSpace(stringValue(answer["choice"]))
	if !investorCategories[choice] {
		return "", fmt.Errorf("TypeSafe category %q is not one of the allowed categories", choice)
	}
	return choice, nil
}

type investorAudit struct {
	Version     int                     `json:"version"`
	GeneratedAt string                  `json:"generated_at"`
	Since       investorTime            `json:"since"`
	Watchlist   map[string]any          `json:"watchlist"`
	Source      map[string]any          `json:"source"`
	Engine      map[string]any          `json:"engine"`
	Items       []map[string]any        `json:"items"`
	Failures    []investorSourceFailure `json:"failures"`
}

func (w investorWatchlist) validate() error {
	if w.SchemaVersion != 0 && w.SchemaVersion != investorSchemaVersion {
		return fmt.Errorf("unsupported watchlist schema_version %d", w.SchemaVersion)
	}
	if len(w.Issuers) == 0 {
		return errors.New("watchlist must contain at least one issuer")
	}
	seen := map[string]bool{}
	for i := range w.Issuers {
		issuer := &w.Issuers[i]
		issuer.CIK = strings.TrimSpace(issuer.CIK)
		issuer.Ticker = strings.ToUpper(strings.TrimSpace(issuer.Ticker))
		issuer.Name = strings.TrimSpace(issuer.Name)
		if !investorCIKPattern.MatchString(issuer.CIK) {
			return fmt.Errorf("issuer %d has invalid CIK %q; expected exactly ten digits", i+1, issuer.CIK)
		}
		if seen[issuer.CIK] {
			return fmt.Errorf("watchlist repeats CIK %s", issuer.CIK)
		}
		seen[issuer.CIK] = true
	}
	w.Screen.IncludeForms = normalizeInvestorForms(w.Screen.IncludeForms)
	if len(w.Screen.IncludeForms) == 0 {
		w.Screen.IncludeForms = []string{"8-K", "8-K/A", "10-Q", "10-Q/A", "10-K", "10-K/A"}
	}
	w.Screen.ResearchFocus = cleanInvestorFocus(w.Screen.ResearchFocus)
	w.Screen.ThesisContext = strings.TrimSpace(w.Screen.ThesisContext)
	if len(w.Screen.ThesisContext) > investorMaxThesisChars {
		return fmt.Errorf("thesis_context exceeds %d characters", investorMaxThesisChars)
	}
	return nil
}

func normalizeInvestorForms(forms []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, raw := range forms {
		form := strings.ToUpper(strings.TrimSpace(raw))
		if form == "" || seen[form] {
			continue
		}
		seen[form] = true
		out = append(out, form)
	}
	sort.Strings(out)
	return out
}

func cleanInvestorFocus(values []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" || seen[strings.ToLower(value)] {
			continue
		}
		seen[strings.ToLower(value)] = true
		out = append(out, truncate(value, 300))
		if len(out) == investorMaxFocusItems {
			break
		}
	}
	return out
}

func investorScoreFromAnswers(answers map[string]any) (investorScore, error) {
	var out investorScore
	var err error
	out.Materiality, err = investorScoreAnswer(answers, "materiality")
	if err != nil {
		return out, err
	}
	out.Novelty, err = investorScoreAnswer(answers, "novelty")
	if err != nil {
		return out, err
	}
	out.MarketSensitivity, err = investorScoreAnswer(answers, "market_sensitivity")
	if err != nil {
		return out, err
	}
	if _, ok := answers["thesis_link"]; ok {
		out.ThesisLink, err = investorScoreAnswer(answers, "thesis_link")
		if err != nil {
			return out, err
		}
	} else {
		out.ThesisLink = 0
	}
	confidenceValues := []float64{}
	for _, key := range []string{"materiality", "novelty", "market_sensitivity", "thesis_link"} {
		if raw, ok := answers[key]; ok {
			if value, ok := numberValue(valueOrEmptyMap(raw)["confidence"]); ok {
				if value < 0 || value > 1 || math.IsNaN(value) || math.IsInf(value, 0) {
					return out, fmt.Errorf("%s confidence must be within [0,1]", key)
				}
				confidenceValues = append(confidenceValues, value)
			}
		}
	}
	if len(confidenceValues) == 0 {
		return out, errors.New("TypeSafe score answers have no confidence")
	}
	for _, value := range confidenceValues {
		out.Confidence += value
	}
	out.Confidence /= float64(len(confidenceValues))
	return out, nil
}

func investorScoreAnswer(answers map[string]any, key string) (float64, error) {
	raw, ok := answers[key]
	if !ok {
		return 0, fmt.Errorf("TypeSafe response is missing %s", key)
	}
	answer := valueOrEmptyMap(raw)
	if len(answer) == 0 {
		return 0, fmt.Errorf("TypeSafe answer %s is not an object", key)
	}
	score, ok := numberValue(answer["score"])
	if !ok || math.IsNaN(score) || math.IsInf(score, 0) || score < 0 || score > 4 {
		return 0, fmt.Errorf("TypeSafe answer %s has invalid score", key)
	}
	probabilities := valueOrEmptyMap(answer["probabilities"])
	if len(probabilities) != 5 {
		return 0, fmt.Errorf("TypeSafe answer %s must provide five probabilities", key)
	}
	total := 0.0
	for level := 0; level <= 4; level++ {
		value, ok := numberValue(probabilities[fmt.Sprint(level)])
		if !ok || value < 0 || value > 1 || math.IsNaN(value) || math.IsInf(value, 0) {
			return 0, fmt.Errorf("TypeSafe answer %s has invalid probability for %d", key, level)
		}
		total += value
	}
	if math.Abs(total-1) > investorScoreEpsilon {
		return 0, fmt.Errorf("TypeSafe answer %s probabilities sum to %.4f", key, total)
	}
	if confidence, ok := numberValue(answer["confidence"]); !ok || confidence < 0 || confidence > 1 {
		return 0, fmt.Errorf("TypeSafe answer %s has invalid confidence", key)
	}
	return score, nil
}

func investorAttentionScore(score investorScore, complete bool) int {
	// The score is a review-priority ranking, not an expected return.
	value := score.Materiality/4*30 + score.Novelty/4*18 + score.MarketSensitivity/4*22 + score.ThesisLink/4*18 + 12
	if !complete {
		value = value*0.70 + 70*0.30
	}
	return int(math.Floor(value + 0.5))
}

func investorLane(score int, confidence float64, complete bool) string {
	if !complete {
		return "incomplete"
	}
	if confidence < 0.50 {
		return "human_review"
	}
	if score >= 72 {
		return "read_now"
	}
	if score >= 50 {
		return "monitor"
	}
	return "human_review"
}
