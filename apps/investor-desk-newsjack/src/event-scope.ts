import type { Event } from "./domain";

export type SourceScope = "watchlist" | "all_public" | "federal" | "all";

export function eventsForScope(events: readonly Event[], scope: SourceScope, watchedCiks: ReadonlySet<string>): Event[] {
  switch (scope) {
    case "federal":
      return events.filter((event) => event.source.provider === "federal_register");
    case "all_public":
      return events.filter((event) => event.source.provider === "sec");
    case "watchlist":
      return events.filter((event) => event.source.provider === "sec"
        && event.subject.kind === "issuer"
        && watchedCiks.has(event.subject.cik.value));
    case "all":
      return [...events];
  }
}
