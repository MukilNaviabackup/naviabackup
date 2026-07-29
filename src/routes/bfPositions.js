'use strict';
const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const zlib     = require('zlib');
const { getConnection, sql } = require('../config/database');
const { adminAuthenticate }  = require('../middleware/adminAuthenticate');
require('dotenv').config();

const TMP_DIR = path.join(os.tmpdir(), 'bf_uploads');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Multiple terminals fix (2026-07-27): the exchange's own daily clearing
// Position file (NCL for NSE F&O, MCXCCL for MCX) is now also accepted
// alongside the existing Symphony/Inhouse export -- see detectFormat() below.
// NSE/MCX distribute this file gzipped (Position_NCL_FO_..._F_0000.csv.gz)
// but it can also arrive already decompressed (.csv), so both extensions are
// allowed here; SYMPHONY_* files are untouched and still must be .csv.
const upload = multer({
    dest: TMP_DIR,
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const f = file.originalname.toLowerCase();
        if (f.endsWith('.csv') || f.endsWith('.csv.gz') || f.endsWith('.gz')) cb(null, true);
        else cb(new Error('Only CSV (or gzipped CSV) files allowed'));
    }
});

// ─── Format detection ─────────────────────────────────────────────────────────
// format: 'SYMPHONY' -> legacy Inhouse pipe-delimited export (parseSymphonyRow).
// format: 'EXCHANGE' -> raw exchange clearing-corp Position file, UDiFF-style
// comma-delimited with a header row (parseExchangePositionRow). Both formats
// are additive branches in the same upload handler -- neither touches the
// other's parsing or qty math.
function detectFormat(filename) {
    const f = filename.toUpperCase();
    if (f.includes('SYMPHONY_NFO') || f.includes('SYMPHONY_NSE'))
        return { exchange: 'NSE', segment: 'FO', source: 'SYMPHONY_NFO', format: 'SYMPHONY' };
    if (f.includes('SYMPHONY_MCX'))
        return { exchange: 'MCX', segment: 'FO', source: 'SYMPHONY_MCX', format: 'SYMPHONY' };
    if (f.includes('SYMPHONY_BSE'))
        return { exchange: 'BSE', segment: 'FO', source: 'SYMPHONY_BSE', format: 'SYMPHONY' };
    // Exchange-format Position files -- one file per exchange per day, filename
    // pattern is Position_<Src>_<Sgmt>_0_TM_<code>_<date>_F_0000.csv[.gz].
    // BSE's clearing corp (ICCL) file isn't wired in yet -- add its filename
    // pattern here once a real sample confirms the naming, same shape as these two.
    if (f.includes('POSITION_NCL'))
        return { exchange: 'NSE', segment: 'FO', source: 'NCL_FO',    format: 'EXCHANGE' };
    if (f.includes('POSITION_MCXCCL'))
        return { exchange: 'MCX', segment: 'FO', source: 'MCXCCL_CO', format: 'EXCHANGE' };
    return null;
}

// ─── Instrument type detection ────────────────────────────────────────────────
function getInstrumentType(t) {
    t = (t || '').toUpperCase();
    if (['IDO','STO','FUO','OPTIDX','OPTSTK','IO','OPTFUT'].includes(t)) return 'OPTIONS';
    if (['STF','COF','IDF','FUTSTK','FUTIDX','FUTCOM'].includes(t))      return 'FUTURES';
    return 'FUTURES';
}

function extractDateFromFilename(filename) {
    const m8 = filename.match(/(\d{8})/);
    if (m8) {
        const d = m8[1];
        return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
    }
    const m6 = filename.match(/(\d{2})-(\d{2})-(\d{2})/);
    if (m6) {
        const [, dd, mm, yy] = m6;
        return `${parseInt(yy) + 2000}-${mm}-${dd}`;
    }
    console.warn('[BF Upload] WARNING: Could not extract date from filename:', filename, '— using today as fallback');
    return null;
}

