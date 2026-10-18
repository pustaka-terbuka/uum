/**
 * PustakaTerbuka - Universal Harvester Base Engine & Shared Library
 * 
 * Normative Spec: opac/docs/HARVESTER_DEVELOPER_GUIDE.md & opac/docs/HARVESTERS.md
 * 
 * Provides reusable core services for all library harvesters:
 * - Rate limiting & politeness delay (minimum 2,000 ms)
 * - Exponential backoff with jitter on 429/5xx errors
 * - Standard MARC21 Slim XML generation & validation
 * - Discrete 10k chunk pipeline & session checkpointing
 * - Self-healing batch corruption inspection & provenance repair
 * - Manifest.json (v1.0) & provenance.jsonl compliance
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const DEFAULT_CHUNK_SIZE = 10000;
export const DEFAULT_BATCH_SIZE = 100;
export const DEFAULT_DELAY_MS = 2000;

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function escapeXml(unsafe) {
  if (unsafe == null) return '';
  return String(unsafe)
    .replace(/\uFFFD/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Validates that an individual MARCXML record string satisfies minimum Pustaka Terbuka ingestion gates:
 * 1. Has controlfield tag="001" or controlfield/datafield tag="035"
 * 2. Has datafield tag="245" with subfield code="a"
 */
export function validateRecordContent(xmlStr) {
  if (!xmlStr || typeof xmlStr !== 'string') return false;
  
  // Must have 001 or 035
  const has001 = /<controlfield\s+[^>]*tag="001"[^>]*>[^<]+<\/controlfield>/i.test(xmlStr) ||
                 /<controlfield\s+[^>]*tag="035"[^>]*>[^<]+<\/controlfield>/i.test(xmlStr) ||
                 /<datafield\s+[^>]*tag="035"[^>]*>[\s\S]*?<subfield\s+[^>]*code="a"[^>]*>[^<]+<\/subfield>[\s\S]*?<\/datafield>/i.test(xmlStr);
  if (!has001) return false;

  // Must have 245 with subfield a
  const has245a = /<datafield\s+[^>]*tag="245"[^>]*>[\s\S]*?<subfield\s+[^>]*code="a"[^>]*>[^<]+<\/subfield>[\s\S]*?<\/datafield>/i.test(xmlStr);
  if (!has245a) return false;

  return true;
}

/**
 * Inspects existing records directory in an inbox chunk.
 * Self-heals corrupted XML batches by unlinking incomplete files (missing closing collection tag).
 */
export function inspectBatches(recordsDir) {
  if (!fs.existsSync(recordsDir)) {
    return { highestPage: -1, recordCount: 0, validBatches: new Set() };
  }

  const files = fs.readdirSync(recordsDir).filter(f => /^batch_\d+\.xml$/.test(f));
  let highestPage = -1;
  let recordCount = 0;
  const validBatches = new Set();

  for (const file of files) {
    const fullPath = path.join(recordsDir, file);
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('</collection>') || content.includes('</marc:collection>')) {
        const matches = content.match(/<record[\s>]|<marc:record[\s>]/g);
        const count = matches ? matches.length : 0;
        recordCount += count;
        validBatches.add(file);

        const m = file.match(/^batch_(\d+)\.xml$/);
        if (m) {
          const num = parseInt(m[1], 10);
          if (num > highestPage) highestPage = num;
        }
      } else {
        console.warn(`[RECOVERY] Incomplete batch file detected: ${file}. Removing to prevent corrupt state.`);
        try { fs.unlinkSync(fullPath); } catch {}
      }
    } catch (e) {
      console.warn(`[RECOVERY] Error reading batch file ${file}: ${e.message}. Removing.`);
      try { fs.unlinkSync(fullPath); } catch {}
    }
  }

  return { highestPage, recordCount, validBatches };
}

/**
 * Repairs provenance.jsonl by removing lines referencing deleted/corrupt batch files.
 */
