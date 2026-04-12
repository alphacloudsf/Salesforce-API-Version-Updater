import {
	loginProdBtn, loginSandboxBtn, logoutBtn, loadComponentsBtn,
	searchInput, statusFilter, typeFilter, updateBtn, backupBtn,
	testLevelSelect, testClassesSelectAll, testClassesClear,
	testSuitesSelectAll, testSuitesClear, testClassesSearch, testSuitesSearch,
	testClassesList, testSuitesList,
	selectAllCb, pageFirstBtn, pagePrevBtn, pageNextBtn, pageLastBtn, pageSizeSelect,
	sessionExpiredModal, sessionExpiredProdBtn, sessionExpiredSandboxBtn,
	errorModal, errorModalDismiss,
} from './dom';
import {
	filteredComponents, currentPage, pageSize, setCurrentPage, setPageSize, type SortCol,
} from './state';
import { isAuthenticated, initiateLogin, logout, handleHashCallback } from '../lib/auth';
import { SESSION_EXPIRED_EVENT } from '../lib/salesforce';
import { showLogin, showDashboard, loadComponents } from './dashboard';
import { applyFilters, onSortHeaderClick, renderTable } from './table';
import { onTestLevelChange, setAllChecked, filterTestPicker } from './test-picker';
import { performUpdate, performBackupOnly } from './update';

export async function init() {
	// Session expired. Fired by sfFetch when refresh also fails
	window.addEventListener(SESSION_EXPIRED_EVENT, () => {
		sessionExpiredModal.classList.remove('hidden');
	});
	sessionExpiredProdBtn.addEventListener('click', () => initiateLogin('https://login.salesforce.com'));
	sessionExpiredSandboxBtn.addEventListener('click', () => initiateLogin('https://test.salesforce.com'));
	errorModalDismiss.addEventListener('click', () => errorModal.classList.add('hidden'));

	// Auth
	loginProdBtn.addEventListener('click', () => initiateLogin('https://login.salesforce.com'));
	loginSandboxBtn.addEventListener('click', () => initiateLogin('https://test.salesforce.com'));
	logoutBtn.addEventListener('click', logout);

	// Dashboard
	loadComponentsBtn.addEventListener('click', loadComponents);

	// Filters and search
	searchInput.addEventListener('input', () => applyFilters(searchInput.value, statusFilter.value, typeFilter.value));
	statusFilter.addEventListener('change', () => applyFilters(searchInput.value, statusFilter.value, typeFilter.value));
	typeFilter.addEventListener('change', () => applyFilters(searchInput.value, statusFilter.value, typeFilter.value));

	// Column sort
	document.querySelectorAll<HTMLElement>('.th-sortable').forEach(th => {
		th.addEventListener('click', () => onSortHeaderClick(th.dataset.col as SortCol));
	});

	// Select all
	selectAllCb.addEventListener('change', () => {
		filteredComponents.forEach((c) => { c.selected = selectAllCb.checked; });
		renderTable();
	});

	// Pagination
	pageFirstBtn.addEventListener('click', () => { setCurrentPage(1); renderTable(); });
	pagePrevBtn.addEventListener('click', () => { setCurrentPage(currentPage - 1); renderTable(); });
	pageNextBtn.addEventListener('click', () => { setCurrentPage(currentPage + 1); renderTable(); });
	pageLastBtn.addEventListener('click', () => { setCurrentPage(Math.ceil(filteredComponents.length / pageSize)); renderTable(); });
	pageSizeSelect.addEventListener('change', () => {
		setPageSize(parseInt(pageSizeSelect.value));
		setCurrentPage(1);
		renderTable();
	});

	// Update actions
	updateBtn.addEventListener('click', performUpdate);
	backupBtn.addEventListener('click', performBackupOnly);

	// Test level
	testLevelSelect.addEventListener('change', onTestLevelChange);
	testClassesSelectAll.addEventListener('click', () => setAllChecked(testClassesList, true));
	testClassesClear.addEventListener('click', () => setAllChecked(testClassesList, false));
	testSuitesSelectAll.addEventListener('click', () => setAllChecked(testSuitesList, true));
	testSuitesClear.addEventListener('click', () => setAllChecked(testSuitesList, false));
	testClassesSearch.addEventListener('input', () => filterTestPicker(testClassesList, testClassesSearch.value));
	testSuitesSearch.addEventListener('input', () => filterTestPicker(testSuitesList, testSuitesSearch.value));

	// Route: OAuth callback or already authenticated
	if (handleHashCallback()) {
		await showDashboard();
		return;
	}

	if (isAuthenticated()) {
		await showDashboard();
	} else {
		showLogin();
	}
}
