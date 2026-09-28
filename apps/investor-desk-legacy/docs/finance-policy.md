# Finance policy

This document defines the financial behavior of Signal Desk version 0.1.

## Output type

Signal Desk is a research-prioritization tool. Its output is an ordered queue of public-company source records.

The attention score ranks records for inspection. It does not estimate a security's value or expected return.

The analyst remains responsible for interpreting the filing and making an investment decision.

## Authoritative facts

The first release does not calculate revenue, earnings, valuation, return, risk, exposure, or portfolio performance.

The first release stores filing metadata, source URLs, issuer identity, filing type, filing date, observation time, source digest, bounded extracted source text, extraction digest and parser version, and analyst review state.

## Time rules

Signal Desk stores the filing's publication or filing time separately from the time Signal Desk observed the record.

The interface does not use the browser's current time as the source publication time.

The source precision is stored with the timestamp. A date-only SEC value remains date-only.

## Identity rules

An issuer, a ticker, and a filing are different records.

The watchlist stores issuer identity with a CIK and ticker. SEC records use the provider and native accession or document identifier as their source key.

The database upsert keeps one record for one provider and native identifier. A refresh does not create a second record for the same source.

## Screening rules

The current score uses fixed integer weights for the four JEv-returned dimensions of materiality, novelty, market sensitivity, and thesis link, plus SEC source reliability.

JEv is an input to triage, not an authority over the investment decision. The local server validates the response shape, probability distributions, and score range, records the returned model identity, aggregate confidence, and raw typed answers, and stores no event when a required answer is missing or malformed. Document completeness means the primary SEC document was extracted without truncation and no unfetched exhibit reference was detected. If extraction is truncated or an exhibit is referenced, the result is marked incomplete, source reliability is reduced, and the event is forced into the human review lane.

The score, component values, aggregate JEv confidence, and raw typed answers are stored with the event. The interface shows the component values, provider model, and confidence.

If aggregate JEv confidence is below 50/100, code forces the event into the human review lane even when its raw composite score is low. This is a routing policy, not a claim that the model is wrong.

If source retrieval fails, Signal Desk keeps the prior data, records the source health state, and reports the failure. It does not replace a failed source with an unmarked estimate.

## Future extensions

Any feature that introduces financial numbers must add explicit fields for units, currency, period, accounting basis, actual or estimate status, source availability time, and precision.

Any historical test must prevent information available after the decision time from entering the result.

Any performance claim must account for selection bias, survivorship, liquidity, costs, and the difference between research prioritization and investment returns.
