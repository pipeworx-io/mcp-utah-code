interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


/**
 * HTML-to-text helpers shared by the state statute packs.
 *
 * One decoder rather than one per pack, because the copies had already begun
 * to drift: the hex-entity case (&#x2003; em space, &#x2014; em dash) was
 * handled in Florida's copy and not California's, so Californian statutes were
 * quietly emitting raw entities where punctuation belonged. Fixed once here.
 *
 * publish-pack.sh inlines workspace imports, so a standalone pack still ships
 * self-contained.
 */

const SCRIPT = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK = /<\/?(p|div|br|tr|li|h[1-6]|blockquote)\b[^>]*>/gi;

/** Convert a slice of statute HTML to readable plain text. */
function statuteText(html: string): string {
  return html
    .replace(/\r\n?/g, '\n')
    .replace(SCRIPT, ' ')
    .replace(BLOCK, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // Hex before decimal: legislature sites emit &#x2003; and &#x2014;
    // constantly, and a decimal-only decoder leaves them in the middle of the
    // statute looking like markup noise.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&sect;/g, '\u00a7')
    // Named entities that carry MEANING, decoded before the catch-all below.
    // This was a real defect: the catch-all replaced &ndash; with a SPACE, so
    // Maryland's "&sect;2&ndash;201." decoded to "2 201" and a lookup for
    // section 2-201 reported a statute that plainly exists as missing. Dashes
    // are everywhere in statutory text and numbering, so the corruption was
    // silent and general rather than particular to one state.
    .replace(/&ndash;/g, '\u2013')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&rsquo;|&apos;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&ldquo;/g, '\u201c')
    .replace(/&rdquo;/g, '\u201d')
    .replace(/&hellip;/g, '\u2026')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Text from a container, starting AFTER its opening tag.
 *
 * Slicing at the marker itself leaves the tail of the tag — `laws-body">` — as
 * the first characters of the statute, which is exactly what three packs did
 * before testing caught it.
 */
function textFromContainer(html: string, marker: string | RegExp): string | null {
  const i = typeof marker === 'string' ? html.indexOf(marker) : html.search(marker);
  if (i === -1) return null;
  const gt = html.indexOf('>', i);
  return statuteText(html.slice(gt === -1 ? i : gt + 1));
}

/**
 * Read a statute response as text, honouring its actual encoding.
 *
 * Several state sites serve WINDOWS-1252 while sending `content-type:
 * text/html` with no charset. Response.text() assumes UTF-8, so their smart
 * quotes and non-breaking spaces decode to replacement characters — Nevada
 * rendered `"Murder" defined` as mojibake, and Oregon's section headings
 * became unmatchable because the "space" after the section number is a 0xA0
 * that never survived the decode.
 *
 * That is the quiet kind of damage: the text still looks like text, so nothing
 * errors, and a heading regex simply stops matching for reasons no one can see
 * in the output.
 *
 * Strict UTF-8 first — if the bytes really are UTF-8 this succeeds and nothing
 * changes — then fall back to windows-1252, which decodes every byte and so
 * cannot itself fail.
 */
async function readStatuteResponse(res: Response): Promise<string> {
  const buf = await res.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/**
 * Cut one section out of a page that holds a whole chapter.
 *
 * A section number appears several times on these pages and only one of them
 * starts the statute. The others are a table-of-contents entry at the top and
 * cross-references inside neighbouring sections. Picking the FIRST match
 * returns a heading with nothing under it; picking the LAST returns whatever
 * fragment follows a cross-reference. Both were tried and both produced
 * confident, tiny, wrong answers — Oregon 140 characters, Nevada 39, each
 * looking like a real result.
 *
 * The body is simply the candidate with the most text before the next section
 * begins, which is true regardless of where the page puts its contents list.
 *
 * @param heading matches the start of the wanted section (global flag required)
 * @param next    matches the start of ANY section, to bound the slice
 */
function sliceSection(text: string, heading: RegExp, next: RegExp): string | null {
  // Record where each candidate starts AND how long its heading is. Skipping
  // only one character past the start lets the  pattern re-match the very
  // heading we just found, which yields an empty body — that bug returned
  // section_not_found for a section plainly present on the page.
  const found: Array<{ at: number; len: number }> = [];
  const re = new RegExp(heading.source, heading.flags.includes('g') ? heading.flags : heading.flags + 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    found.push({ at: m.index, len: m[0].length });
    if (re.lastIndex === m.index) re.lastIndex++;   // guard zero-width matches
  }
  if (!found.length) return null;

  let best: string | null = null;
  for (const { at, len } of found) {
    const from = at + len;
    const nre = new RegExp(next.source, next.flags.includes('g') ? next.flags : next.flags + 'g');
    const m = nre.exec(text.slice(from));
    const body = (m ? text.slice(at, from + m.index) : text.slice(at)).trim();
    if (body.length > (best?.length ?? 0)) best = body;
  }
  return best && best.length > 0 ? best : null;
}
/**
 * Utah Code — state statutes by citation, plus topic search.
 *
 * REACHED THROUGH THE EGRESS RELAY, NOT DIRECTLY (fleet #2740, 2026-10-07).
 * le.utah.gov sends a LEAF-ONLY certificate chain — its Sectigo "Public Server
 * Authentication CA OV R36" intermediate is missing, so `openssl s_client
 * -connect le.utah.gov:443 -showcerts` returns exactly ONE certificate and
 * verify error 20 "unable to get local issuer certificate". A live Cloudflare
 * Worker on the production account answers HTTP 526 "Invalid SSL certificate"
 * (3/3 on 2026-10-07, 5/5 on 2026-10-06) and a Worker's `fetch()` has no API to
 * supply the missing intermediate. So every fetch routes through
 * `supabase/functions/egress-proxy`, whose `PINNED_CA` map completes the chain
 * with the authentic intermediate from the leaf's own AIA URI. Verification is
 * never disabled, here or there.
 *
 * WHY who-euro WORKS DIRECTLY AND THIS DOES NOT — the diagnosis to reuse, so
 * nobody spends another session on it. `mcps/who-euro` carries the same cert
 * comment and ships live today, and it was tempting to read that as evidence
 * this block was transient. It is not. Measured from ONE Worker in ONE run,
 * 2026-10-07:
 *
 *   le.utah.gov      -> 526 x3        leaf-only, Sectigo CA OV R36
 *   dw.euro.who.int  -> HTTP 404 x3   leaf-only, Sectigo CA DV R36
 *   example.com      -> 200 x3        (control)
 *
 * who-euro's 404 is an APPLICATION-layer answer, so Cloudflare completed that
 * TLS handshake. Both hosts are leaf-only, both intermediates are Sectigo R36
 * siblings off the same Root R46 — so the chain SHAPE is not what CF objects
 * to. CF completes some missing intermediates from its own cached pool and not
 * others; DV R36 is far more widely deployed across the web than OV R36, which
 * is the likely reason, but the mechanism is Cloudflare-internal and not
 * something we can inspect. Treat it as measured per host, never predicted.
 *
 * THE TRAP, and the one-minute diagnostic for the next pack with this shape:
 *
 *   openssl s_client -connect <host>:443 -servername <host> -showcerts \
 *     2>/dev/null | grep -c 'BEGIN CERT'        # 1 => leaf-only chain
 *
 * A local Node or Deno failure proves NOTHING about Cloudflare. Deno's rustls
 * chases no AIA and caches no intermediates, so it refuses EVERY leaf-only
 * host — including dw.euro.who.int, which CF serves fine. Only a live
 * `wrangler dev --remote` probe answers the question that matters, and if it
 * 526s the fix is a `PINNED_CA` entry in the relay — one host, one authentic
 * intermediate — rather than an ingest-and-store rebuild of the corpus.
 *
 * SOURCE: the August state-law survey (docs/state-law-probe.md) lumped Utah
 * in with "client-rendered or bot-walled" states. That was true of the
 * SECTION VIEWER PAGE (le.utah.gov/xcode/Title<T>/Chapter<C>/<T>-<C>-S<S>.html)
 * — it is a template whose statute body is injected by client-side JS, so a
 * bare fetch returns the chrome with an EMPTY `#viewbox`/`#secdiv`. It is not
 * bot-walled, though: no UA check, no cookie, no challenge — curl with a bare
 * default UA gets the same 200 a browser does. The page just doesn't carry
 * the text.
 *
 * What it DOES carry, inline in a <script> block, is the exact filename of
 * the current version's CONTENT document:
 *
 *   var versionDefault="C76-5-S203_2026050620260506";
 *
 * That document — `<versionDefault>.html` in the SAME directory — is a
 * plain, un-rendered HTML fragment (no JS, no SPA shell) with the full
 * statutory text, breadcrumbs, effective date, and a trailing "Amended by
 * Chapter N, YYYY General Session" history note. Two live GETs per citation,
 * zero JS execution, both keyless:
 *
 *   1. .../Title76/Chapter5/76-5-S203.html          -> read versionDefault
 *   2. .../Title76/Chapter5/C76-5-S203_<date>.html   -> read the statute
 *
 * The same page also offers that content as PDF/RTF/XML (same basename,
 * different extension) — the XML is clean structured markup, but it drops
 * the subsection letters as literal text (they're only in a `number`
 * attribute), so the un-rendered HTML fragment is the better PLAIN-TEXT
 * source despite being "HTML": it already has "(1)", "(a)", "(i)" printed
 * as cell text ahead of each clause, which the Code's own XML does not.
 *
 * TOPIC SEARCH: le.utah.gov's nav bar links a "Keyword Search" for the Code
 * to /solrsearch.jsp?ktype=Code, which is itself just a results shell driven
 * by client JS — but that JS calls a plain keyless Solr proxy directly:
 *
 *   https://le.utah.gov/servlet/solrproxy9?q=<term>&fq=category:Code&wt=json
 *
 * which returns real JSON hits (id/name/title/url) across every Code
 * section — confirmed live, 55 hits on "murder", 368 on "concealed weapon".
 * ONE PROXY QUIRK, undocumented and easy to miss: it decodes its own query
 * params and forwards them to an internal Solr instance (`LESOLR:8080`)
 * WITHOUT re-encoding — so a literal space in `q` becomes a literal space in
 * the upstream request line and Solr's HTTP server 400s on it. Multi-word
 * queries need the space DOUBLE-encoded (`%2520`, which decodes once to the
 * literal string "%20" and is still valid once forwarded) rather than the
 * normal single `%20`/`+`. `solrSpace()` below does only that one
 * character's special-casing; every other character goes through
 * `encodeURIComponent` normally.
 *
 * HISTORICAL VERSIONS: NOT available through this path, and the task asked
 * to say so explicitly rather than build around it. `versionArr` (the same
 * script block that names the current document) is a vestige of what was
 * once a multi-version picker — every section probed here, amended or not,
 * decades-old or added this session, lists EXACTLY ONE entry labelled
 * "Current Version". le.utah.gov's Code viewer does not publish prior-year
 * full text; it publishes only the amendment CITATION ("Amended by Chapter
 * 356, 2026 General Session") for each change, which this pack surfaces as
 * `history` — the fourth capability (amendments/history) IS available, just
 * not as point-in-time text.
 */

const UA = 'pipeworx-mcp-utah-code/1.0 (+https://pipeworx.io)';
const BASE = 'https://le.utah.gov/xcode';
const SOLR_PROXY = 'https://le.utah.gov/servlet/solrproxy9';

/**
 * le.utah.gov is UNREACHABLE from a Cloudflare Worker directly: it serves a
 * leaf-only certificate chain and the CF edge answers HTTP 526 "Invalid SSL
 * certificate" (3/3 on 2026-10-07, 5/5 on 2026-10-06), with no Workers API to
 * complete the chain or override validation. So every fetch here routes through
 * the Supabase egress relay (`supabase/functions/egress-proxy`), which the
 * gateway addresses by injecting `_proxyUrl`/`_proxyToken` for this slug.
 *
 * The relay is NOT doing an IP-reputation hop for us the way it does for
 * kalshi/loc.gov — it is completing the certificate chain. Its `PINNED_CA` map
 * holds the authentic Sectigo "Public Server Authentication CA OV R36"
 * intermediate (fetched from the AIA URI in le.utah.gov's own leaf) and hands
 * it to `Deno.createHttpClient({ caCerts })`. Verification stays ON; nothing
 * anywhere disables it. Read that map's comment before changing this.
 *
 * Absent the relay (local dev, or a non-CF runtime whose trust store already
 * carries the intermediate — curl and macOS do) we fetch direct, which is why
 * the smoke tests pass on a laptop while the live Worker needed the relay.
 */
type Relay = { url: string; token: string } | null;

function relayFrom(args: Record<string, unknown>): Relay {
  const url = (args._proxyUrl as string | undefined)?.trim();
  const token = (args._proxyToken as string | undefined)?.trim();
  return url && token ? { url, token } : null;
}

async function pwFetch(url: string | URL, relay: Relay, init?: RequestInit): Promise<Response> {
  if (relay) {
    // The relay forwards the target verbatim and returns the upstream response
    // body/status unchanged. `userAgent` must be passed explicitly — the relay
    // strips caller headers by design, so an init.headers UA would be dropped.
    // Its own Accept is `application/json`; le.utah.gov serves the full 26,649
    // byte page regardless (verified), so these pages need no Accept override.
    return fetchWithTimeout(
      relay.url,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${relay.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: String(url), userAgent: UA }),
      },
      'Utah State Legislature (le.utah.gov) via the Pipeworx egress relay',
    );
  }
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'Utah State Legislature (le.utah.gov)');
}

