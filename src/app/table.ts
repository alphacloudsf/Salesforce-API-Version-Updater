import {
  componentsTbody, noComponentsMsg, paginationBar, paginationInfo,
  pageNumbers, pageFirstBtn, pagePrevBtn, pageNextBtn, pageLastBtn,
  componentsCount, selectAllCb, updateBtn, backupBtn,
} from './dom';
import {
  allComponents, filteredComponents, setFilteredComponents,
  currentPage, setCurrentPage, pageSize, setPageSize,
  sortCol, setSortCol, sortAsc, setSortAsc,
  type SortCol,
} from './state';
import { escapeHtml, statusBadge } from './ui';

export function applyFilters(
  search: string,
  statusVal: string,
  typeVal: string,
) {
  setFilteredComponents(allComponents.filter((c) => {
    if (search && !c.fullName.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusVal !== 'all' && c.status !== statusVal) return false;
    if (typeVal !== 'all' && c.typeLabel !== typeVal) return false;
    return true;
  }));
  applySort();
  setCurrentPage(1);
  renderTable();
}

export function applySort() {
  const dir = sortAsc ? 1 : -1;
  filteredComponents.sort((a, b) => {
    let av: string | number, bv: string | number;
    switch (sortCol) {
      case 'name': av = a.fullName.toLowerCase(); bv = b.fullName.toLowerCase(); break;
      case 'type': av = a.typeLabel.toLowerCase(); bv = b.typeLabel.toLowerCase(); break;
      case 'apiVersion': av = a.apiVersion; bv = b.apiVersion; break;
      case 'status': {
        const order: Record<string, number> = { deprecated: 0, outdated: 1, current: 2 };
        av = order[a.status] ?? 1; bv = order[b.status] ?? 1;
        break;
      }
      case 'lastModified':
        av = a.lastModifiedDate ?? '';
        bv = b.lastModifiedDate ?? '';
        break;
      default: return 0;
    }
    return av < bv ? -dir : av > bv ? dir : 0;
  });
  updateSortHeaders();
}

export function updateSortHeaders() {
  document.querySelectorAll<HTMLElement>('.th-sortable').forEach(th => {
    const arrow = th.querySelector('.sort-arrow')!;
    if (th.dataset.col === sortCol) {
      arrow.textContent = sortAsc ? '↑' : '↓';
      th.classList.add('th-sorted');
    } else {
      arrow.textContent = '';
      th.classList.remove('th-sorted');
    }
  });
}

export function renderTable() {
  componentsTbody.innerHTML = '';

  if (filteredComponents.length === 0) {
    noComponentsMsg.classList.remove('hidden');
    paginationBar.classList.add('hidden');
    componentsCount.textContent = '';
    updateBtn.disabled = true;
    backupBtn.disabled = true;
    return;
  }

  noComponentsMsg.classList.add('hidden');

  const totalPages = Math.ceil(filteredComponents.length / pageSize);
  setCurrentPage(Math.min(currentPage, totalPages));
  const start = (currentPage - 1) * pageSize;
  const pageItems = filteredComponents.slice(start, start + pageSize);

  for (const comp of pageItems) {
    const tr = document.createElement('tr');

    // Checkbox cell — use DOM API so fullName/type are never interpolated into HTML
    const cbTd = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'component-cb checkbox';
    cb.dataset.name = comp.fullName;
    cb.dataset.type = comp.type;
    cb.checked = comp.selected;
    cbTd.appendChild(cb);

    tr.appendChild(cbTd);
    tr.insertAdjacentHTML('beforeend', `
      <td class="component-name-cell" style="cursor:pointer;user-select:none;font-weight:500;">${escapeHtml(comp.fullName)}</td>
      <td style="color:var(--text-secondary);">${escapeHtml(comp.typeLabel)}</td>
      <td>v${comp.apiVersion}</td>
      <td>${statusBadge(comp.status)}</td>
      <td style="color:var(--text-tertiary);font-size:12px;">${comp.lastModifiedDate ? new Date(comp.lastModifiedDate).toLocaleDateString() : '-'}</td>
    `);

    componentsTbody.appendChild(tr);
  }

  // Checkbox change
  componentsTbody.querySelectorAll('.component-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      const input = cb as HTMLInputElement;
      const comp = allComponents.find((c) => c.fullName === input.dataset.name && c.type === input.dataset.type);
      if (comp) comp.selected = input.checked;
      updateActionButtons();
      syncSelectAll();
    });
  });

  // Click on name cell toggles checkbox
  componentsTbody.querySelectorAll('.component-name-cell').forEach((cell) => {
    cell.addEventListener('click', () => {
      const cb = cell.closest('tr')?.querySelector<HTMLInputElement>('.component-cb');
      if (!cb) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });
  });

  updatePagination(totalPages);
  updateActionButtons();
  syncSelectAll();
}

export function syncSelectAll() {
  const allSelected = filteredComponents.every((c) => c.selected);
  const noneSelected = filteredComponents.every((c) => !c.selected);
  selectAllCb.checked = allSelected && filteredComponents.length > 0;
  selectAllCb.indeterminate = !allSelected && !noneSelected;
}

export function updateActionButtons() {
  const selectedCount = allComponents.filter((c) => c.selected).length;
  componentsCount.textContent = `${selectedCount} of ${filteredComponents.length} selected`;
  updateBtn.disabled = selectedCount === 0;
  backupBtn.disabled = selectedCount === 0;
}

export function updatePagination(totalPages: number) {
  const show = filteredComponents.length > pageSize;
  paginationBar.classList.toggle('hidden', !show);
  if (!show) return;

  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, filteredComponents.length);
  paginationInfo.textContent = `${start}–${end} of ${filteredComponents.length}`;

  pageFirstBtn.disabled = currentPage === 1;
  pagePrevBtn.disabled = currentPage === 1;
  pageNextBtn.disabled = currentPage === totalPages;
  pageLastBtn.disabled = currentPage === totalPages;

  pageNumbers.innerHTML = '';
  const range = 2;
  for (let p = 1; p <= totalPages; p++) {
    if (p !== 1 && p !== totalPages && Math.abs(p - currentPage) > range) {
      if (p === currentPage - range - 1 || p === currentPage + range + 1) {
        const dots = document.createElement('span');
        dots.textContent = '…';
        dots.style.cssText = 'padding:0 4px;font-size:12px;color:var(--text-tertiary);';
        pageNumbers.appendChild(dots);
      }
      continue;
    }
    const btn = document.createElement('button');
    btn.textContent = String(p);
    btn.className = p === currentPage ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
    btn.addEventListener('click', () => { setCurrentPage(p); renderTable(); });
    pageNumbers.appendChild(btn);
  }
}

export function onSortHeaderClick(col: SortCol) {
  if (sortCol === col) {
    setSortAsc(!sortAsc);
  } else {
    setSortCol(col);
    setSortAsc(true);
  }
  applySort();
  setCurrentPage(1);
  renderTable();
}
