import {
  targetVersionSelect, testLevelSelect, backupBeforeUpdate, deleteOldFlowVersion,
  progressSection, progressLog, progressBarContainer, backupBtn,
} from './dom';
import { allComponents } from './state';
import {
  retrieveMetadata, deployMetadata, checkDeployStatus, deleteFlowVersion, getSuiteClasses,
} from '../lib/salesforce';
import { updateApiVersionInZip, downloadBackup } from '../lib/metadata-processor';
import { logProgress, updateProgress, showLoading, hideLoading } from './ui';
import { getCheckedValues } from './test-picker';
import { testClassesList, testSuitesList } from './dom';

export async function performUpdate() {
  const selected = allComponents.filter((c) => c.selected);
  if (selected.length === 0) return;

  const targetVersion = targetVersionSelect.value;
  const rawTestLevel = testLevelSelect.value;
  const shouldBackup = backupBeforeUpdate.checked;
  const shouldDeleteOldFlow = deleteOldFlowVersion.checked;

  // Resolve test level + classes
  // 'RunSpecifiedTestSuites' is UI-only. Resolve to class names then use RunSpecifiedTests
  let testLevel: string = rawTestLevel;
  let testClasses: string[] = [];

  if (rawTestLevel === 'RunSpecifiedTests') {
    testClasses = getCheckedValues(testClassesList);
    if (testClasses.length === 0) {
      logProgress('Please select at least one test class.', 'error');
      progressSection.classList.remove('hidden');
      return;
    }
  } else if (rawTestLevel === 'RunSpecifiedTestSuites') {
    const suiteNames = getCheckedValues(testSuitesList);
    if (suiteNames.length === 0) {
      logProgress('Please select at least one test suite.', 'error');
      progressSection.classList.remove('hidden');
      return;
    }
    logProgress('Resolving test suite members...');
    progressSection.classList.remove('hidden');
    try {
      testClasses = await getSuiteClasses(suiteNames);
      if (testClasses.length === 0) {
        logProgress('Selected suites have no test class members. Aborting.', 'error');
        return;
      }
      logProgress(`Resolved ${testClasses.length} test class(es) from ${suiteNames.length} suite(s).`, 'success');
    } catch (err: any) {
      logProgress(`Failed to resolve suite members: ${err.message}`, 'error');
      return;
    }
    testLevel = 'RunSpecifiedTests';
  }

  progressSection.classList.remove('hidden');
  progressLog.innerHTML = '';
  progressBarContainer.classList.remove('hidden');

  // Skip components already on target version
  const targetVersionNum = parseFloat(targetVersion);
  const toUpdate = selected.filter((c) => c.apiVersion !== targetVersionNum);
  const alreadyCurrent = selected.filter((c) => c.apiVersion === targetVersionNum);
  if (alreadyCurrent.length > 0) {
    logProgress(`Skipping ${alreadyCurrent.length} component(s) already on v${targetVersion}.`, 'info');
  }
  if (toUpdate.length === 0) {
    logProgress('All selected components are already on the target version. Nothing to deploy.', 'success');
    updateProgress(100);
    return;
  }

  const components = toUpdate.map((c) => ({ type: c.type, fullName: c.fullName }));
  const flowComponents = toUpdate.filter((c) => c.type === 'Flow');

  try {
    // Step 1: Retrieve
    logProgress(`Retrieving ${toUpdate.length} component(s) from Salesforce...`);
    updateProgress(10);
    const zipBase64 = await retrieveMetadata(components);
    logProgress(`Retrieved ${toUpdate.length} component(s).`, 'success');

    // Step 2: Backup
    if (shouldBackup) {
      logProgress('Downloading backup...');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      downloadBackup(zipBase64, `sf-metadata-backup-${timestamp}.zip`);
      logProgress('Backup downloaded.', 'success');
    }
    updateProgress(30);

    // Step 3: Update API version in zip
    logProgress(`Updating API version to v${targetVersion}...`);
    const updatedZip = await updateApiVersionInZip(zipBase64, targetVersion);
    logProgress('API versions updated in metadata.', 'success');
    updateProgress(50);

    // Step 4: Deploy
    logProgress(`Deploying updated metadata (Test level: ${testLevel})...`);
    const { deployId } = await deployMetadata(updatedZip, {
      testLevel: testLevel as any,
      testClasses,
    });
    logProgress(`Deploy started (ID: ${deployId}).`);

    // Step 5: Poll deploy status
    // Intervals scale based on elapsed time and whether tests are running.
    // Schedule (ms between polls):
    //   0–30s elapsed   → 5s
    //   30s–2min        → 10s
    //   2min–10min      → 20s
    //   10min+          → 30s
    //   (tests running) → always at least 10s
    function nextPollInterval(elapsedMs: number, testsRunning: boolean): number {
      if (testsRunning) return Math.max(10_000, elapsedMs < 120_000 ? 10_000 : 20_000);
      if (elapsedMs < 30_000) return 5_000;
      if (elapsedMs < 120_000) return 10_000;
      if (elapsedMs < 600_000) return 20_000;
      return 30_000;
    }

    const deployStart = Date.now();
    const DEPLOY_TIMEOUT = 90 * 60 * 1000;
    let lastComponentLog = '';
    let lastTestLog = '';

    const status = await (async () => {
      while (true) {
        const elapsed = Date.now() - deployStart;
        if (elapsed > DEPLOY_TIMEOUT) {
          logProgress('Deploy timed out after 90 minutes. Check Setup → Deployment Status in Salesforce.', 'error');
          return null;
        }

        const testsRunning = testLevel !== 'NoTestRun';
        await new Promise((r) => setTimeout(r, nextPollInterval(elapsed, testsRunning)));

        const s = await checkDeployStatus(deployId);

        if (s.numberComponentsTotal > 0) {
          const componentLog = `${s.numberComponentsDeployed}/${s.numberComponentsTotal}`;
          if (componentLog !== lastComponentLog) {
            const pct = 50 + (s.numberComponentsDeployed / s.numberComponentsTotal) * 40;
            updateProgress(pct);
            logProgress(`Components: ${componentLog} deployed. Status: ${s.status}`);
            lastComponentLog = componentLog;
          }
        }

        if (s.numberTestsTotal > 0) {
          const testLog = `${s.numberTestsCompleted}/${s.numberTestsTotal}`;
          if (testLog !== lastTestLog) {
            logProgress(`Tests: ${testLog} completed (${s.numberTestErrors} failed).`);
            lastTestLog = testLog;
          }
        }

        if (s.done) return s;
      }
    })();

    if (!status) return; // timed out

    if (status.success) {
      logProgress('Deployment successful!', 'success');
      updateProgress(95);

      // Step 6: Flow version cleanup
      // flow.id is the Tooling API record Id of the version active BEFORE deploy.
      // After deploy Salesforce marks it Obsolete, so it's safe to delete.
      if (shouldDeleteOldFlow && flowComponents.length > 0) {
        logProgress(`Cleaning up ${flowComponents.length} old Flow version(s)...`);
        await Promise.all(flowComponents.map(async (flow) => {
          if (!flow.id) {
            logProgress(`Skipping Flow ${flow.fullName}: no version Id captured`, 'warning');
            return;
          }
          try {
            const result = await deleteFlowVersion(flow.id);
            if (result.success) {
              logProgress(`Deleted old version of Flow: ${flow.fullName}`, 'success');
            } else {
              logProgress(`Could not delete old Flow version for ${flow.fullName}: ${result.error}`, 'warning');
            }
          } catch (err: any) {
            logProgress(`Error deleting old Flow version for ${flow.fullName}: ${err.message}`, 'warning');
          }
        }));
      }

      updateProgress(100);
      logProgress('All done! Refresh the component list to verify.', 'success');
    } else {
      logProgress('Deployment failed! Changes have been rolled back.', 'error');
      for (const err of status.errors) {
        logProgress(`Error: ${err}`, 'error');
      }
      if (status.testFailures.length > 0) {
        logProgress(`${status.testFailures.length} test(s) failed:`, 'error');
        for (const tf of status.testFailures) {
          logProgress(`  ${tf.name}.${tf.methodName}: ${tf.message}`, 'error');
        }
      }
    }
  } catch (err: any) {
    logProgress(`Error: ${err.message}`, 'error');
  }
}

export async function performBackupOnly() {
  const selected = allComponents.filter((c) => c.selected);
  if (selected.length === 0) return;

  backupBtn.disabled = true;
  showLoading('Retrieving metadata for backup...');

  try {
    const components = selected.map((c) => ({ type: c.type, fullName: c.fullName }));
    const zipBase64 = await retrieveMetadata(components);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBackup(zipBase64, `sf-metadata-backup-${timestamp}.zip`);
    progressSection.classList.remove('hidden');
    logProgress('Backup downloaded successfully.', 'success');
  } catch (err: any) {
    progressSection.classList.remove('hidden');
    logProgress(`Backup failed: ${err.message}`, 'error');
  }

  hideLoading();
  backupBtn.disabled = false;
}
