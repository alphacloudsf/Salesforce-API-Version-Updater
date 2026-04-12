import type { ComponentInfo } from '../lib/salesforce';

export type SortCol = 'name' | 'type' | 'apiVersion' | 'status' | 'lastModified';

// Component data
export let allComponents: ComponentInfo[] = [];
export let filteredComponents: ComponentInfo[] = [];
export let deprecatedThreshold = 0;
export let allApiVersions: { version: string; label: string; }[] = [];
export let selectedTypes: Set<string> = new Set();

// Test picker. Loaded lazily on first selection
export let testClassesLoaded = false;
export let testSuitesLoaded = false;

// Pagination
export let currentPage = 1;
export let pageSize = 25;

// Sorting
export let sortCol: SortCol = 'name';
export let sortAsc = true;

// Setters (modules can't reassign exported lets from other modules in TS without this)
export function setAllComponents(v: ComponentInfo[]) { allComponents = v; }
export function setFilteredComponents(v: ComponentInfo[]) { filteredComponents = v; }
export function setDeprecatedThreshold(v: number) { deprecatedThreshold = v; }
export function setAllApiVersions(v: { version: string; label: string; }[]) { allApiVersions = v; }
export function setTestClassesLoaded(v: boolean) { testClassesLoaded = v; }
export function setTestSuitesLoaded(v: boolean) { testSuitesLoaded = v; }
export function setCurrentPage(v: number) { currentPage = v; }
export function setPageSize(v: number) { pageSize = v; }
export function setSortCol(v: SortCol) { sortCol = v; }
export function setSortAsc(v: boolean) { sortAsc = v; }