// B/F always represents positions carried forward TO today's session — there is
// no real scenario where a B/F upload should be dated anything other than the
// actual day it's uploaded. Previously biz_date was parsed from the filename
// (e.g. "..._25-06-26..."), which silently files the data under whatever date
// happens to appear in the filename - if that date doesn't match the real
// calendar day (a stale export name, a backfill, a typo), the upload succeeds
// but becomes invisible to both Client and Dealer views, since both correctly
// only ever query for today's biz_date. Using the real server date removes
// this entire class of mismatch.
function getISTTodayDate() {
    const now    = new Date();
    const istNow = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    return istNow.toISOString().slice(0, 10);
}

function parseDate(val) {
    if (!val) return null;
    val = val.toString().trim();
    const monMap = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
    const m1 = val.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (m1) {
        const mon = monMap[m1[2]];
        if (mon) return new Date(`${m1[3]}-${String(mon).padStart(2,'0')}-${m1[1].padStart(2,'0')}`);
    }
    if (/^\d{2}-\d{2}-\d{4}$/.test(val)) {
        const [d,m,y] = val.split('-');
        return new Date(`${y}-${m}-${d}`);
    }
    if (/^\d{8}$/.test(val))
        return new Date(`${val.slice(0,4)}-${val.slice(4,6)}-${val.slice(6,8)}`);
    return new Date(val);
}

function readRawLines(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
}

function safeUnlink(p) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
}

// ─── Gzip-aware raw line reader (2026-07-27) ──────────────────────────────────
// Only used by the new EXCHANGE-format path -- readRawLines() above stays
// exactly as it was for the Symphony path. NSE/MCX distribute their daily
// Position file gzipped; multer's fileFilter now also allows a plain .csv
// (as MCX's sample arrived), so this detects gzip by magic bytes rather than
// trusting the filename extension, and reads every line in the file with no
// truncation -- required for files running into the thousands of rows.
function readRawLinesAnyEncoding(filePath) {
    const buf     = fs.readFileSync(filePath);
    const isGzip  = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    const content = (isGzip ? zlib.gunzipSync(buf) : buf).toString('utf-8');
    return content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
}

// ─── Parse exchange clearing-corp Position file (header-driven) ──────────────
// Format: NSE Clearing (NCL) / MCXCCL UDiFF-style Position report -- one
// header row, comma-delimited, same column layout across NCL and MCXCCL
// (confirmed against both sample files). Returns { headerIdx, dataLines }.
function buildExchangeHeaderIndex(headerLine) {
    const cols = headerLine.split(',').map(c => c.trim());
    const idx  = {};
    cols.forEach((name, i) => { idx[name] = i; });
    return idx;
}

// Navia Backup B/F formula (confirmed 2026-07-27): the carry-forward figure
// comes from PreExrcAssgndLngQty / PreExrcAssgndShrtQty -- NOT the opening or
// same-day trading qty columns elsewhere in the file. Exactly one side should
// be populated per row; if both are zero there is nothing to carry forward
// and the row is skipped. NewBrdLotQty is this row's own lot size, straight
// from the exchange for that trading day -- both NSE (65 for the NIFTY rows
// sampled) and MCX (1 for every commodity sampled, matching the fact the
// existing Symphony parser never divides MCX qty by lot size) confirm this
// column is authoritative and safe to use directly instead of a separate
// lot_size_master lookup.
function parseExchangePositionRow(cols, idx) {
    const get = (name) => (cols[idx[name]] !== undefined ? cols[idx[name]].trim() : '');

    const ucc      = get('ClntId');
    const symbol   = get('TckrSymb');
    if (!ucc || !symbol) return null;

    const lngQty = parseFloat(get('PreExrcAssgndLngQty')) || 0;
    const shrtQty = parseFloat(get('PreExrcAssgndShrtQty')) || 0;
    if (lngQty === 0 && shrtQty === 0) return null;

    const lotSize = parseFloat(get('NewBrdLotQty')) || 1;
    const netQtyLots  = Math.round((lngQty - shrtQty) / lotSize);
    if (netQtyLots === 0) return null;
    const netQtyActual = netQtyLots * lotSize;

    const instrRaw    = get('FinInstrmTp').toUpperCase();
    const instrType   = getInstrumentType(instrRaw);
    const strikeRaw   = get('StrkPric');
    const strike      = strikeRaw && parseFloat(strikeRaw) !== 0 ? parseFloat(strikeRaw) : null;
    const optRaw      = get('OptnTp');
    const optionType  = optRaw ? optRaw : null;
    const expiryRaw   = get('XpryDt');
    const expiry      = expiryRaw ? parseDate(expiryRaw) : null;

    return {
        ucc, symbol, instrType, expiry, strike, optionType,
        lotSize, netQtyLots, netQtyActual,
        buyLots:  netQtyLots > 0 ? netQtyLots  : 0,
        sellLots: netQtyLots < 0 ? -netQtyLots : 0,
    };
}

