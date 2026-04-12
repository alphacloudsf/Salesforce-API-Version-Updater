// Configuration for the Salesforce API Version Updater
// All URLs are public values, secrets stay in Cloudflare.

// WORKER_URL: Salesforce API proxy (this project's worker with /sf/* routes only)
const WORKER_URL = import.meta.env.PUBLIC_WORKER_URL as string | undefined;
if (!WORKER_URL) {
  throw new Error(
    'PUBLIC_WORKER_URL is not set. Define it in your .env file or GitHub Actions secrets ' +
    '(e.g. PUBLIC_WORKER_URL=https://sf-api-version-updater.<your-account>.workers.dev).'
  );
}

// BROKER_URL: Generic Salesforce OAuth broker (sf-oauth-broker project with /oauth/* routes)
const BROKER_URL = import.meta.env.PUBLIC_BROKER_URL as string | undefined;
if (!BROKER_URL) {
  throw new Error(
    'PUBLIC_BROKER_URL is not set. Define it in your .env file or GitHub Actions secrets ' +
    '(e.g. PUBLIC_BROKER_URL=https://sf-oauth-broker.<your-account>.workers.dev).'
  );
}

export const CONFIG = {
  // Salesforce API proxy worker (/sf/* routes)
  WORKER_URL,
  // Generic OAuth broker worker (/oauth/* routes)
  BROKER_URL,

  // Salesforce OAuth scopes needed
  OAUTH_SCOPES: 'api refresh_token',

  // Session storage keys
  STORAGE_KEYS: {
    ACCESS_TOKEN: 'sf_access_token',
    REFRESH_TOKEN: 'sf_refresh_token',
    INSTANCE_URL: 'sf_instance_url',
    LOGIN_URL: 'sf_login_url',
    USER_INFO: 'sf_user_info',
    OAUTH_NONCE: 'sf_oauth_nonce',
  },

  // Metadata types we support
  METADATA_TYPES: [
    { xmlName: 'ApexClass', label: 'Apex Classes', icon: '{}' },
    { xmlName: 'ApexTrigger', label: 'Apex Triggers', icon: '⚡' },
    { xmlName: 'LightningComponentBundle', label: 'Lightning Web Components', icon: '⚙' },
    { xmlName: 'Flow', label: 'Flows', icon: '🔀' },
    { xmlName: 'AuraDefinitionBundle', label: 'Aura Components', icon: '💫' },
    { xmlName: 'ApexPage', label: 'Visualforce Pages', icon: '📄' },
    { xmlName: 'ApexComponent', label: 'Visualforce Components', icon: '🧩' },
  ] as const,

  // Managed package install links. Shown proactively on the login screen and guide page
  PACKAGE_INSTALL_URL_PROD: 'https://login.salesforce.com/packaging/installPackage.apexp?p0=04tQy000000Uk73IAC',
  PACKAGE_INSTALL_URL_SANDBOX: 'https://test.salesforce.com/packaging/installPackage.apexp?p0=04tQy000000Uk73IAC',
} as const;

export type MetadataTypeName = typeof CONFIG.METADATA_TYPES[number]['xmlName'];