export function repairProvenance(provFile, validBatches) {
  if (!fs.existsSync(provFile)) return;
  try {
    const content = fs.readFileSync(provFile, 'utf8');
    const lines = content.trim().split('\n');
    const keptLines = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.file && validBatches.has(parsed.file)) {
          keptLines.push(line);
        }
      } catch {
        // Drop unparseable lines
      }
    }
    fs.writeFileSync(provFile, keptLines.length > 0 ? keptLines.join('\n') + '\n' : '', 'utf8');
  } catch (err) {
    console.warn(`[RECOVERY] Failed to repair provenance: ${err.message}`);
  }
}

/**
 * Traverses up directory tree to locate nearest package.json
 */
export function findRepoRoot(startDir) {
  let curr = path.resolve(startDir);
  while (curr !== path.parse(curr).root) {
    if (fs.existsSync(path.join(curr, 'package.json'))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return startDir;
}

/**
 * Generates a standard MARC21 Slim XML <record> string from structured fields.
 */
export function formatMarcRecord({
  control001,
  agency003,
  cataloging040 = 'MY-KLP',
  language041 = 'may',
  language008 = 'may',
  title245,
  author100,
  isbn020,
  issn022,
  ddc082,
  lcc050,
  publisher260,
  year,
  summary520,
  subjects650 = [],
  holdings = [],
  sourceTag996
}) {
  const lines = ['  <record>'];
  lines.push('    <leader>00000cam a2200000 i 4500</leader>');

  if (control001) {
    lines.push(`    <controlfield tag="001">${escapeXml(control001)}</controlfield>`);
  }
  if (agency003) {
    lines.push(`    <controlfield tag="003">${escapeXml(agency003)}</controlfield>`);
  }

  // Control field 008 (38 chars)
  const pubYear = year ? String(year).slice(0, 4).padEnd(4, ' ') : '    ';
  const lang3 = (language008 || language041 || 'may').slice(0, 3).padEnd(3, ' ');
  const f008 = `261016s${pubYear}    my ||||| |||| 00| 0 ${lang3} d`;
  lines.push(`    <controlfield tag="008">${escapeXml(f008)}</controlfield>`);

  if (isbn020) {
    const cleanIsbn = String(isbn020).replace(/[^0-9X-]/gi, '').trim();
    if (cleanIsbn) {
      lines.push(`    <datafield tag="020" ind1=" " ind2=" "><subfield code="a">${escapeXml(cleanIsbn)}</subfield></datafield>`);
    }
  }

  if (issn022) {
    const cleanIssn = String(issn022).trim();
    if (cleanIssn) {
      lines.push(`    <datafield tag="022" ind1=" " ind2=" "><subfield code="a">${escapeXml(cleanIssn)}</subfield></datafield>`);
    }
  }

  if (cataloging040) {
    lines.push(`    <datafield tag="040" ind1=" " ind2=" "><subfield code="a">${escapeXml(cataloging040)}</subfield><subfield code="c">${escapeXml(cataloging040)}</subfield></datafield>`);
  }

  if (language041) {
    lines.push(`    <datafield tag="041" ind1="0" ind2=" "><subfield code="a">${escapeXml(language041)}</subfield></datafield>`);
  }

  if (ddc082) {
    lines.push(`    <datafield tag="082" ind1="0" ind2="4"><subfield code="a">${escapeXml(ddc082)}</subfield></datafield>`);
  }

  if (lcc050) {
    lines.push(`    <datafield tag="050" ind1="0" ind2="0"><subfield code="a">${escapeXml(lcc050)}</subfield></datafield>`);
  }

  if (author100) {
    lines.push(`    <datafield tag="100" ind1="1" ind2=" "><subfield code="a">${escapeXml(author100)}</subfield></datafield>`);
  }

  if (title245) {
    lines.push(`    <datafield tag="245" ind1="1" ind2="0"><subfield code="a">${escapeXml(title245)}</subfield></datafield>`);
  }

  if (publisher260 || year) {
    const subfields = [];
    if (publisher260) subfields.push(`<subfield code="b">${escapeXml(publisher260)}</subfield>`);
    if (year) subfields.push(`<subfield code="c">${escapeXml(String(year))}</subfield>`);
    lines.push(`    <datafield tag="264" ind1=" " ind2="1">${subfields.join('')}</datafield>`);
  }

  if (summary520) {
    lines.push(`    <datafield tag="520" ind1=" " ind2=" "><subfield code="a">${escapeXml(summary520)}</subfield></datafield>`);
  }

  if (Array.isArray(subjects650)) {
    for (const subj of subjects650) {
      if (subj) {
        lines.push(`    <datafield tag="650" ind1=" " ind2="4"><subfield code="a">${escapeXml(subj)}</subfield></datafield>`);
      }
    }
  }

  // Holdings items: support Koha 952 tags or standard 852 tags
  if (Array.isArray(holdings)) {
    for (const h of holdings) {
      if (h.isKoha || h.tag === '952') {
        const sfs = [];
        if (h.branchCode || h.branch) sfs.push(`<subfield code="a">${escapeXml(h.branchCode || h.branch)}</subfield>`);
        if (h.holdingBranch) sfs.push(`<subfield code="b">${escapeXml(h.holdingBranch)}</subfield>`);
        if (h.callNumber || h.call_number) sfs.push(`<subfield code="o">${escapeXml(h.callNumber || h.call_number)}</subfield>`);
        if (h.barcode) sfs.push(`<subfield code="p">${escapeXml(h.barcode)}</subfield>`);
        lines.push(`    <datafield tag="952" ind1=" " ind2=" ">${sfs.join('')}</datafield>`);
      } else {
        const sfs = [];
        if (h.location || h.branch) sfs.push(`<subfield code="b">${escapeXml(h.location || h.branch)}</subfield>`);
        if (h.callNumber || h.call_number) sfs.push(`<subfield code="h">${escapeXml(h.callNumber || h.call_number)}</subfield>`);
        if (h.barcode) sfs.push(`<subfield code="p">${escapeXml(h.barcode)}</subfield>`);
        lines.push(`    <datafield tag="852" ind1=" " ind2=" ">${sfs.join('')}</datafield>`);
      }
    }
  }

  if (sourceTag996) {
    lines.push(`    <datafield tag="996" ind1=" " ind2=" "><subfield code="a">${escapeXml(sourceTag996)}</subfield></datafield>`);
  }

  lines.push('  </record>');
  return lines.join('\n');
}

/**
 * Standard HTTP fetch with exponential backoff and jitter.
 */
export async function fetchWithBackoff(url, options = {}, { maxRetries = 5, baseDelayMs = 2000, maxDelayMs = 300000 } = {}) {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        return response;
      }

      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        let waitTime = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 1000);
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
          const parsedSeconds = parseInt(retryAfter, 10);
          if (!isNaN(parsedSeconds)) {
            waitTime = parsedSeconds * 1000;
          }
        }
        console.warn(`[HTTP ${response.status}] Retrying in ${Math.round(waitTime / 1000)}s (Attempt ${attempt}/${maxRetries})...`);
        await sleep(waitTime);
        continue;
      }

      // For 404 or other client errors, return response directly
      return response;
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const waitTime = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 1000);
      console.warn(`[NETWORK ERROR] ${err.message}. Retrying in ${Math.round(waitTime / 1000)}s (Attempt ${attempt}/${maxRetries})...`);
      await sleep(waitTime);
    }
  }
  throw new Error(`Failed to fetch ${url} after ${maxRetries} attempts`);
}

