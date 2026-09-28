package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestInvestorAutoFlagDoesNotConsumeFollowingOption(t *testing.T) {
	args := reorderIntermixedFlags([]string{
		"--source", "all_public", "--auto", "--since", "2026-09-22T00:00:00Z", "--run-dir", "runs/test",
	}, investorScanValueFlags())
	flags := flag.NewFlagSet("investor scan test", flag.ContinueOnError)
	var auto bool
	var source, since, runDir string
	flags.BoolVar(&auto, "auto", false, "")
	flags.StringVar(&source, "source", "watchlist", "")
	flags.StringVar(&since, "since", "", "")
	flags.StringVar(&runDir, "run-dir", "", "")
	if err := flags.Parse(args); err != nil {
		t.Fatalf("parse reordered investor scan flags: %v", err)
	}
	if flags.NArg() != 0 || !auto || source != "all_public" || since != "2026-09-22T00:00:00Z" || runDir != "runs/test" {
		t.Fatalf("parsed auto scan flags = auto:%t source:%q since:%q runDir:%q args:%v", auto, source, since, runDir, flags.Args())
	}
}

func TestFinnhubRequiresWrittenTypeSafeProcessingApproval(t *testing.T) {
	if shouldQueryInvestorFinnhub("all", false) {
		t.Fatal("combined refresh must not request Finnhub without written processing approval")
	}
	if shouldQueryInvestorFinnhub("company_news", false) {
		t.Fatal("company-news refresh must not request Finnhub without written processing approval")
	}
	if !shouldQueryInvestorFinnhub("all", true) || !shouldQueryInvestorFinnhub("company_news", true) {
		t.Fatal("an explicitly approved Finnhub path should remain available")
	}

	t.Setenv("NEWSJACK_FINNHUB_PROCESSING_APPROVED", "false")
	t.Setenv("FINNHUB_API_KEY", "test-key-not-a-real-key")
	var stderr strings.Builder
	code := cmdInvestorScan([]string{"--source", "company_news", "--run-dir", t.TempDir()}, io.Discard, &stderr)
	if code == 0 || !strings.Contains(stderr.String(), "written approval") || !strings.Contains(stderr.String(), "no Finnhub request was made") {
		t.Fatalf("unapproved company-news result code=%d stderr=%q", code, stderr.String())
	}
}

func TestInvestorSECUserAgentPrefersProductSettingThenLegacyAlias(t *testing.T) {
	t.Setenv("NEWSJACK_SEC_USER_AGENT", "")
	t.Setenv("SEC_USER_AGENT", "")
	t.Setenv("ALETHEIA_SEC_USER_AGENT", "legacy contact")
	if got := investorSECUserAgentFromEnv(); got != "legacy contact" {
		t.Fatalf("legacy SEC contact identity = %q, want fallback value", got)
	}

	t.Setenv("SEC_USER_AGENT", "shared contact")
	if got := investorSECUserAgentFromEnv(); got != "shared contact" {
		t.Fatalf("shared SEC contact identity = %q, want shared setting to win", got)
	}

	t.Setenv("NEWSJACK_SEC_USER_AGENT", "product contact")
	if got := investorSECUserAgentFromEnv(); got != "product contact" {
		t.Fatalf("product SEC contact identity = %q, want product setting to win", got)
	}
}

