# @pipeworx/utah-code

Utah Code — state statutes by citation, full text plus effective date and
amendment history, and topic/keyword search across the whole Code.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1857+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ut_code_section(section)` — full text of a Utah Code section by citation
  (e.g. "76-5-203", "53-5a-102.2"), with its effective date and amendment
  history (e.g. "Amended by Chapter 356, 2026 General Session"). Does NOT
  return superseded/historical full text — le.utah.gov's own code viewer only
  ever lists one "Current Version" per section; only the amendment citation
  survives for a prior change, not the prior text.
- `ut_code_search(query, limit?)` — full-text keyword/topic search across
  every Utah Code section, returning citation + title + url for each hit.

## Auth

Keyless.

## Data sources

- `https://le.utah.gov/xcode/TitleNN/ChapterMM/NN-MM-Sxxx.html` (e.g.
  `Title76/Chapter5/76-5-S203.html`) — the public section VIEWER page. It is a
  template whose statute text is injected by client-side JS, so a bare fetch
  returns only the chrome — **but** the page's inline script block always
  carries a line of the form `var versionDefault="C76-5-S203_2026050620260506";`,
  which names the current version's content document. No bot wall: a bare
  default UA gets the same 200 a browser does, this pack just sends an honest
  one anyway.
- The content document named by `versionDefault`, in the SAME directory with
  `.html` appended (e.g. `C76-5-S203_2026050620260506.html`) — the actual
  statute text. Plain, un-rendered HTML (no JS): a breadcrumb trail, an
  "Effective MM/DD/YYYY" line, the statute body as nested HTML-table rows
  with the subsection letters ("(1)", "(a)", "(i)") printed as literal cell
  text, and a trailing "Amended by Chapter N, YYYY General Session" history
  note. The SAME document is also published as PDF / RTF / XML (same
  basename, different extension) — the XML is cleaner markup but drops the
  subsection letters as literal text (they live only in a `number` attribute
  instead), which is why this pack reads the plain-HTML fragment rather than
  the XML.
- `https://le.utah.gov/servlet/solrproxy9` — the keyless Solr proxy backing
  le.utah.gov's own "Keyword Search" nav link for the Code
  (`/solrsearch.jsp?ktype=Code`), called directly rather than through that
  JS-rendered results shell. `fq=category:Code` scopes it to statute text;
  without that filter it searches bills, committee docs, and more. **Known
  quirk, not documented anywhere on the site**: the proxy decodes its own
  query params and forwards them to an internal Solr server
  (`LESOLR:8080`) WITHOUT re-encoding, so a literal space in `q` becomes a
  literal space in the upstream HTTP request line and Solr 400s on it.
  Multi-word queries need the space DOUBLE-encoded as `%2520` (which decodes
  once, server-side, to the still-valid string `%20`) rather than the normal
  `%20`/`+` — single-word queries work either way. The gate did not need to
  forge an identity: an honest UA and a `GET` is all it takes.

Both the viewer-page quirk and the Solr double-encoding quirk were found by
probing live with curl before writing any code — the August state-law survey
had filed Utah as "client-rendered or bot-walled" on the strength of the
viewer page alone.

## Reachability — this pack goes through the egress relay

le.utah.gov serves a **leaf-only TLS chain** (its Sectigo "Public Server
Authentication CA OV R36" intermediate is missing), and a live Cloudflare Worker
answers **HTTP 526 "Invalid SSL certificate"** — 3/3 on 2026-10-07, 5/5 on
2026-10-06. A Worker's `fetch()` has no API to supply a missing intermediate, so
every request routes through `supabase/functions/egress-proxy`, whose `PINNED_CA`
map completes the chain with the authentic intermediate fetched from the AIA URI
in le.utah.gov's own leaf. **Certificate verification is never disabled** — the
chain is completed, not skipped.

The gateway injects `_proxyUrl`/`_proxyToken` for this slug
(`workers/gateway/src/index.ts`). Without that injection the pack is not slow or
partial, it is **100% dark**, so the slug must stay on that list.

### Why `mcps/who-euro` works directly and this does not

Both hosts are leaf-only with sibling Sectigo R36 intermediates off the same
Root R46, so the chain *shape* is not what Cloudflare objects to. Measured from
**one** Worker in **one** run, 2026-10-07:

| Host | Result | Intermediate |
|---|---|---|
| `le.utah.gov` | **526** ×3 | Sectigo CA **OV** R36 |
| `dw.euro.who.int` | **404** ×3 — an *application*-layer answer, so TLS completed | Sectigo CA **DV** R36 |
| `example.com` | 200 ×3 | control |

Cloudflare completes some missing intermediates from its own cached pool and not
others. DV R36 is far more widely deployed than OV R36, which is the likely
reason, but the mechanism is CF-internal and not inspectable — treat it as
**measured per host, never predicted**.

### The one-minute diagnostic for the next pack with this shape

```bash
openssl s_client -connect <host>:443 -servername <host> -showcerts \
  2>/dev/null | grep -c 'BEGIN CERT'      # 1 => leaf-only chain
```

**A local Node or Deno failure proves nothing about Cloudflare.** Deno's rustls
chases no AIA and caches no intermediates, so it refuses *every* leaf-only host —
including `dw.euro.who.int`, which CF serves fine. Only a live `wrangler dev
--remote` probe answers the question that matters. If it 526s, the fix is a
`PINNED_CA` entry in the relay (one host, one authentic intermediate), **not** an
ingest-and-store rebuild of the corpus.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "utah-code": {
      "url": "https://gateway.pipeworx.io/utah-code/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/utah-code/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1857+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ut_code_section \
  -H 'Content-Type: application/json' \
  -d '{"section":"76-5-203"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ut_code_section`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-utah-code` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/utah-code/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "utah-code": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-utah-code"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Utah Code data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