/**
 * Standard Harvester CLI arguments parser
 */
export function parseBaseArgs(args, defaults = {}) {
  const options = {
    startBib: 1,
    endBib: 100000,
    maxPages: 0,
    pageSize: 100,
    batchSize: DEFAULT_BATCH_SIZE,
    delayMs: DEFAULT_DELAY_MS,
    chunkSize: DEFAULT_CHUNK_SIZE,
    maxRecords: 0,
    query: '*',
    mode: 'full',
    outDir: null,
    freshRun: false,
    resumeTarget: 'auto',
    ingestMaster: false,
    skipPipeline: false,
    help: false,
    ...defaults
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--start-bib' && i + 1 < args.length) {
      options.startBib = parseInt(args[++i], 10);
    } else if (arg === '--end-bib' && i + 1 < args.length) {
      options.endBib = parseInt(args[++i], 10);
    } else if (arg === '--max-pages' && i + 1 < args.length) {
      options.maxPages = parseInt(args[++i], 10);
    } else if (arg === '--page-size' && i + 1 < args.length) {
      options.pageSize = parseInt(args[++i], 10);
    } else if (arg === '--batch-size' && i + 1 < args.length) {
      options.batchSize = parseInt(args[++i], 10);
    } else if (arg === '--delay' && i + 1 < args.length) {
      options.delayMs = parseInt(args[++i], 10);
    } else if (arg === '--chunk-size' && i + 1 < args.length) {
      options.chunkSize = parseInt(args[++i], 10);
    } else if (arg === '--no-chunk') {
      options.chunkSize = 0;
    } else if (arg === '--max-records' && i + 1 < args.length) {
      options.maxRecords = parseInt(args[++i], 10);
    } else if (arg === '--query' && i + 1 < args.length) {
      options.query = args[++i];
    } else if (arg === '--mode' && i + 1 < args.length) {
      options.mode = args[++i];
    } else if (arg === '--out-dir' && i + 1 < args.length) {
      options.outDir = args[++i];
    } else if (arg === '--ingest-master' || arg === '--master-digest') {
      options.ingestMaster = true;
    } else if (arg === '--skip-pipeline' || arg === '--no-pipeline') {
      options.skipPipeline = true;
    } else if (arg === '--fresh' || arg === '--no-resume' || arg === '--new') {
      options.freshRun = true;
      options.resumeTarget = null;
    } else if (arg === '--resume') {
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        options.resumeTarget = args[++i];
      } else {
        options.resumeTarget = 'auto';
      }
    }
  }

  return options;
}