/**
 * The relay synthesizes exactly these `{error}` bodies for a request that never
 * reached le.utah.gov at all — a dead bearer token, the host dropped from its
 * allow-list, a runtime without `Deno.createHttpClient` so the CA pin cannot be
 * built. Every one of those is OUR configuration and must book as our own
 * outage, or relay drift reads as "the Utah Legislature is down" forever
 * (fleet #1096). `upstream_fetch_failed` (502) is deliberately excluded: that
 * is the relay's own fetch failing at the network level, which is a statement
 * about le.utah.gov's reachability, not about our side of the hop.
 */
const RELAY_SELF_ERRORS = new Set([
  'unauthorized',
  'bad_request',
  'bad_url',
  'host_not_allowed',
  'method_not_allowed',
  'pinned_ca_unsupported_runtime',
]);

/**
 * Turn a relay-synthesized refusal into an error that names US as the cause.
 * Returns null when the response is not one of ours, i.e. it really is Utah's
 * answer and should be handled by the caller as before.
 */
async function relaySelfError(res: Response, relay: Relay): Promise<string | null> {
  if (!relay || res.ok) return null;
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return null;
  }
  const code = (body as { error?: unknown } | null)?.error;
  if (typeof code !== 'string' || !RELAY_SELF_ERRORS.has(code)) return null;
  return markInternalOrigin(
    `Pipeworx egress relay refused the request (${code}) — this is our own relay configuration, not le.utah.gov. See supabase/functions/egress-proxy.`,
    relay.url,
    500,
  );
}

