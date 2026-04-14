import JSZip from 'jszip';

/**
 * Updates the API version in metadata XML files within a zip package.
 * Only modifies the <apiVersion> tag. No other changes to the metadata.
 */
export async function updateApiVersionInZip(
  zipBase64: string,
  newApiVersion: string
): Promise<string> {
  const sourceZip = await JSZip.loadAsync(zipBase64, { base64: true });
  const deployZip = new JSZip();
  // Global flag so every <apiVersion> in the file is rewritten, not just the
  // first. Metadata files today only have one tag, but this keeps us safe if
  // Salesforce ever emits multiple (e.g. nested subflow definitions).
  const apiVersionRegex = /<apiVersion>[\d.]+<\/apiVersion>/g;
  const newTag = `<apiVersion>${newApiVersion}</apiVersion>`;

  // Salesforce retrieve zips nest everything under "unpackaged/".
  // Deploy with singlePackage:true expects files at the root.
  // Strip the "unpackaged/" prefix when rebuilding the deploy zip.
  const PREFIX = 'unpackaged/';

  const copyPromises: Promise<void>[] = [];

  sourceZip.forEach((relativePath, file) => {
    if (file.dir) return;

    const deployPath = relativePath.startsWith(PREFIX)
      ? relativePath.slice(PREFIX.length)
      : relativePath;

    if (!deployPath) return; // was the root "unpackaged/" dir entry itself

    const promise = (async () => {
      if (isMetadataXml(deployPath)) {
        const content = await file.async('string');
        // Use replace unconditionally; if no match, content is unchanged.
        // Avoids the /g test()/replace() stateful lastIndex pitfall.
        deployZip.file(deployPath, content.replace(apiVersionRegex, newTag));
      } else {
        // Keep binary files (e.g. .cls body, static resources) as-is
        const data = await file.async('uint8array');
        deployZip.file(deployPath, data);
      }
    })();

    copyPromises.push(promise);
  });

  await Promise.all(copyPromises);
  return deployZip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}

function isMetadataXml(path: string): boolean {
  // All -meta.xml files contain apiVersion
  if (path.endsWith('-meta.xml')) return true;
  // Flows can also be retrieved as plain .flow files (no -meta.xml suffix)
  if (path.startsWith('flows/') && path.endsWith('.flow')) return true;
  return false;
}

/**
 * Extracts unpackaged/package.xml from a retrieve zip and returns it as a Blob.
 * Returns null if the file is not found.
 */
export async function extractPackageXml(zipBase64: string): Promise<Blob | null> {
  const zip = await JSZip.loadAsync(zipBase64, { base64: true });
  const file = zip.file('unpackaged/package.xml');
  if (!file) return null;
  const content = await file.async('uint8array');
  return new Blob([content], { type: 'application/xml' });
}

/**
 * Creates a downloadable backup from a base64 zip
 */
export function downloadBackup(zipBase64: string, filename: string): void {
  const byteString = atob(zipBase64);
  const bytes = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    bytes[i] = byteString.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
