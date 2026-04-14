# Architecture Guide

A full breakdown of how SF API Version Updater is structured, how its components communicate, where data lives, and how each piece of the system works.

---

## Table of Contents

1. [High-Level Overview](#1-high-level-overview)
2. [Layer 1: Browser (Astro Frontend)](#2-layer-1-browser-astro-frontend)
3. [Layer 2: Cloudflare Workers (Proxy)](#3-layer-2-cloudflare-workers-proxy)
4. [Layer 3: Salesforce Org](#4-layer-3-salesforce-org)
5. [Authentication Flow](#5-authentication-flow)
6. [Update Operation: Full Data Flow](#6-update-operation-full-data-flow)
7. [Worker Endpoints Reference](#7-worker-endpoints-reference)
8. [Security Model](#8-security-model)
9. [Why Workers at All?](#9-why-workers-at-all)
10. [Deployment Topology](#10-deployment-topology)

---

## 1. High-Level Overview

The application is split into four distinct layers:

```
┌─────────────────────────────────────────────────────────┐
│              Browser (GitHub Pages)                      │
│  Astro static site, all logic runs in the user's tab    │
└───────┬─────────────────────────────────┬───────────────┘
        │ OAuth (login/refresh/logout)     │ SF API calls (/sf/*)
        │ PUBLIC_BROKER_URL                │ PUBLIC_WORKER_URL
        ▼                                  ▼
┌───────────────────┐          ┌───────────────────────────┐
│  sf-oauth-broker  │          │  sf-api-version-updater   │
│  (generic worker) │          │  (project worker)         │
│  /oauth/* routes  │          │  /sf/* routes only        │
└───────────────────┘          └─────────────┬─────────────┘
                                             │ HTTPS + Bearer token
                                             ▼
                               ┌─────────────────────────────┐
                               │        Salesforce Org        │
                               │  Tooling API + Metadata SOAP │
                               └─────────────────────────────┘
```

**Core design principles:**
- The browser does all the work: retrieve, process, deploy
- Both Workers are pure pass-throughs; they never store, transform, or inspect payload data
- User credentials and metadata never touch any persistent server storage
- No backend database, no session store, no file storage anywhere
- OAuth responsibilities are split: the generic broker handles auth for any app using the same ECA; this project's worker handles only Salesforce API proxying

---

## 2. Layer 1: Browser (Astro Frontend)

**Hosted at:** GitHub Pages (`https://alphacloudsf.github.io/Salesforce-API-Version-Updater`)
**Built with:** Astro (static output), Tailwind CSS v4, TypeScript, JSZip

Because Astro outputs a fully static site, there is no Node.js server, no SSR, and no API routes. Every file is plain HTML, CSS, and JavaScript served from GitHub's CDN.

### Key source files

**Pages & layout**

| File | Responsibility |
|------|---------------|
| `src/pages/index.astro` | HTML markup only, mounts the app via `src/app/init.ts` |
| `src/pages/guide.astro` | User guide page |
| `src/layouts/Layout.astro` | Shared header, footer, theme toggle, dark mode |
| `src/styles/global.css` | Design tokens, component classes, dark mode |

**App logic (`src/app/`)**

| File | Responsibility |
|------|---------------|
| `src/app/init.ts` | Entry point, wires all event listeners, handles OAuth routing |
| `src/app/state.ts` | All mutable runtime state (components, sort, pagination) with typed setters |
| `src/app/dom.ts` | Single source of truth for all DOM element references |
| `src/app/dashboard.ts` | `showDashboard`, `showLogin`, `buildMetadataTypeGrid`, `loadComponents` |
| `src/app/table.ts` | `renderTable`, `applyFilters`, `applySort`, `updatePagination` |
| `src/app/test-picker.ts` | Test class / test suite picker rendering and interaction |
| `src/app/update.ts` | `performUpdate` (full retrieve > patch > deploy > poll flow), `performBackupOnly` |
| `src/app/repo-sync.ts` | Generates repo sync commands and wires the package.xml download after a successful deploy |
| `src/app/ui.ts` | `logProgress`, `logError`, `showLoading`, `updateProgress`, `escapeHtml` |

**Libraries (`src/lib/`)**

| File | Responsibility |
|------|---------------|
| `src/lib/auth.ts` | OAuth initiation, hash callback handling, token storage, refresh. All calls go to `BROKER_URL` |
| `src/lib/salesforce.ts` | Typed wrappers around every Worker proxy endpoint. All calls go to `WORKER_URL` |
| `src/lib/metadata-processor.ts` | In-browser zip processing and XML patching (JSZip) |
| `src/lib/config.ts` | App-wide constants: `WORKER_URL`, `BROKER_URL`, metadata types, package URLs |

### URL routing from the browser

| Call type | Env var | Destination |
|-----------|---------|-------------|
| OAuth (login, refresh, logout) | `PUBLIC_BROKER_URL` | `sf-oauth-broker` worker |
| Salesforce API proxy (`/sf/*`) | `PUBLIC_WORKER_URL` | `sf-api-version-updater` worker |

### What the browser does

**Session management**
After OAuth login, tokens are stored in `sessionStorage`, not `localStorage`. This means they are scoped to the browser tab and are automatically cleared when the tab is closed. No tokens are ever written to disk or sent to a server for storage.

**Component listing**
The browser calls `listComponents(type, deprecatedThreshold)` for each selected metadata type, which hits the Worker proxy, which queries the Salesforce Tooling API. The `deprecatedThreshold` is derived dynamically from the oldest version shown in the target version dropdown (the 10th-most-recent API version). Results are held in memory as a `ComponentInfo[]` array for the lifetime of the session.

**Metadata retrieval**
When the user clicks Update or Download Backup, the browser sends the selected component list to the Worker, which initiates a Metadata API SOAP `retrieve` call. The Worker polls Salesforce until the retrieve is complete, then returns the base64-encoded zip to the browser. **The zip is never stored anywhere except browser memory.**

**In-browser zip processing** (`src/lib/metadata-processor.ts`)
This is the most important piece of the design. Once the zip arrives in the browser:

1. JSZip unpacks the base64 zip entirely in memory
2. For every `-meta.xml` file (and `.flow` files), it finds `<apiVersion>XX.0</apiVersion>` and replaces the version number
3. The `unpackaged/` path prefix used by Salesforce retrieve is stripped; the deploy format expects files at the root
4. A new zip is built and re-encoded as base64

All of this happens in the JavaScript engine of the user's browser tab. No server is involved. No metadata content is ever logged, stored, or forwarded anywhere other than back to Salesforce.

**Deployment**
The modified base64 zip is sent to the Worker, which passes it to the Salesforce Metadata API `deploy` endpoint. A `deployId` is returned immediately (deploy is async in Salesforce).

**Deploy polling with exponential backoff**
Rather than polling every few seconds (which would exhaust the Cloudflare Worker free tier request limit on large orgs), the browser uses an exponential backoff schedule:

| Elapsed time | Poll interval |
|-------------|--------------|
| 0-30s | 5s |
| 30s-2min | 10s |
| 2min-10min | 20s |
| 10min+ | 30s |
| Any (tests running) | min 10s |

The browser polls `checkDeployStatus` until `done: true`, then reads `success`, `errors`, and `testFailures` from the response.

**Repo sync (post-deploy)**
After a successful deploy, `src/app/repo-sync.ts` takes over:

1. Extracts `unpackaged/package.xml` from the already-in-memory retrieve ZIP (no extra network call) and offers it as a download named `sf-api-updated-package.xml`.
2. Displays a fixed retrieve command: `sf project retrieve start --manifest manifest/sf-api-updated-package.xml`. This command is short and OS-agnostic regardless of how many components were updated.
3. Displays a `git add` command (bash/zsh and PowerShell variants) that stages only `-meta.xml` files from both modified and untracked files: `git ls-files --modified --others --exclude-standard | grep -E '\-meta\.xml$'`. The user manually handles any companion source files (`.cls`, `.trigger`, etc.) that were retrieved alongside the metadata.

This covers the gap between the org-side update and the user's local repo without requiring any server-side storage or GitHub integration.

---

## 3. Layer 2: Cloudflare Workers (Proxy)

This project uses **two separate Cloudflare Workers** with distinct responsibilities.

### 3a. OAuth Broker (`sf-oauth-broker`)

**Source:** `Salesforce-OAuth-Broker\src\index.ts` (separate repo)
**Hosted at:** `https://sf-oauth-broker.<account>.workers.dev`

A **generic, reusable worker**, not specific to this project. Any app that uses the same Salesforce ECA can point its OAuth calls here without modification.

**What it does:**
- Holds the ECA `SF_CLIENT_SECRET` as an encrypted Cloudflare secret
- Performs the OAuth authorization code to token exchange (the step that requires the secret)
- Handles token refresh and revocation
- Redirects tokens to the calling app via URL fragment after login

**What it does NOT do:**
- Make any Salesforce API calls
- Know anything about metadata, components, or deployments
- Store any data

**Environment variables:**

| Variable | Where set | Purpose |
|----------|-----------|---------|
| `SF_CLIENT_ID` | `wrangler.toml` (public) | ECA consumer key |
| `SF_CLIENT_SECRET` | `wrangler secret put` (encrypted) | ECA consumer secret, never in source code |
| `ALLOWED_ORIGINS` | `wrangler.toml` | Comma-separated list of allowed front-end origins |

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/oauth/authorize` | Initiates OAuth, redirects browser to Salesforce login |
| GET | `/oauth/callback` | Receives auth code, exchanges for tokens, redirects to app |
| POST | `/oauth/refresh` | Exchanges a refresh token for a new access token |
| POST | `/oauth/revoke` | Revokes a token (logout, best-effort) |

---

### 3b. API Proxy (`sf-api-version-updater`)

**Source:** `worker/src/index.ts`
**Hosted at:** `https://sf-api-version-updater.<account>.workers.dev`
**Config:** `worker/wrangler.toml`

This worker has **one job**: CORS proxy for Salesforce Metadata and Tooling API calls. It knows nothing about OAuth, no secrets, no token exchange, no auth routes.

**What it does:**
- Validates `X-SF-Access-Token` and `X-SF-Instance-URL` headers on every request
- Validates the instance URL against a Salesforce host allowlist before forwarding anything
- Proxies Tooling API (REST) and Metadata API (SOAP) calls with the correct CORS headers

**What it does NOT do:**
- Handle OAuth in any form
- Store any data
- Transform or inspect metadata content

**Environment variables:**

| Variable | Where set | Purpose |
|----------|-----------|---------|
| `ALLOWED_ORIGIN` | `wrangler.toml` | The GitHub Pages URL allowed to call this worker (CORS) |

---

## 4. Layer 3: Salesforce Org

The app uses two Salesforce APIs:

### Tooling API (REST)

`GET /services/data/vXX.0/tooling/query?q=<SOQL>`
`GET /services/data/vXX.0/tooling/tests/`
`DELETE /services/data/vXX.0/tooling/sobjects/Flow/<id>`

Used for:
- Listing components (ApexClass, ApexTrigger, ApexPage, ApexComponent, AuraDefinitionBundle, LightningComponentBundle, Flow)
- Discovering test classes via the Test Discovery API
- Deleting obsolete Flow versions after a successful deploy

The Tooling API returns richer metadata than the Metadata API list operation, including `ApiVersion`, `Id`, and `LastModifiedDate` per record.

Only **unmanaged components** are returned. Managed package components (from installed packages) are excluded by filtering `NamespacePrefix = ''` in SOQL queries.

### Metadata API (SOAP)

`POST /services/Soap/m/XX.0`
SOAPAction: `retrieve` | `checkRetrieveStatus` | `deploy` | `checkDeployStatus`

Used for:
- Retrieving metadata as a zip (async: initiate then poll)
- Deploying modified metadata (async: initiate then poll)

The Metadata API operates asynchronously for both retrieve and deploy. The Worker initiates the retrieve and polls until complete before returning to the browser (retrieve is fast, typically a few seconds). For deploy, the Worker only initiates; the browser polls via `checkDeployStatus`.

**Deploy options always set:**
- `rollbackOnError: true` - any error rolls back the entire deployment atomically
- `singlePackage: true` - the zip is a single package without namespace nesting
- `purgeOnDelete: true` - ensures deleted items are fully removed (relevant for Flow cleanup)

---

## 5. Authentication Flow

```
User clicks "Login (Production)"
        │
        ▼
Browser > GET sf-oauth-broker /oauth/authorize?login_url=https://login.salesforce.com&return_url=<app>
        │
        ▼
Broker builds Salesforce OAuth authorize URL
  - embeds { loginUrl, returnUrl, nonce } in base64 state param
  - redirects browser to Salesforce login page
        │
        ▼
User logs in on Salesforce (browser talks directly to SF, broker not involved)
        │
        ▼
Salesforce > GET sf-oauth-broker /oauth/callback?code=<auth_code>&state=<base64>
        │
        ▼
Broker decodes state, recovers loginUrl + returnUrl + nonce
Broker > POST <loginUrl>/services/oauth2/token  (with code + client_secret)
        │
        ▼
Salesforce returns { access_token, refresh_token, instance_url }
Broker > GET <instance_url>/services/oauth2/userinfo
        │
        ▼
Broker encodes { access_token, instance_url, username, org_id, nonce } as base64
Broker > 302 redirect to <returnUrl>#sf_auth=<base64>
        │
        ▼
Browser reads window.location.hash
Verifies nonce matches the one stored before login (CSRF protection)
Parses base64 payload, stores tokens in sessionStorage
Clears hash from URL with history.replaceState (never appears in server logs)
        │
        ▼
Dashboard shown, user is authenticated
```

**Why the URL hash?**
The broker redirects to the GitHub Pages origin. It cannot write to the browser's `sessionStorage` because that is same-origin only. Passing tokens via URL hash is a standard OAuth pattern; the hash fragment is never sent to the server in HTTP requests, so it won't appear in GitHub Pages access logs.

---

## 6. Update Operation: Full Data Flow

```
1. SELECT COMPONENTS
   User checks metadata types, clicks "Load Components"
   Browser > API proxy worker > Tooling API SOQL query per type
   <- Component list with name, apiVersion, id, lastModifiedDate
   Browser renders table, user selects rows

2. RETRIEVE
   User clicks "Update Selected Components"
   Browser sends [{ type, fullName }] array to API proxy worker
   Worker builds package.xml + Metadata SOAP retrieve envelope
   Worker > SF: retrieve (async)
   Worker polls SF every 2s until done
   Worker > Browser: base64 zip

3. BACKUP (optional)
   Browser decodes zip, triggers browser file download
   File saved to user's computer, nothing sent anywhere

4. PROCESS (entirely in browser)
   JSZip unpacks zip in memory
   For each -meta.xml / .flow file:
     regex replace <apiVersion>old</apiVersion> with <apiVersion>new</apiVersion>
   Strip unpackaged/ prefix from all paths
   Rebuild zip as base64

5. DEPLOY
   Browser > API proxy worker: { zipBase64, testLevel, testClasses }
   Worker builds Metadata SOAP deploy envelope
   Worker > SF: deploy (async)
   Worker > Browser: { deployId }

6. POLL (browser drives this loop)
   Browser waits (exponential backoff interval)
   Browser > API proxy worker > SF: checkDeployStatus
   <- { done, success, status, numberComponentsDeployed, errors, testFailures }
   Repeat until done === true

7. RESULT
   success=true  -> log success, optionally run Flow cleanup
   success=false -> log all errors (component errors, coverage warnings, test failures)
                    Salesforce has already rolled back all changes (rollbackOnError=true)

8. FLOW CLEANUP (optional, Flows only)
   The Tooling API record Id of the previously-active Flow version was captured
   at step 1 (before deploy). After a successful deploy, that version is now Obsolete.
   Browser > API proxy worker > SF: DELETE /tooling/sobjects/Flow/<id>
   Worker safety-checks: refuses if Status === 'Active'
```

---

## 7. Worker Endpoints Reference

### OAuth Broker (`sf-oauth-broker`) - separate project

| Method | Path | Description |
|--------|------|-------------|
| GET | `/oauth/authorize` | Initiates OAuth, redirects to Salesforce login |
| GET | `/oauth/callback` | Receives auth code, exchanges for tokens, redirects to app |
| POST | `/oauth/refresh` | Exchanges a refresh token for a new access token (called automatically on 401) |
| POST | `/oauth/revoke` | Revokes access token (logout, best-effort) |

### API Proxy (`sf-api-version-updater`) - this project

All routes require `X-SF-Access-Token` and `X-SF-Instance-URL` headers. The `X-SF-Instance-URL` value must resolve to a Salesforce host (validated by `isValidSalesforceHost`) before the Worker will forward anything.

Entry point: `handleSfProxy` in `worker/src/index.ts`.

| Method | Path | SF API | Handler | Description |
|--------|------|--------|---------|-------------|
| GET | `/sf/api-versions` | REST | `proxyGetApiVersions` | Lists all API versions (used to populate the target version dropdown) |
| GET | `/sf/metadata/list?type=X` | Tooling | `proxyListMetadata` | Lists components of a metadata type; returns 401 on expired token |
| POST | `/sf/metadata/retrieve` | Metadata SOAP | `proxyRetrieveMetadata` | Retrieves metadata zip (synchronous from caller perspective; Worker polls internally, 3 min max) |
| POST | `/sf/metadata/deploy` | Metadata SOAP | `proxyDeployMetadata` | Initiates async deploy, returns deployId |
| GET | `/sf/metadata/deploy-status?id=X` | Metadata SOAP | `proxyCheckDeployStatus` | Polls deploy status (SOAP response parsed with `fast-xml-parser`) |
| POST | `/sf/metadata/delete-flow-version` | Tooling | `proxyDeleteFlowVersion` | Deletes a specific Flow version by Id |
| GET | `/sf/test-classes` | Tooling Tests Discovery | `proxyListTestClasses` | Returns all Apex test classes |
| GET | `/sf/test-suites` | Tooling | `proxyListTestSuites` | Returns all ApexTestSuite records |
| POST | `/sf/test-suites/classes` | Tooling | `proxyGetSuiteClasses` | Resolves suite names to member class names (suite names whitelisted to identifier chars) |

---

## 8. Security Model

| Concern | Approach |
|---------|---------|
| Client secret | Stored only as a Cloudflare encrypted secret in the OAuth broker (`wrangler secret put`). Never in source code, never sent to browser, not present in the API proxy worker at all. |
| Access token | Stored only in browser `sessionStorage`. Scoped to the tab, cleared on close. Never stored by either Worker. |
| Metadata content | Processed entirely in browser memory. The API proxy worker forwards the raw bytes but never parses, logs, or stores them. |
| Token in URL | Passed via URL hash fragment (`#sf_auth=...`). Hash is not included in HTTP requests so it never appears in server access logs. Cleared immediately after parsing. |
| OAuth nonce | Before redirecting to Salesforce, the browser generates a UUID nonce and stores it in `sessionStorage`. The broker echoes it back in the hash payload. `handleHashCallback` refuses to store tokens if the nonce does not match, defending against an attacker crafting a `#sf_auth=...` URL to inject their own session. |
| Refresh token | Used automatically on 401 via broker `/oauth/refresh`. If refresh succeeds, the in-flight request is retried transparently. If refresh fails, the app fires a `sf:session-expired` event and shows a re-auth dialog without destroying the page state. |
| CORS (broker) | Accepts requests from any origin listed in `ALLOWED_ORIGINS` (comma-separated). Supports multiple apps sharing one broker. |
| CORS (API proxy) | Only allows requests from the configured `ALLOWED_ORIGIN` (single GitHub Pages URL) and localhost for development. |
| Instance URL allowlist | The `X-SF-Instance-URL` header must resolve to a Salesforce host (`*.salesforce.com`, `*.force.com`, `*.cloudforce.com`, or `*.salesforce-setup.com`) over HTTPS. Prevents the Worker from being coerced into forwarding a Bearer token to an attacker-chosen origin. |
| SOQL injection | Test suite names are whitelisted to `[A-Za-z0-9_]` (valid identifier chars) before being interpolated into SOQL. Record IDs from Salesforce responses are re-validated against the Salesforce 15/18-char ID pattern before being used in subsequent queries. |
| SOAP XML parsing | Deploy status responses are parsed with `fast-xml-parser` instead of regex, so nested `<success>` tags inside `componentSuccesses` cannot cause false positives for the top-level result. |
| Session IDs in SOAP envelopes | Access tokens interpolated into SOAP `<sessionId>` elements are passed through `escapeXml()` defensively, even though Salesforce tokens do not contain XML-special characters today. |
| Flow deletion safety | Before deleting a Flow version, the Worker checks its `Status` field. If it is `Active`, deletion is refused regardless of what the browser requested. |
| Rollback | Every deploy uses `rollbackOnError: true`. A failed deploy leaves the org exactly as it was. |

---

## 9. Why Workers at All?

Without the Workers, two things are impossible:

**1. OAuth with a client secret**
Salesforce's Web Server OAuth flow requires a `client_secret` during token exchange. Any secret embedded in a static site is public. The OAuth broker holds the secret server-side and performs the exchange. This is the only reason the broker exists; once authenticated, it is not involved in any Salesforce API calls.

**2. CORS**
Browsers block cross-origin requests unless the target server explicitly allows them. Salesforce APIs do not include CORS headers for arbitrary browser origins. The API proxy worker sits between the browser and Salesforce, adding the required headers.

Everything else (authentication state, data processing, UI) lives in the browser. Both Workers are intentionally as thin as possible.

---

## 10. Deployment Topology

### Frontend

```
GitHub Actions (.github/workflows/deploy.yml)
  -> npm run build  (Astro static build, inlines PUBLIC_WORKER_URL + PUBLIC_BROKER_URL)
  -> Deploy to GitHub Pages
  -> Served at https://alphacloudsf.github.io/Salesforce-API-Version-Updater
```

Source changes to `src/` trigger an automatic deploy via GitHub Actions on push to `master`.

### OAuth Broker (`sf-oauth-broker`)

```
Manual deploy from Salesforce-OAuth-Broker:
  npx wrangler deploy

Shared across projects; only needs redeploying when the ECA credentials change
or when adding a new allowed origin.
```

### API Proxy Worker (`sf-api-version-updater`)

```
Manual deploy only:
  cd worker && npx wrangler deploy

Worker CI deploy is intentionally disabled in .github/workflows/deploy.yml
to avoid consuming free-tier request budget on accidental deploys.
```

### Managed Package (External Client App)

The Salesforce External Client App that provides the OAuth consumer key/secret is distributed as a **2GP managed package**. Users install it once per org via the install URL embedded in the app. This registers the OAuth app in their org without requiring any manual Connected App setup.

The package is created and versioned from the namespace org. After promoting a new version:
1. Update the install URLs in `src/lib/config.ts`
2. Update `PACKAGE_VERSION_ID` in the broker's `wrangler.toml`
3. Update `SF_CLIENT_ID` in the broker's `wrangler.toml` if the ECA changed
4. Redeploy the broker
5. Push the frontend

The install URLs follow the pattern:
- Production: `https://login.salesforce.com/packaging/installPackage.apexp?p0=<04t...>`
- Sandbox: `https://test.salesforce.com/packaging/installPackage.apexp?p0=<04t...>`