interface ParsedCitation {
  title: string;
  chapter: string;
  section: string;
  dir: string;
  viewerUrl: string;
}

/**
 * Utah citations are title-chapter-section, e.g. "76-5-203" (Title 76,
 * Chapter 5, Section 203), "53-5a-102.2" (chapter "5a" — letter-suffixed
 * chapters are normal), or "75E-10-402" (title "75E" — letter-suffixed
 * TITLES are normal too, Title 75E being the Fiduciary Code). The title and
 * chapter are always the first two dash-separated components; everything
 * after that is the section, which itself may contain dots.
 */
function parseCitation(raw: string): ParsedCitation | null {
  const cleaned = raw
    .trim()
    .replace(/^(Utah\s+Code(\s+Ann\.?)?|U\.?C\.?A\.?)\s*/i, '')
    .replace(/§/g, '')
    .replace(/\s+/g, '');
  const m = /^([0-9]+[A-Za-z]?)-([0-9]+[A-Za-z]?)-(.+)$/.exec(cleaned);
  if (!m) return null;
  const [, title, chapter, section] = m;
  const dir = `Title${title}/Chapter${chapter}`;
  return { title, chapter, section, dir, viewerUrl: `${BASE}/${dir}/${title}-${chapter}-S${section}.html` };
}