func TestInvestorNormalizationPreservesSourceTimeAndBoundsText(t *testing.T) {
	payload := map[string]any{
		"filings": map[string]any{"recent": map[string]any{
			"accessionNumber":       []string{"0000320193-26-000001"},
			"form":                  []string{"8-K"},
			"filingDate":            []string{"2026-09-21"},
			"acceptanceDateTime":    []string{"20260921153045"},
			"primaryDocument":       []string{"event.htm"},
			"primaryDocDescription": []string{"Current report"},
			"reportDate":            []string{"2026-09-20"},
		}},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	issuer := investorIssuer{CIK: "0000320193", Ticker: "AAPL", Name: "Apple Inc."}
	items, err := parseInvestorSubmissions(body, issuer, "digest", time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	if items[0].FiledAt.Precision != "day" || items[0].AvailableAt.Precision != "second" {
		t.Fatalf("time precision = %#v %#v", items[0].FiledAt, items[0].AvailableAt)
	}
	if items[0].NativeID != "0000320193:0000320193-26-000001:event.htm" {
		t.Fatalf("native id = %q", items[0].NativeID)
	}
	text, complete, reason := normalizeInvestorDocument([]byte(`<html><script>ignore()</script><body>Revenue &amp; cash&nbsp; grew.</body></html>`), 10)
	if complete || reason != "character_cap" || text != "Revenue &" {
		t.Fatalf("bounded text = %q complete=%v reason=%q", text, complete, reason)
	}
	full, complete, reason := normalizeInvestorDocument([]byte(`<html><script>ignore()</script><body>Revenue &amp; cash&nbsp; grew.</body></html>`), 100)
	if !complete || reason != "primary_document_captured" || full != "Revenue & cash grew." {
		t.Fatalf("normalized text = %q complete=%v reason=%q", full, complete, reason)
	}
}

func TestFinnhubDirectoryRetainsBroadUSCommonStockUniverse(t *testing.T) {
	entries := make([]finnhubSymbol, 0, 503)
	for i := 0; i < 501; i++ {
		entries = append(entries, finnhubSymbol{
			Description: fmt.Sprintf("Public company %d", i),
			Exchange:    "NASDAQ NMS - GLOBAL MARKET",
			Symbol:      fmt.Sprintf("ZX%04d", i),
			Type:        "Common Stock",
		})
	}
	entries = append(entries,
		finnhubSymbol{Description: "Fund", Exchange: "NASDAQ", Symbol: "FUND", Type: "ETP"},
		finnhubSymbol{Description: "OTC company", Exchange: "OTC", Symbol: "OTCQ", Type: "Common Stock"},
	)
	body, err := json.Marshal(entries)
	if err != nil {
		t.Fatal(err)
	}
	symbols, names, err := parseInvestorFinnhubSymbols(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(symbols) != 501 {
		t.Fatalf("eligible symbols = %d, want all 501 listed common stocks", len(symbols))
	}
	if names["ZX0500"] != "Public company 500" {
		t.Fatalf("directory symbol name missing: %q", names["ZX0500"])
	}
}

func TestFinnhubUniverseBatchesRotateWithoutRepeatingAndWrap(t *testing.T) {
	symbols := []string{"AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"}
	first, offset := investorFinnhubSymbolBatch(symbols, 0, 3)
	if strings.Join(first, ",") != "AAA,BBB,CCC" || offset != 3 {
		t.Fatalf("first broad batch = %v, next offset = %d", first, offset)
	}
	second, offset := investorFinnhubSymbolBatch(symbols, offset, 3)
	if strings.Join(second, ",") != "DDD,EEE,FFF" || offset != 6 {
		t.Fatalf("second broad batch = %v, next offset = %d", second, offset)
	}
	for _, symbol := range first {
		for _, next := range second {
			if symbol == next {
				t.Fatalf("rotation repeated %q before covering the directory", symbol)
			}
		}
	}
	last, offset := investorFinnhubSymbolBatch(symbols, offset, 3)
	if strings.Join(last, ",") != "GGG,AAA,BBB" || offset != 2 {
		t.Fatalf("wrapped broad batch = %v, next offset = %d", last, offset)
	}
}

func TestFinnhubPerRunItemCapAdvancesPastTheCapturedTicker(t *testing.T) {
	if got := nextInvestorFinnhubSymbolOffset(0, 1, 4_755); got != 1 {
		t.Fatalf("next symbol offset after one captured ticker = %d, want 1", got)
	}
	if got := nextInvestorFinnhubSymbolOffset(4_754, 1, 4_755); got != 0 {
		t.Fatalf("next symbol offset after last ticker = %d, want wrap to 0", got)
	}
}

func TestFinnhubOffsetNormalizesChangedUniverseSize(t *testing.T) {
	if got := normalizeInvestorFinnhubOffset(9, 5); got != 4 {
		t.Fatalf("offset after directory-size change = %d, want 4", got)
	}
	if got := normalizeInvestorFinnhubOffset(-1, 5); got != 0 {
		t.Fatalf("negative offset = %d, want 0", got)
	}
}

func TestInvestorHTTPGetReturnsRateLimitBodyForEvidenceCapture(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusTooManyRequests)
		_, _ = response.Write([]byte(`{"error":"Too many requests. Please try again later."}`))
	}))
	defer server.Close()

	body, err := investorHTTPGet(server.URL, "newsjack-test/1.0", time.Second)
	if err == nil || !strings.Contains(err.Error(), "HTTP 429") {
		t.Fatalf("error = %v, want HTTP 429", err)
	}
	if got := string(body); got != `{"error":"Too many requests. Please try again later."}` {
		t.Fatalf("captured failure body = %q", got)
	}
}

func TestFinnhubErrorEvidenceRedactsCredential(t *testing.T) {
	const token = "secret-token-value"
	body := redactInvestorResponse([]byte(`{"error":"rejected secret-token-value"}`), token)
	if got, want := string(body), `{"error":"rejected [REDACTED]"}`; got != want {
		t.Fatalf("redacted response = %q, want %q", got, want)
	}
	if got := redactInvestorSecret("provider echoed secret-token-value", token); got != "provider echoed [REDACTED]" {
		t.Fatalf("redacted error = %q", got)
	}
}

