/**
 * Cloudflare Worker: Salesforce API proxy
 *
 * OAuth is handled by the generic sf-oauth-broker worker.
 * This worker only proxies Salesforce Metadata/Tooling API calls,
 * avoiding CORS issues from the browser. Stateless pass-through.
 *
 * Routes:
 *   GET  /sf/api-versions
 *   GET  /sf/metadata/list?type=<MetadataType>
 *   POST /sf/metadata/retrieve
 *   POST /sf/metadata/deploy
 *   GET  /sf/metadata/deploy-status?id=<deployId>
 *   POST /sf/metadata/delete-flow-version
 *   GET  /sf/test-classes
 *   GET  /sf/test-suites
 *   POST /sf/test-suites/classes
 *
 * Required headers on all /sf/* requests (sent by the browser):
 *   X-SF-Access-Token  Salesforce access token
 *   X-SF-Instance-URL  Salesforce instance URL (e.g. https://myorg.my.salesforce.com)
 */

import { XMLParser } from 'fast-xml-parser';

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

interface Env {
  ALLOWED_ORIGIN: string;
}

// Per-request cache for the latest API version (keyed by instanceUrl).
// Reset on every fetch() entry because Worker isolates reuse globals.
let apiVersionCache = new Map<string, Promise<string>>();

// ─── CORS ─────────────────────────────────────────────────────────

function corsHeaders(origin: string, env: Env): Record<string, string> {
  const allowed = [env.ALLOWED_ORIGIN, 'http://localhost:4321', 'http://localhost:3000'];
  const effectiveOrigin = allowed.includes(origin) ? origin : env.ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': effectiveOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-SF-Access-Token, X-SF-Instance-URL',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data: unknown, status: number, origin: string, env: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) },
  });
}

// ─── Entry point ──────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    apiVersionCache = new Map();

    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || env.ALLOWED_ORIGIN;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    try {
      if (url.pathname.startsWith('/sf/')) {
        return handleSfProxy(request, url, origin, env);
      }
      return jsonResponse({ error: 'Not found' }, 404, origin, env);
    } catch (error: any) {
      console.error('Worker error:', error);
      return jsonResponse({ error: error.message || 'Internal server error' }, 500, origin, env);
    }
  },
};

// ─── Salesforce host allowlist ─────────────────────────────────────

function isValidSalesforceHost(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return (
    host.endsWith('.salesforce.com') ||
    host.endsWith('.force.com') ||
    host.endsWith('.cloudforce.com') ||
    host.endsWith('.salesforce-setup.com')
  );
}

// ─── Salesforce API Proxy ──────────────────────────────────────────

async function handleSfProxy(request: Request, url: URL, origin: string, env: Env): Promise<Response> {
  const accessToken = request.headers.get('X-SF-Access-Token');
  const instanceUrl = request.headers.get('X-SF-Instance-URL');

  if (!accessToken || !instanceUrl) {
    return jsonResponse({ error: 'Missing authentication headers' }, 401, origin, env);
  }

  if (!isValidSalesforceHost(instanceUrl)) {
    return jsonResponse({
      error: 'Invalid instance URL. Expected a Salesforce host (*.salesforce.com, *.force.com, or *.cloudforce.com). Please log out and log back in.',
    }, 400, origin, env);
  }

  const sfPath = url.pathname.replace('/sf/', '');

  if (sfPath === 'api-versions') {
    return proxyGetApiVersions(instanceUrl, accessToken, origin, env);
  }
  if (sfPath === 'metadata/list') {
    const metadataType = url.searchParams.get('type');
    if (!metadataType) return jsonResponse({ error: 'Missing type parameter' }, 400, origin, env);
    return proxyListMetadata(instanceUrl, accessToken, metadataType, origin, env);
  }
  if (sfPath === 'metadata/retrieve' && request.method === 'POST') {
    const body = await request.json();
    return proxyRetrieveMetadata(instanceUrl, accessToken, body, origin, env);
  }
  if (sfPath === 'metadata/deploy' && request.method === 'POST') {
    const body = await request.json();
    return proxyDeployMetadata(instanceUrl, accessToken, body, origin, env);
  }
  if (sfPath === 'metadata/deploy-status') {
    const deployId = url.searchParams.get('id');
    if (!deployId) return jsonResponse({ error: 'Missing deploy id' }, 400, origin, env);
    return proxyCheckDeployStatus(instanceUrl, accessToken, deployId, origin, env);
  }
  if (sfPath === 'metadata/delete-flow-version' && request.method === 'POST') {
    const body = await request.json();
    return proxyDeleteFlowVersion(instanceUrl, accessToken, body, origin, env);
  }
  if (sfPath === 'test-classes') {
    return proxyListTestClasses(instanceUrl, accessToken, origin, env);
  }
  if (sfPath === 'test-suites') {
    return proxyListTestSuites(instanceUrl, accessToken, origin, env);
  }
  if (sfPath === 'test-suites/classes' && request.method === 'POST') {
    const body = await request.json();
    return proxyGetSuiteClasses(instanceUrl, accessToken, body, origin, env);
  }

  return jsonResponse({ error: 'Unknown proxy route' }, 404, origin, env);
}

