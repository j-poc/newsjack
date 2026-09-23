import type { ReactElement } from "react";
import type { WatchlistEntry } from "./domain";

type WatchlistEntriesProps = {
  entries: readonly WatchlistEntry[];
  busy: boolean;
  onRemove: (issuer: WatchlistEntry["issuer"]) => void;
};

export function WatchlistEntries({ entries, busy, onRemove }: WatchlistEntriesProps): ReactElement | null {
  if (entries.length === 0) return null;

  return (
    <ul className="watchlist-entries" aria-label="Companies on your personal watchlist">
      {entries.map(({ issuer }) => (
        <li key={issuer.cik.value}>
          <span className="watchlist-company"><strong>{issuer.name}</strong><code>{issuer.ticker.value}</code></span>
          <button type="button" disabled={busy} aria-label={`Remove ${issuer.name} from watchlist`} onClick={() => onRemove(issuer)}><span aria-hidden="true">×</span></button>
        </li>
      ))}
    </ul>
  );
}
