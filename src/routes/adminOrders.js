const express = require('express');
const router = express.Router();
const { getConnection, sql } = require('../config/database');
const { adminAuthenticate, blockDealerAdmin } = require('../middleware/adminAuthenticate');
const nodemailer = require('nodemailer');
require('dotenv').config();

function createTransporter() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.zatpatmail.com',
        port: 465, secure: true,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
        tls: { rejectUnauthorized: false }
    });
}

// ── NEAT/BOLT file row builders ───────────────────────────────────────────────
// NSE NEAT CM Basket — 19 fixed-width comma-separated columns
// Verified against accepted NEAT terminal file 10-Jun-2026
function makeNeatCMRow(serial, side, symbol, qty, ucc, memberCode) {
    const trans = side.toUpperCase() === 'BUY' ? '1' : '2';
    return [
        String(serial).padEnd(13),   // Col 0: Serial No
        '1 ',                         // Col 1: Order Flow = 1 (Normal) — ALWAYS 1, never 2
        trans + ' ',                  // Col 2: Transaction 1=Buy 2=Sell
        symbol.padEnd(10),           // Col 3: Symbol padded to 10
        'EQ',                         // Col 4: Series — NO trailing spaces
        String(qty) + ' ',           // Col 5: Quantity
        '           ',               // Col 6: Price (blank, 11 chars)
        '  ',                         // Col 7: Stop Loss (blank)
        '         ',                 // Col 8: Disc Qty (blank)
        'MKT       ',                // Col 9: Order Type MKT
        '        ',                  // Col 10: Price Condition (blank)
        '1        ',                 // Col 11: Fill/Kill = 1
        '         ',                 // Col 12: Participant (blank)
        memberCode.padEnd(12),       // Col 13: Member Code (07708)
        '2 ',                         // Col 14: Client Type = 2
        ucc.padEnd(10),              // Col 15: Client Code (UCC)
        '                         ', // Col 16: Account (blank)
        '                ',          // Col 17: Exchange Reference (blank)
        '          ',                // Col 18: Text (blank)
    ].join(',');
}

// ── Lot size lookup (NEAT FO requires correct lot size in Col 17) ────────────
// Previously a hardcoded map - which is exactly how NIFTY's lot size silently
// went stale (75 instead of the correct, current 65) until proven against real
// orders and the lot_size_master table. Now reads the live table instead, the
// same one the Python DropCopy sync service keeps up to date via
// /api/dropcopy/refresh-lots after every successful sync - so this can't
// drift out of sync again for any symbol, not just NIFTY.
// lotSizeMap is built once per request from lot_size_master (see /orders/
// generate-file below) and passed in here rather than queried per-row.
function getLotSize(symbol, lotSizeMap) {
    if (!symbol) return 1;
    const base = symbol.toUpperCase().trim().split(/[\s@0-9]/)[0];
    return (lotSizeMap && lotSizeMap[base]) || 1;
}

// ── Freeze-quantity (slice) lookup + splitter ─────────────────────────────
// Same base-symbol extraction convention as getLotSize() above, applied to
// slice_qty_master instead. Used by the BSE BOLT generator to replicate the
// freeze-quantity splitting SqOffOrders.jsx already does client-side for
// NSE FO (see its splitSlices/sliceQty). Returns null (no split) when the
// symbol has no configured slice_qty row — safe by construction: an order
// is never split unless real freeze-qty data exists for that symbol.
function getSliceQty(symbol, sliceQtyMap) {
    if (!symbol) return null;
    const base = symbol.toUpperCase().trim().split(/[\s@0-9]/)[0];
    return (sliceQtyMap && sliceQtyMap[base]) || null;
}

function splitQtyBySlice(qty, sliceQ) {
    if (!sliceQ || qty <= sliceQ) return [qty];
    const chunks = [];
    let rem = qty;
    while (rem > 0) {
        const c = Math.min(rem, sliceQ);
        chunks.push(c);
        rem -= c;
    }
    return chunks;
}

// NSE NEAT FO Basket — options and futures
function makeNeatFORow(serial, side, symbol, expiry, strikePrice, optionType, qty, ucc, memberCode, lotSize) {
    // Col 3: 1=BUY, 2=SELL
    const trans = side.toUpperCase() === 'BUY' ? '1' : '2';

    // Col 6: Instrument type — OPTIDX for options, FUTIDX for futures
    const instrType = (optionType && optionType !== 'XX') ? 'OPTIDX' : 'FUTIDX';

    // Col 8: Expiry in DDMMMYYYY format (e.g. 23JUN2026)
    let expStr = '          ';
    if (expiry) {
        const d   = new Date(expiry);
        const dd  = String(d.getUTCDate()).padStart(2,'0');
        const mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getUTCMonth()];
        const yr  = d.getUTCFullYear();
        expStr = (dd + mon + yr).padEnd(10);
    }

    // Col 9: Strike price padded (e.g. '25550     ')
    const strike = strikePrice
        ? String(Math.round(parseFloat(strikePrice))).padEnd(10)
        : '          ';

    // Col 10: Option type CE or PE (blank for futures)
    const optType = (optionType && optionType !== 'XX') ? optionType : '';

    // Col 17: Lot size
    const lot = String(lotSize || qty).padEnd(9);

    // 26-column NEAT FO format — matched to RMS exactly
    return [
        String(serial).padEnd(13),   // Col 0:  Serial number
        'O',                          // Col 1:  Order type (letter O = normal)
        'U',                          // Col 2:  Order category
        trans + ' ',                  // Col 3:  Buy(1)/Sell(2)
        '0',                          // Col 4:  Order sub-type
        '2 ',                         // Col 5:  Product type
        instrType,                    // Col 6:  OPTIDX or FUTIDX
        symbol.padEnd(10),            // Col 7:  Symbol
        expStr,                       // Col 8:  Expiry DDMMMYYYY
        strike,                       // Col 9:  Strike price
        optType,                      // Col 10: CE/PE or blank
        String(qty) + ' ',            // Col 11: Quantity
        '           ',                // Col 12: Blank
        '  ',                         // Col 13: Blank
        '         ',                  // Col 14: Blank
        'MKT       ',                 // Col 15: Order type MKT
        '          ',                 // Col 16: Price (blank for MKT)
        lot,                          // Col 17: Lot size
        '         ',                  // Col 18: Blank
        memberCode.padEnd(12),        // Col 19: Member code
        '2 ',                         // Col 20: Exchange (2=NSE)
        ucc.padEnd(10),               // Col 21: Client UCC
        '                        ',   // Col 22: Blank
        '0 ',                         // Col 23: Disclosed qty
        '                ',           // Col 24: Blank
        '            ',               // Col 25: Blank
    ].join(',');
}

