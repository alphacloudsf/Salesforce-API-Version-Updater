import {
  loadingOverlay, loadingText,
  progressLog, progressBar, progressText,
  errorModal, errorModalBody,
} from './dom';

export function showLoading(text = 'Loading...') {
  loadingText.textContent = text;
  loadingOverlay.classList.remove('hidden');
}

export function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

export function logProgress(message: string, type: 'info' | 'success' | 'error' | 'warning' = 'info') {
  const div = document.createElement('div');
  div.className = `log-line log-${type}`;
  const icons: Record<string, string> = { info: 'i', success: '✓', error: '✗', warning: '!' };
  div.innerHTML = `<span style="opacity:0.5;">[${icons[type]}]</span> ${escapeHtml(message)}`;
  progressLog.appendChild(div);
  progressLog.scrollTop = progressLog.scrollHeight;
}

export function logError(message: string) {
  errorModalBody.textContent = message;
  errorModal.classList.remove('hidden');
}

export function updateProgress(pct: number) {
  const clamped = Math.min(100, pct);
  progressBar.style.width = `${clamped}%`;
  progressText.textContent = `${Math.round(clamped)}%`;
}

export function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function statusBadge(status: string): string {
  const labels: Record<string, string> = { current: 'Current', outdated: 'Outdated', deprecated: 'Deprecated' };
  return `<span class="pill pill-${status}">${labels[status] || status}</span>`;
}
