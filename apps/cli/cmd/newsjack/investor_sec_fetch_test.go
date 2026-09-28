package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func configureSECFetchForTest(t *testing.T, cacheDir string, pacing time.Duration) {
	t.Helper()
	investorConfigureSECFetch(cacheDir, pacing)
	t.Cleanup(func() {
		investorConfigureSECFetch("", 300*time.Millisecond)
	})
}

func countingServer(t *testing.T, status int, body string, hits *int64) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt64(hits, 1)
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestInvestorHTTPGetServesImmutableDocumentsFromCache(t *testing.T) {
	configureSECFetchForTest(t, t.TempDir(), time.Millisecond)
	var hits int64
	server := countingServer(t, http.StatusOK, "PRIMARY DOCUMENT TEXT", &hits)
	url := server.URL + "/Archives/edgar/data/1/000000000100000001/filing.htm"

	first, err := investorHTTPGet(url, "test-agent", 5*time.Second)
	if err != nil {
		t.Fatalf("first fetch: %v", err)
	}
	second, err := investorHTTPGet(url, "test-agent", 5*time.Second)
	if err != nil {
		t.Fatalf("second fetch: %v", err)
	}
	if hits != 1 {
		t.Fatalf("server hits = %d, want 1; the second read must come from the cache", hits)
	}
	if string(first) != string(second) {
		t.Fatal("cached body differs from the fetched body")
	}
}

func TestInvestorHTTPGetExpiresSubmissionCache(t *testing.T) {
	t.Setenv("NEWSJACK_SEC_CACHE_TTL_SUBMISSIONS_SECONDS", "1")
	configureSECFetchForTest(t, t.TempDir(), time.Millisecond)
	var hits int64
	server := countingServer(t, http.StatusOK, `{"filings":{}}`, &hits)
	url := server.URL + "/submissions/CIK0000000001.json"

	if _, err := investorHTTPGet(url, "test-agent", 5*time.Second); err != nil {
		t.Fatalf("first fetch: %v", err)
	}
	if _, err := investorHTTPGet(url, "test-agent", 5*time.Second); err != nil {
		t.Fatalf("cached fetch: %v", err)
	}
	if hits != 1 {
		t.Fatalf("server hits = %d, want 1 inside the TTL window", hits)
	}
	time.Sleep(1100 * time.Millisecond)
	if _, err := investorHTTPGet(url, "test-agent", 5*time.Second); err != nil {
		t.Fatalf("fetch after TTL: %v", err)
	}
	if hits != 2 {
		t.Fatalf("server hits = %d, want 2 after the TTL expired", hits)
	}
}

func TestInvestorHTTPGetStopsAfterRateLimit(t *testing.T) {
	dir := t.TempDir()
	configureSECFetchForTest(t, dir, time.Millisecond)
	var hits int64
	server := countingServer(t, http.StatusTooManyRequests, "rate limited", &hits)

	_, firstErr := investorHTTPGet(server.URL+"/a", "test-agent", 5*time.Second)
	if firstErr == nil || !strings.Contains(firstErr.Error(), "backing off until") {
		t.Fatalf("first error = %v, want a rate-limit backoff error", firstErr)
	}
	_, secondErr := investorHTTPGet(server.URL+"/b", "test-agent", 5*time.Second)
	if secondErr == nil || !strings.Contains(secondErr.Error(), "cooldown active") {
		t.Fatalf("second error = %v, want a fail-fast cooldown error", secondErr)
	}
	if hits != 1 {
		t.Fatalf("server hits = %d, want 1; the cooldown must stop further requests", hits)
	}
	reloaded := investorReadRateLimitState(dir, time.Now())
	if reloaded.IsZero() || !reloaded.After(time.Now()) {
		t.Fatal("the cooldown state must persist for the next process")
	}
}

func TestInvestorHTTPGetDoesNotTreatUndeclaredTool403AsRateLimit(t *testing.T) {
	configureSECFetchForTest(t, t.TempDir(), time.Millisecond)
	var hits int64
	server := countingServer(t, http.StatusForbidden, "SEC.gov | Your Request Originates from an Undeclared Automated Tool", &hits)

	if _, err := investorHTTPGet(server.URL+"/a", "test-agent", 5*time.Second); err == nil {
		t.Fatal("expected the 403 to surface as an error")
	}
	if _, err := investorHTTPGet(server.URL+"/b", "test-agent", 5*time.Second); err == nil {
		t.Fatal("expected the second 403 to surface as an error")
	}
	if hits != 2 {
		t.Fatalf("server hits = %d, want 2; an undeclared-tool 403 is a configuration error, not a rate limit", hits)
	}
}

func TestInvestorHTTPGetPacesRequests(t *testing.T) {
	configureSECFetchForTest(t, "", 60*time.Millisecond)
	var hits int64
	server := countingServer(t, http.StatusOK, "ok", &hits)

	start := time.Now()
	for _, path := range []string{"/one", "/two"} {
		if _, err := investorHTTPGet(server.URL+path, "test-agent", 5*time.Second); err != nil {
			t.Fatalf("fetch %s: %v", path, err)
		}
	}
	if elapsed := time.Since(start); elapsed < 55*time.Millisecond {
		t.Fatalf("two fetches took %s, want at least the 60ms spacing between them", elapsed)
	}
	if hits != 2 {
		t.Fatalf("server hits = %d, want 2", hits)
	}
}

func TestNormalizeInvestorDocumentStripsEntityEncodedGlyphs(t *testing.T) {
	raw := []byte("<html><body>20549" + string(rune(0x200B)) + " FORM 8-K &#8203; check &#61514; mark</body></html>")
	text, _, _ := normalizeInvestorDocument(raw, 10000)
	for _, r := range text {
		if r == 0x200B || r == 0x200C || r == 0x200D || r == 0xFEFF || (r >= 0xE000 && r <= 0xF8FF) {
			t.Fatalf("normalized text still contains an invisible glyph: %q", text)
		}
	}
	if !strings.Contains(text, "20549 FORM 8-K check mark") {
		t.Fatalf("normalized text = %q, want readable content", text)
	}
}

func TestInvestorCacheStoresAndFindsBodyFiles(t *testing.T) {
	dir := t.TempDir()
	configureSECFetchForTest(t, dir, time.Millisecond)
	investorSECFetch.cacheStore("https://example.test/Archives/x.htm", []byte("body"), 0, time.Now())
	if _, ok := investorSECFetch.cacheLookup("https://example.test/Archives/x.htm", time.Now()); !ok {
		t.Fatal("a forever-TTL entry must stay readable")
	}
	if _, ok := investorSECFetch.cacheLookup("https://example.test/Archives/other.htm", time.Now()); ok {
		t.Fatal("a different URL must not match another entry's cache files")
	}
	if _, err := os.Stat(filepath.Join(dir, investorRateLimitStateFile)); !os.IsNotExist(err) {
		t.Fatal("no rate-limit state should exist until a rate limit is observed")
	}
}
