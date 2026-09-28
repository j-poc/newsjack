package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func summaryTestScore(value float64) map[string]any {
	probabilities := map[string]any{"0": 0.0, "1": 0.0, "2": 0.0, "3": 0.0, "4": 0.0}
	probabilities[fmt.Sprintf("%d", int(value))] = 1.0
	return map[string]any{
		"type":          "score",
		"score":         value,
		"legend":        map[string]any{"0": "None", "4": "Very high"},
		"probabilities": probabilities,
		"confidence":    0.9,
	}
}

func summaryTestCategory() map[string]any {
	return map[string]any{
		"type":   "choice",
		"choice": "operations",
		"probabilities": map[string]any{
			"operations": 0.8, "capital_allocation": 0.05, "governance_legal": 0.05,
			"risk_disclosure": 0.05, "routine_disclosure": 0.05,
		},
		"confidence": 0.8,
	}
}

func summaryTestChoice(choice string, options []string, chosenProbability float64) map[string]any {
	probabilities := map[string]any{}
	for _, option := range options {
		probabilities[option] = 0.01
	}
	probabilities[choice] = chosenProbability
	return map[string]any{"type": "choice", "choice": choice, "probabilities": probabilities, "confidence": 0.9}
}

func summaryTestScreen(t *testing.T, handler http.HandlerFunc, text string, complete bool) (investorScreenBatch, *int) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	var calls int
	t.Setenv("TYPESAFE_API_KEY", "test-key")
	t.Setenv("NEWSJACK_TYPESAFE_BASE_URL", server.URL)
	filing := investorFiling{
		Issuer: investorIssuer{CIK: "0000001234", Ticker: "EXMP", Name: "Example Industries"},
		Form:   "8-K", Accession: "0000001234-26-000003",
		PrimaryDocument: "current.htm", PrimaryDescription: "Current report",
		FiledAt:     investorTime{Value: "2026-09-23T00:00:00.000Z", Precision: "day"},
		AvailableAt: investorTime{Value: "2026-09-23T16:00:00.000Z", Precision: "second"},
		NativeID:    "SEC:0000001234:0000001234-26-000003:current.htm",
		URL:         "https://www.sec.gov/Archives/edgar/data/1234/000000123426000003/current.htm",
		Text:        text, TextComplete: complete, CompletenessReason: "primary_document_captured",
		DocumentDigest: strings.Repeat("a", 64), NormalizedDigest: strings.Repeat("b", 64),
		SourceProvider: "sec", SubjectKind: "issuer", SubjectCode: "EXMP", SubjectName: "Example Industries",
	}
	watchlist := investorWatchlist{SchemaVersion: investorSchemaVersion, Screen: investorScreenSettings{
		IncludeForms: defaultInvestorForms(), ResearchFocus: []string{"material operating, financing, governance, or legal changes"},
	}}
	batch := screenInvestorFilings([]investorFiling{filing}, watchlist, investorScreenOptions{Model: "jev-latest", Concurrency: 1, Timeout: 10 * time.Second})
	return batch, &calls
}

func summaryTestHandler(t *testing.T, direct map[string]any, groupChoice string, resolution map[string]any) (http.HandlerFunc, *int) {
	t.Helper()
	calls := 0
	return func(w http.ResponseWriter, r *http.Request) {
		calls++
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		questions, _ := payload["questions"].(map[string]any)
		answers := map[string]any{
			"materiality": summaryTestScore(3), "novelty": summaryTestScore(2),
			"market_sensitivity": summaryTestScore(3), "thesis_link": summaryTestScore(2),
			"category": summaryTestCategory(),
		}
		if _, isGroup := questions["first_read_summary_group"]; isGroup {
			answers["first_read_summary_group"] = summaryTestChoice(groupChoice, nil, 1.0)
		} else if _, isDirect := questions["first_read_summary"]; isDirect {
			answers["first_read_summary"] = direct
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"answers": answers, "model": "jev-latest", "usage": map[string]any{"input_tokens": 10, "output_tokens": 5}})
	}, &calls
}

