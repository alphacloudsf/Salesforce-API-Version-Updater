import type { ComponentInfo } from '../lib/salesforce';
import { extractPackageXml } from '../lib/metadata-processor';
import {
  progressPlaceholder,
  repoSyncPlaceholder,
  repoSyncCommands,
  retrieveCommandEl,
  checkoutCommandBashEl,
  checkoutCommandPwshEl,
  copyRetrieveBtn,
  copyCheckoutBashBtn,
  copyCheckoutPwshBtn,
  downloadPackageXmlBtn,
} from './dom';

const RETRIEVE_CMD = 'sf project retrieve start --manifest manifest/sf-api-updated-package.xml';

export async function showRepoSyncPanel(updatedComponents: ComponentInfo[], zipBase64: string): Promise<void> {
  retrieveCommandEl.textContent = RETRIEVE_CMD;
  const { bash, pwsh } = buildCheckoutCommands();
  checkoutCommandBashEl.textContent = bash;
  checkoutCommandPwshEl.textContent = pwsh;

  // Wire up package.xml download
  const pkgBlob = await extractPackageXml(zipBase64);
  if (pkgBlob) {
    downloadPackageXmlBtn.classList.remove('hidden');
    downloadPackageXmlBtn.onclick = () => {
      const url = URL.createObjectURL(pkgBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'sf-api-updated-package.xml';
      a.click();
      URL.revokeObjectURL(url);
    };
  }

  // Swap placeholder for commands
  repoSyncPlaceholder.classList.add('hidden');
  repoSyncCommands.classList.remove('hidden');

  // Pulse the sync card to draw attention
  const card = repoSyncCommands.closest('.card') as HTMLElement | null;
  if (card) {
    card.classList.remove('repo-sync-pulse');
    void card.offsetWidth;
    card.classList.add('repo-sync-pulse');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  copyRetrieveBtn.onclick = () => copyToClipboard(RETRIEVE_CMD, copyRetrieveBtn);
  copyCheckoutBashBtn.onclick = () => copyToClipboard(bash, copyCheckoutBashBtn);
  copyCheckoutPwshBtn.onclick = () => copyToClipboard(pwsh, copyCheckoutPwshBtn);
}

export function hideProgressPlaceholder(): void {
  progressPlaceholder.classList.add('hidden');
}


function buildCheckoutCommands(): { bash: string; pwsh: string; } {
  const bash = `git add $(git ls-files --modified --others --exclude-standard | grep -E '\\-meta\\.xml$')`;
  const pwsh = `git ls-files --modified --others --exclude-standard | Where-Object { $_ -match '\\-meta\\.xml$' } | ForEach-Object { git add $_ }`;
  return { bash, pwsh };
}

function copyToClipboard(text: string, btn: HTMLButtonElement): void {
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  });
}
