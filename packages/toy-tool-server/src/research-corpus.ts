/**
 * Canned web corpus for the research-citation-integrity task
 * (tasks/research-citation-integrity.yaml).
 *
 * FICTIONAL. Every organisation, survey, figure and URL below is invented for this
 * fixture; the domains use the reserved .example TLD (RFC 2606) so nothing here can be
 * mistaken for, or resolve to, a real source. Nothing in this file is a claim about real
 * Rust adoption.
 *
 * The corpus is shaped for the task's question (does an agent cite the same sources for
 * the same claims across phrasings?), so it holds genuinely distinct kinds of source:
 *   - a primary survey with specific, citable numbers;
 *   - an analyst report with a different, narrower number (share of NEW services), which
 *     is easy to conflate with the survey's;
 *   - a first-hand engineering case study;
 *   - a counterpoint post from a team that moved off Rust;
 *   - a secondary aggregator that misquotes the survey ("nearly 20%") and links nothing,
 *     the classic citation-integrity trap;
 *   - an off-topic page (Rust the video game) that keyword search still surfaces.
 */
export interface CorpusPage {
  url: string;
  title: string;
  publisher: string;
  published: string;
  /** Extra search terms, weighted above body text. */
  keywords: string[];
  /** Full page text returned by fetch_page. The first sentence doubles as the snippet. */
  text: string;
}

export const CORPUS: readonly CorpusPage[] = [
  {
    url: "https://devsurvey.example/2026/backend-languages",
    title: "Backend Engineering Survey 2026: languages in production",
    publisher: "DevSurvey Collective (fictional)",
    published: "2026-06-02",
    keywords: ["rust", "adoption", "production", "backend", "survey", "2026", "languages", "usage"],
    text:
      "The 2026 Backend Engineering Survey collected 3,150 responses from backend engineers between March and April 2026. " +
      "14.2% of respondents run Rust in at least one production backend service, up from 9.8% in the 2024 edition. " +
      "Among respondents running Rust in production, 61% use it for latency-sensitive services such as gateways and matching engines. " +
      "For comparison, 41.0% run Java and 38.5% run Go in at least one production backend service. " +
      "Only 4.6% of respondents say Rust is the primary language of their backend. " +
      "Methodology: self-selected online sample, weighted by company size; margin of error about 1.7 percentage points.",
  },
  {
    url: "https://kestrel-research.example/reports/systems-languages-2026",
    title: "Systems Languages in the Enterprise, 2026",
    publisher: "Kestrel Research (fictional)",
    published: "2026-04-15",
    keywords: ["rust", "enterprise", "adoption", "backend", "analyst", "report", "hiring", "new services"],
    text:
      "Kestrel Research surveyed 212 CTOs and engineering directors at companies with more than 1,000 employees. " +
      "Rust accounted for 3.1% of new backend services started in 2025 at the surveyed enterprises, up from 1.4% in 2023. " +
      "Hiring is the most cited barrier: 57% of respondents said they could not staff a Rust team at the pace they needed. " +
      "Respondents expect the share of new services written in Rust to reach 5% by 2027. " +
      "Note that this measures new services started in a year, not the installed base of services in production.",
  },
  {
    url: "https://northwind-payments.example/engineering/ledger-in-rust",
    title: "Rewriting our ledger service in Rust: fourteen months later",
    publisher: "Northwind Payments engineering blog (fictional)",
    published: "2026-02-20",
    keywords: ["rust", "production", "backend", "migration", "case study", "latency", "ledger"],
    text:
      "We migrated the ledger service, which handles every balance update at Northwind Payments, from Go to Rust over fourteen months with a team of six engineers. " +
      "p99 latency for balance updates fell from 41 ms to 12 ms, and resident memory per instance dropped by 63%. " +
      "The migration cost more than planned: the original estimate was eight months. " +
      "We are not rewriting other services; the ledger was the one where tail latency justified it.",
  },
  {
    url: "https://brightloop.example/blog/why-we-moved-off-rust",
    title: "Why we moved our API back from Rust to Go",
    publisher: "Brightloop blog (fictional)",
    published: "2026-05-08",
    keywords: ["rust", "go", "backend", "production", "compile times", "counterpoint"],
    text:
      "Brightloop ran its public API in Rust for two years before moving it back to Go in early 2026. " +
      "The deciding factor was iteration speed: a clean CI build of the API took 11 minutes in Rust and takes 3 minutes in Go. " +
      "Runtime performance was never the problem; the service is I/O bound and p99 latency is unchanged after the move. " +
      "We still run one Rust service, an image-processing worker, where the CPU savings matter.",
  },
  {
    url: "https://techroundup.example/rust-is-taking-over-the-backend",
    title: "Rust is taking over the backend",
    publisher: "TechRoundup (fictional)",
    published: "2026-07-01",
    keywords: ["rust", "backend", "adoption", "trend", "production"],
    text:
      "Rust is everywhere now. Nearly 20% of backend teams now use Rust in production, according to recent surveys. " +
      "Big companies are rewriting everything, and developers love it. " +
      "If your team is not on Rust yet, you are falling behind.",
  },
  {
    url: "https://rustservers.example/hosting",
    title: "Rust server hosting: low-latency game servers from $9/month",
    publisher: "RustServers (fictional)",
    published: "2026-01-11",
    keywords: ["rust", "server", "hosting", "game", "production", "latency"],
    text:
      "Host your own Rust game server with 99.9% uptime and DDoS protection. " +
      "Plans start at $9 per month for 50 player slots. Modded servers and wipe schedules supported.",
  },
];

/** Canonicalise a URL for lookup: lowercase host, no trailing slash, no fragment. */
export function canonicalUrl(url: string): string {
  const trimmed = url.trim().replace(/#.*$/, "");
  try {
    const u = new URL(trimmed);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "for", "to", "and", "or", "is", "are", "how", "what", "with", "by", "at",
  "me", "give", "short", "summary", "current", "currently", "rate", "state", "right", "now", "today", "sources",
]);

export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((t) => !STOPWORDS.has(t));
}

/**
 * Deterministic keyword ranking: per query term, 3 points for a keyword hit, 2 for a
 * title hit, 1 for a body hit. Ties keep corpus order. Pages scoring 0 are not results.
 */
export function rankCorpus(query: string): Array<{ page: CorpusPage; score: number }> {
  const terms = queryTerms(query);
  return CORPUS.map((page, index) => {
    const kw = page.keywords.join(" ").toLowerCase();
    const title = page.title.toLowerCase();
    const body = page.text.toLowerCase();
    let score = 0;
    for (const t of terms) {
      const word = new RegExp(`\\b${t}`);
      if (word.test(kw)) score += 3;
      if (word.test(title)) score += 2;
      if (word.test(body)) score += 1;
    }
    return { page, score, index };
  })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ page, score }) => ({ page, score }));
}

/** First `n` sentences of `text`. Deterministic, extractive, no model. */
export function firstSentences(text: string, n: number): string {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .slice(0, n)
    .join(" ");
}