func TestInvestorDailyIndexDiscoveryKeepsSECIdentityAndBoundsTickerAlias(t *testing.T) {
	body := []byte("CIK|Company Name|Form Type|Date Filed|Filename\n" +
		"0000320193|APPLE INC|8-K|2026-09-21|edgar/data/320193/0001.txt\n" +
		"0000789019|MICROSOFT CORP|10-Q|2026-09-21|edgar/data/789019/0002.txt\n" +
		"0000320193|APPLE INC|10-K|2026-09-21|edgar/data/320193/0003.txt\n")
	issuers := parseInvestorDailyIndex(body, map[string]bool{"8-K": true, "10-Q": true, "10-K": true})
	if len(issuers) != 3 {
		t.Fatalf("issuers = %d, want 3 before deduplication", len(issuers))
	}
	if len(issuers[0].Ticker) > 10 || issuers[0].CIK != "0000320193" {
		t.Fatalf("discovered issuer = %#v", issuers[0])
	}
}

func TestSECDiscoveryCapturePreservesRawResponseAndReportsDigest(t *testing.T) {
	runDir := t.TempDir()
	body := []byte("CIK|Company Name|Form Type|Date Filed|Filename\n0000320193|APPLE INC|8-K|2026-09-21|edgar/data/320193/0001.txt\n")
	capture, err := captureInvestorDiscovery(investorSECScanOptions{RunDir: runDir}, "daily-index-20260921", "https://www.sec.gov/Archives/edgar/daily-index/2026/QTR3/master.20260921.idx", ".idx", body)
	if err != nil {
		t.Fatal(err)
	}
	if capture == nil || capture.SHA256 != sha256Hex(body) || capture.Source != "daily-index-20260921" {
		t.Fatalf("discovery capture metadata = %#v", capture)
	}
	captured, err := os.ReadFile(capture.Path)
	if err != nil {
		t.Fatal(err)
	}
	if string(captured) != string(body) {
		t.Fatalf("raw SEC response changed during capture: %q", captured)
	}
}

func TestSECDiscoveryFailureSurfacesStatusWithoutProviderBody(t *testing.T) {
	failure := investorDiscoveryError(
		[]error{fmt.Errorf("HTTP 403: provider response detail"), fmt.Errorf("HTTP 403: provider response detail")},
		fmt.Errorf("HTTP 403: issuer response detail"),
	)
	if !strings.Contains(failure.Error(), "HTTP 403") || !strings.Contains(failure.Error(), "failed on 2 date(s)") {
		t.Fatalf("discovery failure omitted actionable source status: %v", failure)
	}
	if strings.Contains(failure.Error(), "provider response detail") || strings.Contains(failure.Error(), "issuer response detail") {
		t.Fatalf("discovery failure leaked provider response body: %v", failure)
	}
}

func TestFederalRegisterDocumentNormalizesAgencyAndSource(t *testing.T) {
	doc := map[string]any{
		"document_number":  "2026-12345",
		"publication_date": "2026-09-21",
		"title":            "A material proposed rule",
		"abstract":         "The agency proposes a change affecting public issuers.",
		"html_url":         "https://www.federalregister.gov/documents/2026/09/21/2026-12345/a-material-proposed-rule",
		"agencies":         []any{map[string]any{"name": "Securities and Exchange Commission", "slug": "securities-and-exchange-commission"}},
	}
	filing, err := federalFilingFromDocument(doc, []byte(`{"results":[]}`), "/tmp/federal.json", "2026-09-21T12:00:00Z", time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC), investorSECScanOptions{MaxChars: 1000})
	if err != nil {
		t.Fatal(err)
	}
	if filing.SourceProvider != "federal_register" || filing.SubjectKind != "agency" || !strings.HasPrefix(filing.SubjectCode, "SECURITIES-AND-EXCHANGE") {
		t.Fatalf("federal filing identity = %#v", filing)
	}
	if filing.Text == "" || filing.NativeID != "FR:2026-12345" {
		t.Fatalf("federal filing content = %#v", filing)
	}
}

func TestFederalRegisterChallengePageNeverCountsAsCompleteEvidence(t *testing.T) {
	if !investorLooksLikeAccessChallenge([]byte("Request Access: CAPTCHA required due to aggressive automated scraping")) {
		t.Fatal("expected access challenge to be detected")
	}
	if investorLooksLikeAccessChallenge([]byte("<html><body>Official proposed rule text</body></html>")) {
		t.Fatal("ordinary document text was treated as a challenge")
	}
}

func TestInvestorSummaryHeadlineUsesCapturedMeaningfulText(t *testing.T) {
	filing := investorFiling{
		Issuer: investorIssuer{Ticker: "AAPL", Name: "Apple Inc."},
		Form:   "8-K", PrimaryDescription: "Current report",
		SummaryText: "The issuer authorized a material capital allocation update affecting its next fiscal year.",
		Text:        "Current report UNITED STATES SECURITIES AND EXCHANGE COMMISSION. The issuer authorized a material capital allocation update affecting its next fiscal year.",
	}
	if got := investorSummaryHeadline(filing); got != "The issuer authorized a material capital allocation update affecting its next fiscal year." {
		t.Fatalf("summary headline = %q", got)
	}
}

