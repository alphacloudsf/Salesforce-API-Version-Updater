import {
  testClassesPanel, testClassesList, testClassesLoading, testClassesEmpty, testClassesSearch,
  testSuitesPanel, testSuitesList, testSuitesLoading, testSuitesEmpty, testSuitesSearch,
  testLevelSelect,
} from './dom';
import { testClassesLoaded, testSuitesLoaded, setTestClassesLoaded, setTestSuitesLoaded } from './state';
import { listTestClasses, listTestSuites } from '../lib/salesforce';
import { escapeHtml } from './ui';

export function renderTestPicker(
  container: HTMLElement,
  items: { id: string; name: string; }[],
  loadingEl: HTMLElement,
  emptyEl: HTMLElement,
  searchEl?: HTMLInputElement,
) {
  loadingEl.classList.add('hidden');
  if (items.length === 0) {
    emptyEl.classList.remove('hidden');
    return;
  }
  container.innerHTML = '';
  for (const item of items) {
    const label = document.createElement('label');
    label.className = 'test-picker-item';
    label.innerHTML = `<input type="checkbox" class="checkbox" value="${item.name}"><span>${escapeHtml(item.name)}</span>`;
    container.appendChild(label);
  }
  container.classList.remove('hidden');
  if (searchEl) searchEl.classList.remove('hidden');
}

export function filterTestPicker(container: HTMLElement, query: string) {
  const q = query.toLowerCase();
  container.querySelectorAll<HTMLElement>('label.test-picker-item').forEach(label => {
    const name = label.querySelector('span')?.textContent?.toLowerCase() ?? '';
    label.style.display = name.includes(q) ? '' : 'none';
  });
}

export function getCheckedValues(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')
  ).map(cb => cb.value);
}

export function setAllChecked(container: HTMLElement, checked: boolean) {
  container.querySelectorAll<HTMLElement>('label.test-picker-item').forEach(label => {
    if (label.style.display === 'none') return;
    const cb = label.querySelector<HTMLInputElement>('input[type=checkbox]');
    if (cb) cb.checked = checked;
  });
}

export async function onTestLevelChange() {
  const val = testLevelSelect.value;
  testClassesPanel.classList.toggle('hidden', val !== 'RunSpecifiedTests');
  testSuitesPanel.classList.toggle('hidden', val !== 'RunSpecifiedTestSuites');

  if (val === 'RunSpecifiedTests' && !testClassesLoaded) {
    setTestClassesLoaded(true);
    try {
      const classes = await listTestClasses();
      renderTestPicker(testClassesList, classes, testClassesLoading, testClassesEmpty, testClassesSearch);
    } catch (err: any) {
      testClassesLoading.textContent = `Error loading test classes: ${err.message}`;
    }
  }

  if (val === 'RunSpecifiedTestSuites' && !testSuitesLoaded) {
    setTestSuitesLoaded(true);
    try {
      const suites = await listTestSuites();
      renderTestPicker(testSuitesList, suites, testSuitesLoading, testSuitesEmpty, testSuitesSearch);
    } catch (err: any) {
      testSuitesLoading.textContent = `Error loading test suites: ${err.message}`;
    }
  }
}
