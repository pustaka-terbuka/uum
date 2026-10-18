/**
 * PustakaTerbuka - Academic Library Harvester Factory
 * 
 * Provides standard, reusable harvester engine instance for Malaysian academic libraries.
 * Complies with Decision D005 Chunk Lifecycle and PustakaTerbuka Harvester Standards.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  escapeXml,
  validateRecordContent,
  inspectBatches,
  repairProvenance,
  findRepoRoot,
  formatMarcRecord,
  fetchWithBackoff,
  parseBaseArgs,
  sleep,
  DEFAULT_CHUNK_SIZE
} from './harvester-base.js';

export { validateRecordContent, inspectBatches, repairProvenance };

export function createAcademicHarvester(config) {
  const SOURCE_CODE = config.sourceCode.toLowerCase();
  const SOURCE_NAME = config.sourceName;
  const AGENCY_CODE = config.agencyCode;
  const SOURCE_BASE_URL = config.opacUrl || config.sourceBaseUrl;
  const TERMS_URL = config.termsUrl || SOURCE_BASE_URL;
  const BASE_EXPORT_URL = config.baseExportUrl || `${SOURCE_BASE_URL}cgi-bin/koha/opac-export.pl`;
  const BASE_DETAIL_URL = config.baseDetailUrl || `${SOURCE_BASE_URL}cgi-bin/koha/opac-detail.pl`;
  const USER_AGENT = `PustakaTerbuka-Harvester/1.0 (+https://github.com/pustaka-terbuka/${SOURCE_CODE}; contact@pustakaterbuka.org)`;
  const HARVESTER_NAME = `${SOURCE_CODE}-${config.platform || 'koha'}-harvester`;
  const HARVESTER_VERSION = config.version || '1.0.0';
  const DEFAULT_MAX_BIB = config.defaultMaxBib || 250000;
  const DEFAULT_BRANCH = config.defaultBranch || `${SOURCE_NAME} (Perpustakaan Utama)`;
  const DEFAULT_SCHEME = config.defaultScheme || 'LCC';
  const PLATFORM = config.platform || 'koha';

  let sessionCookie = '';

  async function getSessionHeaders() {
    if (!sessionCookie) {
      try {
        const homeRes = await fetch(SOURCE_BASE_URL, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(8000)
        });
        const setCookie = homeRes.headers.get('set-cookie');
        if (setCookie) {
          sessionCookie = setCookie.split(';')[0];
        }
      } catch {}
    }
    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': SOURCE_BASE_URL
    };
    if (sessionCookie) {
      headers['Cookie'] = sessionCookie;
    }
    return headers;
  }

  function parseArgs(args = []) {
    return parseBaseArgs(args, {
      endBib: DEFAULT_MAX_BIB
    });
  }

  function printHelp() {
    console.log(`
PustakaTerbuka ${AGENCY_CODE} Harvester (${SOURCE_NAME})
Standard Classification: ${DEFAULT_SCHEME} (Library of Congress Classification)

Usage:
  node tools/harvesters/${SOURCE_CODE}/harvester.js [options]

Options:
  --start-bib <num>          First record/biblionumber to harvest (default: 1)
  --end-bib <num>            Last record/biblionumber to harvest (default: ${DEFAULT_MAX_BIB})
  --batch-size <num>         Records per XML file (default: 100)
  --delay <ms>               Delay between requests in ms (default: 2000)
  --chunk-size <num>         Records per harvest chunk for master digest (default: ${DEFAULT_CHUNK_SIZE})
  --no-chunk                 Disable chunk pauses (single monolithic output)
  --master-digest            Automatically validate, merge, and index into Master on each chunk pause
  --max-records <num>        Limit total records saved this run (0 = unconstrained)
  --mode <full|incremental>  Harvest mode (default: "full")
  --out-dir <path>           Override output directory
  --resume [run-id|auto]     Resume latest incomplete run or specify run-id (default: auto)
  --fresh, --new             Start a new run without resuming
  --skip-pipeline            Skip validate-inbox, merge, and master ingest during chunk pauses
  -h, --help                 Show this help message
`);
  }

  function recordToMarcXml(rawItem) {
    const control001 = String(rawItem.id || rawItem.controlNumber || rawItem.biblionumber || '');
    const title245 = rawItem.title || 'Judul Tidak Dinyatakan';
    const author100 = rawItem.author || rawItem.creator || '';
    const isbn020 = rawItem.isbn || '';
    const issn022 = rawItem.issn || '';
    const lcc050 = rawItem.lcc || rawItem.callNumber || '';
    const ddc082 = rawItem.ddc || '';
    const publisher260 = rawItem.publisher || '';
    const year = rawItem.year || rawItem.publicationYear || '';
    const summary520 = rawItem.summary || rawItem.abstract || '';
    const subjects650 = Array.isArray(rawItem.subjects) ? rawItem.subjects : (rawItem.subjects ? [rawItem.subjects] : []);

    const holdings = [];
    if (Array.isArray(rawItem.holdings) && rawItem.holdings.length > 0) {
      for (const h of rawItem.holdings) {
        holdings.push({
          isKoha: true,
          branch: h.branch || DEFAULT_BRANCH,
          holdingBranch: h.holdingBranch || h.branch || DEFAULT_BRANCH,
          callNumber: h.callNumber || lcc050 || ddc082,
          barcode: h.barcode || (control001 ? `${AGENCY_CODE}-${control001}` : '')
        });
      }
    } else {
      holdings.push({
        isKoha: true,
        branch: DEFAULT_BRANCH,
        holdingBranch: DEFAULT_BRANCH,
        callNumber: lcc050 || ddc082 || 'LCC',
        barcode: control001 ? `${AGENCY_CODE}-${control001}` : ''
      });
    }

    return formatMarcRecord({
      control001,
      agency003: AGENCY_CODE,
      cataloging040: AGENCY_CODE,
      language041: rawItem.language || 'may',
      language008: rawItem.language || 'may',
      title245,
      author100,
      isbn020,
      issn022,
      lcc050,
      ddc082,
      publisher260,
      year,
      summary520,
      subjects650,
      holdings,
      sourceTag996: SOURCE_CODE
    });
  }

  function parsePermataRecordHtml(html, recordNo) {
    if (!html || !html.includes('Butiran Rekod')) return null;

    const marcLines = [];
    let lcc050 = '';
    let title = '';

    const tagMatches = Array.from(html.matchAll(/<div class="m-mini mono">(\d{3})<\/div>[\s\S]*?<div class="m-items">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi));
    for (const tm of tagMatches) {
      const tag = tm[1];
      const itemsHtml = tm[2];
      const sfMatches = Array.from(itemsHtml.matchAll(/<span class="sfcode">([a-z0-9])<\/span><span class="sfval">([\s\S]*?)<\/span>/gi));
      if (sfMatches.length === 0) continue;

      if (tag === '245') {
        const aSf = sfMatches.find(m => m[1] === 'a');
        if (aSf) title = aSf[2].replace(/<[^>]+>/g, '').trim();
      }
      if ((tag === '090' || tag === '050') && !lcc050) {
        const parts = sfMatches.map(m => m[2].replace(/<[^>]+>/g, '').trim());
        lcc050 = parts.join(' ');
      }

      let df = `  <datafield tag="${tag}" ind1=" " ind2=" ">\n`;
      for (const sf of sfMatches) {
        const code = sf[1];
        const val = escapeXml(sf[2].replace(/<[^>]+>/g, '').trim());
        df += `    <subfield code="${code}">${val}</subfield>\n`;
      }
      df += `  </datafield>`;
      marcLines.push(df);
    }

    if (!title) {
      const tMatch = html.match(/<div class="k">Tajuk<\/div>\s*<div class="v">([\s\S]*?)<\/div>/i);
      if (tMatch) {
        title = tMatch[1].replace(/<[^>]+>/g, '').trim();
        marcLines.push(`  <datafield tag="245" ind1="1" ind2="0">\n    <subfield code="a">${escapeXml(title)}</subfield>\n  </datafield>`);
      }
    }
    if (!title) return null;

    if (!lcc050) {
      const cMatch = html.match(/<div class="k">Nombor Panggilan<\/div>\s*<div class="v[^"]*">([\s\S]*?)<\/div>/i);
      if (cMatch) {
        lcc050 = cMatch[1].replace(/<[^>]+>/g, '').trim();
      }
    }

    if (lcc050 && !marcLines.some(l => l.includes('tag="050"'))) {
      marcLines.unshift(`  <datafield tag="050" ind1="0" ind2="0">\n    <subfield code="a">${escapeXml(lcc050)}</subfield>\n  </datafield>`);
    }

    const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
    if (tbodyMatch) {
      const rows = tbodyMatch[1].match(/<tr[\s\S]*?<\/tr>/gi) || [];
      for (const r of rows) {
        const cols = Array.from(r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map(m => m[1].replace(/<[^>]+>/g, '').trim());
        if (cols.length >= 3) {
          const campus = cols[0];
          const location = cols[1];
          const copyId = cols[2];
          const branch = campus ? `UiTM ${campus} (${location})` : `UiTM PTAR (${location})`;
          const barcode = copyId ? `UiTM-${copyId}` : `UiTM-${recordNo}`;
          marcLines.push(
            `  <datafield tag="952" ind1=" " ind2=" ">\n` +
            `    <subfield code="a">${escapeXml(branch)}</subfield>\n` +
            `    <subfield code="b">${escapeXml(branch)}</subfield>\n` +
            `    <subfield code="o">${escapeXml(lcc050 || 'LCC')}</subfield>\n` +
            `    <subfield code="p">${escapeXml(barcode)}</subfield>\n` +
            `  </datafield>`
          );
        }
      }
    }

    if (!marcLines.some(l => l.includes('tag="952"'))) {
      marcLines.push(
        `  <datafield tag="952" ind1=" " ind2=" ">\n` +
        `    <subfield code="a">${escapeXml(DEFAULT_BRANCH)}</subfield>\n` +
        `    <subfield code="b">${escapeXml(DEFAULT_BRANCH)}</subfield>\n` +
        `    <subfield code="o">${escapeXml(lcc050 || 'LCC')}</subfield>\n` +
        `    <subfield code="p">${escapeXml(`${AGENCY_CODE}-${recordNo}`)}</subfield>\n` +
        `  </datafield>`
      );
    }

    marcLines.push(`  <datafield tag="996" ind1=" " ind2=" ">\n    <subfield code="a">${SOURCE_CODE}</subfield>\n  </datafield>`);

    return [
      '<record>',
      '  <leader>00000cam a2200000 i 4500</leader>',
      `  <controlfield tag="001">${recordNo}</controlfield>`,
      `  <controlfield tag="003">${AGENCY_CODE}</controlfield>`,
      '  <controlfield tag="008">261017s2020    my ||||| |||| 00| 0 may d</controlfield>',
      ...marcLines,
      '</record>'
    ].join('\n');
  }

  function parseKohaShowMarc(text, bibNumber) {
    if (!text || !text.includes('<pre>')) return null;
    const preMatch = text.match(/<pre>([\s\S]*?)<\/pre>/i);
    if (!preMatch) return null;
    const raw = preMatch[1];
    if (!raw.includes('LDR') && !raw.includes('245')) return null;

    const lines = raw.split('\n');
    let leader = '00000nam a2200000 a 4500';
    const controlFields = [];
    const dataFields = [];
    let currentField = null;

    for (let line of lines) {
      if (!line.trim()) continue;
      if (line.startsWith('LDR ')) {
        leader = line.substring(4).trim();
        continue;
      }
      const tagMatch = line.match(/^([0-9]{3})\s*(.*)$/);
      if (tagMatch) {
        if (currentField) { dataFields.push(currentField); currentField = null; }
        const tag = tagMatch[1];
        const rest = tagMatch[2];
        if (tag.startsWith('00')) {
          controlFields.push(`  <controlfield tag="${tag}">${escapeXml(rest.trim())}</controlfield>`);
        } else {
          let ind1 = ' ', ind2 = ' ';
          let subfieldsStr = rest;
          if (rest.length >= 2 && !rest.startsWith('_')) {
            ind1 = rest[0] !== ' ' ? rest[0] : ' ';
            ind2 = rest[1] !== ' ' ? rest[1] : ' ';
            subfieldsStr = rest.substring(2);
          }
          currentField = { tag, ind1, ind2, subfields: [] };
          const parts = subfieldsStr.split(/_([a-z0-9])/);
          for (let i = 1; i < parts.length; i += 2) {
            const code = parts[i];
            const val = (parts[i + 1] || '').trim();
            if (val) currentField.subfields.push({ code, val });
          }
        }
      } else if (currentField && line.trim().startsWith('_')) {
        const parts = line.trim().split(/_([a-z0-9])/);
        for (let i = 1; i < parts.length; i += 2) {
          const code = parts[i];
          const val = (parts[i + 1] || '').trim();
          if (val) currentField.subfields.push({ code, val });
        }
      }
    }
    if (currentField) dataFields.push(currentField);

    if (!controlFields.some(f => f.includes('tag="001"'))) {
      controlFields.unshift(`  <controlfield tag="001">${bibNumber}</controlfield>`);
    }
    if (!controlFields.some(f => f.includes('tag="003"'))) {
      controlFields.push(`  <controlfield tag="003">${AGENCY_CODE}</controlfield>`);
    }

    const xmlDataFields = dataFields.map(f => {
      const subs = f.subfields.map(s => `    <subfield code="${s.code}">${escapeXml(s.val)}</subfield>`).join('\n');
      return `  <datafield tag="${f.tag}" ind1="${f.ind1}" ind2="${f.ind2}">\n${subs}\n  </datafield>`;
    });

    xmlDataFields.push(`  <datafield tag="996" ind1=" " ind2=" ">\n    <subfield code="a">${SOURCE_CODE}</subfield>\n  </datafield>`);

    return [
      '<record>',
      `  <leader>${leader}</leader>`,
      ...controlFields,
      ...xmlDataFields,
      '</record>'
    ].join('\n');
  }

  async function fetchRecord(bibNumber, options = {}) {
    const headers = await getSessionHeaders();

    if (PLATFORM === 'permata') {
      const detailUrl = `${BASE_DETAIL_URL}&recordno=${bibNumber}&cat=HARDCOPY`;
      try {
        const res = await fetchWithBackoff(detailUrl, {
          headers,
          signal: AbortSignal.timeout(15000)
        }, { baseDelayMs: options.delayMs || 1500, maxRetries: 2 });
        if (!res || !res.ok) return null;
        const html = await res.text();
        return parsePermataRecordHtml(html, bibNumber);
      } catch {
        return null;
      }
    }

    // 1. Primary Strategy: Koha direct MARCXML export
    const exportUrl = `${BASE_EXPORT_URL}?op=export&bib=${bibNumber}&format=marcxml`;
    try {
      const res = await fetchWithBackoff(exportUrl, {
        headers,
        signal: AbortSignal.timeout(12000)
      }, { baseDelayMs: options.delayMs || 2000, maxRetries: 3 });

      if (res && res.ok) {
        const text = await res.text();
        if (text && text.includes('<record') && text.includes('</record>')) {
          const match = text.match(/<record[\s\S]*?<\/record>/);
          if (match) {
            let recordStr = match[0];
            if (!recordStr.includes('tag="996"')) {
              recordStr = recordStr.replace(
                '</record>',
                `  <datafield tag="996" ind1=" " ind2=" ">\n    <subfield code="a">${SOURCE_CODE}</subfield>\n  </datafield>\n</record>`
              );
            }
            return recordStr;
          }
        }
      }
    } catch {
      // Fall through
    }

    // 1.5 Strategy: Koha opac-showmarc.pl plain text MARC extraction
    const showMarcUrl = BASE_DETAIL_URL.replace(/opac-detail\.pl.*$/, `opac-showmarc.pl?id=${bibNumber}`);
    try {
      const res = await fetchWithBackoff(showMarcUrl, {
        headers,
        signal: AbortSignal.timeout(12000)
      }, { baseDelayMs: options.delayMs || 2000, maxRetries: 2 });

      if (res && res.ok) {
        const text = await res.text();
        if (text && text.includes('<pre>') && (text.includes('LDR') || text.includes('245'))) {
          const parsed = parseKohaShowMarc(text, bibNumber);
          if (parsed && validateRecordContent(parsed)) {
            return parsed;
          }
        }
      }
    } catch {
      // Fall through to Detail HTML scraping
    }

    // 2. Secondary Strategy: Koha OPAC Detail HTML scraping
    const detailUrl = `${BASE_DETAIL_URL}?biblionumber=${bibNumber}`;
    try {
      const res = await fetchWithBackoff(detailUrl, {
        headers,
        signal: AbortSignal.timeout(12000)
      }, { baseDelayMs: options.delayMs || 2000, maxRetries: 3 });

      if (!res || !res.ok) return null;
      const html = await res.text();
      if (!html || html.length < 50) return null;

      const titleMatch = html.match(/<h1[^>]*class="title"[^>]*>([\s\S]*?)<\/h1>/i) ||
                         html.match(/<title>([\s\S]*?)<\/title>/i);
      let title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      if (!title || title.toLowerCase().includes('not found') || title.toLowerCase().includes('error has occurred')) {
        return null;
      }

      // Extract author from contributor list or byAuthor
      const authorMatch = html.match(/class="author"[^>]*>([\s\S]*?)<\/span>/i) ||
                          html.match(/class="contributors"[^>]*>([\s\S]*?)<\/a>/i) ||
                          html.match(/Pengarang|Author[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i);
      const author = authorMatch ? authorMatch[1].replace(/<[^>]+>/g, '').trim() : '';

      // Extract publisher & year from RDA 264 / publisher
      const pubMatch = html.match(/class="results_summary rda264"[^>]*>([\s\S]*?)<\/span>/i) ||
                       html.match(/class="publisher"[^>]*>([\s\S]*?)<\/span>/i);
      const pubText = pubMatch ? pubMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
      let publisher = '';
      let year = '';
      if (pubText) {
        const yMatch = pubText.match(/\b(19\d\d|20\d\d)\b/);
        if (yMatch) year = yMatch[1];
        publisher = pubText.replace(/Publisher:|Copyright date:|Date of publication:/gi, '').trim();
      }

      // Extract ISBN
      const isbnMatch = html.match(/class="results_summary isbn"[^>]*>([\s\S]*?)<\/span>/i) ||
                        html.match(/(\b97[89][-0-9]{10,14}\b)/);
      const isbn = isbnMatch ? isbnMatch[1].replace(/<[^>]+>/g, '').replace(/ISBN:/gi, '').trim() : '';

      // Extract Call Number and Holdings from table
      let lccCallNumber = '';
      const holdings = [];
      const holdingTableMatch = html.match(/<table[^>]*id="holdingst"[^>]*>([\s\S]*?)<\/table>/i);
      if (holdingTableMatch) {
        const trMatches = Array.from(holdingTableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi));
        for (const tr of trMatches) {
          const cells = Array.from(tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map(c => c[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
          if (cells.length >= 4) {
            // Koha default column layout: Item type, Current library, Home library, Call number, ..., Barcode
            const branch = cells[1] || cells[2] || DEFAULT_BRANCH;
            const call = cells[3] ? cells[3].replace(/\(.*?\)/g, '').trim() : '';
            const barcode = cells[cells.length - 1] || cells[cells.length - 2] || '';
            if (call && !lccCallNumber) {
              lccCallNumber = call;
            }
            holdings.push({
              branch,
              callNumber: call || 'LCC',
              barcode: barcode || `${AGENCY_CODE}-${bibNumber}`
            });
          }
        }
      }

      if (!lccCallNumber) {
        const callMatch = html.match(/class="callnumber"[^>]*>([\s\S]*?)<\/span>/i) ||
                          html.match(/No\. Panggilan|Call Number[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/i);
        lccCallNumber = callMatch ? callMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      }

      const raw = {
        id: String(bibNumber),
        title,
        author,
        publisher,
        year,
        isbn,
        lcc: lccCallNumber,
        holdings: holdings.length > 0 ? holdings : [{
          branch: DEFAULT_BRANCH,
          callNumber: lccCallNumber || 'LCC',
          barcode: `${AGENCY_CODE}-${bibNumber}`
        }]
      };

      return recordToMarcXml(raw);
    } catch {
      return null;
    }
  }

  /**
   * Discovers active biblionumbers via Koha OPAC search queries
   */
  async function discoverBiblionumbers(query, count = 100, offset = 0) {
    const headers = await getSessionHeaders();
    if (PLATFORM === 'permata') {
      const page = Math.floor(offset / 24) + 1;
      const searchUrl = `${SOURCE_BASE_URL}page/page.php?p=02&lang=ms&query=${encodeURIComponent(query)}&type=all&searchby=title&page=${page}`;
      try {
        const res = await fetchWithBackoff(searchUrl, {
          headers,
          signal: AbortSignal.timeout(15000)
        }, { baseDelayMs: 1500, maxRetries: 2 });
        if (!res || !res.ok) return [];
        const text = await res.text();
        const matches = Array.from(text.matchAll(/recordno=(\d+)/gi)).map(m => parseInt(m[1], 10));
        return Array.from(new Set(matches));
      } catch {
        return [];
      }
    }
    const searchUrl = `${SOURCE_BASE_URL}cgi-bin/koha/opac-search.pl?q=${encodeURIComponent(query)}&count=${count}&offset=${offset}`;
    try {
      const res = await fetchWithBackoff(searchUrl, {
        headers,
        signal: AbortSignal.timeout(15000)
      }, { baseDelayMs: 1500, maxRetries: 2 });

      if (!res || !res.ok) return [];
      const text = await res.text();
      const matches = Array.from(text.matchAll(/biblionumber=(\d+)/g)).map(m => parseInt(m[1], 10));
      return Array.from(new Set(matches));
    } catch {
      return [];
    }
  }

  async function runHarvest(rawArgs = []) {
    const options = Array.isArray(rawArgs) ? parseArgs(rawArgs) : { ...parseArgs([]), ...rawArgs };
    if (options.help) {
      printHelp();
      return 0;
    }

    const repoRoot = findRepoRoot(process.cwd());
    const inboxBaseDir = options.outDir
      ? path.resolve(options.outDir)
      : path.join(repoRoot, 'harvest', 'inbox', SOURCE_CODE);

    fs.mkdirSync(inboxBaseDir, { recursive: true });

    const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
    const chunkSuffix = options.chunkSize > 0 ? '-chunk-001' : '';
    const chunkDir = path.join(inboxBaseDir, `${runId}${chunkSuffix}`);
    const recordsDir = path.join(chunkDir, 'records');
    fs.mkdirSync(recordsDir, { recursive: true });
    const provFile = path.join(chunkDir, 'provenance.jsonl');

    console.log(`=======================================================`);
    console.log(`[${AGENCY_CODE}] Starting Harvester: ${SOURCE_NAME}`);
    console.log(`[${AGENCY_CODE}] Base OPAC:       ${SOURCE_BASE_URL}`);
    console.log(`[${AGENCY_CODE}] Target Records:  ${options.maxRecords > 0 ? options.maxRecords : 'Unconstrained'}`);
    console.log(`[${AGENCY_CODE}] Output Inbox:    ${chunkDir}`);
    console.log(`=======================================================\n`);

    let savedCount = 0;
    let errorCount = 0;
    let batchBuffer = [];
    let batchNumber = 0;
    let consecutiveMisses = 0;
    const MAX_CONSECUTIVE_MISSES = 25;

    function flushBatch() {
      if (batchBuffer.length === 0) return;
      const xmlLines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<collection xmlns="http://www.loc.gov/MARC21/slim">'
      ];
      const provLines = [];
      let idx = 0;
      for (const item of batchBuffer) {
        xmlLines.push(item.xml);
        provLines.push(JSON.stringify({
          source_001: String(item.id),
          source_url: `${BASE_DETAIL_URL}?biblionumber=${item.id}`,
          harvested_at: item.timestamp,
          file: `batch_${batchNumber}.xml`,
          index: idx++
        }));
      }
      xmlLines.push('</collection>');

      fs.writeFileSync(path.join(recordsDir, `batch_${batchNumber}.xml`), xmlLines.join('\n'), 'utf8');
      fs.appendFileSync(provFile, provLines.join('\n') + '\n', 'utf8');
      savedCount += batchBuffer.length;
      console.log(`[${AGENCY_CODE}] Wrote batch_${batchNumber}.xml (${batchBuffer.length} records | Total saved: ${savedCount}/${options.maxRecords || 'all'})`);
      batchNumber++;
      batchBuffer = [];
    }

    // 1. Initial bib check
    let targetBibs = [];
    let isQueryDiscovered = false;

    // Check if initial sequential range is responsive
    const probeRec = await fetchRecord(options.startBib, options);
    if (!probeRec) {
      // If startBib is sparse, use query partition discovery
      console.log(`[${AGENCY_CODE}] Sparse initial bib detected. Initiating query discovery partition...`);
      const searchQueries = [
        'engineering', 'technology', 'science', 'management', 'malaysia',
        'computer', 'pendidikan', 'sejarah', 'business', 'system',
        'research', 'design', 'social', 'health', 'international',
        'yr:2024', 'yr:2023', 'yr:2022', 'yr:2021', 'yr:2020',
        'ccl=yr>2010', 'a*', 'b*', 'c*', 'd*', 'e*', 'm*', 'p*', 's*'
      ];

      for (const q of searchQueries) {
        if (targetBibs.length >= (options.maxRecords || 500)) break;
        let offset = 0;
        while (offset < 400 && targetBibs.length < (options.maxRecords || 500)) {
          const found = await discoverBiblionumbers(q, 50, offset);
          if (!found || found.length === 0) break;
          for (const b of found) {
            if (!targetBibs.includes(b)) targetBibs.push(b);
          }
          offset += 50;
          if (options.delayMs > 0) await sleep(options.delayMs);
        }
      }

      if (targetBibs.length > 0) {
        console.log(`[${AGENCY_CODE}] Discovered ${targetBibs.length} active catalog biblionumbers via query partitioning.`);
        isQueryDiscovered = true;
      }
    }

    // Harvest execution loop
    if (isQueryDiscovered) {
      for (const bib of targetBibs) {
        if (options.maxRecords > 0 && savedCount + batchBuffer.length >= options.maxRecords) {
          break;
        }

        try {
          const record = await fetchRecord(bib, options);
          if (record) {
            const xml = typeof record === 'string' ? record : recordToMarcXml(record);
            if (validateRecordContent(xml)) {
              batchBuffer.push({ id: bib, xml, timestamp: new Date().toISOString() });
              consecutiveMisses = 0;
              if (batchBuffer.length >= options.batchSize) {
                flushBatch();
              }
            } else {
              errorCount++;
            }
          } else {
            consecutiveMisses++;
          }
        } catch {
          errorCount++;
          consecutiveMisses++;
        }

        if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES && savedCount === 0) {
          console.warn(`[${AGENCY_CODE}] Reached ${MAX_CONSECUTIVE_MISSES} consecutive misses. Triggering circuit breaker.`);
          break;
        }

        if (options.delayMs > 0) {
          await sleep(options.delayMs);
        }
      }
    } else {
      // Sequential harvest loop
      for (let bib = options.startBib; bib <= options.endBib; bib++) {
        if (options.maxRecords > 0 && savedCount + batchBuffer.length >= options.maxRecords) {
          break;
        }

        try {
          const record = await fetchRecord(bib, options);
          if (record) {
            const xml = typeof record === 'string' ? record : recordToMarcXml(record);
            if (validateRecordContent(xml)) {
              batchBuffer.push({ id: bib, xml, timestamp: new Date().toISOString() });
              consecutiveMisses = 0;
              if (batchBuffer.length >= options.batchSize) {
                flushBatch();
              }
            } else {
              errorCount++;
            }
          } else {
            consecutiveMisses++;
          }
        } catch {
          errorCount++;
          consecutiveMisses++;
        }

        if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES && savedCount === 0) {
          console.warn(`[${AGENCY_CODE}] Reached ${MAX_CONSECUTIVE_MISSES} consecutive misses without records. Circuit breaker halting.`);
          break;
        }

        if (options.delayMs > 0) {
          await sleep(options.delayMs);
        }
      }
    }

    flushBatch();

    const manifest = {
      schema_version: '1.0',
      source_code: SOURCE_CODE,
      source_name: SOURCE_NAME,
      source_base_url: SOURCE_BASE_URL,
      terms_url: TERMS_URL,
      terms_verified_on: new Date().toISOString().slice(0, 10),
      harvester_name: HARVESTER_NAME,
      harvester_version: HARVESTER_VERSION,
      run_id: `${runId}${chunkSuffix}`,
      mode: options.mode,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      record_count: savedCount,
      error_count: errorCount,
      status: savedCount > 0 ? 'complete' : 'partial',
      user_agent: USER_AGENT,
      notes: `${AGENCY_CODE} harvest completed. Total: ${savedCount} records.`
    };
    fs.writeFileSync(path.join(chunkDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`\n=======================================================`);
    console.log(`[${AGENCY_CODE}] Harvest Run Finished. Status: ${manifest.status}`);
    console.log(`[${AGENCY_CODE}] Records Harvested: ${savedCount}`);
    console.log(`[${AGENCY_CODE}] Manifest: ${path.join(chunkDir, 'manifest.json')}`);
    console.log(`=======================================================\n`);
    return 0;
  }

  return {
    SOURCE_CODE,
    SOURCE_NAME,
    AGENCY_CODE,
    SOURCE_BASE_URL,
    TERMS_URL,
    USER_AGENT,
    HARVESTER_NAME,
    HARVESTER_VERSION,
    DEFAULT_MAX_BIB,
    DEFAULT_BRANCH,
    DEFAULT_SCHEME,
    parseArgs,
    printHelp,
    recordToMarcXml,
    fetchRecord,
    discoverBiblionumbers,
    runHarvest,
    validateRecordContent,
    inspectBatches,
    repairProvenance
  };
}