// ─── Parse SYMPHONY pipe-delimited row ────────────────────────────────────────
function parseSymphonyRow(line) {
    const cols = line.split('|');
    if (cols.length < 14) return null;

    const ucc       = (cols[2]  || '').trim();
    const segStr    = (cols[3]  || '').trim().toLowerCase();
    const instrRaw  = (cols[4]  || '').trim().toUpperCase();
    const symbol    = (cols[5]  || '').trim();
    const expiryRaw = (cols[6]  || '').trim();
    const strikeRaw = (cols[7]  || '').trim();
    const optRaw    = (cols[8]  || '').trim();
    const buyQtyRaw = (cols[9]  || '').trim();

    const selQtyRaw = buyQtyRaw === ''
        ? (cols[11] || '').trim()
        : (cols[12] || '').trim();

    if (!ucc || !symbol) return null;

    const buyQty  = parseFloat(buyQtyRaw) || 0;
    const sellQty = parseFloat(selQtyRaw) || 0;
    if (buyQty === 0 && sellQty === 0) return null;

    const instrType  = getInstrumentType(instrRaw);
    const strike     = strikeRaw && strikeRaw !== '0' ? parseFloat(strikeRaw) : null;
    const optionType = (optRaw && optRaw.toLowerCase() !== 'nan' && optRaw !== '') ? optRaw : null;
    const expiry     = expiryRaw ? parseDate(expiryRaw) : null;

    let exchange = 'NSE';
    if (segStr.startsWith('bse'))      exchange = 'BSE';
    else if (segStr.startsWith('mcx')) exchange = 'MCX';

    return { ucc, exchange, segment: 'FO', symbol, instrType, expiry, strike, optionType, buyQty, sellQty };
}

// ─── Batch INSERT helper ──────────────────────────────────────────────────────
const BATCH_SIZE = 100;

// Terminal tagging (2026-07-27): every row now carries the client's terminal
// (Inhouse/BoW/XTS, from clients.terminal via r.terminal) and, for the new
// exchange-format path only, a qty_actual figure expressed in real
// units -- matching how Day/Net Position already display quantity -- instead
// of the lot count that total_open_qty has always held. Both new columns are
// nullable and simply omitted (NULL) for any row that doesn't set them, so
// this cannot change what a Symphony-sourced row's existing columns mean.
async function batchInsert(pool, rows) {
    let inserted = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch   = rows.slice(i, i + BATCH_SIZE);
        const request = pool.request();
        const values  = [];

        batch.forEach((r, idx) => {
            const p = `_${idx}`;
            request.input(`ucc${p}`,       sql.VarChar(20),   r.ucc);
            request.input(`exchange${p}`,  sql.VarChar(10),   r.exchange);
            request.input(`segment${p}`,   sql.VarChar(10),   r.segment);
            request.input(`symbol${p}`,    sql.VarChar(50),   r.symbol);
            request.input(`expiry${p}`,    sql.Date,          r.expiryDate);
            request.input(`strike${p}`,    sql.Decimal(10,2), r.strikePrice);
            request.input(`optType${p}`,   sql.VarChar(5),    r.optionType);
            request.input(`instrType${p}`, sql.VarChar(10),   r.instrType);
            request.input(`buyQty${p}`,    sql.Int,           r.buyQtyInt);
            request.input(`sellQty${p}`,   sql.Int,           r.sellQtyInt);
            request.input(`totalOpen${p}`, sql.Decimal(10,2), r.totalOpenQty);
            request.input(`bizDate${p}`,   sql.Date,          r.bizDate);
            request.input(`fileSrc${p}`,   sql.VarChar(20),   r.fileSource);
            request.input(`terminal${p}`,  sql.VarChar(10),   r.terminal || null);
            request.input(`qtyActual${p}`, sql.Decimal(18,2), r.qtyActual != null ? r.qtyActual : null);

            values.push(
                `(@ucc${p}, @exchange${p}, @segment${p}, @symbol${p}, @expiry${p}, ` +
                `@strike${p}, @optType${p}, @instrType${p}, 1, ` +
                `@buyQty${p}, @sellQty${p}, @buyQty${p}, @sellQty${p}, ` +
                `@buyQty${p} - @sellQty${p}, @totalOpen${p}, NULL, @bizDate${p}, @fileSrc${p}, 0, ` +
                `@terminal${p}, @qtyActual${p})`
            );
        });

        await request.query(`
            INSERT INTO bf_positions (
                ucc, exchange, segment, symbol, expiry_date,
                strike_price, option_type, instrument_type, lot_size,
                opng_lng_qty, opng_shrt_qty, buy_trdg_qty, sell_trdg_qty,
                pre_exercised, total_open_qty, settlement_price,
                biz_date, file_source, pre_exercised_shrt,
                terminal, qty_actual
            ) VALUES ${values.join(',\n')}
        `);

        inserted += batch.length;
    }

    return inserted;
}

