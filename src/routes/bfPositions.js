'use strict';
const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const { getConnection, sql } = require('../config/database');
const { adminAuthenticate }  = require('../middleware/adminAuthenticate');
require('dotenv').config();

const TMP_DIR = path.join(os.tmpdir(), 'bf_uploads');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const upload = multer({
    dest: TMP_DIR,
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.originalname.toLowerCase().endsWith('.csv')) cb(null, true);
        else cb(new Error('Only CSV files allowed'));
    }
});

// ─── Format detection ─────────────────────────────────────────────────────────
function detectFormat(filename) {
    const f = filename.toUpperCase();
    if (f.includes('SYMPHONY_NFO') || f.includes('SYMPHONY_NSE'))
        return { exchange: 'NSE', segment: 'FO', source: 'SYMPHONY_NFO', format: 'SYMPHONY' };
    if (f.includes('SYMPHONY_MCX'))
        return { exchange: 'MCX', segment: 'FO', source: 'SYMPHONY_MCX', format: 'SYMPHONY' };
    if (f.includes('SYMPHONY_BSE'))
        return { exchange: 'BSE', segment: 'FO', source: 'SYMPHONY_BSE', format: 'SYMPHONY' };
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

            values.push(
                `(@ucc${p}, @exchange${p}, @segment${p}, @symbol${p}, @expiry${p}, ` +
                `@strike${p}, @optType${p}, @instrType${p}, 1, ` +
                `@buyQty${p}, @sellQty${p}, @buyQty${p}, @sellQty${p}, ` +
                `@buyQty${p} - @sellQty${p}, @totalOpen${p}, NULL, @bizDate${p}, @fileSrc${p}, 0)`
            );
        });

        await request.query(`
            INSERT INTO bf_positions (
                ucc, exchange, segment, symbol, expiry_date,
                strike_price, option_type, instrument_type, lot_size,
                opng_lng_qty, opng_shrt_qty, buy_trdg_qty, sell_trdg_qty,
                pre_exercised, total_open_qty, settlement_price,
                biz_date, file_source, pre_exercised_shrt
            ) VALUES ${values.join(',\n')}
        `);

        inserted += batch.length;
    }

    return inserted;
}

// ─── POST /api/bf/upload ──────────────────────────────────────────────────────
router.post('/upload', adminAuthenticate, upload.single('bf_file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const filename = req.file.originalname;
    const fmt      = detectFormat(filename);

    if (!fmt) {
        safeUnlink(req.file.path);
        return res.status(400).json({
            error: 'Unknown file format. Filename must contain SYMPHONY_NFO, SYMPHONY_MCX, or SYMPHONY_BSE.'
        });
    }

    const startTime = Date.now();

    try {
        const pool    = await getConnection();
        const bizDate = getISTTodayDate();

        const lines = readRawLines(req.file.path);
        console.log(`[BF Upload] ${filename} | Exchange: ${fmt.exchange} | BizDate: ${bizDate} | Lines: ${lines.length}`);

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

        const rowsToInsert = [];
        let skipped = 0;

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
            });
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
            duration_ms: duration,
            message:     `${filename} processed — ${inserted} positions loaded, ${skipped} skipped (${duration}ms)`
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
                    bf.settlement_price, bf.biz_date, bf.file_source
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
        return res.json({ success: true, status: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch status.' });
    }
});

// ─── GET /api/bf/history ──────────────────────────────────────────────────────
router.get('/history', adminAuthenticate, async (req, res) => {
    try {
        const pool   = await getConnection();
        const result = await pool.request().query(`
            SELECT TOP 20
                log_id, filename, exchange, biz_date,
                total_rows, inserted, skipped, uploaded_by, created_at
            FROM bf_upload_logs
            ORDER BY created_at DESC
        `);
        return res.json({ success: true, history: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch upload history.' });
    }
});

module.exports = router;