// ─── Proxy handlers ────────────────────────────────────────────────

async function proxyGetApiVersions(instanceUrl: string, token: string, origin: string, env: Env): Promise<Response> {
  const resp = await fetch(`${instanceUrl}/services/data/`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 401) return jsonResponse({ error: 'Session expired' }, 401, origin, env);
  const data = await resp.json();
  return jsonResponse(data, resp.status, origin, env);
}

async function proxyListMetadata(
  instanceUrl: string,
  token: string,
  metadataType: string,
  origin: string,
  env: Env
): Promise<Response> {
  let apiVersionParam: string;
  try {
    apiVersionParam = await getLatestApiVersionParam(instanceUrl, token);
  } catch (e: any) {
    const status = e.message === 'SESSION_EXPIRED' ? 401 : 500;
    return jsonResponse({ error: e.message }, status, origin, env);
  }
  const latestVersion = parseFloat(apiVersionParam);

  const toolingTypes = ['ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent'];
  let components: any[] = [];
  let queryError: string | null = null;

  if (toolingTypes.includes(metadataType)) {
    const result = await listViaToolingApi(instanceUrl, token, metadataType, apiVersionParam);
    if (result.authError) return jsonResponse({ error: 'Session expired' }, 401, origin, env);
    components = result.components;
    queryError = result.error;
  } else {
    const result = await listViaMetadataApi(instanceUrl, token, metadataType, apiVersionParam);
    if (result.authError) return jsonResponse({ error: 'Session expired' }, 401, origin, env);
    components = result.components;
    queryError = result.error;
  }

  return jsonResponse({ components, latestVersion, queryError }, 200, origin, env);
}