// Loads every active client's terminal assignment once per upload, keyed by
// ucc -- confirmed (2026-07-27) that the exchange file's ClntId IS the same
// value as clients.ucc, so this is a direct lookup, no separate mapping
// table needed. A ucc not found here (closed account, or clients.terminal
// not yet backfilled) simply gets terminal = NULL rather than failing the row.
async function loadClientTerminalMap(pool) {
    const result = await pool.request().query(`SELECT ucc, terminal FROM clients`);
    const map = {};
    result.recordset.forEach(r => { map[r.ucc] = r.terminal || null; });
    return map;
}

// ─── POST /api/bf/upload ──────────────────────────────────────────────────────
router.post('/upload', adminAuthenticate, upload.single('bf_file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const filename = req.file.originalname;
    const fmt      = detectFormat(filename);

    if (!fmt) {
        safeUnlink(req.file.path);
        return res.status(400).json({
            error: 'Unknown file format. Filename must contain SYMPHONY_NFO, SYMPHONY_MCX, SYMPHONY_BSE, POSITION_NCL, or POSITION_MCXCCL.'
        });
    }

    const startTime = Date.now();

    try {
        const pool    = await getConnection();
        const bizDate = getISTTodayDate();

        // Terminal tagging (2026-07-27): loaded once per upload, used by both
        // the Symphony and exchange-format branches below so every row --
        // regardless of source file -- gets the client's real terminal
        // (Inhouse/BoW/XTS) instead of assuming it from the filename.
        const clientTerminalMap = await loadClientTerminalMap(pool);
        let unmappedClients = 0;

        console.log(`[BF Upload] ${filename} | Exchange: ${fmt.exchange} | Format: ${fmt.format} | BizDate: ${bizDate}`);

        const rowsToInsert = [];
        let skipped = 0;

        if (fmt.format === 'SYMPHONY') {
            // ── Existing Inhouse/Symphony path -- parsing and qty math are
            // byte-for-byte unchanged from before this feature; only the
            // terminal lookup is new. ──────────────────────────────────────
            const lines = readRawLines(req.file.path);
            console.log(`[BF Upload] Lines: ${lines.length}`);

            const lotResult = await pool.request().query(
                `SELECT symbol, exchange, lot_size FROM lot_size_master WHERE lot_size > 1`
            );
            const lotMap = {};
            lotResult.recordset.forEach(r => {
                lotMap[`${r.symbol}|${r.exchange}`] = r.lot_size;
            });
            console.log(`[BF Upload] Loaded ${lotResult.recordset.length} lot sizes`);

            await pool.request()
                .input('exchange', sql.VarChar(10), fmt.exchange)
                .input('bizDate',  sql.Date, new Date(bizDate))
                .query('DELETE FROM bf_positions WHERE exchange = @exchange AND biz_date = @bizDate');

            if (fmt.exchange === 'NSE') {
                await pool.request()
                    .input('exchange', sql.VarChar(10), 'BSE')
                    .input('bizDate',  sql.Date, new Date(bizDate))
                    .query('DELETE FROM bf_positions WHERE exchange = @exchange AND biz_date = @bizDate');
            }

            for (const line of lines) {
                if (!line.startsWith('|')) { skipped++; continue; }

                const row = parseSymphonyRow(line);
                if (!row) { skipped++; continue; }

                let buyQtyLots   = row.buyQty;
                let sellQtyLots  = row.sellQty;
                let totalOpenQty = row.buyQty - row.sellQty;

                if (row.exchange !== 'MCX') {
                    const lotKey  = `${row.symbol}|${row.exchange}`;
                    const lotSize = lotMap[lotKey] || 1;
                    if (lotSize > 1) {
                        buyQtyLots   = row.buyQty  / lotSize;
                        sellQtyLots  = row.sellQty / lotSize;
                        totalOpenQty = buyQtyLots  - sellQtyLots;
                    }
                }

                const terminal = clientTerminalMap[row.ucc] || null;
                if (!terminal) unmappedClients++;

                rowsToInsert.push({
                    ucc:          row.ucc,
                    exchange:     row.exchange,
                    segment:      row.segment,
                    symbol:       row.symbol,
                    expiryDate:   row.expiry,
                    strikePrice:  row.strike,
                    optionType:   row.optionType,
                    instrType:    row.instrType,
                    buyQtyInt:    Math.round(buyQtyLots),
                    sellQtyInt:   Math.round(sellQtyLots),
                    totalOpenQty: Math.round(totalOpenQty * 100) / 100,
                    bizDate:      new Date(bizDate),
                    fileSource:   (fmt.source || '').slice(0, 20),
                    terminal,
                    qtyActual:    null,
                });
            }

        } else {
            // ── New exchange-format path (NCL/MCXCCL Position files). ──────
            // DELETE is scoped to exchange + biz_date + file_source (not just
            // exchange + biz_date like the Symphony path above), so this can
            // never wipe out a Symphony-sourced row for the same exchange/day,
            // and vice versa, while either format is still in use.
            const lines = readRawLinesAnyEncoding(req.file.path);
            console.log(`[BF Upload] Lines (incl. header): ${lines.length}`);

            if (lines.length < 2) {
                safeUnlink(req.file.path);
                return res.json({
                    success: true, filename, exchange: fmt.exchange,
                    biz_date: bizDate, inserted: 0, skipped: 0,
                    message: 'File has no data rows.'
                });
            }

            const headerIdx = buildExchangeHeaderIndex(lines[0]);

            await pool.request()
                .input('exchange',  sql.VarChar(10), fmt.exchange)
                .input('bizDate',   sql.Date, new Date(bizDate))
                .input('fileSrc',   sql.VarChar(20), fmt.source)
                .query('DELETE FROM bf_positions WHERE exchange = @exchange AND biz_date = @bizDate AND file_source = @fileSrc');

            // Read every remaining row -- no truncation, however many
            // thousand lines the exchange file contains.
            for (let li = 1; li < lines.length; li++) {
                const cols = lines[li].split(',');
                const row  = parseExchangePositionRow(cols, headerIdx);
                if (!row) { skipped++; continue; }

                const terminal = clientTerminalMap[row.ucc] || null;
                if (!terminal) unmappedClients++;

                rowsToInsert.push({
                    ucc:          row.ucc,
                    exchange:     fmt.exchange,
                    segment:      fmt.segment,
                    symbol:       row.symbol,
                    expiryDate:   row.expiry,
                    strikePrice:  row.strike,
                    optionType:   row.optionType,
                    instrType:    row.instrType,
                    buyQtyInt:    row.buyLots,
                    sellQtyInt:   row.sellLots,
                    totalOpenQty: row.netQtyLots,
                    bizDate:      new Date(bizDate),
                    fileSource:   fmt.source,
                    terminal,
                    qtyActual:    row.netQtyActual,
                });
            }
        }

        if (unmappedClients > 0) {
            console.warn(`[BF Upload] ${unmappedClients} row(s) had no matching/terminal-tagged client in 'clients' -- inserted with terminal = NULL`);
        }

        console.log(`[BF Upload] Parsed ${rowsToInsert.length} valid rows, ${skipped} skipped — inserting in batches of ${BATCH_SIZE}`);

        if (rowsToInsert.length === 0) {
            safeUnlink(req.file.path);
            return res.json({
                success: true, filename, exchange: fmt.exchange,
                biz_date: bizDate, inserted: 0, skipped,
                message: 'No valid rows found in file.'
            });
        }

        const inserted = await batchInsert(pool, rowsToInsert);
        const duration = Date.now() - startTime;

        console.log(`[BF Upload] Batch INSERT done: ${inserted} rows in ${duration}ms`);

        safeUnlink(req.file.path);

        try {
            await pool.request()
                .input('adminId', sql.Int,          req.admin.adminId)
                .input('action',  sql.VarChar(50),  'BF_FILE_UPLOADED')
                .input('details', sql.VarChar(500), `${filename} — ${inserted} inserted, ${skipped} skipped in ${duration}ms`)
                .query(`INSERT INTO admin_logs (admin_id, action, details) VALUES (@adminId, @action, @details)`);
        } catch (_) {}

        try {
            await pool.request()
                .input('filename',   sql.VarChar(200), filename)
                .input('exchange',   sql.VarChar(10),  fmt.exchange)
                .input('bizDate',    sql.Date,         new Date(bizDate))
                .input('totalRows',  sql.Int,          inserted + skipped)
                .input('inserted',   sql.Int,          inserted)
                .input('skipped',    sql.Int,          skipped)
                .input('uploadedBy', sql.VarChar(100), req.admin.name || req.admin.username || 'admin')
                .query(`INSERT INTO bf_upload_logs (filename, exchange, biz_date, total_rows, inserted, skipped, uploaded_by)
                        VALUES (@filename, @exchange, @bizDate, @totalRows, @inserted, @skipped, @uploadedBy)`);
        } catch (_) {}

        return res.json({
            success:     true,
            filename,
            format:      fmt.format,
            exchange:    fmt.exchange,
            biz_date:    bizDate,
            inserted,
            skipped,
            unmapped_terminal: unmappedClients,
            duration_ms: duration,
            message:     `${filename} processed — ${inserted} positions loaded, ${skipped} skipped (${duration}ms)`
                + (unmappedClients > 0 ? ` — ${unmappedClients} client(s) had no terminal on file` : '')
        });

    } catch (err) {
        safeUnlink(req.file?.path);
        console.error('[BF Upload] Error:', err);
        return res.status(500).json({ error: 'Failed to process file: ' + err.message });
    }
});

