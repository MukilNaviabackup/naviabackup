const express = require('express');
const router = express.Router();
const { getConnection, sql } = require('../config/database');
const { adminAuthenticate } = require('../middleware/adminAuthenticate');
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
// same one the Python DropCopy sync service already keeps up to date via
// /api/dropcopy/refresh-lots after every successful sync - so this can't
// drift out of sync again for any symbol, not just NIFTY.
// lotSizeMap is built once per request from lot_size_master (see /orders/
// generate-file below) and passed in here rather than queried per-row.
function getLotSize(symbol, lotSizeMap) {
    if (!symbol) return 1;
    const base = symbol.toUpperCase().trim().split(/[\s@0-9]/)[0];
    return (lotSizeMap && lotSizeMap[base]) || 1;
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
                o.file_generated, o.file_generated_at, o.alert_sent
            FROM squareoff_orders o
            LEFT JOIN clients c ON o.ucc = c.ucc
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
router.post('/orders/mark-file-generated', adminAuthenticate, async (req, res) => {
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
router.post('/orders/generate-file', adminAuthenticate, async (req, res) => {
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
            console.log('[LOTSIZE DEBUG] lotSizeMap:', JSON.stringify(lotSizeMap));

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
            // BSE BOLT format is XLSX (Excel), not CSV
            const cmOrders = orders.filter(o => o.segment === 'CM');
            const foOrders = orders.filter(o => o.segment === 'FO');

            // BOLT headers (11 columns)
            const boltHeaders = ['Buy/Sell','Qty','Rev.Qty','Scrip Code','Rate',
                                  'Short/Client ID','Retention Status','Client Type',
                                  'Order Type','CP Code','TrgRate'];

            // Build rows for CM + FO combined
            const boltRows = [boltHeaders];
            cmOrders.forEach(o => {
                const side    = o.side.toUpperCase() === 'BUY' ? 'B' : 'S';
                const scrip   = o.bse_scrip_code || o.bse_code || '';
                if (!scrip) {
                    console.warn(`[BSE BOLT] No scrip code for order ${o.order_id} ${o.symbol}`);
                }
                boltRows.push([side, o.quantity, o.quantity, scrip, '',
                               o.ucc, 'EOSESS', 'CLIENT', 'G', '', '']);
            });
            foOrders.forEach(o => {
                const side  = o.side.toUpperCase() === 'BUY' ? 'B' : 'S';
                const scrip = o.bse_scrip_code || o.bse_code || '';
                if (!scrip) {
                    console.warn(`[BSE BOLT] No scrip code for FO order ${o.order_id} ${o.symbol}`);
                }
                boltRows.push([side, o.quantity, o.quantity, scrip, '',
                               o.ucc, 'EOSESS', 'CLIENT', 'G', '', '']);
            });

            // Generate XLSX file
            try {
                const XLSX = require('xlsx');
                const ws   = XLSX.utils.aoa_to_sheet(boltRows);
                const wb   = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, 'BOLT');
                const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
                filename = basketFilename('BasketBSE').replace('.csv', '.xlsx');

                // Mark orders as file generated (before sending)
                await pool.request().query(`
                    UPDATE squareoff_orders
                    SET file_generated = 1, file_generated_at = GETDATE(), status = 'FILE_GENERATED'
                    WHERE order_id IN (${idList}) AND status = 'ORDER_RECEIVED'`);

                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
                return res.send(xlsxBuffer);
            } catch (xlsxErr) {
                console.error('[BSE BOLT] XLSX generation error:', xlsxErr.message);
                // Fallback: send as CSV if xlsx fails
                cmOrders.concat(foOrders).forEach(o => {
                    const side  = o.side.toUpperCase() === 'BUY' ? 'B' : 'S';
                    const scrip = o.bse_scrip_code || o.bse_code || '';
                    csvRows.push([side, o.quantity, o.quantity, scrip, '',
                                  o.ucc, 'EOSESS', 'CLIENT', 'G', '', ''].join(','));
                });
            }
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

module.exports = router;