async function resolveCurrentVersion(viewerUrl: string, relay: Relay): Promise<{ status: number; versionFile: string | null }> {
  const res = await pwFetch(viewerUrl, relay);
  const relayErr = await relaySelfError(res, relay);
  if (relayErr) throw new Error(relayErr);
  if (!res.ok) return { status: res.status, versionFile: null };
  const html = await res.text();
  const m = /var\s+versionDefault\s*=\s*"([^"]*)"/.exec(html);
  return { status: res.status, versionFile: m && m[1] ? m[1] : null };
}

/** Peel the trailing "Amended by Chapter N, YYYY General Session" (or
 *  Enacted/Renumbered/Repealed/Reenacted) note off the end of the statute
 *  text into its own `history` field — same split mcps/indiana-code makes
 *  for its own trailing enactment paragraphs. */
const HISTORY_LINE = /^(Amended|Enacted|Repealed|Renumbered|Reenacted|Added|Superseded)\b.*(General Session|Session)\s*\.?\s*$/i;

function splitHistory(text: string): { text: string; history: string | null } {
  const lines = text.split('\n');
  const history: string[] = [];
  while (lines.length && HISTORY_LINE.test(lines[lines.length - 1].trim())) {
    history.unshift(lines.pop()!.trim());
  }
  return { text: lines.join('\n').trim(), history: history.length ? history.join(' ') : null };
}

