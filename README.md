# Pustaka Terbuka — UUM (Universiti Utara Malaysia)

> **Pustaka Terbuka: Katalog Induk Terbuka untuk Perpustakaan dan Sekolah Malaysia.**  
> *Official Perpustakaan Sultanah Bahiyah (Universiti Utara Malaysia) (UUM) Bibliographic Dataset & Standalone Harvester.*

This repository contains the harvested open MARCXML collection and harvester pipeline for **Perpustakaan Sultanah Bahiyah (Universiti Utara Malaysia)** (`UUM`), contributing to the national Malaysian union catalog at [pustaka-terbuka/opac](https://github.com/pustaka-terbuka/opac).

---

## Institutional Metadata

| Attribute | Value |
| :--- | :--- |
| **Institution Code** | `uum` |
| **Agency Code** | `UUM` |
| **Official Name** | Perpustakaan Sultanah Bahiyah (Universiti Utara Malaysia) |
| **Institution Type** | `university` |
| **State / Territory** | Kedah |
| **Classification Scheme** | `LCC` |
| **OPAC Base URL** | [https://library.uum.edu.my/](https://library.uum.edu.my/) |
| **Platform / Engine** | `koha` |
| **Default Branch** | Perpustakaan Sultanah Bahiyah (Sintok) |

---

## Directory Structure

```text
uum/
├── README.md                      # Institutional repository documentation
├── package.json                   # Node.js project specification & scripts
├── harvest/
│   └── inbox/uum/             # Sealed MARCXML batch chunks and manifests
│       └── <run-id>-chunk-001/
│           ├── manifest.json      # Chunk SHA-256 manifest & metadata
│           ├── provenance.jsonl   # Record-level attribution and fetch logs
│           └── records/           # Batched MARC21 slim XML files
├── tools/
│   ├── harvesters/uum/        # Automated OPAC crawler & MARC21 converter
│   ├── lib/                       # Supporting MARCXML, LCC, and validation utilities
│   ├── schemas/                   # JSON schemas for manifests and provenance
│   ├── validate-inbox.js          # Dataset integrity and schema validator
│   ├── merge.js                   # Local catalog merge engine
│   └── ingest-to-master.js        # Safe master ingestion bridge into pustaka-terbuka/opac
└── tests/
    └── harvester-uum.test.js  # Autonomous test suite
```

---

## Usage

```bash
# Install dependencies
npm install

# Test run harvester (10 sample records)
npm run harvest:sample

# Run harvester with chunking
npm run harvest:chunked

# Validate dataset integrity
npm run validate-inbox harvest/inbox/uum/<chunk-directory>

# Ingest new harvested batches into the central OPAC union catalog
npm run ingest:master
```

---

## Attribution & License

Dataset harvested and preserved under open library metadata standards for educational, civic, and cooperative indexing. Attribution: **Perpustakaan Sultanah Bahiyah (Universiti Utara Malaysia) (UUM)** & **Pustaka Terbuka**.