// ── TEMPORARY DIAGNOSTIC ROUTE ────────────────────────────────────────────────
// No auth, read-only, calls makeNeatFORow directly with fixed test values.
// Lets us verify exactly what code is live on the server via a plain browser
// visit - no Kudu/console needed. Touches nothing else. Safe to remove once
// the FAO file format mismatch is resolved.
router.get('/diag/neat-fo-test', (req, res) => {
    const testRow = makeNeatFORow(1, 'SELL', 'NIFTY', '2026-06-23', '25400', 'CE', 1, '88707169', '07708', 65);
    const cols = testRow.split(',');

    // Also read this file's OWN source directly from disk, right now, to prove
    // with zero ambiguity what code is actually running - not what we assume
    // is deployed. This bypasses every layer of doubt about caching/deploy.
    let sourceSnippet = null;
    try {
        const fs = require('fs');
        const selfSource = fs.readFileSync(__filename, 'utf8');
        const defIndex = selfSource.indexOf('function makeNeatFORow');
        const callIndex = selfSource.indexOf('router.post(\'/orders/generate-file\'');
        sourceSnippet = {
            file_path: __filename,
            function_definition_excerpt: selfSource.slice(defIndex, defIndex + 400),
            generate_file_route_excerpt: selfSource.slice(callIndex, callIndex + 1200),
        };
    } catch (e) {
        sourceSnippet = { error: e.message };
    }

    res.json({
        full_row: testRow,
        col_1_order_type: cols[1],
        col_1_is_letter_O: cols[1] === 'O',
        col_1_is_digit_0: cols[1] === '0',
        col_13_blank: cols[13],
        col_13_length: cols[13] ? cols[13].length : 0,
        col_16_price_blank: cols[16],
        col_16_length: cols[16] ? cols[16].length : 0,
        col_22_blank_length: cols[22] ? cols[22].length : 0,
        timestamp: new Date().toISOString(),
        source_proof: sourceSnippet
    });
});

// BSE BOLT CM format
function makeBoltCMRow(serial, side, symbol, qty, ucc, memberCode) {
    const trans = side.toUpperCase() === 'BUY' ? '1' : '2';
    return [
        String(serial).padEnd(13),
        '1 ',
        trans + ' ',
        symbol.padEnd(10),
        'A ',
        String(qty) + ' ',
        '           ',
        '  ',
        '         ',
        'MKT       ',
        '        ',
        '1        ',
        '         ',
        memberCode.padEnd(12),
        '2 ',
        ucc.padEnd(10),
        '                         ',
        '                ',
        '          ',
    ].join(',');
}

// BSE BOLT FO format
function makeBoltFORow(serial, side, symbol, expiry, strikePrice, optionType, qty, ucc, memberCode, lotSize) {
    const trans = side.toUpperCase() === 'BUY' ? '1' : '2';

    // Instrument type: SENSEX uses SXOPT/SXFUT, others use OPTIDX/FUTIDX
    const sym = (symbol || '').toUpperCase().trim();
    const isFO  = optionType && optionType !== 'XX';
    let instrType;
    if (sym === 'SENSEX' || sym === 'BANKEX') {
        instrType = isFO ? 'SXOPT' : 'SXFUT';
    } else {
        instrType = isFO ? 'OPTIDX' : 'FUTIDX';
    }

    // Expiry in DDMMMYYYY format
    let expStr = '          ';
    if (expiry) {
        const d   = new Date(expiry);
        const dd  = String(d.getUTCDate()).padStart(2,'0');
        const mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getUTCMonth()];
        const yr  = d.getUTCFullYear();
        expStr = (dd + mon + yr).padEnd(10);
    }

    const strike  = strikePrice ? String(Math.round(parseFloat(strikePrice))).padEnd(10) : '          ';
    const optType = isFO ? optionType : '';
    const lot     = String(lotSize || 1).padEnd(9);

    // BSE BOLT FO — 26 columns (same structure as NSE NEAT FO)
    return [
        String(serial).padEnd(13),   // Col 0:  Serial
        'O',                          // Col 1:  Order type (letter O)
        'U',                          // Col 2:  Order category
        trans + ' ',                  // Col 3:  Buy/Sell
        '0',                          // Col 4:  Sub-type
        '2 ',                         // Col 5:  Product type
        instrType,                    // Col 6:  SXOPT/SXFUT/OPTIDX/FUTIDX
        symbol.padEnd(10),            // Col 7:  Symbol
        expStr,                       // Col 8:  Expiry DDMMMYYYY
        strike,                       // Col 9:  Strike
        optType,                      // Col 10: CE/PE or blank
        String(qty) + ' ',            // Col 11: Quantity
        '           ',                // Col 12: Blank
        '  ',                         // Col 13: Blank
        '         ',                  // Col 14: Blank
        'MKT       ',             // Col 15: Order type
        '          ',             // Col 16: Price blank for MKT
        lot,                      // Col 17: Lot size
        '         ',              // Col 18: Blank
        memberCode.padEnd(12),    // Col 19: Clearing code
        '2 ',                     // Col 20: Exchange
        ucc.padEnd(10),           // Col 21: UCC
        '                         ', // Col 22: Blank
        '0 ',                     // Col 23: Disclosed qty
        '                ',       // Col 24: Blank
        '            ',           // Col 25: Blank
    ].join(',');
}

