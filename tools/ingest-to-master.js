#!/usr/bin/env node

/**
 * PustakaTerbuka - Safe Sequential Master Ingestion Tool
 * 
 * Checks whether the master catalog repository is currently locked by another
 * provider or build job. If locked, waits sequentially until available.
 * Acquires the master lock, merges new inbox records into master, and triggers master build.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { acquireMasterLock, findMasterRepo, isMasterLocked } from './lib/master-lock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const args = process.argv.slice(2);
  const provider = 'uum';
  let wait = true;
  let timeoutMs = 600000;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-wait') wait = false;
    else if (args[i] === '--timeout') timeoutMs = parseInt(args[++i], 10);
    else if (args[i] === '--dry-run') dryRun = true;
  }

  const masterPath = findMasterRepo(process.cwd());
  if (!masterPath) {
    console.error('[ERROR] Could not locate PustakaTerbuka OPAC repository. Make sure ../opac exists.');
    process.exit(1);
  }

  console.log('=======================================================');
  console.log(` PustakaTerbuka Safe Master Ingestion — ${provider.toUpperCase()}`);
  console.log(` Master Target: ${masterPath}`);
  console.log('=======================================================');

  const currentStatus = isMasterLocked(masterPath);
  if (currentStatus.locked) {
    console.log(`[INFO] Master repository is currently busy with '${currentStatus.metadata.operation}' by '${currentStatus.metadata.provider}'.`);
    if (!wait) {
      console.error('[ERROR] Ingestion aborted because master is busy.');
      process.exit(1);
    }
    console.log('[WAIT] Waiting for master lock to be released...');
  }

  let lock = null;
  try {
    lock = await acquireMasterLock({
      masterPath,
      provider,
      operation: `ingest-${provider}`,
      wait,
      timeoutMs
    });

    console.log(`\n[LOCK ACQUIRED] Exclusive access granted to master for provider '${provider}'.`);

    if (dryRun) {
      console.log('[DRY RUN] Lock verified successfully. Skipping actual build.');
      return;
    }

    // Locate latest inbox chunk in this provider repo
    const inboxBase = path.join(process.cwd(), 'harvest', 'inbox', provider);
    if (fs.existsSync(inboxBase)) {
      const chunks = fs.readdirSync(inboxBase).filter(d => fs.existsSync(path.join(inboxBase, d, 'manifest.json')));
      for (const chunk of chunks) {
        const chunkPath = path.join(inboxBase, chunk);
        console.log(`\n[STEP] Merging inbox chunk '${chunk}' into master catalog...`);
        execSync(`node tools/merge.js "${chunkPath}"`, {
          cwd: masterPath,
          stdio: 'inherit',
          env: { ...process.env, PUSTAKA_MASTER_LOCKED: '1' }
        });
      }
    }

    console.log(`\n[STEP] Triggering master site build...`);
    execSync('node tools/build.js --skip-lock --skip-size-gate --skip-dumps', {
      cwd: masterPath,
      stdio: 'inherit',
      env: { ...process.env, PUSTAKA_MASTER_LOCKED: '1' }
    });

    console.log('=======================================================');
    console.log(` Master Ingestion Completed Successfully for ${provider.toUpperCase()}!`);
    console.log('=======================================================');
  } catch (err) {
    console.error(`\n[ERROR] Master ingestion failed: ${err.message}`);
    process.exit(1);
  } finally {
    if (lock) {
      lock.release();
      console.log('[LOCK RELEASED] Master repository is now available for other providers.');
    }
  }
}

main();