func TestInvestorFirstReadDirectSelection(t *testing.T) {
	text := "The company adopted a plan to extend its capital resources. The weather in the region remained pleasant throughout the quarter. A copy of the press release is filed as Exhibit 99.1 hereto. The transaction is expected to close during the fourth quarter of 2026."
	handler, calls := summaryTestHandler(t, summaryTestChoice("candidate_3", []string{"candidate_0", "candidate_1", "candidate_2", "candidate_3", "none"}, 1.0), "", nil)
	batch, _ := summaryTestScreen(t, handler, text, true)
	if *calls != 1 {
		t.Fatalf("TypeSafe calls = %d, want 1 for the direct path", *calls)
	}
	if len(batch.Items) != 1 {
		for _, failure := range batch.Failures {
			t.Logf("failure: %s %s", failure.Stage, failure.Error)
		}
		t.Fatalf("items = %d, want 1", len(batch.Items))
	}
	title := stringValue(batch.Items[0]["title"])
	if !strings.HasPrefix(title, "A transaction is expected to close") && !strings.Contains(title, "expected to close") {
		t.Fatalf("title = %q, want the TypeSafe-selected sentence (compressed)", title)
	}
	screening := batch.Items[0]["screening"].(map[string]any)
	rationale := screening["rationale"].([]string)
	if rationale[0] != "The first-read headline is an exact source sentence selected by TypeSafe AI; envelope boilerplate was trimmed." {
		t.Fatalf("rationale[0] = %q, want the provenance line", rationale[0])
	}
}

func TestInvestorFirstReadAbstentionFallsBackToDescription(t *testing.T) {
	text := "The company adopted a plan to extend its capital resources. The weather in the region remained pleasant throughout the quarter."
	handler, _ := summaryTestHandler(t, summaryTestChoice("none", []string{"candidate_0", "candidate_1", "none"}, 1.0), "", nil)
	batch, _ := summaryTestScreen(t, handler, text, true)
	title := stringValue(batch.Items[0]["title"])
	if title != "Current report" {
		t.Fatalf("abstained title = %q, want the document description", title)
	}
	screening := batch.Items[0]["screening"].(map[string]any)
	rationale := screening["rationale"].([]string)
	found := false
	for _, item := range rationale {
		if strings.Contains(item, "did not select a usable first-read candidate") {
			found = true
		}
	}
	if !found {
		t.Fatalf("rationale = %v, want the abstention note", rationale)
	}
}

func TestInvestorFirstReadRejectsNonHighestProbability(t *testing.T) {
	text := "The company adopted a plan to extend its capital resources. The transaction is expected to close during the fourth quarter of 2026."
	handler, _ := summaryTestHandler(t, map[string]any{"type": "choice", "choice": "candidate_0", "probabilities": map[string]any{"candidate_0": 0.2, "candidate_1": 0.9, "none": 0.01}, "confidence": 0.9}, "", nil)
	batch, _ := summaryTestScreen(t, handler, text, true)
	_ = batch
	title := stringValue(batch.Items[0]["title"])
	if strings.Contains(title, "adopted a plan") {
		t.Fatalf("title = %q; a choice below the highest probability must fall back", title)
	}
	if title != "Current report" {
		t.Fatalf("fallback title = %q, want the document description", title)
	}
}

func TestInvestorFirstReadGroupResolution(t *testing.T) {
	var sentences []string
	for index := 0; index < 300; index += 1 {
		sentences = append(sentences, "The issuer recorded operating update "+strings.Repeat("x", index%40)+" number "+itoa(index)+" for the period.")
	}
	text := strings.Join(sentences, " ")
	if len(investorExtractSummaryCandidates(text, false)) < 254 {
		t.Fatalf("fixture must exceed the direct candidate limit")
	}
	handler, calls := summaryTestHandler(t, summaryTestChoice("candidate_8", []string{"candidate_8", "none"}, 1.0), "group_1", summaryTestChoice("candidate_9", []string{"candidate_8", "candidate_9", "none"}, 1.0))
	batch, _ := summaryTestScreen(t, handler, text, true)
	if *calls != 2 {
		t.Fatalf("TypeSafe calls = %d, want 2 for the group path", *calls)
	}
	title := stringValue(batch.Items[0]["title"])
	if !strings.Contains(title, "operating update") {
		screening := batch.Items[0]["screening"].(map[string]any)
		t.Fatalf("title = %q, want the resolution-selected sentence; rationale = %v", title, screening["rationale"])
	}
	_ = batch
}

func TestInvestorExtractSummaryCandidatesDiscardsClippedTail(t *testing.T) {
	text := "The company adopted a plan to extend its capital resources. The trans"
	candidates := investorExtractSummaryCandidates(text, true)
	for _, candidate := range candidates {
		if strings.HasSuffix(candidate.Text, "The trans") {
			t.Fatalf("clipped fragment became a candidate: %q", candidate.Text)
		}
	}
}

func itoa(value int) string {
	digits := ""
	if value == 0 {
		return "0"
	}
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}