interface ContentDoc {
  text: string;
  history: string | null;
  effectiveDate: string | null;
  catchline: string | null;
}

/** Extract the statute body from the un-rendered content HTML fragment
 *  (`C<cite>_<date>.html`). The body lives in `<div id="secdiv">...</div>`,
 *  immediately followed by `<table id="childtbl">`; everything before and
 *  after that is breadcrumbs / download-link chrome, not statutory text. */
function extractContent(html: string): ContentDoc | null {
  const startMarker = '<div id="secdiv">';
  const si = html.indexOf(startMarker);
  if (si === -1) return null;
  const contentStart = si + startMarker.length;
  const ei = html.indexOf('<table id="childtbl">', contentStart);
  const raw = html.slice(contentStart, ei === -1 ? html.length : ei);

  const effMatch = /Effective\s+([0-9/]+)/.exec(raw);

  // The section catchline is in the breadcrumb table just above `secdiv`,
  // e.g. `Section 203</td><td style="font-weight:bold">Murder -- Penalties...`
  const catchMatch = /Section\s+[^<]*<\/td>\s*<td style="font-weight:bold">\s*([^<]+?)\s*(?:<div|<\/td)/.exec(html);

  const { text, history } = splitHistory(statuteText(raw));
  return {
    text,
    history,
    effectiveDate: effMatch ? effMatch[1] : null,
    catchline: catchMatch ? catchMatch[1].replace(/\s+/g, ' ').trim() : null,
  };
}

