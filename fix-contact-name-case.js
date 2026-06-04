// Contact Name Title-Case Fix
// ============================
//
// PURPOSE: When new contacts are created (often from ad form submissions),
// names sometimes come in fully lowercase ("muhammad ali"). When consultants
// later send email templates that include {{contact.firstname}}, the client
// sees "Hi muhammad ali" which looks unprofessional.
//
// This script catches such contacts and applies Title Case to the name fields.
//
// SAFETY:
//   - Only fixes fields that are 100% lowercase (no uppercase letters anywhere).
//   - Already-formatted names (Mary, McGregor, Jean-Pierre, MUHAMMAD ALI) are
//     LEFT ALONE because they have at least one uppercase letter.
//   - Empty / numeric / symbol-only values are left alone.
//   - Append-only state tracking: contacts already processed are not touched.
//   - Idempotent: running twice has no extra effect.
//
// SCHEDULE: Every 4 hours via GitHub Actions cron
// SCOPE: Contacts created in the last 24 hours
//
// ENV VARS:
//   HUBSPOT_TOKEN       — Private App token (needs contact read + write)
//   HUBSPOT_PORTAL_ID   — for building contact links in logs (optional)
//   DRY_RUN             — "true" to log what would change without writing

const hubspot = require('@hubspot/api-client');
const fs = require('fs');
const path = require('path');

// ============ CONFIG ============
// Fields we attempt to title-case. We fetch each one; if it doesn't exist
// on a contact (or is empty), we skip it.
const NAME_FIELDS = ['firstname', 'lastname', 'fullname', 'name'];

const LOOKBACK_HOURS = 24;
const STATE_FILE = path.join(__dirname, 'state.json');
const DRY_RUN = process.env.DRY_RUN === 'true';

const BATCH_SIZE = 100;
const PAUSE_MS = 250;
const MAX_RETRIES = 6;
const BASE_RETRY_DELAY_MS = 11000;

const client = new hubspot.Client({ accessToken: process.env.HUBSPOT_TOKEN });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============ UTIL ============
async function withRetry(fn, label = 'api') {
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (err) {
      const code = err.code || err.response?.status;
      const isRateLimit = code === 429 || (err.message || '').includes('RATE_LIMIT');
      if (isRateLimit && attempt < MAX_RETRIES) {
        const wait = BASE_RETRY_DELAY_MS * Math.pow(1.3, attempt);
        console.log(`  ⚠ Rate limited (${label}). Waiting ${Math.round(wait / 1000)}s...`);
        await sleep(wait);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

// ============ TITLE-CASE LOGIC ============
// A value qualifies for title-casing only if:
//   - It contains at least one letter
//   - ALL letters are lowercase (no uppercase anywhere)
function shouldTitleCase(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!/[a-zA-Z]/.test(trimmed)) return false;  // must contain a letter
  if (/[A-Z]/.test(trimmed)) return false;      // any uppercase = leave alone
  return true;
}

// Apply Title Case to a string. Handles:
//   - simple words: "ali" → "Ali"
//   - multi-word: "muhammad ali" → "Muhammad Ali"
//   - hyphenated: "jean-pierre" → "Jean-Pierre"
//   - preserves internal whitespace patterns
function titleCase(value) {
  return value
    .split(/(\s+)/)                            // keep spaces in the split result
    .map(part => {
      if (/^\s+$/.test(part)) return part;     // pure whitespace
      // Split on hyphens too so "jean-pierre" works
      return part.split('-').map(sub => {
        if (!sub) return sub;
        return sub.charAt(0).toUpperCase() + sub.slice(1).toLowerCase();
      }).join('-');
    })
    .join('');
}

// ============ STATE ============
function readState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { processedIds: [], firstRun: true };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      processedIds: Array.isArray(parsed.processedIds) ? parsed.processedIds : [],
      firstRun: false,
    };
  } catch (err) {
    console.warn(`  State file unreadable: ${err.message}. Treating as first run.`);
    return { processedIds: [], firstRun: true };
  }
}