func TestInvestorSummaryHeadlineSkipsCoverPageNoise(t *testing.T) {
	filing := investorFiling{
		Issuer: investorIssuer{Ticker: "ADGM", Name: "Adtheus Digital Medicine Group, Inc."},
		Form:   "8-K", PrimaryDescription: "Current report",
		Text: "26051 Merit Circle , Suite 102 Laguna Hills, CA 92653 (Address of principal executive offices; Zip Code) (949) 348-1188",
	}
	if got := investorSummaryHeadline(filing); got != "Current report" {
		t.Fatalf("cover-page-only headline = %q, want the primary description", got)
	}
}

func TestInvestorSummaryHeadlinePrefersNarrativeOverCoverPage(t *testing.T) {
	filing := investorFiling{
		Issuer: investorIssuer{Ticker: "ADGM", Name: "Adtheus Digital Medicine Group, Inc."},
		Form:   "8-K", PrimaryDescription: "Current report",
		Text: "26051 Merit Circle , Suite 102 Laguna Hills, CA 92653 (Address of principal executive offices; Zip Code) (949) 348-1188. The company entered into a definitive agreement to acquire its primary contract manufacturer.",
	}
	want := "The company entered into a definitive agreement to acquire its primary contract manufacturer."
	if got := investorSummaryHeadline(filing); got != want {
		t.Fatalf("narrative headline = %q, want %q", got, want)
	}
}

func TestInvestorSummaryHeadlineSkipsCheckboxLegends(t *testing.T) {
	filing := investorFiling{
		Issuer: investorIssuer{Ticker: "ADTX", Name: "Aditxt, Inc."},
		Form:   "8-K", PrimaryDescription: "Current report",
		Text: "FORM 8-K CURRENT REPORT. Emerging growth company \u2612 If an emerging growth company, indicate by check mark if the registrant has elected not to use the extended transition period for complying with any new or revised financial accounting standards provided pursuant to Section 13(a) of the Exchange Act. \u2610 Item 3.01. As previously disclosed, the Nasdaq Hearings Panel notified the Company that its securities face delisting.",
	}
	want := "The Nasdaq Hearings Panel notified the Company that its securities face delisting."
	if got := investorSummaryHeadline(filing); got != want {
		t.Fatalf("checkbox legend headline = %q, want the narrative fact %q", got, want)
	}
}

func TestInvestorSummaryHeadlinePrefersNarrativeOverSectionHeading(t *testing.T) {
	filing := investorFiling{
		Issuer: investorIssuer{Ticker: "ALC", Name: "Alcoa Corporation"},
		Form:   "8-K", PrimaryDescription: "Current report",
		Text: "Item 1.01 Entry into a Material Definitive Agreement. On September 22, 2026, Alcoa Corporation entered into a definitive agreement to sell its stake in the joint venture for $310 million.",
	}
	want := "Entered into a definitive agreement to sell its stake in the joint venture for $310 million."
	if got := investorSummaryHeadline(filing); got != want {
		t.Fatalf("section heading headline = %q, want the narrative fact %q", got, want)
	}
}

func TestInvestorSummaryHeadlineKeepsMessrsSentenceTogether(t *testing.T) {
	filing := investorFiling{
		Issuer: investorIssuer{Ticker: "AIRE", Name: "reAlpha Tech Corp."},
		Form:   "8-K/A", PrimaryDescription: "Amendment",
		Text: "The merger agreement among reAlpha, InstaMortgage, and the Stockholders (Messrs. Shekhar and Dhingra) was amended and restated.",
	}
	want := "The merger agreement among reAlpha, InstaMortgage, and the Stockholders (Messrs. Shekhar and Dhingra) was amended and restated."
	if got := investorSummaryHeadline(filing); got != want {
		t.Fatalf("messrs split headline = %q, want the whole sentence %q", got, want)
	}
}

