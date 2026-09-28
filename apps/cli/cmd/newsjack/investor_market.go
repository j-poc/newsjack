package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"
)

// investorMarketContext is a factual market observation attached to a surfaced
// record: how the issuer's listed shares actually traded from the last close
// at or before the filing date to the latest available close. It carries its
// own provenance (dates, source, observation time) and is omitted entirely
// when the data cannot be sourced — the desk never estimates a missing price.
type investorMarketContext struct {
	Ticker        string  `json:"ticker"`
	BaselineDate  string  `json:"baseline_date"`
	BaselineClose float64 `json:"baseline_close"`
	LatestDate    string  `json:"latest_date"`
	LatestClose   float64 `json:"latest_close"`
	ChangePercent float64 `json:"change_percent"`
	Source        string  `json:"source"`
	ObservedAt    string  `json:"observed_at"`
}

var (
	investorMarketMu        sync.Mutex
	investorMarketLastReq   time.Time
	investorMarketPacing    = 250 * time.Millisecond
	investorMarketUA        = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
	investorMarketChartBase = "https://query1.finance.yahoo.com/v8/finance/chart/"
)

// investorMarketFetch paces third-party market requests independently of the
// SEC gate: this is a different provider with its own etiquette.
func investorMarketFetch(rawURL string, timeout time.Duration) ([]byte, error) {
	investorMarketMu.Lock()
	if wait := investorMarketLastReq.Add(investorMarketPacing).Sub(time.Now()); wait > 0 {
		time.Sleep(wait)
	}
	investorMarketLastReq = time.Now()
	investorMarketMu.Unlock()
	request, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", investorMarketUA)
	request.Header.Set("Accept", "application/json")
	client := &http.Client{Timeout: timeout}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		return nil, fmt.Errorf("market data HTTP %d", response.StatusCode)
	}
	return readAllLimited(response)
}

func readAllLimited(response *http.Response) ([]byte, error) {
	body := make([]byte, 0, 4096)
	buffer := make([]byte, 32*1024)
	for {
		n, err := response.Body.Read(buffer)
		body = append(body, buffer[:n]...)
		if err != nil || len(body) > 8*1024*1024 {
			break
		}
	}
	return body, nil
}

type investorChartResponse struct {
	Chart struct {
		Result []struct {
			Meta struct {
				Symbol string `json:"symbol"`
			} `json:"meta"`
			Timestamp  []int64 `json:"timestamp"`
			Indicators struct {
				Quote []struct {
					Close []*float64 `json:"close"`
				} `json:"quote"`
			} `json:"indicators"`
		} `json:"result"`
	} `json:"chart"`
}

// investorPriceContext turns daily closes into the factual filing-to-latest
// price observation. ok=false means the context is omitted, never estimated.
func investorPriceContext(ticker string, filedAt time.Time, timeout time.Duration) (investorMarketContext, bool) {
	ticker = strings.TrimSpace(ticker)
	if ticker == "" || strings.HasPrefix(strings.ToUpper(ticker), "CIK") || len(ticker) > 8 {
		return investorMarketContext{}, false
	}
	// The range form is what Yahoo serves reliably; one month covers the
	// fourteen-day baseline window the desk allows.
	url := fmt.Sprintf("%s%s?interval=1d&range=1mo", getenv("NEWSJACK_MARKET_CHART_BASE_URL", investorMarketChartBase), strings.ReplaceAll(ticker, "^", "%5E"))
	body, err := investorMarketFetch(url, timeout)
	if err != nil {
		time.Sleep(time.Second)
		body, err = investorMarketFetch(url, timeout)
	}
	if err != nil {
		return investorMarketContext{}, false
	}
	var payload investorChartResponse
	if json.Unmarshal(body, &payload) != nil || len(payload.Chart.Result) == 0 {
		return investorMarketContext{}, false
	}
	chart := payload.Chart.Result[0]
	if len(chart.Timestamp) == 0 || len(chart.Indicators.Quote) == 0 || len(chart.Indicators.Quote[0].Close) != len(chart.Timestamp) {
		return investorMarketContext{}, false
	}
	closes := chart.Indicators.Quote[0].Close
	type point struct {
		date  time.Time
		close float64
	}
	var points []point
	for index, stamp := range chart.Timestamp {
		if index >= len(closes) || closes[index] == nil || *closes[index] <= 0 {
			continue
		}
		points = append(points, point{date: time.Unix(stamp, 0).UTC(), close: *closes[index]})
	}
	baselineIndex := -1
	for index, candidate := range points {
		if !candidate.date.After(filedAt) {
			baselineIndex = index
		} else {
			break
		}
	}
	if baselineIndex < 0 || baselineIndex > len(points)-1 {
		return investorMarketContext{}, false
	}
	baseline := points[baselineIndex]
	if filedAt.Sub(baseline.date) > 14*24*time.Hour {
		return investorMarketContext{}, false
	}
	latest := points[len(points)-1]
	if latest.close <= 0 || baseline.close <= 0 {
		return investorMarketContext{}, false
	}
	change := math.Round((latest.close/baseline.close-1)*1000) / 10
	return investorMarketContext{
		Ticker:        ticker,
		BaselineDate:  baseline.date.Format("2006-01-02") + "T00:00:00.000Z",
		BaselineClose: math.Round(baseline.close*100) / 100,
		LatestDate:    latest.date.Format("2006-01-02") + "T00:00:00.000Z",
		LatestClose:   math.Round(latest.close*100) / 100,
		ChangePercent: change,
		Source:        "yahoo_finance",
		ObservedAt:    time.Now().UTC().Format(time.RFC3339Nano),
	}, true
}

// investorTickerIsPlaceholder reports whether the ticker field actually holds
// a CIK identity (a non-listed filer) rather than a listed symbol; price
// context is omitted for those, never estimated.
func investorTickerIsPlaceholder(ticker string) bool {
	trimmed := strings.TrimSpace(ticker)
	if trimmed == "" || strings.HasPrefix(strings.ToUpper(trimmed), "CIK") {
		return true
	}
	allDigits := true
	for _, r := range trimmed {
		if r < '0' || r > '9' {
			allDigits = false
			break
		}
	}
	return allDigits
}