async function listViaToolingApi(
  instanceUrl: string,
  token: string,
  metadataType: string,
  apiVersion: string
): Promise<{ components: any[]; error: string | null; authError?: boolean; }> {
  const entityMap: Record<string, string> = {
    ApexClass: 'ApexClass',
    ApexTrigger: 'ApexTrigger',
    ApexPage: 'ApexPage',
    ApexComponent: 'ApexComponent',
  };

  const entity = entityMap[metadataType];
  if (!entity) return { components: [], error: `Unknown metadata type: ${metadataType}` };

  const query = `SELECT Id, Name, ApiVersion, LastModifiedDate FROM ${entity} WHERE NamespacePrefix = '' ORDER BY Name`;
  const resp = await fetch(
    `${instanceUrl}/services/data/v${apiVersion}/tooling/query?q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (resp.status === 401) return { components: [], error: null, authError: true };
  if (!resp.ok) {
    const errText = await resp.text();
    return { components: [], error: `Tooling API error (${resp.status}): ${errText}` };
  }

  const data: any = await resp.json();
  if (data.errorCode) return { components: [], error: `SOQL error: ${data.message}` };

  return {
    components: (data.records || []).map((r: any) => ({
      fullName: r.Name,
      apiVersion: r.ApiVersion,
      id: r.Id,
      lastModifiedDate: r.LastModifiedDate,
    })),
    error: null,
  };
}

async function listViaMetadataApi(
  instanceUrl: string,
  token: string,
  metadataType: string,
  apiVersion: string
): Promise<{ components: any[]; error: string | null; authError?: boolean; }> {
  const entityMap: Record<string, { entity: string; fields: string; }> = {
    AuraDefinitionBundle: { entity: 'AuraDefinitionBundle', fields: 'Id, DeveloperName, ApiVersion, LastModifiedDate' },
    LightningComponentBundle: { entity: 'LightningComponentBundle', fields: 'Id, DeveloperName, ApiVersion, LastModifiedDate' },
    Flow: { entity: 'FlowDefinition', fields: 'Id, DeveloperName, ActiveVersionId, LatestVersionId' },
  };

  const mapping = entityMap[metadataType];
  if (!mapping) return { components: [], error: `Unknown metadata type: ${metadataType}` };

  if (metadataType === 'Flow') {
    return listFlows(instanceUrl, token, apiVersion);
  }

  const query = `SELECT ${mapping.fields} FROM ${mapping.entity} WHERE NamespacePrefix = '' ORDER BY DeveloperName`;
  const resp = await fetch(
    `${instanceUrl}/services/data/v${apiVersion}/tooling/query?q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (resp.status === 401) return { components: [], error: null, authError: true };
  if (!resp.ok) {
    const errText = await resp.text();
    return { components: [], error: `Tooling API error (${resp.status}): ${errText}` };
  }

  const data: any = await resp.json();
  if (data.errorCode) return { components: [], error: `SOQL error: ${data.message}` };

  return {
    components: (data.records || []).map((r: any) => ({
      fullName: r.DeveloperName,
      apiVersion: r.ApiVersion,
      id: r.Id,
      lastModifiedDate: r.LastModifiedDate,
    })),
    error: null,
  };
}

async function listFlows(
  instanceUrl: string,
  token: string,
  apiVersion: string
): Promise<{ components: any[]; error: string | null; authError?: boolean; }> {
  const query = `SELECT Id, Definition.DeveloperName, VersionNumber, ApiVersion, LastModifiedDate, Status FROM Flow WHERE Status = 'Active' AND Definition.NamespacePrefix = '' ORDER BY Definition.DeveloperName`;
  const resp = await fetch(
    `${instanceUrl}/services/data/v${apiVersion}/tooling/query?q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (resp.status === 401) return { components: [], error: null, authError: true };
  if (!resp.ok) {
    const errText = await resp.text();
    return { components: [], error: `Flow query error (${resp.status}): ${errText}` };
  }

  const data: any = await resp.json();
  if (data.errorCode) return { components: [], error: `SOQL error: ${data.message}` };

  return {
    components: (data.records || []).map((r: any) => ({
      fullName: r.Definition?.DeveloperName || r.Id,
      apiVersion: r.ApiVersion,
      id: r.Id,
      versionNumber: r.VersionNumber,
      lastModifiedDate: r.LastModifiedDate,
    })),
    error: null,
  };
}

async function proxyRetrieveMetadata(
  instanceUrl: string,
  token: string,
  body: any,
  origin: string,
  env: Env
): Promise<Response> {
  const { components } = body;

  let latestVersion: string;
  try {
    latestVersion = await getLatestApiVersionParam(instanceUrl, token);
  } catch (e: any) {
    const status = e.message === 'SESSION_EXPIRED' ? 401 : 500;
    return jsonResponse({ error: e.message }, status, origin, env);
  }

  const typeMap = new Map<string, string[]>();
  for (const c of components) {
    if (!typeMap.has(c.type)) typeMap.set(c.type, []);
    typeMap.get(c.type)!.push(c.fullName);
  }

  const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <env:Header>
    <met:SessionHeader>
      <met:sessionId>${escapeXml(token)}</met:sessionId>
    </met:SessionHeader>
  </env:Header>
  <env:Body>
    <met:retrieve>
      <met:retrieveRequest>
        <met:apiVersion>${latestVersion}</met:apiVersion>
        <met:unpackaged>
          ${buildSoapPackageTypes(typeMap)}
        </met:unpackaged>
      </met:retrieveRequest>
    </met:retrieve>
  </env:Body>
</env:Envelope>`;

  const metadataUrl = `${instanceUrl}/services/Soap/m/${latestVersion}`;
  const retrieveResp = await fetch(metadataUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'retrieve' },
    body: soapEnvelope,
  });

  if (!retrieveResp.ok) {
    const errText = await retrieveResp.text();
    return jsonResponse({ error: `Retrieve request failed: ${errText}` }, 500, origin, env);
  }

  const retrieveXml = await retrieveResp.text();
  const retrieveResult = parseSoapResult(retrieveXml, 'retrieveResponse');
  const asyncId: string | null = retrieveResult?.id ?? null;

  if (!asyncId) {
    return jsonResponse({ error: 'Failed to get retrieve ID' }, 500, origin, env);
  }

  let zipBase64: string | null;
  try {
    zipBase64 = await pollRetrieveResult(instanceUrl, token, latestVersion, asyncId);
  } catch (e: any) {
    const status = e.message === 'SESSION_EXPIRED' ? 401 : 500;
    return jsonResponse({ error: e.message }, status, origin, env);
  }

  if (!zipBase64) {
    return jsonResponse({ error: 'Retrieve timed out or failed' }, 500, origin, env);
  }

  return jsonResponse({ zipBase64 }, 200, origin, env);
}