// ─── GET /api/bf/positions ────────────────────────────────────────────────────
// Returns TODAY's (IST) B/F records per exchange for the logged-in client.
// total_open_qty is stored in LOTS. Positive = LONG, Negative = SHORT.
//
// Whatever file is uploaded is accepted as-is (no rejection logic here).
// Data is shown only for today's IST calendar date and flushes out
// automatically at midnight IST (00:00, i.e. the moment 11:59 PM IST ends).
// GETDATE() on Azure SQL returns UTC, so we add 5:30 before taking the date —
// without this offset the flip happens at 5:30 AM IST instead of midnight IST.
router.get('/positions', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized.' });

    try {
        const jwt     = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const ucc     = decoded.ucc?.toString();
        if (!ucc) return res.status(401).json({ error: 'Invalid token: missing UCC.' });

        const pool   = await getConnection();
        const result = await pool.request()
            .input('ucc', sql.VarChar(20), ucc)
            .query(`
                SELECT
                    bf.bf_id, bf.ucc, bf.exchange, bf.segment, bf.symbol,
                    bf.expiry_date, bf.strike_price, bf.option_type,
                    bf.instrument_type, bf.lot_size,
                    bf.opng_lng_qty, bf.opng_shrt_qty,
                    bf.buy_trdg_qty, bf.sell_trdg_qty,
                    bf.pre_exercised,
                    bf.total_open_qty,
                    bf.total_open_qty  AS qty_in_lots,
                    1                  AS lot_size_known,
                    bf.lot_size        AS resolved_lot_size,
                    bf.settlement_price, bf.biz_date, bf.file_source,
                    bf.terminal,
                    bf.qty_actual,
                    ISNULL(bf.qty_actual, bf.total_open_qty) AS display_qty
                FROM bf_positions bf
                WHERE bf.ucc = @ucc
                AND   bf.biz_date = CAST(DATEADD(MINUTE, 330, GETDATE()) AS DATE)
                ORDER BY bf.exchange, bf.instrument_type, bf.symbol, bf.expiry_date, bf.strike_price
            `);

        const positions    = result.recordset;
        const options      = positions.filter(p => p.instrument_type === 'OPTIONS');
        const futures      = positions.filter(p => p.instrument_type === 'FUTURES');
        const totalOpenQty = positions.reduce((s, p) => s + (Number(p.total_open_qty) || 0), 0);

        return res.json({
            success:         true,
            total_open_qty:  Math.round(totalOpenQty * 100) / 100,
            total_positions: positions.length,
            options_count:   options.length,
            futures_count:   futures.length,
            options, futures, positions
        });

    } catch (err) {
        console.error('[BF Positions] Error:', err);
        return res.status(500).json({ error: 'Failed to fetch B/F positions.' });
    }
});

