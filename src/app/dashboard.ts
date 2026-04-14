import {
  loginSection, dashboardSection, userInfoDiv, usernameDisplay, orgInfoSpan,
  latestVersionBadge, targetVersionSelect, metadataTypeGrid, loadComponentsBtn,
  componentsSection, typeFilter, flowOptions, progressSyncRow,
} from './dom';
import {
  setDeprecatedThreshold, setAllApiVersions, setAllComponents,
  deprecatedThreshold, selectedTypes,
} from './state';
import { CONFIG } from '../lib/config';
import type { MetadataTypeName } from '../lib/config';
import { getTokens, getUserInfo } from '../lib/auth';
import { getLatestApiVersion, listComponents } from '../lib/salesforce';
import { showLoading, hideLoading, logError } from './ui';
import { applyFilters } from './table';
import { searchInput, statusFilter } from './dom';

export function showLogin() {
  loginSection.classList.remove('hidden');
  dashboardSection.classList.add('hidden');
  userInfoDiv.classList.add('hidden');
}

export async function showDashboard() {
  loginSection.classList.add('hidden');
  dashboardSection.classList.remove('hidden');

  const userInfo = getUserInfo();
  if (userInfo) {
    userInfoDiv.classList.remove('hidden');
    usernameDisplay.textContent = userInfo.username;
    usernameDisplay.title = userInfo.username;
    orgInfoSpan.textContent = `${userInfo.displayName} / ${userInfo.username} (Org Id: ${userInfo.orgId})`;
  }

  showLoading('Fetching latest API version...');
  try {
    const latest = await getLatestApiVersion();
    latestVersionBadge.textContent = `v${latest.version}`;

    // Fetch all available API versions to populate the target dropdown
    const resp = await fetch(`${CONFIG.WORKER_URL}/sf/api-versions`, {
      headers: {
        'Content-Type': 'application/json',
        'X-SF-Access-Token': getTokens()!.accessToken,
        'X-SF-Instance-URL': getTokens()!.instanceUrl,
      },
    });
    const allApiVersions: { version: string; label: string; }[] = await resp.json();
    setAllApiVersions(allApiVersions);

    // Show last 10 versions; anything older is deprecated
    targetVersionSelect.innerHTML = '';
    const recentVersions = allApiVersions.slice(-10).reverse();
    if (recentVersions.length > 0) {
      setDeprecatedThreshold(parseFloat(recentVersions[recentVersions.length - 1].version));
    }
    for (const v of recentVersions) {
      const opt = document.createElement('option');
      opt.value = v.version;
      opt.textContent = `v${v.version} - ${v.label}`;
      if (v.version === latest.version) opt.selected = true;
      targetVersionSelect.appendChild(opt);
    }
  } catch (err: any) {
    logError(`Failed to fetch API versions: ${err.message}`);
  }
  hideLoading();

  buildMetadataTypeGrid();
}

export function buildMetadataTypeGrid() {
  metadataTypeGrid.innerHTML = '';
  for (const mt of CONFIG.METADATA_TYPES) {
    const label = document.createElement('label');
    label.className = 'type-chip';
    label.innerHTML = `<input type="checkbox" value="${mt.xmlName}" class="metadata-type-cb checkbox"><span>${mt.label}</span>`;
    metadataTypeGrid.appendChild(label);
  }

  metadataTypeGrid.querySelectorAll('.metadata-type-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      const input = cb as HTMLInputElement;
      const card = input.closest('label')!;
      if (input.checked) {
        selectedTypes.add(input.value);
        card.classList.add('selected');
      } else {
        selectedTypes.delete(input.value);
        card.classList.remove('selected');
      }
      loadComponentsBtn.disabled = selectedTypes.size === 0;
      flowOptions.classList.toggle('hidden', !selectedTypes.has('Flow'));
    });
  });
}

export async function loadComponents() {
  showLoading('Loading components...');
  setAllComponents([]);

  try {
    const promises = Array.from(selectedTypes).map((type) =>
      listComponents(type as MetadataTypeName, deprecatedThreshold)
    );
    const results = await Promise.all(promises);
    const flat = results.flat();
    flat.sort((a, b) => a.fullName.localeCompare(b.fullName));
    setAllComponents(flat);

    // Populate type filter dropdown
    const types = [...new Set(flat.map((c) => c.typeLabel))];
    typeFilter.innerHTML = '<option value="all">All Types</option>';
    for (const t of types) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      typeFilter.appendChild(opt);
    }

    applyFilters(searchInput.value, statusFilter.value, typeFilter.value);
    componentsSection.classList.remove('hidden');
    progressSyncRow.classList.remove('hidden');
  } catch (err: any) {
    logError(`Failed to load components: ${err.message}`);
  }

  hideLoading();
}
