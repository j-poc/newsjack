package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type investorFederalScanResult struct {
	Filings  []investorFiling
	Failures []investorSourceFailure
	Observed string
}

var federalCodePattern = regexp.MustCompile(`[^A-Z0-9-]+`)

func scanInvestorFederal(since time.Time, opts investorSECScanOptions) investorFederalScanResult {
	now := time.Now().UTC()
	result := investorFederalScanResult{Observed: now.Format(time.RFC3339Nano)}
	endpoint := strings.TrimRight(getenv("NEWSJACK_FEDERAL_REGISTER_BASE_URL", investorFederalRegisterURL), "/")
	query := url.Values{}
	query.Set("per_page", fmt.Sprint(maxInt(opts.MaxFilings, 1)))
	query.Set("order", "newest")
	query.Set("conditions[publication_date][gte]", since.UTC().Format("2006-01-02"))
	body, err := investorHTTPGet(endpoint+"?"+query.Encode(), opts.UserAgent, opts.Timeout)
	if err != nil {
		result.Failures = append(result.Failures, investorSourceFailure{Stage: "federal_register_index", Error: cleanError(err.Error())})
		return result
	}
	if strings.TrimSpace(opts.RunDir) == "" {
		result.Failures = append(result.Failures, investorSourceFailure{Stage: "federal_register_capture", Error: "run directory is required for raw Federal Register capture"})
		return result
	}
	rawPath := filepath.Join(expandPath(opts.RunDir), "raw", "federal-register", sha256Hex(body)+".json")
	if err := atomicWriteInvestorFile(rawPath, body); err != nil {
		result.Failures = append(result.Failures, investorSourceFailure{Stage: "federal_register_capture", Error: cleanError(err.Error())})
		return result
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		result.Failures = append(result.Failures, investorSourceFailure{Stage: "federal_register_index", Error: cleanError(err.Error())})
		return result
	}
	results := anySlice(payload["results"])
	if len(results) == 0 {
		result.Failures = append(result.Failures, investorSourceFailure{Stage: "federal_register_index", Error: "Federal Register returned no documents in the requested window"})
		return result
	}
	for _, raw := range results {
		doc := valueOrEmptyMap(raw)
		filing, err := federalFilingFromDocument(doc, body, rawPath, result.Observed, since, opts)
		if err != nil {
			result.Failures = append(result.Failures, investorSourceFailure{Stage: "federal_register_document", Identity: stringValue(doc["document_number"]), Error: cleanError(err.Error())})
			continue
		}
		result.Filings = append(result.Filings, filing)
		if len(result.Filings) >= opts.MaxFilings {
			break
		}
	}
	return result
}