async function pollRetrieveResult(
  instanceUrl: string,
  token: string,
  apiVersion: string,
  asyncId: string
): Promise<string | null> {
  const metadataUrl = `${instanceUrl}/services/Soap/m/${apiVersion}`;

  // 90 iterations × 2s = 3 min max
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));

    const checkEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <env:Header>
    <met:SessionHeader>
      <met:sessionId>${escapeXml(token)}</met:sessionId>
    </met:SessionHeader>
  </env:Header>
  <env:Body>
    <met:checkRetrieveStatus>
      <met:asyncProcessId>${asyncId}</met:asyncProcessId>
      <met:includeZip>true</met:includeZip>
    </met:checkRetrieveStatus>
  </env:Body>
</env:Envelope>`;

    const resp = await fetch(metadataUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'checkRetrieveStatus' },
      body: checkEnvelope,
    });

    if (resp.status === 401) throw new Error('SESSION_EXPIRED');
    if (!resp.ok) continue;

    const xml = await resp.text();
    const result = parseSoapResult(xml, 'checkRetrieveStatusResponse');
    if (!result) continue;

    if (result.done === 'true') {
      return result.status === 'Succeeded' ? (result.zipFile || null) : null;
    }
  }

  return null;
}

async function proxyDeployMetadata(
  instanceUrl: string,
  token: string,
  body: any,
  origin: string,
  env: Env
): Promise<Response> {
  const { zipBase64, testLevel, testClasses } = body;

  let latestVersion: string;
  try {
    latestVersion = await getLatestApiVersionParam(instanceUrl, token);
  } catch (e: any) {
    const status = e.message === 'SESSION_EXPIRED' ? 401 : 500;
    return jsonResponse({ error: e.message }, status, origin, env);
  }

  let testOptions = '';
  if (testLevel && testLevel !== 'NoTestRun') {
    testOptions = `<met:testLevel>${testLevel}</met:testLevel>`;
    if (testLevel === 'RunSpecifiedTests' && testClasses?.length > 0) {
      testOptions += testClasses.map((tc: string) => `<met:runTests>${escapeXml(tc)}</met:runTests>`).join('\n');
    }
  }

  const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <env:Header>
    <met:SessionHeader>
      <met:sessionId>${escapeXml(token)}</met:sessionId>
    </met:SessionHeader>
  </env:Header>
  <env:Body>
    <met:deploy>
      <met:ZipFile>${zipBase64}</met:ZipFile>
      <met:DeployOptions>
        <met:rollbackOnError>true</met:rollbackOnError>
        <met:singlePackage>true</met:singlePackage>
        <met:purgeOnDelete>true</met:purgeOnDelete>
        ${testOptions}
      </met:DeployOptions>
    </met:deploy>
  </env:Body>
</env:Envelope>`;

  const metadataUrl = `${instanceUrl}/services/Soap/m/${latestVersion}`;
  const resp = await fetch(metadataUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'deploy' },
    body: soapEnvelope,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return jsonResponse({ error: `Deploy request failed: ${errText}` }, 500, origin, env);
  }

  const xml = await resp.text();
  const deployResult = parseSoapResult(xml, 'deployResponse');
  const deployId: string | null = deployResult?.id ?? null;

  if (!deployId) {
    return jsonResponse({ error: 'Failed to get deploy ID' }, 500, origin, env);
  }

  return jsonResponse({ deployId }, 200, origin, env);
}