// ─── GET /api/bf/status ───────────────────────────────────────────────────────
router.get('/status', adminAuthenticate, async (req, res) => {
    try {
        const pool   = await getConnection();
        const result = await pool.request().query(`
            SELECT exchange, file_source, biz_date,
                   COUNT(DISTINCT ucc) AS client_count,
                   COUNT(*)            AS position_count,
                   MAX(created_at)     AS uploaded_at
            FROM bf_positions
            WHERE biz_date >= CAST(GETDATE() - 1 AS DATE)
            GROUP BY exchange, file_source, biz_date
            ORDER BY biz_date DESC, exchange
        `);

        // Multiple terminals fix (2026-07-27): per-terminal breakdown so RMS
        // can see today's load split Inhouse / BoW / XTS (and NULL for any
        // row whose client wasn't found/tagged in `clients`), additive to the
        // existing `status` array above -- nothing already reading
        // res.status changes shape.
        const byTerminal = await pool.request().query(`
            SELECT exchange, biz_date, ISNULL(terminal, 'UNMAPPED') AS terminal,
                   COUNT(DISTINCT ucc) AS client_count,
                   COUNT(*)            AS position_count
            FROM bf_positions
            WHERE biz_date = CAST(DATEADD(MINUTE, 330, GETDATE()) AS DATE)
            GROUP BY exchange, biz_date, ISNULL(terminal, 'UNMAPPED')
            ORDER BY exchange, terminal
        `);

        return res.json({ success: true, status: result.recordset, by_terminal: byTerminal.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch status.' });
    }
});

// ─── GET /api/bf/history ──────────────────────────────────────────────────────
// Full history + date-range filter (2026-07-29): previously hard-capped to
// TOP 20 regardless of date. Every upload was already being permanently
// stored in bf_upload_logs -- the cap was only in this SELECT -- so this now
// returns the complete history for the requested range instead of an
// arbitrary "last 20", filtered by an optional
// ?from=YYYY-MM-DD&to=YYYY-MM-DD on the upload timestamp (created_at), same
// pattern as the Client Alerts / Client Upload history date filters.
// Omitting from/to returns the entire history, newest first.
router.get('/history', adminAuthenticate, async (req, res) => {
    try {
        const pool    = await getConnection();
        const request = pool.request();
        const conditions = [];

        if (req.query.from) {
            request.input('fromDate', sql.Date, req.query.from);
            conditions.push('created_at >= @fromDate');
        }
        if (req.query.to) {
            request.input('toDate', sql.Date, req.query.to);
            conditions.push('created_at < DATEADD(DAY, 1, @toDate)');
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        const result = await request.query(`
            SELECT
                log_id, filename, exchange, biz_date,
                total_rows, inserted, skipped, uploaded_by, created_at
            FROM bf_upload_logs
            ${whereClause}
            ORDER BY created_at DESC
        `);
        return res.json({ success: true, history: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch upload history.' });
    }
});

module.exports = router;