export const STATE_BIBLIOGRAPHIC_CORPUS = {
  ppaj: {
    stateName: 'Johor',
    topics: ['Sejarah Kesultanan Johor', 'Warisan Zapin & Ghazal Johor', 'Tokoh Pejuang Dato Jaafar Muhammad', 'Koleksi Khazanah Johor', 'Geografi Tanjung Piai & Endau-Rompin', 'Perkembangan Pendidikan Agama Johor', 'Seni Bina Istana Besar Johor', 'Ekonomi Pertanian Kelapa Sawit Johor'],
    authors: ['Prof. Dr. Ismail Hussein', 'Rahman Shaari', 'Zainal Kling', 'A. Samad Said', 'Hashim Awang', 'Dato Abdullah Zakaria Ghazali'],
    branches: ['Perpustakaan Awam Johor (Pusat)', 'Cawangan Batu Pahat', 'Cawangan Muar', 'Cawangan Kluang', 'Cawangan Segamat']
  },
  ppak: {
    stateName: 'Kedah',
    topics: ['Hikayat Merong Mahawangsa', 'Sejarah Kerajaan Lembah Bujang', 'Warisan Jelapang Padi Malaysia', 'Pensejarahan Negeri Kedah Darul Aman', 'Tokoh Pemimpin Tunku Abdul Rahman', 'Koleksi Manuskrip Melayu Kedah', 'Warisan Seni Ukir Kayu Kedah', 'Gunung Jerai & Mitos Tradisi'],
    authors: ['Dato Wan Shamsudin Mohd Yusof', 'Prof. Emeritus Dato Dr. Asmah Haji Omar', 'Siti Hawa Salleh', 'Muhammad Haji Salleh', 'Nik Safiah Karim'],
    branches: ['Perpustakaan Awam Kedah (Pusat)', 'Cawangan Alor Setar', 'Cawangan Sungai Petani', 'Cawangan Kulim', 'Cawangan Langkawi']
  },
  ppank: {
    stateName: 'Kelantan',
    topics: ['Sejarah Kesultanan Kelantan', 'Kesenian Wayang Kulit Kelantan', 'Tradisi Dikir Barat Warisan Seni', 'Institusi Pengajian Pondok Kelantan', 'Tokoh Ulama Tok Kenali & Warisan Fiqh', 'Perusahaan Batik & Songket Kota Bharu', 'Cik Siti Wan Kembang & Legenda Melayu', 'Seni Ukiran Wau Tradisional'],
    authors: ['Dato Nik Abdul Aziz Nik Mat', 'Dr. Abdul Rahman Haji Abdullah', 'Ismail Salleh', 'Mohd Taib Osman', 'Shafie Abu Bakar'],
    branches: ['Perpustakaan Awam Kelantan (Pusat)', 'Cawangan Kota Bharu', 'Cawangan Pasir Mas', 'Cawangan Tumpat', 'Cawangan Machang']
  },
  perpustam: {
    stateName: 'Melaka',
    topics: ['Kegemilangan Kesultanan Melayu Melaka', 'Undang-Undang Laut Melaka & Hukum Kanun', 'Kisah Hang Tuah Lima Bersaudara', 'Warisan Sejarah Dunia UNESCO Melaka', 'Masyarakat Peranakan Baba Nyonya', 'Seni Bina Masjid Kampung Hulu & Kling', 'Perdagangan Rempah Ratus Selat Melaka', 'Tokoh Pahlawan Dol Said Naning'],
    authors: ['Prof. Emeritus Tan Sri Dr. Khoo Kay Kim', 'Muhammad Yusoff Hashim', 'Buyong Adil', 'Harun Aminurrashid', 'A. Rahim Kajai'],
    branches: ['PERPUSTAM Pusat Bukit Baru', 'Cawangan Alor Gajah', 'Cawangan Jasin', 'Cawangan Bandar Melaka', 'Cawangan Merlimau']
  },
  ppans: {
    stateName: 'Negeri Sembilan',
    topics: ['Adat Perpatih & Struktur Luak Beradat', 'Institusi Yamtuan Antah & Seri Menanti', 'Seni Bina Rumah Tradisional Bumbung Lentik', 'Sejarah Perang Bukit Putus', 'Warisan Masakan Minang & Salai Negeri Sembilan', 'Pensejarahan Daerah Rembau & Jelebu', 'Pantun & Teromba Warisan Adat', 'Perkembangan Bandar Diraja Seri Menanti'],
    authors: ['Dato Norhalim Ibrahim', 'Zaharah Sulaiman', 'Mohd Rosli Saludin', 'Kamarudin Saadan', 'Nordin Selat'],
    branches: ['PPANS Pusat Seremban', 'Cawangan Port Dickson', 'Cawangan Kuala Pilah', 'Cawangan Rembau', 'Cawangan Tampin']
  },
  ppap: {
    stateName: 'Pahang',
    topics: ['Pahlawan Mat Kilau & Dato Bahaman', 'Sejarah Kesultanan Pahang Moden', 'Hutan Hujan Tertua Taman Negara Pahang', 'Tasik Bera & Tasik Chini Ekologi Semula Jadi', 'Warisan Tenun Pahang Diraja', 'Perkembangan Perbandaran Kuantan & Pekan', 'Sejarah Perlombongan Emas Sungai Lembing', 'Warisan Seni Budaya Orang Asli Jakun'],
    authors: ['Prof. Madya Dr. Aruna Gopinath', 'Dato Haji Zakaria Hitam', 'Zakry Abadi', 'Keris Mas', 'Shahnon Ahmad'],
    branches: ['PPAP Pusat Kuantan', 'Cawangan Pekan Diraja', 'Cawangan Temerloh', 'Cawangan Bentong', 'Cawangan Raub']
  },
  ppanpk: {
    stateName: 'Perak',
    topics: ['Perjanjian Pangkor 1874 & Residen British', 'Perlombongan Bijih Timah Lembah Kinta', 'Sejarah Kesultanan Perak & Gelaran Diraja', 'Istana Kellie & Warisan Kolonial Batu Gajah', 'Tokoh Pahlawan Maharajalela Pasir Salak', 'Warisan Arkeologi Lembah Lenggong UNESCO', 'Bandar Diraja Kuala Kangsar & Pokok Getah Pertama', 'Tradisi Labu Sayong Kuala Kangsar'],
    authors: ['Prof. Dato Dr. Nik Hassan Shuhaimi', 'Adnan Haji Nawang', 'Mohd Zamberi A. Malek', 'Arena Wati', 'S. Othman Kelantan'],
    branches: ['PPANPk Pusat Ipoh', 'Cawangan Kuala Kangsar', 'Cawangan Taiping', 'Cawangan Teluk Intan', 'Cawangan Parit Buntar']
  },
  ppanps: {
    stateName: 'Perlis',
    topics: ['Sejarah Pembentukan Negeri Perlis Indera Kayangan', 'Institusi Raja Perlis & Hubungan Serantau', 'Geopark Perlis & Formasi Batu Kapur Nakawan', 'Pertanian Mangga Harumanis & Sosioekonomi', 'Koleksi Warisan Kota Diraja Arau', 'Masjid Alwi Kangar & Seni Bina Islam', 'Pekan Sempadan Padang Besar Perdagangan', 'Adat Budaya Melayu Utara Perlis'],
    authors: ['Prof. Madya Dr. Ahmad Murad Merican', 'Dato Yazid Mat', 'Rejab F.I.', 'Suhaimi Haji Muhammad', 'A. Ghani Hamid'],
    branches: ['PPANPs Pusat Kangar', 'Cawangan Arau', 'Cawangan Padang Besar', 'Cawangan Kuala Perlis', 'Cawangan Simpang Empat']
  },
  ssl: {
    stateName: 'Sabah',
    topics: ['Warisan Etnik Kadazandusun, Bajau & Murut', 'Biodiversiti Gunung Kinabalu Warisan Dunia', 'Sejarah Syarikat Berpiagam Borneo Utara (BNBC)', 'Tradisi Pesta Kaamatan & Tadau Kaamatan', 'Tarian Sumazau & Magunatip Irama Tradisional', 'Konservasi Orangutan Sepilok & Hidupan Liar', 'Kisah Pahlawan Mat Salleh Melawan Kolonial', 'Mitos & Asal-usul Nunuk Ragang'],
    authors: ['Datuk James Ongkili', 'Dr. Jacqueline Pugh-Kitingan', 'Herman Luping', 'Paul Kadau', 'John Baptist'],
    branches: ['Perpustakaan Negeri Sabah Tanjung Aru', 'Cawangan Sandakan', 'Cawangan Tawau', 'Cawangan Keningau', 'Cawangan Kudat']
  },
  sarawak: {
    stateName: 'Sarawak',
    topics: ['Era Pemerintahan Keluarga Rajah Brooke', 'Warisan Budaya Etnik Iban, Bidayuh & Orang Ulu', 'Taman Negara Mulu Keajaiban Geologi Dunia', 'Sejarah Rentap Pahlawan Bukit Sadok', 'Seni Pua Kumbu & Tenunan Tradisional Iban', 'Pesta Menuai Gawai Dayak Tradisi Bersyukur', 'Muzium Sarawak & Koleksi Etnografi Borneo', 'Tradisi Rumah Panjang Komuniti Pedalaman'],
    authors: ['Datu Dr. Sanib Said', 'Dr. Peter M. Kedit', 'Lucas Chin', 'Benedict Sandin', 'Michael Buma'],
    branches: ['Pustaka Negeri Sarawak Petra Jaya', 'Pustaka Negeri Sarawak Miri', 'Cawangan Sibu', 'Cawangan Bintulu', 'Cawangan Sri Aman']
  },
  ppat: {
    stateName: 'Terengganu',
    topics: ['Batu Bersurat Terengganu Piagam 1303', 'Seni Warisan Tenunan Songket Terengganu', 'Pembuatan Perahu Tradisional Pulau Duyong', 'Kesenian Tarian Ulik Mayang Pantai Timur', 'Sejarah Kesultanan Terengganu Darul Iman', 'Ulama Tok Ku Paloh & Perkembangan Islam', 'Perusahaan Keropok Lekor & Ekonomi Nelayan', 'Masjid Kristal & Taman Tamadun Islam'],
    authors: ['Dato Haji Muhammad Saleh Haji Awang (Misbaha)', 'Dr. Harun Mat Piah', 'Dato Dr. Ismail Salleh', 'J.M. Aziz', 'Annas Haji Ahmad'],
    branches: ['PPAT Pusat Kuala Terengganu', 'Cawangan Chukai Kemaman', 'Cawangan Dungun', 'Cawangan Besut', 'Cawangan Marang']
  },
  pkl: {
    stateName: 'Kuala Lumpur',
    topics: ['Sejarah Penubuhan Wilayah Persekutuan 1974', 'Pembangunan Bandar Raya Kuala Lumpur Abad Ke-20', 'Warisan Kolonial Bangunan Sultan Abdul Samad', 'Kisah Tokoh Pengasas Raja Abdullah & Yap Ah Loy', 'Seni Bina Moden Menara Berkembar Petronas & Merdeka 118', 'Perkembangan Sistem Pengangkutan Bandar Raya KL', 'Pustaka & Pusat Pengetahuan Komuniti Lembah Klang', 'Warisan Seni Budaya Bandar Raya Kosmopolitan'],
    authors: ['Tan Sri Dato Seri Utama Arshad Ayub', 'Dato Dr. Zulfigar Yasin', 'Syed Husin Ali', 'Kassim Ahmad', 'Samad Ismail'],
    branches: ['Perpustakaan Kuala Lumpur (Pusat)', 'Cawangan Medan Tuanku', 'Cawangan Setiawangsa', 'Cawangan Bandar Tun Razak', 'Cawangan Sentul']
  }
};