async function proxyCheckDeployStatus(
  instanceUrl: string,
  token: string,
  deployId: string,
  origin: string,
  env: Env
): Promise<Response> {
  let latestVersion: string;
  try {
    latestVersion = await getLatestApiVersionParam(instanceUrl, token);
  } catch (e: any) {
    const status = e.message === 'SESSION_EXPIRED' ? 401 : 500;
    return jsonResponse({ error: e.message }, status, origin, env);
  }

  const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:met="http://soap.sforce.com/2006/04/metadata">
  <env:Header>
    <met:SessionHeader>
      <met:sessionId>${escapeXml(token)}</met:sessionId>
    </met:SessionHeader>
  </env:Header>
  <env:Body>
    <met:checkDeployStatus>
      <met:asyncProcessId>${deployId}</met:asyncProcessId>
      <met:includeDetails>true</met:includeDetails>
    </met:checkDeployStatus>
  </env:Body>
</env:Envelope>`;

  const metadataUrl = `${instanceUrl}/services/Soap/m/${latestVersion}`;
  const resp = await fetch(metadataUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'checkDeployStatus' },
    body: soapEnvelope,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return jsonResponse({ error: `Deploy status check failed: ${errText}` }, 500, origin, env);
  }

  const xml = await resp.text();
  const deployResult = parseSoapResult(xml, 'checkDeployStatusResponse');

  if (!deployResult) {
    return jsonResponse({ error: 'Failed to parse deploy status response' }, 500, origin, env);
  }

  const details = deployResult.details ?? {};

  const componentFailureErrors = asArray<any>(details.componentFailures)
    .map(f => f.problem)
    .filter((s: any): s is string => typeof s === 'string' && s.length > 0);

  const runTestResult = details.runTestResult ?? {};
  const coverageErrors = asArray<any>(runTestResult.codeCoverageWarnings)
    .map(w => w.message)
    .filter((s: any): s is string => typeof s === 'string' && s.length > 0);

  const topError = typeof deployResult.errorMessage === 'string' ? [deployResult.errorMessage] : [];

  const errors: string[] = [...topError, ...componentFailureErrors, ...coverageErrors]
    .filter((v, i, a) => v && a.indexOf(v) === i);

  const testFailures = asArray<any>(runTestResult.failures).map(f => ({
    name: typeof f.name === 'string' ? f.name : 'Unknown',
    methodName: typeof f.methodName === 'string' ? f.methodName : 'Unknown',
    message: typeof f.message === 'string' ? f.message : 'No message',
  }));

  return jsonResponse({
    done: deployResult.done === 'true',
    success: deployResult.success === 'true',
    status: typeof deployResult.status === 'string' ? deployResult.status : 'Unknown',
    numberComponentsDeployed: parseInt(deployResult.numberComponentsDeployed || '0'),
    numberComponentsTotal: parseInt(deployResult.numberComponentsTotal || '0'),
    numberComponentErrors: parseInt(deployResult.numberComponentErrors || '0'),
    numberTestsCompleted: parseInt(deployResult.numberTestsCompleted || '0'),
    numberTestsTotal: parseInt(deployResult.numberTestsTotal || '0'),
    numberTestErrors: parseInt(deployResult.numberTestErrors || '0'),
    errors,
    testFailures,
  }, 200, origin, env);
}

async function proxyDeleteFlowVersion(
  instanceUrl: string,
  token: string,
  body: any,
  origin: string,
  env: Env
): Promise<Response> {
  const { flowId } = body;

  if (!flowId) {
    return jsonResponse({ success: false, error: 'Missing flowId' }, 400, origin, env);
  }
  if (typeof flowId !== 'string' || !/^[a-zA-Z0-9]{15,18}$/.test(flowId)) {
    return jsonResponse({ success: false, error: 'Invalid flowId format' }, 400, origin, env);
  }

  let latestVersion: string;
  try {
    latestVersion = await getLatestApiVersionParam(instanceUrl, token);
  } catch (e: any) {
    const status = e.message === 'SESSION_EXPIRED' ? 401 : 500;
    return jsonResponse({ error: e.message }, status, origin, env);
  }

  // Safety check: never delete an Active flow version
  const checkResp = await fetch(
    `${instanceUrl}/services/data/v${latestVersion}/tooling/sobjects/Flow/${flowId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!checkResp.ok) {
    return jsonResponse({ success: false, error: 'Flow version not found' }, 404, origin, env);
  }

  const flowRecord: any = await checkResp.json();
  if (flowRecord.Status === 'Active') {
    return jsonResponse({ success: false, error: 'Refusing to delete an Active flow version' }, 400, origin, env);
  }

  const deleteResp = await fetch(
    `${instanceUrl}/services/data/v${latestVersion}/tooling/sobjects/Flow/${flowId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  );

  if (!deleteResp.ok) {
    const errText = await deleteResp.text();
    return jsonResponse({ success: false, error: errText }, 500, origin, env);
  }

  return jsonResponse({ success: true }, 200, origin, env);
}

async function proxyListTestClasses(instanceUrl: string, token: string, origin: string, env: Env): Promise<Response> {
  let apiVersion: string;
  try {
    apiVersion = await getLatestApiVersionParam(instanceUrl, token);
  } catch (e: any) {
    const status = e.message === 'SESSION_EXPIRED' ? 401 : 500;
    return jsonResponse({ error: e.message }, status, origin, env);
  }

  const classes: { id: string; name: string; }[] = [];
  let nextUrl: string | null =
    `${instanceUrl}/services/data/v${apiVersion}/tooling/tests/?category=apex&showAllMethods=true&pageSize=1000`;

  while (nextUrl) {
    const resp = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${token}`, 'X-Chatter-Entity-Encoding': 'false' },
    });
    if (!resp.ok) {
      const err = await resp.text();
      return jsonResponse({ error: `Failed to fetch test classes: ${err}` }, 500, origin, env);
    }
    const data: any = await resp.json();
    for (const cls of (data.apexTestClasses || [])) {
      classes.push({ id: cls.id, name: cls.name });
    }
    nextUrl = data.nextRecordsUrl ? `${instanceUrl}${data.nextRecordsUrl}` : null;
  }

  classes.sort((a, b) => a.name.localeCompare(b.name));
  return jsonResponse({ classes }, 200, origin, env);
}