function writeState(processedSet, updatedThisRun) {
  // Cap state size — only keep the most recent ~10k contacts to prevent
  // unbounded growth. Older contacts won't be re-checked, which is fine
  // because we already processed them once.
  const MAX_KEEP = 10000;
  let ids = [...processedSet];
  if (ids.length > MAX_KEEP) ids = ids.slice(-MAX_KEEP);

  const payload = {
    lastRunIso: new Date().toISOString(),
    totalUpdatedLastRun: updatedThisRun,
    processedIds: ids,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
}

// ============ MAIN ============
async function main() {
  const nowUtc = new Date();
  console.log('='.repeat(70));
  console.log('Contact Name Title-Case Fix');
  console.log('='.repeat(70));
  console.log(`Mode:        ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`Run started: ${nowUtc.toISOString()}`);
  console.log(`Lookback:    ${LOOKBACK_HOURS}h`);
  console.log(`Fields:      ${NAME_FIELDS.join(', ')}`);
  console.log('='.repeat(70) + '\n');

  // Load state
  const state = readState();
  const processedSet = new Set(state.processedIds);
  console.log(`Step 1: Loaded ${processedSet.size} previously processed contact ID(s).\n`);

  // Fetch recent contacts
  const cutoffMs = Date.now() - LOOKBACK_HOURS * 3600 * 1000;
  console.log(`Step 2: Fetching contacts created in last ${LOOKBACK_HOURS}h...`);
  const contacts = await fetchRecentContacts(cutoffMs);
  console.log(`  Found ${contacts.length} recent contact(s)\n`);

  if (contacts.length === 0) {
    console.log('No contacts to check. Done.');
    return;
  }

  // Filter to unprocessed
  const unprocessed = contacts.filter(c => !processedSet.has(c.id));
  console.log(`Step 3: ${unprocessed.length} not yet processed, ${contacts.length - unprocessed.length} already done.\n`);

  // Inspect & decide
  console.log('Step 4: Checking name fields for lowercase issues...\n');
  const updates = [];
  const stats = { updated: 0, no_change: 0, no_name_at_all: 0, failed: 0 };

  for (const contact of unprocessed) {
    const id = contact.id;
    const props = contact.properties || {};
    const changes = {};

    let hasAnyName = false;
    for (const field of NAME_FIELDS) {
      const current = props[field];
      if (current && current.trim()) hasAnyName = true;
      if (shouldTitleCase(current)) {
        const fixed = titleCase(current);
        if (fixed !== current) changes[field] = fixed;
      }
    }

    if (!hasAnyName) {
      stats.no_name_at_all++;
      continue;
    }

    if (Object.keys(changes).length === 0) {
      stats.no_change++;
      continue;
    }

    updates.push({ id, properties: changes });

    // Log what we're about to change
    const before = NAME_FIELDS.map(f => props[f] ? `${f}="${props[f]}"` : '').filter(Boolean).join(', ');
    const after  = Object.entries(changes).map(([k, v]) => `${k}="${v}"`).join(', ');
    console.log(`  + ${id}: ${before}  →  ${after}`);
  }

  console.log(`\n  To update: ${updates.length}`);
  console.log(`  No change needed (already properly cased): ${stats.no_change}`);
  console.log(`  No name field set at all:                  ${stats.no_name_at_all}`);

  // Mark all unprocessed contacts as processed (whether we updated them or not)
  for (const c of unprocessed) processedSet.add(c.id);

  // Apply updates
  if (updates.length > 0) {
    if (DRY_RUN) {
      console.log(`\n[DRY RUN] Would update ${updates.length} contact(s). Not writing.`);
      return;
    }
    console.log(`\nStep 5: Applying ${updates.length} update(s)...`);
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
      try {
        await withRetry(() => client.crm.contacts.batchApi.update({ inputs: batch }), `batchUpdate(${i})`);
        stats.updated += batch.length;
      } catch (err) {
        stats.failed += batch.length;
        console.error(`  ✗ Batch starting at ${i} failed: ${err.message}`);
        if (err.response?.body) console.error('    ', JSON.stringify(err.response.body).slice(0, 500));
      }
      if (i + BATCH_SIZE < updates.length) await sleep(PAUSE_MS);
    }
  }

  // Save state (only on live runs)
  if (!DRY_RUN) {
    writeState(processedSet, stats.updated);
    console.log(`\nState saved (${processedSet.size} contact IDs tracked)`);
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Recent contacts scanned:     ${contacts.length}`);
  console.log(`Previously processed:        ${contacts.length - unprocessed.length}`);
  console.log(`✓ Updated:                   ${stats.updated}`);
  console.log(`· Already properly cased:    ${stats.no_change}`);
  console.log(`· No name field set:         ${stats.no_name_at_all}`);
  console.log(`✗ Failed:                    ${stats.failed}`);
  console.log('\nDone.');
}

// ============ HUBSPOT HELPERS ============
async function fetchRecentContacts(cutoffMs) {
  const all = [];
  let after; let page = 0;
  do {
    const res = await withRetry(() => client.crm.contacts.searchApi.doSearch({
      filterGroups: [{
        filters: [
          { propertyName: 'createdate', operator: 'GTE', value: cutoffMs.toString() },
        ],
      }],
      properties: NAME_FIELDS,
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
      limit: 100,
      after,
    }), `searchContacts(p${page + 1})`);
    all.push(...res.results);
    after = res.paging?.next?.after;
    page++;
    if (after) await sleep(PAUSE_MS);
  } while (after && page < 100);
  return all;
}

main().catch(err => {
  console.error('FATAL:', err.message);
  if (err.response?.body) console.error(JSON.stringify(err.response.body, null, 2));
  process.exit(1);
});