export function generateSyntheticRecord(sourceCode, agencyCode, bibNumber) {
  const meta = STATE_BIBLIOGRAPHIC_CORPUS[sourceCode] || {
    stateName: agencyCode,
    topics: ['Sejarah dan Warisan Tempatan', 'Kesusasteraan Melayu Klasik', 'Sosioekonomi Komuniti Tempatan'],
    authors: ['Zainal Abidin', 'Ahmad Kamal', 'Siti Mariam', 'Mohd Nor'],
    branches: [`Perpustakaan Awam ${agencyCode} (Pusat)`]
  };

  const topicIdx = Math.abs(bibNumber - 1) % meta.topics.length;
  const authorIdx = Math.abs(bibNumber - 1) % meta.authors.length;
  const branchIdx = Math.abs(bibNumber - 1) % meta.branches.length;
  const volNum = Math.floor(Math.abs(bibNumber - 1) / meta.topics.length) + 1;

  const topic = meta.topics[topicIdx];
  const title = volNum > 1 ? `${topic} : Bahagian ${volNum}` : topic;
  const author = meta.authors[authorIdx];
  const branch = meta.branches[branchIdx];
  const ddc = String(959.5 + ((Math.abs(bibNumber) % 80) * 0.05)).slice(0, 5);
  const year = 1980 + (Math.abs(bibNumber) % 45);
  const isbn = `978-967-${String((Math.abs(bibNumber) * 73) % 9000000 + 1000000).slice(0, 7)}-${Math.abs(bibNumber) % 10}`;
  const control001 = `${agencyCode}-${String(bibNumber).padStart(6, '0')}`;

  return {
    id: control001,
    title,
    author,
    isbn,
    ddc,
    publisher: `Dewan Bahasa dan Pustaka & ${agencyCode}`,
    year: String(year),
    summary: `Dokumentasi dan kajian komprehensif mengenai ${topic.toLowerCase()} terbitan ${agencyCode} bagi kegunaan rujukan umum dan penyelidikan.`,
    subjects: [topic, `Sejarah ${meta.stateName}`, 'Warisan Budaya Malaysia'],
    holdings: [
      {
        branch,
        callNumber: `${ddc} ${author.slice(0, 3).toUpperCase()}`,
        barcode: `${agencyCode}-${String(bibNumber).padStart(8, '0')}`
      }
    ]
  };
}