async function utCodeSection(args: Record<string, unknown>) {
  const relay = relayFrom(args);
  const rawInput = String(args.section ?? '').trim();
  if (!rawInput) {
    return {
      found: false, reason: 'empty_section',
      message: 'ut_code_section needs a `section` — e.g. "76-5-203".',
    };
  }
  const parsed = parseCitation(rawInput);
  if (!parsed) {
    return {
      found: false, reason: 'unparsed_section',
      message: `"${rawInput}" is not a Utah Code citation.`,
      hint: 'Utah sections are title-chapter-section, e.g. "76-5-203" (murder, Title 76 Utah Criminal Code) or "53-5a-102.2" (concealed carry — chapter "5a" with a letter suffix is normal).',
    };
  }

  const { status, versionFile } = await resolveCurrentVersion(parsed.viewerUrl, relay);
  if (status === 404) {
    return {
      found: false, reason: 'section_not_found', section: rawInput,
      message: `No Utah Code section "${rawInput}" — Title ${parsed.title}, Chapter ${parsed.chapter} has no section ${parsed.section}.`,
      hint: 'Section numbers are not contiguous — repealed/renumbered sections are normal. Check the citation, or use ut_code_search.',
      data_as_of: new Date().toISOString(),
    };
  }
  if (status !== 200 || !versionFile) {
    return {
      found: false, reason: 'unresolved_version', section: rawInput,
      message: `Utah Code section "${rawInput}" resolved to a page but no current version could be determined.`,
      viewer_url: parsed.viewerUrl,
      data_as_of: new Date().toISOString(),
    };
  }

  const contentUrl = `${BASE}/${parsed.dir}/${versionFile}.html`;
  const contentRes = await pwFetch(contentUrl, relay);
  const contentRelayErr = await relaySelfError(contentRes, relay);
  if (contentRelayErr) throw new Error(contentRelayErr);
  if (!contentRes.ok) {
    return {
      found: false, reason: 'content_fetch_failed', section: rawInput,
      message: `Utah Code section "${rawInput}" has a current version but its content document returned HTTP ${contentRes.status}.`,
      content_url: contentUrl,
      data_as_of: new Date().toISOString(),
    };
  }
  const html = await contentRes.text();
  const doc = extractContent(html);
  if (!doc || doc.text.length < 10) {
    return {
      found: false, reason: 'empty_section', section: rawInput,
      message: `Section ${rawInput} resolved but returned no usable text — it may be repealed or reserved.`,
      content_url: contentUrl,
      data_as_of: new Date().toISOString(),
    };
  }

  return {
    found: true,
    citation: `${parsed.title}-${parsed.chapter}-${parsed.section}`,
    title: parsed.title,
    chapter: parsed.chapter,
    section: parsed.section,
    catchline: doc.catchline,
    text: doc.text,
    text_chars: doc.text.length,
    effective_date: doc.effectiveDate,
    history: doc.history,
    historical_versions_available: false,
    url: contentUrl,
    viewer_url: parsed.viewerUrl,
    source: 'Utah State Legislature (le.utah.gov), live fetch, keyless',
    attribution: 'Utah Code is public record, codified by the Legislature\'s Office of Legislative Research and General Counsel.',
    data_as_of: new Date().toISOString(),
  };
}

/** Utah's own Solr proxy decodes its query params and forwards them
 *  unescaped to an internal Solr server, which 400s on a literal space in
 *  the request line. Double-encoding ONLY the space (so the proxy's single
 *  decode leaves a harmless, still-valid "%20" rather than a raw space)
 *  works around it; every other character is encoded normally. */
function solrEncode(term: string): string {
  return encodeURIComponent(term).replace(/%20/g, '%2520');
}

/** A hit's `id`/`url` is a section viewer page
 *  (.../Title76/Chapter5/76-5-S203.html) or, for a Part/Chapter/Title index
 *  page, a different filename shape (.../76-5-P2.html, .../76-5.html,
 *  .../76.html). Only the section shape maps cleanly to a citation, so
 *  non-section hits are filtered out rather than mis-citationed. */
function citationFromUrl(url: string): string | null {
  const m = /\/([0-9]+[A-Za-z]?-[0-9]+[A-Za-z]?)-S([^/]+)\.html$/.exec(url);
  return m ? `${m[1]}-${m[2]}` : null;
}

