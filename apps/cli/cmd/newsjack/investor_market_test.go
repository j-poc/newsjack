package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestInvestorPriceContextComputesFactualChange(t *testing.T) {
	body := `{"chart":{"result":[{"meta":{"symbol":"AAPL"},"timestamp":[1790380800,1790467200,1790553600,1790640000,1790726400],"indicators":{"quote":[{"close":[228.10,230.55,null,224.30,215.75]}]}}],"error":null}}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()
	t.Setenv("NEWSJACK_MARKET_CHART_BASE_URL", server.URL+"/")

	filedAt := time.Date(2026, 9, 28, 0, 0, 0, 0, time.UTC) // baseline lands on the last close at or before the filing date
	context, ok := investorPriceContext("AAPL", filedAt, 5*time.Second)
	if !ok {
		t.Fatal("expected a price context")
	}
	if context.BaselineClose != 230.55 {
		t.Fatalf("baseline close = %v, want the last close at or before the filing date", context.BaselineClose)
	}
	if context.LatestClose != 215.75 || context.ChangePercent != -6.4 {
		t.Fatalf("latest = %v change = %v, want 215.75 / -6.4", context.LatestClose, context.ChangePercent)
	}
	if context.Source != "yahoo_finance" || context.ObservedAt == "" {
		t.Fatal("provenance fields are required")
	}
}

func TestInvestorPriceContextOmitsWhenUnavailable(t *testing.T) {
	if _, ok := investorPriceContext("CIK0992", time.Now(), 5*time.Second); ok {
		t.Fatal("a CIK placeholder must not produce price context")
	}
	if _, ok := investorPriceContext("", time.Now(), 5*time.Second); ok {
		t.Fatal("an empty ticker must not produce price context")
	}
	body := `{"chart":{"result":[{"meta":{},"timestamp":[],"indicators":{"quote":[{"close":[]}]}}]}}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()
	t.Setenv("NEWSJACK_MARKET_CHART_BASE_URL", server.URL+"/")
	if _, ok := investorPriceContext("AAPL", time.Now(), 5*time.Second); ok {
		t.Fatal("insufficient price history must omit the context")
	}
}