func federalFilingFromDocument(doc map[string]any, indexBody []byte, rawIndexPath, observed string, since time.Time, opts investorSECScanOptions) (investorFiling, error) {
	number := strings.TrimSpace(stringValue(doc["document_number"]))
	if number == "" {
		return investorFiling{}, errors.New("Federal Register document has no document_number")
	}
	publication := strings.TrimSpace(stringValue(doc["publication_date"]))
	available, err := parseSECInvestorTime(publication, "day")
	if err != nil {
		return investorFiling{}, fmt.Errorf("invalid publication_date: %w", err)
	}
	availableTime, _ := time.Parse(time.RFC3339Nano, available.Value)
	if availableTime.Before(since) {
		return investorFiling{}, errors.New("document is outside requested window")
	}
	name, code := federalAgencyIdentity(doc)
	issuer := investorIssuer{CIK: "0000000000", Ticker: "FED", Name: name}
	title := strings.TrimSpace(stringValue(doc["title"]))
	htmlURL := strings.TrimSpace(stringValue(doc["html_url"]))
	rawTextURL := strings.TrimSpace(stringValue(doc["raw_text_url"]))
	abstract := strings.TrimSpace(stringValue(doc["abstract"]))
	raw := []byte(strings.Join([]string{title, abstract}, "\n\n"))
	capturedDocument := false
	if rawTextURL != "" {
		if fetched, fetchErr := investorHTTPGet(rawTextURL, opts.UserAgent, opts.Timeout); fetchErr == nil && len(fetched) > 0 {
			if !investorLooksLikeAccessChallenge(fetched) {
				raw = fetched
				capturedDocument = true
			}
		}
	}
	if len(raw) == len([]byte(strings.Join([]string{title, abstract}, "\n\n"))) && htmlURL != "" {
		if fetched, fetchErr := investorHTTPGet(htmlURL, opts.UserAgent, opts.Timeout); fetchErr == nil && len(fetched) > 0 {
			if !investorLooksLikeAccessChallenge(fetched) {
				raw = fetched
				capturedDocument = true
			}
		}
	}
	text, complete, reason := normalizeInvestorDocument(raw, opts.MaxChars)
	if text == "" {
		return investorFiling{}, errors.New("Federal Register document contained no readable text")
	}
	if !capturedDocument {
		complete = false
		reason = "abstract_only"
	}
	summary := strings.TrimSpace(abstract)
	if summary == "" {
		summary = federalTitleSummary(name, title)
	}
	return investorFiling{
		Issuer: issuer, Form: firstString(stringValue(doc["type"]), "FEDERAL_REGISTER"),
		Accession: number, PrimaryDocument: number, PrimaryDescription: title,
		FiledAt: available, AvailableAt: available, AcceptanceRaw: "", ReportDate: publication,
		NativeID: "FR:" + number, URL: htmlURL, SubmissionDigest: sha256Hex(indexBody),
		DocumentDigest: sha256Hex(raw), NormalizedDigest: sha256Hex([]byte(text)), ObservedAt: observed,
		Text: text, SummaryText: summary, TextComplete: complete, CompletenessReason: reason,
		RawBytes: len(indexBody), DocumentBytes: len(raw), RawBody: raw,
		RawSubmissionPath: rawIndexPath,
		SourceProvider:    "federal_register", SubjectKind: "agency", SubjectCode: code, SubjectName: name,
	}, nil
}

func federalTitleSummary(agency, title string) string {
	cleanAgency := firstString(strings.TrimSpace(agency), "Federal agency")
	cleanTitle := strings.TrimSpace(title)
	lower := strings.ToLower(cleanTitle)
	if strings.HasPrefix(lower, "order granting ") {
		body := strings.TrimSpace(cleanTitle[len("Order Granting "):])
		if index := strings.Index(strings.ToLower(body), ", pursuant"); index >= 0 {
			body = strings.TrimSpace(body[:index])
		}
		return fmt.Sprintf("%s grants %s.", cleanAgency, lowerFirstInvestor(body))
	}
	if strings.HasPrefix(lower, "notice of ") {
		return fmt.Sprintf("%s issues a notice on %s.", cleanAgency, lowerFirstInvestor(strings.TrimSpace(cleanTitle[len("Notice of "):])))
	}
	if strings.HasPrefix(lower, "proposed rule") {
		return fmt.Sprintf("%s proposes a rule on %s.", cleanAgency, lowerFirstInvestor(strings.TrimSpace(cleanTitle[len("Proposed Rule"):])))
	}
	return fmt.Sprintf("%s publishes a filing about %s.", cleanAgency, lowerFirstInvestor(cleanTitle))
}

func lowerFirstInvestor(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return value
	}
	return strings.ToLower(value)
}

func investorLooksLikeAccessChallenge(raw []byte) bool {
	value := strings.ToLower(string(raw))
	for _, marker := range []string{"captcha", "request access", "aggressive automated scraping", "your request has been flagged"} {
		if strings.Contains(value, marker) {
			return true
		}
	}
	return false
}

func federalAgencyIdentity(doc map[string]any) (string, string) {
	agencies := anySlice(doc["agencies"])
	if len(agencies) > 0 {
		agency := valueOrEmptyMap(agencies[0])
		name := strings.TrimSpace(stringValue(agency["name"]))
		slug := strings.ToUpper(strings.TrimSpace(stringValue(agency["slug"])))
		if slug == "" {
			slug = strings.ToUpper(name)
		}
		code := federalCodePattern.ReplaceAllString(slug, "-")
		code = strings.Trim(code, "-")
		if len(code) > 24 {
			code = code[:24]
		}
		if len(code) >= 2 {
			return firstString(name, "Federal Register"), code
		}
	}
	return "Federal Register", "FEDERAL"
}