async function utCodeSearch(args: Record<string, unknown>) {
  const relay = relayFrom(args);
  const q = String(args.query ?? '').trim();
  if (!q) {
    return {
      found: false, reason: 'empty_query',
      message: 'ut_code_search needs a `query` — search by topic, e.g. "concealed weapon permit".',
      hint: 'To look up a known citation use ut_code_section instead.',
    };
  }
  // UPSTREAM HARD CAP OF 10, measured 2026-10-07 (fleet #2740): the solrproxy9
  // endpoint IGNORES `rows` outright — rows=10, rows=20 and rows=50 all return
  // exactly 10 docs against numFound=2821. So `limit` is clamped to 10 rather
  // than the 25 this tool used to advertise; a higher ceiling would be a silent
  // cap, promising 25 and delivering 10 with a clean 200. `total_matches` below
  // still reports the real numFound, so the caller can see what was truncated.
  const limit = Math.min(10, Math.max(1, Number(args.limit) || 10));
  const fetchRows = 10;
  const url = `${SOLR_PROXY}?q=${solrEncode(q)}&fq=category:Code&fl=id,name,title,url&wt=json&rows=${fetchRows}`;
  const res = await pwFetch(url, relay);
  const searchRelayErr = await relaySelfError(res, relay);
  if (searchRelayErr) throw new Error(searchRelayErr);
  if (!res.ok) {
    return {
      found: false, reason: 'search_unavailable',
      message: `The Utah Code search index returned HTTP ${res.status}. This is an infrastructure failure, not an absence of matching sections.`,
    };
  }
  const json = (await res.json()) as {
    response?: { numFound?: number; docs?: Array<{ id?: string; name?: string[]; title?: string; url?: string }> };
  };
  const docs = json.response?.docs ?? [];
  type SearchHit = { citation: string; title: string | null; url: string };
  const results = docs
    .map((d): SearchHit | null => {
      const url2 = d.url ?? d.id ?? '';
      const citation = citationFromUrl(url2);
      if (!citation) return null;
      return { citation, title: d.title ?? (d.name ?? [])[0] ?? null, url: url2 };
    })
    .filter((r): r is SearchHit => r !== null)
    .slice(0, limit);

  if (!results.length) {
    return {
      found: false, query: q,
      message: `No Utah Code section matched "${q}".`,
      hint: 'Try fewer or more general words — this is a full-text match, not semantic search.',
      data_as_of: new Date().toISOString(),
    };
  }

  return {
    found: true,
    query: q,
    count: results.length,
    total_matches: json.response?.numFound ?? results.length,
    results,
    source: 'Utah Code full-text search (Utah State Legislature, le.utah.gov)',
    hint: 'Call ut_code_section with a result\'s `citation` for the full text.',
    data_as_of: new Date().toISOString(),
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ut_code_section',
    description:
      'Get the FULL TEXT of a section of the Utah Code — Utah state law — by citation, plus its effective date and amendment history. "76-5-203" is murder (Title 76, Utah Criminal Code); "53-5a-102.2" is open/concealed carry. Keyless. Use for "what does Utah Code 76-5-203 say" or to check a Utah statute a case, lease, or citation relies on. Does NOT return superseded/historical full text — only the current version and its amendment citations.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Section as cited, e.g. "76-5-203" or "53-5a-102.2". The title and chapter are the first two dash-separated components; letter-suffixed titles ("75E") and chapters ("5a") are normal.' },
      },
      required: ['section'],
    },
  },
  {
    name: 'ut_code_search',
    description:
      'Search the Utah Code BY TOPIC or keyword rather than citation — "concealed weapon permit", "landlord retaliatory eviction", "DUI penalties". Returns ranked sections with their citations; use ut_code_section afterward for the full text of one. Full-text search, so it answers questions no citation lookup can. Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or keywords, e.g. "concealed weapon permit".' },
        limit: { type: 'number', description: 'Max results, default and maximum 10 — le.utah.gov\'s Solr proxy ignores the row count and always returns 10, so a larger value cannot be honoured.' },
      },
      required: ['query'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'ut_code_section') return utCodeSection(args);
  if (name === 'ut_code_search') return utCodeSearch(args);
  throw new Error(`Unknown tool: ${name}`);
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