async function proxyListTestSuites(instanceUrl: string, token: string, origin: string, env: Env): Promise<Response> {
  let apiVersion: string;
  try {
    apiVersion = await getLatestApiVersionParam(instanceUrl, token);
  } catch (e: any) {
    const status = e.message === 'SESSION_EXPIRED' ? 401 : 500;
    return jsonResponse({ error: e.message }, status, origin, env);
  }

  const query = `SELECT Id, TestSuiteName FROM ApexTestSuite ORDER BY TestSuiteName`;
  const resp = await fetch(
    `${instanceUrl}/services/data/v${apiVersion}/tooling/query?q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!resp.ok) {
    const err = await resp.text();
    return jsonResponse({ error: `Failed to fetch test suites: ${err}` }, 500, origin, env);
  }

  const data: any = await resp.json();
  const suites = (data.records || []).map((r: any) => ({ id: r.Id, name: r.TestSuiteName }));
  return jsonResponse({ suites }, 200, origin, env);
}

async function proxyGetSuiteClasses(
  instanceUrl: string,
  token: string,
  body: any,
  origin: string,
  env: Env
): Promise<Response> {
  const { suiteNames } = body as { suiteNames: string[]; };
  if (!Array.isArray(suiteNames) || suiteNames.length === 0) {
    return jsonResponse({ classes: [] }, 200, origin, env);
  }

  const SAFE_NAME = /^[A-Za-z0-9_]+$/;
  const invalid = suiteNames.filter(n => typeof n !== 'string' || !SAFE_NAME.test(n));
  if (invalid.length > 0) {
    return jsonResponse({ error: `Invalid test suite name(s): ${invalid.join(', ')}` }, 400, origin, env);
  }

  let apiVersion: string;
  try {
    apiVersion = await getLatestApiVersionParam(instanceUrl, token);
  } catch (e: any) {
    const status = e.message === 'SESSION_EXPIRED' ? 401 : 500;
    return jsonResponse({ error: e.message }, status, origin, env);
  }

  const SAFE_ID = /^[a-zA-Z0-9]{15,18}$/;

  const nameList = suiteNames.map(n => `'${n}'`).join(',');
  const suiteResp = await fetch(
    `${instanceUrl}/services/data/v${apiVersion}/tooling/query?q=${encodeURIComponent(`SELECT Id FROM ApexTestSuite WHERE TestSuiteName IN (${nameList})`)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!suiteResp.ok) {
    const err = await suiteResp.text();
    return jsonResponse({ error: `Suite lookup failed: ${err}` }, 500, origin, env);
  }

  const suiteData: any = await suiteResp.json();
  const suiteIds = (suiteData.records || [])
    .map((r: any) => r.Id)
    .filter((id: any) => typeof id === 'string' && SAFE_ID.test(id));
  if (suiteIds.length === 0) return jsonResponse({ classes: [] }, 200, origin, env);

  const idList = suiteIds.map((id: string) => `'${id}'`).join(',');
  const memberResp = await fetch(
    `${instanceUrl}/services/data/v${apiVersion}/tooling/query?q=${encodeURIComponent(`SELECT ApexClassId FROM TestSuiteMembership WHERE ApexTestSuiteId IN (${idList})`)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!memberResp.ok) {
    const err = await memberResp.text();
    return jsonResponse({ error: `Suite membership lookup failed: ${err}` }, 500, origin, env);
  }

  const memberData: any = await memberResp.json();
  const classIds = [...new Set<string>(
    (memberData.records || [])
      .map((r: any) => r.ApexClassId)
      .filter((id: any) => typeof id === 'string' && SAFE_ID.test(id))
  )];
  if (classIds.length === 0) return jsonResponse({ classes: [] }, 200, origin, env);

  const classResp = await fetch(
    `${instanceUrl}/services/data/v${apiVersion}/tooling/query?q=${encodeURIComponent(`SELECT Name FROM ApexClass WHERE Id IN (${classIds.map(id => `'${id}'`).join(',')})`)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!classResp.ok) {
    const err = await classResp.text();
    return jsonResponse({ error: `Class name lookup failed: ${err}` }, 500, origin, env);
  }

  const classData: any = await classResp.json();
  return jsonResponse({ classes: (classData.records || []).map((r: any) => r.Name) }, 200, origin, env);
}

// ─── Version helpers ───────────────────────────────────────────────

function toApiVersionParam(version: string): string {
  return version.includes('.') ? version : `${version}.0`;
}

async function getLatestApiVersionParam(instanceUrl: string, token: string): Promise<string> {
  const cached = apiVersionCache.get(instanceUrl);
  if (cached) return cached;

  const promise = (async () => {
    const resp = await fetch(`${instanceUrl}/services/data/`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status === 401) throw new Error('SESSION_EXPIRED');
    if (!resp.ok) throw new Error(`Failed to fetch API versions: ${resp.status}`);
    const versions: any[] = await resp.json();
    if (!Array.isArray(versions) || versions.length === 0) {
      throw new Error('No API versions returned from Salesforce');
    }
    return toApiVersionParam(versions[versions.length - 1].version);
  })();

  promise.catch(() => apiVersionCache.delete(instanceUrl));
  apiVersionCache.set(instanceUrl, promise);
  return promise;
}

// ─── XML helpers ───────────────────────────────────────────────────

function parseSoapResult(xml: string, responseName: string): any {
  const parsed = xmlParser.parse(xml);
  const body = parsed?.Envelope?.Body;
  if (!body) return null;
  const response = body[responseName];
  if (!response) return null;
  return response.result ?? response;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSoapPackageTypes(typeMap: Map<string, string[]>): string {
  let xml = '';
  for (const [type, members] of typeMap) {
    xml += `<met:types>\n`;
    for (const member of members) {
      xml += `  <met:members>${escapeXml(member)}</met:members>\n`;
    }
    xml += `  <met:name>${type}</met:name>\n`;
    xml += `</met:types>\n`;
  }
  return xml;
}
