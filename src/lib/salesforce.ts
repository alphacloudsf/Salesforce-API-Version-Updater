import { CONFIG } from './config';
import { getTokens, clearAuth, refreshAccessToken } from './auth';
import type { MetadataTypeName } from './config';

/**
 * Fired when refresh fails and the user truly needs to log in again.
 * index.astro listens for this to show a re-auth modal without destroying
 * the current page state (so the user can see what was in flight).
 */
export const SESSION_EXPIRED_EVENT = 'sf:session-expired';

export interface ComponentInfo {
  fullName: string;
  type: MetadataTypeName;
  typeLabel: string;
  apiVersion: number;
  id?: string;
  lastModifiedDate?: string;
  status: 'current' | 'outdated' | 'deprecated';
  selected: boolean;
}

export interface LatestApiVersion {
  version: string;
  label: string;
  url: string;
}

async function doFetch(path: string, options: RequestInit, accessToken: string, instanceUrl: string): Promise<Response> {
  const url = `${CONFIG.WORKER_URL}/sf${path}`;
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Content-Type': 'application/json',
      'X-SF-Access-Token': accessToken,
      'X-SF-Instance-URL': instanceUrl,
    },
  });
}

async function sfFetch(path: string, options: RequestInit = {}): Promise<Response> {
  let tokens = getTokens();
  if (!tokens) throw new Error('Not authenticated');

  let response = await doFetch(path, options, tokens.accessToken, tokens.instanceUrl);

  // On 401, try to refresh the access token once and retry the request.
  // This lets long-running operations (deploy polls, retrieves on big orgs)
  // survive token expiry without interrupting the user.
  if (response.status === 401) {
    const newAccessToken = await refreshAccessToken();
    if (newAccessToken) {
      // Re-read tokens in case instanceUrl was refreshed too
      tokens = getTokens();
      if (tokens) {
        response = await doFetch(path, options, tokens.accessToken, tokens.instanceUrl);
      }
    }

    // Still 401? Refresh failed. Don't destroy the page, notify the app so
    // it can show a re-auth modal and preserve the log/state.
    if (response.status === 401) {
      clearAuth();
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
      throw new Error('Session expired. Please log in again.');
    }
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Salesforce API error (${response.status}): ${errorBody}`);
  }

  return response;
}

export async function getLatestApiVersion(): Promise<LatestApiVersion> {
  const response = await sfFetch('/api-versions');
  const versions: LatestApiVersion[] = await response.json();
  // The last entry is the latest version
  return versions[versions.length - 1];
}

export async function listComponents(metadataType: MetadataTypeName, deprecatedThreshold: number): Promise<ComponentInfo[]> {
  const response = await sfFetch(`/metadata/list?type=${encodeURIComponent(metadataType)}`);
  const data = await response.json();

  if (data.queryError) {
    throw new Error(`${metadataType}: ${data.queryError}`);
  }

  const typeConfig = CONFIG.METADATA_TYPES.find(t => t.xmlName === metadataType);

  return (data.components || []).map((c: any) => ({
    fullName: c.fullName,
    type: metadataType,
    typeLabel: typeConfig?.label || metadataType,
    apiVersion: parseFloat(c.apiVersion) || 0,
    id: c.id,
    lastModifiedDate: c.lastModifiedDate,
    status: getVersionStatus(parseFloat(c.apiVersion) || 0, data.latestVersion, deprecatedThreshold),
    selected: false,
  }));
}

function getVersionStatus(version: number, latest: number, deprecatedThreshold: number): ComponentInfo['status'] {
  if (version >= latest) return 'current';
  if (version < deprecatedThreshold) return 'deprecated';
  return 'outdated';
}

export async function retrieveMetadata(
  components: { type: MetadataTypeName; fullName: string; }[]
): Promise<string> {
  // Returns base64 encoded zip
  const response = await sfFetch('/metadata/retrieve', {
    method: 'POST',
    body: JSON.stringify({ components }),
  });
  const data = await response.json();
  if (!data.zipBase64) {
    throw new Error(data.error || 'Retrieve returned no zip data');
  }
  return data.zipBase64;
}

export async function deployMetadata(
  zipBase64: string,
  options: {
    testLevel?: 'NoTestRun' | 'RunLocalTests' | 'RunAllTestsInOrg' | 'RunSpecifiedTests' | 'RunRelevantTests';
    testClasses?: string[];
    rollbackOnError?: boolean;
  } = {}
): Promise<{ deployId: string; }> {
  const response = await sfFetch('/metadata/deploy', {
    method: 'POST',
    body: JSON.stringify({
      zipBase64,
      testLevel: options.testLevel || 'NoTestRun',
      testClasses: options.testClasses || [],
      rollbackOnError: options.rollbackOnError ?? true,
    }),
  });
  return response.json();
}

export async function checkDeployStatus(deployId: string): Promise<{
  done: boolean;
  success: boolean;
  status: string;
  numberComponentsDeployed: number;
  numberComponentsTotal: number;
  numberComponentErrors: number;
  numberTestsCompleted: number;
  numberTestsTotal: number;
  numberTestErrors: number;
  errors: string[];
  testFailures: { name: string; methodName: string; message: string; }[];
}> {
  const response = await sfFetch(`/metadata/deploy-status?id=${encodeURIComponent(deployId)}`);
  return response.json();
}

export async function listTestClasses(): Promise<{ id: string; name: string; }[]> {
  const response = await sfFetch('/test-classes');
  const data = await response.json();
  return data.classes || [];
}

export async function listTestSuites(): Promise<{ id: string; name: string; }[]> {
  const response = await sfFetch('/test-suites');
  const data = await response.json();
  return data.suites || [];
}

export async function getSuiteClasses(suiteNames: string[]): Promise<string[]> {
  const response = await sfFetch('/test-suites/classes', {
    method: 'POST',
    body: JSON.stringify({ suiteNames }),
  });
  const data = await response.json();
  return data.classes || [];
}

export async function deleteFlowVersion(
  flowId: string
): Promise<{ success: boolean; error?: string; }> {
  const response = await sfFetch('/metadata/delete-flow-version', {
    method: 'POST',
    body: JSON.stringify({ flowId }),
  });
  return response.json();
}