// MCX CTCL basket format
function makeMCXRow(serial, side, symbol, expiry, qty, ucc, memberCode) {
    const trans  = side.toUpperCase() === 'BUY' ? '1' : '2';
    const expStr = expiry
        ? new Date(expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
            .toUpperCase().replace(/ /g, '-')
        : '          ';
    return [
        String(serial).padEnd(13),
        '1 ',
        trans + ' ',
        symbol.padEnd(10),
        expStr.padEnd(10),
        '            ',
        'XX  ',
        String(qty) + ' ',
        '           ',
        'MKT       ',
        '        ',
        '1        ',
        '         ',
        memberCode.padEnd(12),
        '2 ',
        ucc.padEnd(10),
        '                         ',
        '                ',
        '          ',
    ].join(',');
}

// Helper: generate filename like BasketCM09Jun2026-12-26-50
function basketFilename(prefix) {
    const now = new Date();
    const dd  = String(now.getDate()).padStart(2, '0');
    const mon = now.toLocaleString('en-IN', { month: 'short' });
    const yr  = now.getFullYear();
    const hh  = String(now.getHours()).padStart(2, '0');
    const mm  = String(now.getMinutes()).padStart(2, '0');
    const ss  = String(now.getSeconds()).padStart(2, '0');
    return `${prefix}${dd}${mon}${yr}-${hh}-${mm}-${ss}.csv`;
}

// Get all sq-off orders with filters
router.get('/orders', adminAuthenticate, async (req, res) => {
    const { exchange, segment, status, date_from, date_to, ucc, placed_by } = req.query;
    try {
        const pool = await getConnection();
        let query = `
            SELECT
                o.order_id, o.ucc, c.client_name, o.exchange, o.segment,
                o.symbol, o.side, o.quantity, o.order_type, o.status,
                o.placed_at, o.traded_at, o.trade_price,
                o.placed_by, o.dealer_id, o.expiry_date,
                o.strike_price, o.option_type,
                o.file_generated, o.file_generated_at, o.alert_sent,
                -- Stale-order flag: this order is still ORDER_RECEIVED, but the
                -- position it targeted is already flat (net_qty = 0) -- meaning
                -- the client's exposure closed some other way (own trading app,
                -- a duplicate/test order, etc) before RMS ever processed THIS
                -- order. Downloading/submitting a file for a stale order would
                -- send a square-off request to the exchange for a position that
                -- no longer has any real exposure. CM/equity is checked against
                -- today's day_positions row (same join already proven in the
                -- BSE scrip-code lookup below); FO is checked against the live
                -- positions table (the same source the Net position tab itself
                -- uses to decide whether Square off is even offered).
                CASE
                    WHEN o.status <> 'ORDER_RECEIVED' THEN 0
                    WHEN o.segment = 'CM' AND dp.net_qty = 0 THEN 1
                    WHEN o.segment = 'FO' AND p.net_qty  = 0 THEN 1
                    ELSE 0
                END AS is_stale
            FROM squareoff_orders o
            LEFT JOIN clients c ON o.ucc = c.ucc
            LEFT JOIN day_positions dp
                ON dp.ucc      = o.ucc
                AND dp.symbol   = o.symbol
                AND dp.exchange = o.exchange
                AND dp.segment  = o.segment
                AND dp.instrument_type = 'EQUITY'
                AND dp.trade_date = CAST(GETDATE() AS DATE)
            LEFT JOIN positions p
                ON p.ucc      = o.ucc
                AND p.symbol   = o.symbol
                AND p.exchange = o.exchange
                AND p.segment  = o.segment
                AND (p.expiry_date = o.expiry_date OR (p.expiry_date IS NULL AND o.expiry_date IS NULL))
                AND (ABS(ISNULL(p.strike_price,0) - ISNULL(o.strike_price,0)) < 0.01)
                AND (p.option_type = o.option_type OR (p.option_type IS NULL AND o.option_type IS NULL))
            WHERE 1=1
        `;
        const request = pool.request();
        if (ucc)      { query += ' AND o.ucc = @ucc';             request.input('ucc',       sql.VarChar, ucc.trim()); }
        if (exchange) { query += ' AND o.exchange = @exchange';   request.input('exchange',  sql.VarChar, exchange.toUpperCase()); }
        if (segment)  { query += ' AND o.segment = @segment';    request.input('segment',   sql.VarChar, segment.toUpperCase()); }
        if (status)   { query += ' AND o.status = @status';      request.input('status',    sql.VarChar, status); }
        if (placed_by){ query += ' AND o.placed_by = @placedBy'; request.input('placedBy',  sql.VarChar, placed_by.toUpperCase()); }
        if (date_from){ query += ' AND CAST(o.placed_at AS DATE) >= @date_from'; request.input('date_from', sql.Date, date_from); }
        if (date_to)  { query += ' AND CAST(o.placed_at AS DATE) <= @date_to';   request.input('date_to',   sql.Date, date_to); }
        query += ' ORDER BY o.placed_at DESC';
        const result = await request.query(query);
        return res.json({ success: true, orders: result.recordset, count: result.recordset.length });
    } catch (err) {
        console.error('Get orders error:', err);
        return res.status(500).json({ error: 'Failed to fetch orders.' });
    }
});

// Update order status
router.post('/orders/update-status', adminAuthenticate, async (req, res) => {
    const { order_id, status, trade_price } = req.body;
    if (!order_id || !status) return res.status(400).json({ error: 'order_id and status required.' });
    try {
        const pool = await getConnection();
        await pool.request()
            .input('orderId',    sql.VarChar,  order_id)
            .input('status',     sql.VarChar,  status)
            .input('tradePrice', sql.Decimal,  trade_price || null)
            .input('tradedAt',   sql.DateTime, status === 'ORDER_TRADED' ? new Date() : null)
            .query(`UPDATE squareoff_orders SET
                status = @status,
                trade_price = CASE WHEN @tradePrice IS NOT NULL THEN @tradePrice ELSE trade_price END,
                traded_at   = CASE WHEN @tradedAt   IS NOT NULL THEN @tradedAt   ELSE traded_at   END
                WHERE order_id = @orderId`);
        return res.json({ success: true, message: 'Status updated.' });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to update status.' });
    }
});

// Mark file as generated for selected orders
router.post('/orders/mark-file-generated', adminAuthenticate, blockDealerAdmin, async (req, res) => {
    const { order_ids } = req.body;
    if (!order_ids || !order_ids.length) return res.status(400).json({ error: 'No orders selected.' });
    try {
        const pool   = await getConnection();
        const idList = order_ids.map(id => `'${id}'`).join(',');
        await pool.request().query(`
            UPDATE squareoff_orders
            SET file_generated = 1, file_generated_at = GETDATE(), status = 'FILE_GENERATED'
            WHERE order_id IN (${idList}) AND status = 'ORDER_RECEIVED'
        `);
        return res.json({ success: true, message: 'Marked as file generated.' });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to update.' });
    }
});

// Generate exchange basket file for selected orders
router.post('/orders/generate-file', adminAuthenticate, blockDealerAdmin, async (req, res) => {
    const { order_ids, exchange } = req.body;
    if (!order_ids || !order_ids.length) return res.status(400).json({ error: 'No orders selected.' });
    try {
        const pool   = await getConnection();
        const idList = order_ids.map(id => `'${id}'`).join(',');
        const result = await pool.request().query(`
            SELECT o.*, c.client_name
            FROM squareoff_orders o
            LEFT JOIN clients c ON o.ucc = c.ucc
            WHERE o.order_id IN (${idList})
            ORDER BY o.placed_at
        `);
        const orders = result.recordset;
        let csvRows  = [];
        let filename = '';

        if (exchange === 'NSE') {
            // Live lot sizes from lot_size_master - replaces the old hardcoded
            // LOT_SIZES map. Same table the Python DropCopy sync service keeps
            // current automatically; see getLotSize() above for why this matters.
            const lotResult = await pool.request()
                .input('exchange', sql.VarChar(10), 'NSE')
                .query(`SELECT symbol, lot_size FROM lot_size_master WHERE exchange = @exchange AND lot_size > 1`);
            const lotSizeMap = {};
            lotResult.recordset.forEach(r => { lotSizeMap[r.symbol.toUpperCase()] = r.lot_size; });

            const cmOrders = orders.filter(o => o.segment === 'CM');
            const foOrders = orders.filter(o => o.segment === 'FO');

            if (cmOrders.length > 0 && foOrders.length === 0) {
                filename = basketFilename('BasketCM');
                cmOrders.forEach((o, i) => {
                    csvRows.push(makeNeatCMRow(i + 1, o.side, o.symbol, o.quantity, o.ucc, '07708'));
                });
            } else if (foOrders.length > 0 && cmOrders.length === 0) {
                filename = basketFilename('BasketFO');
                foOrders.forEach((o, i) => {
                    csvRows.push(makeNeatFORow(i + 1, o.side, o.symbol, o.expiry_date, o.strike_price, o.option_type, o.quantity, o.ucc, '07708', getLotSize(o.symbol, lotSizeMap)));
                });
            } else {
                // Mixed CM+FO — separate into two files; send CM as primary download
                filename = basketFilename('BasketCM');
                let serial = 1;
                cmOrders.forEach(o => {
                    csvRows.push(makeNeatCMRow(serial++, o.side, o.symbol, o.quantity, o.ucc, '07708'));
                });
                // FO rows appended after CM
                foOrders.forEach(o => {
                    csvRows.push(makeNeatFORow(serial++, o.side, o.symbol, o.expiry_date, o.strike_price, o.option_type, o.quantity, o.ucc, '07708', getLotSize(o.symbol, lotSizeMap)));
                });
            }
        } else if (exchange === 'BSE') {
            // BSE BOLT format is plain CSV — confirmed against real BOLT-accepted
            // sample files (BasketCM/BasketFO, CRLF line endings, no header
            // missing, no XLSX). Replaces the old XLSX attempt entirely: that
            // path (via the 'xlsx' package) was throwing and silently falling
            // back to a headerless CSV with blank scrip codes and no filename
            // — this was the actual cause of both the malformed email
            // attachment and the "not valid JSON" download error.
            //
            // Scrip code was also never resolvable before: o.bse_scrip_code is
            // never written when the order is created (see orders.js), and
            // o.bse_code isn't a real column. Resolving it here the same way
            // as orderDownload.js: day_positions (per-contract, live from
            // DropCopy — correct for F&O) first, symbol_master (equity-level)
            // as fallback for CM.
            const cmOrders = orders.filter(o => o.segment === 'CM');
            const foOrders = orders.filter(o => o.segment === 'FO');
            const bseOrders = [...cmOrders, ...foOrders];

            const scripMap = {}; // order_id -> resolved scrip code
            if (bseOrders.length > 0) {
                const scripResult = await pool.request().query(`
                    SELECT so.order_id,
                           dp.bse_scrip_code AS dp_scrip_code,
                           sm.bse_scrip_code AS sm_scrip_code
                    FROM squareoff_orders so
                    LEFT JOIN day_positions dp
                        ON dp.ucc      = so.ucc
                        AND dp.symbol   = so.symbol
                        AND dp.exchange = so.exchange
                        AND dp.segment  = so.segment
                        AND (dp.expiry_date = so.expiry_date OR (dp.expiry_date IS NULL AND so.expiry_date IS NULL))
                        AND (ABS(ISNULL(dp.strike_price,0) - ISNULL(so.strike_price,0)) < 0.01)
                        AND (dp.option_type = so.option_type OR (dp.option_type IS NULL AND so.option_type IS NULL))
                    LEFT JOIN symbol_master sm
                        ON (UPPER(sm.bse_symbol) = so.symbol OR UPPER(sm.nse_symbol) = so.symbol)
                        AND sm.is_active = 1
                    WHERE so.order_id IN (${idList})
                `);
                scripResult.recordset.forEach(r => {
                    scripMap[r.order_id] = r.dp_scrip_code || r.sm_scrip_code || null;
                });
            }

            // Lot sizes for BSE F&O (index options: SENSEX/BANKEX) — same live
            // lot_size_master table NSE already uses, filtered to BSE.
            // squareoff_orders.quantity for the FO segment is stored as
            // NUMBER OF LOTS (proven against real NSE NEAT bulk data — see
            // SqOffOrders.jsx buildFORow Col 17: lot_size x qty). Since
            // orders.js inserts BSE and NSE orders through the exact same
            // code path with no exchange-specific handling, the same
            // convention applies to BSE. Confirmed against the 06Jul2026 BSE
            // OPTION LONG/SHORT sample files: all 181 real accepted rows
            // (117 LONG + 64 SHORT) are exact multiples of the underlying
            // lot size with zero exceptions — GCD of every quantity in both
            // files is 20. BSE CM (equity) needs no such multiplication,
            // matching NSE CM and confirmed by the CM sample files having
            // arbitrary (non-lot-multiple) share counts.
            const bseLotResult = await pool.request()
                .input('exchange', sql.VarChar(10), 'BSE')
                .query(`SELECT symbol, lot_size FROM lot_size_master WHERE exchange = @exchange AND lot_size > 1`);
            const bseLotSizeMap = {};
            bseLotResult.recordset.forEach(r => { bseLotSizeMap[r.symbol.toUpperCase()] = r.lot_size; });

            // Freeze-quantity (slice) splitting for BSE F&O — same
            // slice_qty_master table and splitting behavior already proven
            // for NSE FO. Non-fatal: if slice_qty_master has no row for a
            // symbol (no real freeze-qty data entered for SENSEX/BANKEX
            // yet), every order for that symbol is sent as a single unsplit
            // row exactly as before — this can only change behavior once
            // real freeze-qty data exists, never break anything today.
            let bseSliceQtyMap = {};
            try {
                const sliceResult = await pool.request()
                    .input('exchange', sql.VarChar(10), 'BSE')
                    .query(`SELECT symbol, slice_qty FROM slice_qty_master WHERE exchange = @exchange`);
                sliceResult.recordset.forEach(r => { bseSliceQtyMap[r.symbol.toUpperCase()] = r.slice_qty; });
            } catch (sliceErr) {
                console.error('[BSE BOLT] slice_qty_master lookup failed (non-fatal, no splitting applied):', sliceErr.message);
            }

            const BOLT_HEADER = 'Buy/Sell,Qty,Rev.Qty,Scrip Code,Rate,Short/Client ID,Retention Status,Client Type,Order Type,CP Code,TrgRate';
            const buildBoltLine = (o, totalQty) => [
                o.side.toUpperCase() === 'BUY' ? 'B' : 'S',
                totalQty, totalQty,
                scripMap[o.order_id] || '',
                '', o.ucc, 'EOSESS', 'CLIENT', 'G', '', ''
            ].join(',');

            // Block a segment's whole file if ANY order in it can't resolve a
            // scrip code — never ship a row with a blank code, and never let
            // a resolved sibling silently vanish with no explanation either.
            const bseFiles = [];
            const bseBlocked = [];
            for (const [label, group] of [['CM', cmOrders], ['FO', foOrders]]) {
                if (group.length === 0) continue;
                const unresolved = group.filter(o => !scripMap[o.order_id]);
                if (unresolved.length > 0) {
                    bseBlocked.push(...group.map(o => ({
                        order_id: o.order_id, ucc: o.ucc, symbol: o.symbol, segment: label,
                        reason: scripMap[o.order_id]
                            ? `Blocked because another order in the same BSE ${label} batch has no resolvable scrip code.`
                            : 'No BSE scrip code found in day_positions or symbol_master.'
                    })));
                    continue;
                }
                const lines = [];
                group.forEach(o => {
                    if (label === 'CM') {
                        // Equity — plain share quantity, no lot multiplication, no slicing.
                        lines.push(buildBoltLine(o, o.quantity));
                    } else {
                        // F&O (SENSEX/BANKEX) — o.quantity is lots; multiply by the live
                        // BSE lot size, and split into multiple rows if a freeze-qty
                        // (slice_qty_master) limit is configured for this symbol.
                        const lot    = getLotSize(o.symbol, bseLotSizeMap);
                        const sliceQ = getSliceQty(o.symbol, bseSliceQtyMap);
                        splitQtyBySlice(o.quantity, sliceQ).forEach(chunkLots => {
                            lines.push(buildBoltLine(o, chunkLots * lot));
                        });
                    }
                });
                bseFiles.push({
                    filename: basketFilename(`Basket${label}`),
                    content:  [BOLT_HEADER, ...lines].join('\r\n') + '\r\n',
                    contentType: 'text/csv',
                    orderIds: group.map(o => o.order_id)
                });
            }

            const bseGeneratedIds = bseFiles.flatMap(f => f.orderIds);
            if (bseGeneratedIds.length > 0) {
                const bseGenIdList = bseGeneratedIds.map(id => `'${id}'`).join(',');
                await pool.request().query(`
                    UPDATE squareoff_orders
                    SET file_generated = 1, file_generated_at = GETDATE(), status = 'FILE_GENERATED'
                    WHERE order_id IN (${bseGenIdList}) AND status = 'ORDER_RECEIVED'`);
            }

            // Email whichever files actually generated, with header included —
            // and mention any blocked orders so RMS/admin knows to check them.
            if (bseFiles.length > 0 || bseBlocked.length > 0) {
                try {
                    const transporter = createTransporter();
                    await transporter.sendMail({
                        from: `"Navia RMS" <${process.env.SMTP_FROM || 'updates@navia.co.in'}>`,
                        to: process.env.ADMIN_ALERT_EMAIL || 'support@navia.co.in',
                        subject: `[NAVIA BACKUP] Sq-Off File Generated — BSE — ${bseGeneratedIds.length} Orders`,
                        html: `<div style="font-family:Arial,sans-serif">
                            <h3>Navia Backup — Sq-Off Basket File</h3>
                            <p>Exchange: <strong>BSE</strong> | Orders: <strong>${bseGeneratedIds.length}</strong> | Generated: ${new Date().toLocaleString('en-IN')}</p>
                            ${bseFiles.map(f => `<p>File attached: <code>${f.filename}</code></p>`).join('')}
                            ${bseBlocked.length > 0 ? `<p style="color:#dc2626">${bseBlocked.length} order(s) blocked — no resolvable BSE scrip code: ${bseBlocked.map(b => b.symbol).join(', ')}</p>` : ''}
                            <p style="color:#dc2626;font-size:12px">Upload this file directly to the BSE terminal. Do not modify.</p>
                        </div>`,
                        attachments: bseFiles.map(f => ({ filename: f.filename, content: f.content, contentType: f.contentType }))
                    });
                } catch (emailErr) {
                    console.error('Admin alert email error:', emailErr.message);
                }
            }

            if (bseFiles.length === 0) {
                return res.status(422).json({
                    error: 'Could not resolve BSE scrip code for the selected order(s). No file generated.',
                    blocked: bseBlocked
                });
            }

            return res.json({
                success: true,
                files: bseFiles.map(f => ({
                    filename: f.filename,
                    contentType: f.contentType,
                    content: Buffer.from(f.content).toString('base64')
                })),
                ...(bseBlocked.length > 0 ? { blocked: bseBlocked } : {})
            });
        } else if (exchange === 'MCX') {
            filename = basketFilename('BasketMCX');
            orders.forEach((o, i) => {
                csvRows.push(makeMCXRow(i + 1, o.side, o.symbol, o.expiry_date, o.quantity, o.ucc, '45345'));
            });
        } else {
            // Generic report (record-keeping only — not for terminal upload)
            filename = `SQOFF_REPORT_${new Date().toISOString().slice(0,10)}.csv`;
            csvRows.push(['UCC','ClientName','PlacedOn','Symbol','Exchange','Segment','ExpiryDate','StrikePrice','OptionType','B/S','Qty','Status','PlacedBy','FileGenerated'].join(','));
            orders.forEach(o => {
                csvRows.push([
                    o.ucc, o.client_name||'',
                    new Date(o.placed_at).toLocaleDateString('en-IN'),
                    o.symbol, o.exchange, o.segment,
                    o.expiry_date ? new Date(o.expiry_date).toLocaleDateString('en-IN') : '',
                    o.strike_price||'', o.option_type||'',
                    o.side, o.quantity, o.status, o.placed_by||'CLIENT',
                    o.file_generated ? 'YES' : 'NO'
                ].join(','));
            });
        }

        const csvContent = csvRows.join('\n');

        // Mark orders as file generated
        await pool.request().query(`
            UPDATE squareoff_orders
            SET file_generated = 1, file_generated_at = GETDATE(), status = 'FILE_GENERATED'
            WHERE order_id IN (${idList}) AND status = 'ORDER_RECEIVED'
        `);

        // Send admin alert email with file attached
        try {
            const transporter = createTransporter();
            await transporter.sendMail({
                from: `"Navia RMS" <${process.env.SMTP_FROM || 'updates@navia.co.in'}>`,
                to: process.env.ADMIN_ALERT_EMAIL || 'support@navia.co.in',
                subject: `[NAVIA BACKUP] Sq-Off File Generated — ${exchange} — ${orders.length} Orders`,
                html: `<div style="font-family:Arial,sans-serif">
                    <h3>Navia Backup — Sq-Off Basket File</h3>
                    <p>Exchange: <strong>${exchange}</strong> | Orders: <strong>${orders.length}</strong> | Generated: ${new Date().toLocaleString('en-IN')}</p>
                    <p>File attached: <code>${filename}</code></p>
                    <p style="color:#dc2626;font-size:12px">Upload this file directly to the ${exchange} terminal. Do not modify.</p>
                </div>`,
                attachments: [{ filename, content: csvContent, contentType: 'text/csv' }]
            });
        } catch (emailErr) {
            console.error('Admin alert email error:', emailErr.message);
        }

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(csvContent);

    } catch (err) {
        console.error('Generate file error:', err);
        return res.status(500).json({ error: 'Failed to generate file.' });
    }
});

// Get current NSE lot sizes (for frontend file-generation logic) - reads the
// same lot_size_master table the Python DropCopy sync service keeps current,
// so the frontend's NEAT FO basket builder no longer needs its own hardcoded
// copy that can silently go stale (see NIFTY 75->65 incident).
router.get('/lot-sizes', adminAuthenticate, async (req, res) => {
    try {
        const pool   = await getConnection();
        const result = await pool.request()
            .input('exchange', sql.VarChar(10), 'NSE')
            .query(`SELECT symbol, lot_size FROM lot_size_master WHERE exchange = @exchange AND lot_size > 1`);
        return res.json({ success: true, lotSizes: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch lot sizes.' });
    }
});

// Get order summary stats
router.get('/orders/stats', adminAuthenticate, async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().query(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status = 'ORDER_RECEIVED' THEN 1 ELSE 0 END) as received,
                SUM(CASE WHEN status = 'FILE_GENERATED' THEN 1 ELSE 0 END) as file_generated,
                SUM(CASE WHEN status = 'ORDER_TRADED'   THEN 1 ELSE 0 END) as traded,
                SUM(CASE WHEN CAST(placed_at AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) as today
            FROM squareoff_orders
        `);
        return res.json({ success: true, stats: result.recordset[0] });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch stats.' });
    }
});

// Create new dealer
router.post('/dealers/create', adminAuthenticate, async (req, res) => {
    const { dealer_id, full_name, email, mobile } = req.body;
    if (!dealer_id || !full_name || !email) return res.status(400).json({ error: 'Dealer ID, name and email are required.' });
    try {
        const pool = await getConnection();
        await pool.request()
            .input('dealerId',  sql.VarChar(10),  dealer_id.toUpperCase().trim())
            .input('fullName',  sql.VarChar(200), full_name.trim())
            .input('email',     sql.VarChar(100), email.trim())
            .input('mobile',    sql.VarChar(15),  mobile || null)
            .input('createdBy', sql.Int,          req.admin.adminId)
            .query(`INSERT INTO dealers (dealer_id, full_name, email, mobile, is_active, created_by)
                    VALUES (@dealerId, @fullName, @email, @mobile, 1, @createdBy)`);
        return res.json({ success: true, message: `Dealer ${dealer_id} created successfully.` });
    } catch (err) {
        if (err.message.includes('PRIMARY KEY')) return res.status(400).json({ error: `Dealer ID ${dealer_id} already exists.` });
        return res.status(500).json({ error: 'Failed to create dealer.' });
    }
});

// Get all admin users
router.get('/users', adminAuthenticate, async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request()
            .query('SELECT admin_id, username, email, full_name, role, is_active, created_at, last_login FROM admin_users ORDER BY admin_id');
        return res.json({ success: true, users: result.recordset });
    } catch (err) { return res.status(500).json({ error: 'Failed to fetch users.' }); }
});

// Create new admin user
router.post('/users/create', adminAuthenticate, async (req, res) => {
    const { username, email, full_name, role } = req.body;
    if (!username || !email || !full_name) return res.status(400).json({ error: 'Username, email and full name are required.' });
    try {
        const pool = await getConnection();
        await pool.request()
            .input('username', sql.VarChar(50),  username.toLowerCase().trim())
            .input('email',    sql.VarChar(100), email.trim())
            .input('fullName', sql.VarChar(200), full_name.trim())
            .input('role',     sql.VarChar(20),  role || 'SUBUSER')
            .query(`INSERT INTO admin_users (username, email, full_name, role, is_active) VALUES (@username, @email, @fullName, @role, 1)`);
        return res.json({ success: true, message: `User ${username} created successfully.` });
    } catch (err) {
        if (err.message.includes('UNIQUE') || err.message.includes('unique')) return res.status(400).json({ error: `Username "${username}" already exists.` });
        return res.status(500).json({ error: 'Failed to create user.' });
    }
});

// Toggle admin user status
router.post('/users/toggle', adminAuthenticate, async (req, res) => {
    const { admin_id, is_active } = req.body;
    try {
        const pool = await getConnection();
        await pool.request()
            .input('adminId',  sql.Int, admin_id)
            .input('isActive', sql.Bit, is_active ? 1 : 0)
            .query('UPDATE admin_users SET is_active = @isActive WHERE admin_id = @adminId');
        return res.json({ success: true });
    } catch (err) { return res.status(500).json({ error: 'Failed to update user.' }); }
});

// Get all dealers
router.get('/dealers', adminAuthenticate, async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().query('SELECT * FROM dealers ORDER BY dealer_id');
        return res.json({ success: true, dealers: result.recordset });
    } catch (err) { return res.status(500).json({ error: 'Failed to fetch dealers.' }); }
});

// Toggle dealer status
router.post('/dealers/toggle', adminAuthenticate, async (req, res) => {
    const { dealer_id, is_active } = req.body;
    try {
        const pool = await getConnection();
        await pool.request()
            .input('dealerId', sql.VarChar(10), dealer_id)
            .input('isActive', sql.Bit, is_active ? 1 : 0)
            .query('UPDATE dealers SET is_active = @isActive WHERE dealer_id = @dealerId');
        return res.json({ success: true });
    } catch (err) { return res.status(500).json({ error: 'Failed to update dealer.' }); }
});

// Get dealer logs
router.get('/dealer-logs', adminAuthenticate, async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().query('SELECT * FROM dealer_logs ORDER BY created_at DESC');
        return res.json({ success: true, logs: result.recordset });
    } catch (err) { return res.status(500).json({ error: 'Failed to fetch dealer logs.' }); }
});

// ══════════════════════════════════════════════════════════════════════════
// CDD Sq.off Report — production-rollout restriction gate (2026-08-14)
// ══════════════════════════════════════════════════════════════════════════
// A second, independent gate layered on top of the existing segment_controls
// check in orders.js (/squareoff) and dealerAuth.js (/place-squareoff).
// When cdd_sqoff_control.is_enabled = 1, a square-off is only allowed for
// UCCs present in cdd_sqoff_whitelist -- everyone else gets the exact same
// denial they'd see for a disabled segment. Does not touch segment_controls,
// or any of its existing routes/UI, in any way. Same adminAuthenticate /
// blockDealerAdmin restriction level as this file's other write routes --
// read-only GETs are adminAuthenticate only, writes add blockDealerAdmin.

// Get current restriction toggle state
router.get('/cdd-sqoff/control', adminAuthenticate, async (req, res) => {
    try {
        const pool   = await getConnection();
        const result = await pool.request().query(`SELECT TOP 1 is_enabled, updated_at FROM cdd_sqoff_control`);
        return res.json({ success: true, control: result.recordset[0] || { is_enabled: false, updated_at: null } });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch CDD Sq.off control state.' });
    }
});

// Toggle the restriction on/off
router.post('/cdd-sqoff/control', adminAuthenticate, blockDealerAdmin, async (req, res) => {
    const { is_enabled } = req.body;
    if (typeof is_enabled !== 'boolean') return res.status(400).json({ error: 'is_enabled (boolean) is required.' });
    try {
        const pool = await getConnection();
        await pool.request()
            .input('isEnabled', sql.Bit, is_enabled ? 1 : 0)
            .input('adminId',   sql.Int, req.admin.adminId)
            .query(`UPDATE cdd_sqoff_control
                    SET is_enabled = @isEnabled, updated_by = @adminId, updated_at = GETDATE()
                    WHERE id = 1`);

        // Audit log — same admin_logs table used elsewhere in this codebase;
        // wrapped so a logging failure can never take down the actual
        // toggle, which has already succeeded by this point.
        try {
            await pool.request()
                .input('adminId', sql.Int,          req.admin.adminId)
                .input('action',  sql.VarChar(100), 'CDD_SQOFF_CONTROL_TOGGLED')
                .input('details', sql.VarChar(500), `CDD Sq.off restriction set to ${is_enabled ? 'ON' : 'OFF'} by admin ${req.admin.adminId}`)
                .query(`INSERT INTO admin_logs (admin_id, action, details, created_at) VALUES (@adminId, @action, @details, GETDATE())`);
        } catch (logErr) {
            console.error('[CDD Sq.off] admin_logs write failed (non-fatal):', logErr.message);
        }

        return res.json({ success: true, message: `CDD Sq.off restriction turned ${is_enabled ? 'ON' : 'OFF'}.` });
    } catch (err) {
        console.error('CDD Sq.off control toggle error:', err);
        return res.status(500).json({ error: 'Failed to update CDD Sq.off control state.' });
    }
});

// List whitelisted UCCs
// FIX (2026-08-14): the live cdd_sqoff_whitelist table was created from an
// earlier draft schema (added_by VARCHAR, no admin_id FK) rather than the
// FK-based design this route was originally written against -- confirmed via
// INFORMATION_SCHEMA.COLUMNS against the real table. added_by already stores
// the admin's username directly as text, so no JOIN to admin_users is needed
// here at all.
router.get('/cdd-sqoff/whitelist', adminAuthenticate, async (req, res) => {
    try {
        const pool   = await getConnection();
        const result = await pool.request().query(`
            SELECT w.id, w.ucc, c.client_name, w.added_at, w.added_by AS added_by_username
            FROM cdd_sqoff_whitelist w
            LEFT JOIN clients c ON w.ucc = c.ucc
            ORDER BY w.added_at DESC
        `);
        return res.json({ success: true, whitelist: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch CDD Sq.off whitelist.' });
    }
});

// Add a UCC to the whitelist
router.post('/cdd-sqoff/whitelist', adminAuthenticate, blockDealerAdmin, async (req, res) => {
    const { ucc } = req.body;
    if (!ucc || !ucc.trim()) return res.status(400).json({ error: 'UCC is required.' });
    const uccTrimmed = ucc.trim();
    try {
        const pool = await getConnection();

        const clientCheck = await pool.request()
            .input('ucc', sql.VarChar(20), uccTrimmed)
            .query(`SELECT ucc, client_name FROM clients WHERE ucc = @ucc`);
        if (clientCheck.recordset.length === 0) {
            return res.status(404).json({ error: `UCC ${uccTrimmed} not found in clients.` });
        }

        // Resolve the logged-in admin's username from admin_id -- req.admin.adminId
        // is the one field already confirmed working (used successfully by the
        // /cdd-sqoff/control route above). Looking the username up here, rather
        // than trusting a possibly-absent req.admin.username, keeps this route
        // correct regardless of exactly what adminAuthenticate puts on req.admin.
        const adminRes = await pool.request()
            .input('adminId', sql.Int, req.admin.adminId)
            .query(`SELECT username FROM admin_users WHERE admin_id = @adminId`);
        const addedByUsername = adminRes.recordset[0]?.username || `admin_${req.admin.adminId}`;

        await pool.request()
            .input('ucc',     sql.VarChar(20), uccTrimmed)
            .input('addedBy', sql.VarChar(50), addedByUsername)
            .query(`INSERT INTO cdd_sqoff_whitelist (ucc, added_by, added_at)
                    VALUES (@ucc, @addedBy, GETDATE())`);

        return res.json({ success: true, message: `UCC ${uccTrimmed} added to CDD Sq.off whitelist.` });
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: `UCC ${uccTrimmed} is already whitelisted.` });
        }
        console.error('CDD Sq.off whitelist add error:', err);
        return res.status(500).json({ error: 'Failed to add UCC to whitelist.' });
    }
});

// Remove a UCC from the whitelist
router.delete('/cdd-sqoff/whitelist/:ucc', adminAuthenticate, blockDealerAdmin, async (req, res) => {
    const uccTrimmed = (req.params.ucc || '').trim();
    if (!uccTrimmed) return res.status(400).json({ error: 'UCC is required.' });
    try {
        const pool = await getConnection();
        await pool.request()
            .input('ucc', sql.VarChar(20), uccTrimmed)
            .query(`DELETE FROM cdd_sqoff_whitelist WHERE ucc = @ucc`);
        return res.json({ success: true, message: `UCC ${uccTrimmed} removed from CDD Sq.off whitelist.` });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to remove UCC from whitelist.' });
    }
});

module.exports = router;