func TestInvestorCleanExcerptSkipsXBRLContext(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"context block", "false 0001726711 0001726711 2026-09-17 2026-09-17 iso4217:USD xbrli:shares UNITED STATES SECURITIES AND EXCHANGE COMMISSION", "UNITED STATES SECURITIES AND EXCHANGE COMMISSION"},
		{"cover stamp", "ADAGIO MEDICAL HOLDINGS, INC._September 23, 2026 0002006986 false 0002006986 2026-09-23 FORM 8-K CURRENT REPORT", "FORM 8-K CURRENT REPORT"},
		{"form number lead", "8-K 0001671584 false 0001671584 2026-09-22 2026-09-22 UNITED STATES SECURITIES", "UNITED STATES SECURITIES"},
		{"cik stamp lead", "Alcoa Corp 0001675149 2026-09-23 2026-09-23 UNITED STATES SECURITIES AND EXCHANGE COMMISSION", "UNITED STATES SECURITIES AND EXCHANGE COMMISSION"},
		{"filename stamp lead", "apog-20260918 0000006845 false 0000006845 2024-11-04 2024-11-04 UNITED STATES SECURITIES AND EXCHANGE COMMISSION", "UNITED STATES SECURITIES AND EXCHANGE COMMISSION"},
		{"zero-width lead", "\u200b\u200bUNITED STATES SECURITIES AND EXCHANGE COMMISSION", "UNITED STATES SECURITIES AND EXCHANGE COMMISSION"},
		{"mid-text mention stays", "A rule of the United States Securities and Exchange Commission applies here.", "A rule of the United States Securities and Exchange Commission applies here."},
		{"plain prose", "On September 23, 2026, the Company adopted a plan.", "On September 23, 2026, the Company adopted a plan."},
	}
	for _, tc := range cases {
		if got := investorCleanExcerpt(tc.in, 1200); got != tc.want {
			t.Errorf("%s: excerpt = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestInvestorFinishSummaryHeadlineCutsLongSentencesAtWordBoundary(t *testing.T) {
	long := strings.Repeat("word ", 50)
	got := investorFinishSummaryHeadline(long)
	cut := strings.LastIndex(long[:200], " ")
	want := long[:cut] + "\u2026"
	if got != want {
		t.Fatalf("long headline = %q, want the word-bounded cut %q", got, want)
	}
}

func TestInvestorSummaryHeadlineStripsEdgarCheckboxGlyphBeforeHeading(t *testing.T) {
	filing := investorFiling{
		Issuer: investorIssuer{Ticker: "ALC", Name: "Alcoa Corporation"},
		Form:   "8-K", PrimaryDescription: "Current report",
		Text: "\uf06f Item 1.01 Entry into a Material Definitive Agreement. On September 23, 2026, Alcoa completed an offering of $1,500,000,000 aggregate principal amount of 6.625% senior notes due 2034.",
	}
	want := "Alcoa completed an offering of $1,500,000,000 aggregate principal amount of 6.625% senior notes due 2034."
	if got := investorSummaryHeadline(filing); got != want {
		t.Fatalf("glyph-prefixed heading = %q, want the narrative fact %q", got, want)
	}
}

func TestInvestorSummaryHeadlineSkipsItemHeadingBodyAfterItemNumber(t *testing.T) {
	filing := investorFiling{
		Issuer: investorIssuer{Ticker: "ADTX", Name: "Aditxt, Inc."},
		Form:   "8-K", PrimaryDescription: "Current report",
		Text: "\u2610 Item 3.01. Notice of Delisting or Failure to Satisfy a Continued Listing Rule or Standard; Transfer of Listing. As previously disclosed, the Nasdaq Hearings Panel notified the Company that its securities face delisting.",
	}
	want := "The Nasdaq Hearings Panel notified the Company that its securities face delisting."
	if got := investorSummaryHeadline(filing); got != want {
		t.Fatalf("item heading body = %q, want the narrative fact %q", got, want)
	}
}

func TestInvestorSummaryHeadlineFallsBackToDocumentTitleWhenOnlyCoverNoise(t *testing.T) {
	filing := investorFiling{
		Issuer: investorIssuer{Ticker: "ALC", Name: "Alcoa Corporation"},
		Form:   "8-K", PrimaryDescription: "Current report",
		Text: "Emerging growth company \u2612 If an emerging growth company, indicate by check mark if the registrant has elected not to use the extended transition period for complying with any new or revised financial accounting standards provided pursuant to Section 13(a) of the Exchange Act. \u2612 Written communications pursuant to Rule 425 under the Securities Act (17 CFR 230.425) \u2610 Soliciting Material pursuant to Rule 14a-12.",
	}
	if got := investorSummaryHeadline(filing); got != "Current report" {
		t.Fatalf("cover-only headline = %q, want the document title", got)
	}
}

func TestInvestorRelevanceGateFiltersRoutineRecords(t *testing.T) {
	meaningful := investorScore{Materiality: 2.4, Novelty: 2.0, MarketSensitivity: 2.0, ThesisLink: 1.5, Confidence: 0.8}
	if !investorRecordIsRelevant("operations", meaningful) {
		t.Fatal("a meaningful non-routine record should reach the wire")
	}
	if investorRecordIsRelevant("routine_disclosure", meaningful) {
		t.Fatal("a record still categorized as routine disclosure should stay off the wire")
	}
	routine := investorScore{Materiality: 1.2, ThesisLink: 2.5, Confidence: 0.8}
	if investorRecordIsRelevant("operations", routine) {
		t.Fatal("a below-materiality record without a thesis connection should stay off the wire")
	}
	focused := investorScore{Materiality: 1.5, ThesisLink: 3.2, Confidence: 0.8}
	if !investorRecordIsRelevant("governance_legal", focused) {
		t.Fatal("a clear thesis connection should keep a record on the wire")
	}
}

func TestInvestorSummaryHeadlineKeepsDecimalAmountsIntact(t *testing.T) {
	filing := investorFiling{
		Company:     &investorCompany{Symbol: "DASH", Name: "DoorDash"},
		Form:        "NEWS",
		SummaryText: "The $131.5 million settlement includes $12.3 million for workers and a $16.7 million fine. DoorDash said it will change its controls.",
		Text:        "The $131.5 million settlement includes $12.3 million for workers and a $16.7 million fine. DoorDash said it will change its controls.",
	}
	want := "The $131.5 million settlement includes $12.3 million for workers and a $16.7 million fine."
	if got := investorSummaryHeadline(filing); got != want {
		t.Fatalf("summary headline = %q, want %q", got, want)
	}
}

func TestInvestorSummaryHeadlineChoosesTargetSentenceFromRoundup(t *testing.T) {
	filing := investorFiling{
		Company:            &investorCompany{Symbol: "DASH", Name: "DOORDASH INC - A"},
		SourceProvider:     "finnhub_news",
		PrimaryDescription: "Wall Street Lunch: Meta's Muse Teams With Shopify After Amazon Ban",
		SummaryText:        "Shopify welcomes Meta's AI shopping agent after Amazon blocks it. Viking soars after its obesity drug delivers 22% weight loss. DoorDash admits it screwed up after drivers lost tips.",
	}
	want := "DoorDash admits it screwed up after drivers lost tips."
	if got := investorSummaryHeadline(filing); got != want {
		t.Fatalf("roundup summary headline = %q, want %q", got, want)
	}
}

func TestInvestorSummaryHeadlineStripsWireDatelineAndCompanyAbbreviation(t *testing.T) {
	filing := investorFiling{
		Company:            &investorCompany{Symbol: "BBNX", Name: "BETA BIONICS INC"},
		SourceProvider:     "finnhub_news",
		PrimaryDescription: "Beta Bionics Announces Agreement Integrate the iLet Bionic Pancreas and mint with Senseonics",
		SummaryText:        "IRVINE, Calif., Sept. 22, 2026 (GLOBE NEWSWIRE) -- Beta Bionics, Inc. (Nasdaq: BBNX), a leader in diabetes management, today announced a partnership with Senseonics.",
	}
	want := "Beta Bionics, Inc. (Nasdaq: BBNX), a leader in diabetes management, today announced a partnership with Senseonics."
	if got := investorSummaryHeadline(filing); got != want {
		t.Fatalf("wire-release summary headline = %q, want %q", got, want)
	}
}

func TestInvestorSummaryHeadlineFallsBackToSourceHeadlineForURLSummary(t *testing.T) {
	filing := investorFiling{
		Company:            &investorCompany{Symbol: "DASH", Name: "DoorDash Inc - A"},
		SourceProvider:     "finnhub_news",
		PrimaryDescription: "DoorDash agrees to settlement for shortchanging workers",
		SummaryText:        "https://example.com/articles/doordash-settlement.html",
	}
	want := "DoorDash agrees to settlement for shortchanging workers"
	if got := investorSummaryHeadline(filing); got != want {
		t.Fatalf("URL-only summary fallback = %q, want %q", got, want)
	}
}

func TestInvestorCompanyMentionRequiresCompanyNameOrExactTicker(t *testing.T) {
	company := investorCompany{Symbol: "DASH", Name: "DOORDASH INC - A"}
	if investorTextMentionsCompany("The delivery company expanded its marketplace.", company) {
		t.Fatal("generic company wording must not establish company attribution")
	}
	if investorTextMentionsCompany("Dashers received new delivery gear.", company) {
		t.Fatal("ticker substring inside another word must not establish company attribution")
	}
	if !investorTextMentionsCompany("DoorDash's marketplace expanded nationwide.", company) {
		t.Fatal("normalized company name should establish a target mention")
	}
}

func TestInvestorCompanyNewsAttributionThresholdIsConservative(t *testing.T) {
	if investorCompanyNewsIsRelevant(investorCompanyNewsRelevanceThreshold - 0.001) {
		t.Fatal("story below company-attribution threshold should not be assigned to the ticker")
	}
	if !investorCompanyNewsIsRelevant(investorCompanyNewsRelevanceThreshold) {
		t.Fatal("story at the company-attribution threshold should be retained")
	}
	if _, err := investorCompanyRelevanceAnswer(map[string]any{"company_relevance": map[string]any{"type": "noul", "noul": 1.1}}); err == nil {
		t.Fatal("out-of-range Noul probability must fail closed")
	}
}

func investorTestScoreAnswer(score, confidence float64) map[string]any {
	return map[string]any{
		"type": "score", "score": score, "confidence": confidence,
		"legend":        map[string]any{"0": "none", "1": "low", "2": "medium", "3": "high", "4": "exceptional"},
		"probabilities": map[string]any{"0": 0.02, "1": 0.03, "2": 0.05, "3": 0.10, "4": 0.80},
	}
}

func TestInvestorScoreValidationAndRouting(t *testing.T) {
	answers := map[string]any{
		"materiality":        investorTestScoreAnswer(3, 0.9),
		"novelty":            investorTestScoreAnswer(2, 0.8),
		"market_sensitivity": investorTestScoreAnswer(3, 0.9),
		"thesis_link":        investorTestScoreAnswer(4, 0.9),
	}
	score, err := investorScoreFromAnswers(answers)
	if err != nil {
		t.Fatal(err)
	}
	if got := investorAttentionScore(score, true); got != 78 {
		t.Fatalf("attention score = %d, want 78", got)
	}
	if got := investorLane(78, score.Confidence, true); got != "read_now" {
		t.Fatalf("lane = %q", got)
	}
	if got := investorLane(99, 0.4, true); got != "human_review" {
		t.Fatalf("low confidence lane = %q", got)
	}
	if got := investorLane(99, 0.9, false); got != "incomplete" {
		t.Fatalf("incomplete lane = %q", got)
	}
	bad := map[string]any{}
	for key, value := range answers {
		bad[key] = value
	}
	bad["novelty"] = map[string]any{"score": 2, "confidence": 0.8, "probabilities": map[string]any{"0": 0.9}}
	if _, err := investorScoreFromAnswers(bad); err == nil {
		t.Fatal("expected malformed probability distribution to fail")
	}
}

func TestInvestorScanUsesLiveShapedSECAndTypeSafeContracts(t *testing.T) {
	watchlistPath := filepath.Join(t.TempDir(), "watchlist.json")
	watchlist := `{"schema_version":1,"issuers":[{"cik":"0000320193","ticker":"AAPL","name":"Apple Inc."}],"screen":{"include_forms":["8-K"],"research_focus":["capital allocation"],"thesis_context":"Does capital allocation remain disciplined?"}}`
	if err := os.WriteFile(watchlistPath, []byte(watchlist), 0o644); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/submissions/CIK0000320193.json":
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"filings":{"recent":{"accessionNumber":["0000320193-26-000001"],"form":["8-K"],"filingDate":["2026-09-21"],"acceptanceDateTime":["20260921153045"],"primaryDocument":["event.htm"],"primaryDocDescription":["Current report"],"reportDate":["2026-09-20"]}}}`)
		case r.URL.Path == "/archives/320193/000032019326000001/event.htm":
			w.Header().Set("Content-Type", "text/html")
			io.WriteString(w, `<html><body><h1>Current report</h1><p>The issuer authorized a material capital allocation update.</p></body></html>`)
		case r.URL.Path == typesafeSystemOnePath:
			if r.Header.Get("Authorization") != "Bearer test-typesafe-key" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"model":"jev-test","usage":{"input_tokens":123,"output_tokens":0},"answers":{"materiality":{"type":"score","score":3,"legend":{"0":"none","1":"low","2":"medium","3":"high","4":"exceptional"},"probabilities":{"0":0.02,"1":0.03,"2":0.05,"3":0.1,"4":0.8},"confidence":0.9},"novelty":{"type":"score","score":2,"legend":{"0":"none","1":"low","2":"medium","3":"high","4":"exceptional"},"probabilities":{"0":0.02,"1":0.03,"2":0.05,"3":0.1,"4":0.8},"confidence":0.8},"market_sensitivity":{"type":"score","score":3,"legend":{"0":"none","1":"low","2":"medium","3":"high","4":"exceptional"},"probabilities":{"0":0.02,"1":0.03,"2":0.05,"3":0.1,"4":0.8},"confidence":0.9},"thesis_link":{"type":"score","score":4,"legend":{"0":"none","1":"low","2":"medium","3":"high","4":"exceptional"},"probabilities":{"0":0.02,"1":0.03,"2":0.05,"3":0.1,"4":0.8},"confidence":0.9},"category":{"type":"choice","choice":"capital_allocation","probabilities":{"operations":0.05,"capital_allocation":0.8,"governance_legal":0.05,"risk_disclosure":0.05,"routine_disclosure":0.05},"confidence":0.9}}}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	t.Setenv("NEWSJACK_SEC_SUBMISSIONS_BASE_URL", server.URL+"/submissions/")
	t.Setenv("NEWSJACK_SEC_ARCHIVES_BASE_URL", server.URL+"/archives")
	t.Setenv("TYPESAFE_API_KEY", "test-typesafe-key")
	t.Setenv("NEWSJACK_TYPESAFE_BASE_URL", server.URL)
	// Keep this SEC contract test deterministic even when the developer
	// environment has a live Finnhub credential configured.
	t.Setenv("FINNHUB_API_KEY", "")
	outDir := filepath.Join(t.TempDir(), "investor-run")
	var stdout, stderr strings.Builder
	code := runCLIWithIO([]string{"investor", "scan", "--watchlist", watchlistPath, "--since", "2026-09-20T00:00:00Z", "--run-dir", outDir, "--user-agent", "newsjack-test test@example.com"}, strings.NewReader(""), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code = %d stderr=%s stdout=%s", code, stderr.String(), stdout.String())
	}
	var audit map[string]any
	if err := json.Unmarshal([]byte(stdout.String()), &audit); err != nil {
		t.Fatal(err)
	}
	items, ok := audit["items"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("items = %#v", audit["items"])
	}
	item := items[0].(map[string]any)
	screen := item["screening"].(map[string]any)
	if screen["lane"] != "incomplete" || screen["model"] != "jev-test" {
		t.Fatalf("screening = %#v", screen)
	}
	evidence := item["evidence"].(map[string]any)
	if evidence["complete"] != false || evidence["primary_document_complete"] != true || evidence["exhibits_applicable"] != true || evidence["exhibits_captured"] != false || evidence["completeness_reason"] != "sec_exhibits_not_captured" {
		t.Fatalf("SEC evidence completeness = %#v", evidence)
	}
	auditPath := filepath.Join(outDir, "audit.json")
	if _, err := os.Stat(auditPath); err != nil {
		t.Fatalf("audit artifact missing: %v", err)
	}
	evidenceDir := filepath.Join(outDir, "evidence")
	entries, err := os.ReadDir(evidenceDir)
	if err != nil || len(entries) != 2 {
		t.Fatalf("evidence entries = %d err=%v", len(entries), err)
	}
	for _, path := range []string{outDir, evidenceDir} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat output directory %s: %v", path, err)
		}
		if got := info.Mode().Perm(); got != 0o700 {
			t.Errorf("directory mode for %s = %04o, want 0700", path, got)
		}
	}
	for _, path := range append([]string{auditPath}, filepath.Join(evidenceDir, entries[0].Name()), filepath.Join(evidenceDir, entries[1].Name())) {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat private output %s: %v", path, err)
		}
		if got := info.Mode().Perm(); got != 0o600 {
			t.Errorf("file mode for %s = %04o, want 0600", path, got)
		}
	}
}

func TestInvestorEvidenceMarksExhibitsOnlyForSEC(t *testing.T) {
	watchlistScreen := investorScreenSettings{}
	secState := investorStateFor(investorFiling{SourceProvider: "sec", TextComplete: true}, watchlistScreen)
	secFiling := valueOrEmptyMap(secState["filing"])
	if secFiling["document_complete"] != false || secFiling["primary_document_complete"] != true || secState["exhibits_not_captured"] != true {
		t.Fatalf("SEC AI evidence state = %#v", secState)
	}

	federalState := investorStateFor(investorFiling{SourceProvider: "federal_register", TextComplete: true}, watchlistScreen)
	if federalState["exhibits_not_captured"] != false {
		t.Fatalf("Federal Register exhibits state = %#v", federalState["exhibits_not_captured"])
	}
}

func TestAtomicInvestorFileUsesPrivateModesWithoutChangingExistingDirectories(t *testing.T) {
	root := t.TempDir()
	newDir := filepath.Join(root, "private", "nested")
	newPath := filepath.Join(newDir, "audit.json")
	if err := atomicWriteInvestorFile(newPath, []byte("{}")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Dir(newDir), newDir} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat newly created directory %s: %v", path, err)
		}
		if got := info.Mode().Perm(); got != 0o700 {
			t.Errorf("new directory mode for %s = %04o, want 0700", path, got)
		}
	}
	newInfo, err := os.Stat(newPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := newInfo.Mode().Perm(); got != 0o600 {
		t.Errorf("new file mode = %04o, want 0600", got)
	}

	existingDir := filepath.Join(root, "existing")
	if err := os.Mkdir(existingDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(existingDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := atomicWriteInvestorFile(filepath.Join(existingDir, "capture.json"), []byte("{}")); err != nil {
		t.Fatal(err)
	}
	existingInfo, err := os.Stat(existingDir)
	if err != nil {
		t.Fatal(err)
	}
	if got := existingInfo.Mode().Perm(); got != 0o755 {
		t.Errorf("pre-existing directory mode changed to %04o, want unchanged 0755", got)
	}
}
