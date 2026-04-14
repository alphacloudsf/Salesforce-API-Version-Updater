# Salesforce API Version Updater

A browser-based tool for bulk-updating the `apiVersion` field across Salesforce metadata components. No CLI, no local tooling, no server-side data storage.

Live at: `https://alphacloudsf.github.io/Salesforce-API-Version-Updater`

---

## What it does

Salesforce metadata components (Apex classes, triggers, LWC, Aura, Flows, Visualforce pages and components) each carry an `apiVersion` field in their XML. Keeping that field current ensures access to the latest platform features and avoids issues with deprecated API behavior.

1. Connect to your org via OAuth
2. List all unmanaged components of the types you select
3. See each component's current API version and whether it is current, outdated, or deprecated
4. Retrieve the selected components as a metadata zip
5. Patch only the `<apiVersion>` tag in each file, no other changes
6. Deploy the modified zip back to your org with `rollbackOnError: true`
7. Download a `package.xml` manifest and use the SF CLI and git commands to sync the changes back to your local repo

All metadata processing happens in the browser. The proxy server (Cloudflare Worker) forwards API calls but never stores, parses, or logs metadata content.

---

## Supported metadata types

- Apex Classes
- Apex Triggers
- Lightning Web Components
- Flows
- Aura Components
- Visualforce Pages
- Visualforce Components

Only unmanaged components are shown. Managed package components are excluded.

---

## Syncing changes to your repo

After a successful deploy, the tool generates the commands needed to pull the updated metadata into your local SFDX project without overwriting your source files.

1. **Download `package.xml`**: a manifest scoped to exactly the components that were updated. Place it at `manifest/sf-api-updated-package.xml` in your repo root.
2. **Retrieve**: `sf project retrieve start --manifest manifest/sf-api-updated-package.xml`
3. **Stage metadata files**: stage only the `-meta.xml` files that changed, leaving companion source files (`.cls`, `.trigger`, etc.) untouched for you to handle manually.

---

## How it works

```
Browser (GitHub Pages)
  - UI, metadata processing, deploy polling

sf-oauth-broker (generic Cloudflare Worker)
  - holds the ECA client secret
  - handles OAuth login, token refresh, logout

sf-api-version-updater (project Cloudflare Worker)
  - adds CORS headers to Salesforce API responses
  - proxies Tooling API and Metadata SOAP calls

Salesforce Org
  - Tooling API (component listing)
  - Metadata API SOAP (retrieve and deploy)
```

OAuth and API proxying are split into two separate workers. The API proxy has no knowledge of secrets or auth, it only forwards Salesforce API calls from the browser.

Full architecture details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

---
