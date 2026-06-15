'use strict';
const express = require('express');
const router  = express.Router();
const { getConnection, sql } = require('../config/database');
const { adminAuthenticate }  = require('../middleware/adminAuthenticate');
const ExcelJS = require('exceljs');
require('dotenv').config();

const BROKER_ID = '07708';
const BSE_BROKER_ID = '6341';

// ── Date format helpers ───────────────────────────────────────────────────────
function formatDateNEAT(dateStr) {
    // Output: 02JUN2026
    if (!dateStr) return '';
    const d      = new Date(dateStr);
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const dd     = String(d.getDate()).padStart(2, '0');
    const mmm    = months[d.getMonth()];
    const yyyy   = d.getFullYear();
    return dd + mmm + yyyy;
}

function formatFileDate(date) {
    // Output: 29May2026
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const d  = new Date(date);
    return String(d.getDate()).padStart(2, '0') + months[d.getMonth()] + d.getFullYear();
}

function formatFileTime(date) {
    // Output: 01-07-30
    const d = new Date(date);
    return String(d.getHours()).padStart(2,'0') + '-' +
           String(d.getMinutes()).padStart(2,'0') + '-' +
           String(d.getSeconds()).padStart(2,'0');
}

function padField(val, len) {
    const s = String(val || '');
    return s.padEnd(len, ' ');
}

// ── Extract base symbol from FO symbol string ─────────────────────────────────
function extractBaseSymbol(symbol) {
    if (!symbol) return '';
    // NIFTY24DECFUT → NIFTY
    // BANKNIFTY26MAY54500PE → BANKNIFTY
    const indexSymbols = ['MIDCPNIFTY','BANKNIFTY','FINNIFTY','NIFTY','SENSEX','BANKEX'];
    for (const idx of indexSymbols) {
        if (symbol.toUpperCase().startsWith(idx)) return idx;
    }
    // For stock futures/options — return as is up to first digit
    const match = symbol.match(/^([A-Z]+)/);
    return match ? match[1] : symbol;
}

// ── Extract CM trading symbol from full name ──────────────────────────────────
function extractCMSymbol(symbolStr) {
    // "VODAFONE IDEA LIMITED EQ ; INE669E01016" → "IDEA"
    // Try to get from known mappings or use first word
    if (!symbolStr) return '';
    if (symbolStr.includes(';')) {
        // Has ISIN — extract symbol from name
        const name = symbolStr.split(';')[0].trim();
        // Remove " EQ" suffix
        return name.replace(/ EQ$/, '').replace(/ BE$/, '').trim();
    }
    return symbolStr.trim();
}

// ── Split quantity into slices ────────────────────────────────────────────────
function splitIntoSlices(qty, sliceQty) {
    if (!sliceQty || sliceQty <= 0 || qty <= sliceQty) return [qty];
    const rows = [];
    let remaining = qty;
    while (remaining > 0) {
        const chunk = Math.min(remaining, sliceQty);
        rows.push(chunk);
        remaining -= chunk;
    }
    return rows;
}

// ── Get instrument type for NEAT FO ──────────────────────────────────────────
function getNEATInstrType(symbol, optionType) {
    const base = extractBaseSymbol(symbol).toUpperCase();
    const indexSymbols = ['NIFTY','BANKNIFTY','FINNIFTY','MIDCPNIFTY','SENSEX','BANKEX'];
    const isIndex = indexSymbols.includes(base);
    if (optionType) return isIndex ? 'OPTIDX' : 'OPTSTK';
    return isIndex ? 'FUTIDX' : 'FUTSTK';
}

// ── Get NEAT FO segment flag ──────────────────────────────────────────────────
function getNEATSegment(optionType) {
    return optionType ? 'O' : 'F';
}

// ── Build NEAT CM row ─────────────────────────────────────────────────────────
function buildNEATCMRow(order, qty) {
    const buySell = order.side === 'BUY' ? '1' : '2';
    const symbol  = extractCMSymbol(order.symbol);
    const fields  = [
        padField('1', 13),
        padField(buySell, 2),
        padField('2', 2),
        padField(symbol, 10),
        padField('EQ', 5),
        padField('1', 2),
        padField('', 11),
        padField('', 2),
        padField('', 9),
        padField('MKT', 10),
        padField('', 8),
        padField(qty, 9),
        padField('', 9),
        padField(BROKER_ID, 12),
        padField('2', 2),
        padField(order.ucc, 10),
        padField('', 24),
        padField('', 16),
        padField('', 10),
    ];
    return fields.join(',');
}

// ── Build NEAT FO row ─────────────────────────────────────────────────────────
function buildNEATFORow(order, qty) {
    const buySell  = order.side === 'BUY' ? '1' : '2';
    const baseSymbol = extractBaseSymbol(order.symbol);
    const instrType  = getNEATInstrType(order.symbol, order.option_type);
    const segment    = getNEATSegment(order.option_type);
    const expiry     = formatDateNEAT(order.expiry_date);
    const strike     = order.strike_price ? String(Math.round(order.strike_price)) : '';
    const optType    = order.option_type || '';

    const fields = [
        padField('1', 13),
        padField(segment, 1),
        padField('U', 1),
        padField(buySell, 2),
        padField('0', 2),
        padField('2', 2),
        padField(instrType, 8),
        padField(baseSymbol, 10),
        padField(expiry, 9),
        padField(strike, 10),
        padField(optType, 2),
        padField('1', 2),
        padField('', 11),
        padField('', 2),
        padField('', 9),
        padField('MKT', 10),
        padField('', 10),
        padField(qty, 5),
        padField('', 9),
        padField(BROKER_ID, 12),
        padField('2', 2),
        padField(order.ucc, 10),
        padField('', 24),
        padField('0', 2),
        padField('', 16),
        padField('', 12),
    ];
    return fields.join(',');
}

// ── Build BOLT CM row (for Excel) ─────────────────────────────────────────────
function buildBOLTCMRow(order, qty) {
    return {
        'Buy/Sell':          order.side === 'BUY' ? 'B' : 'S',
        'Qty':               qty,
        'Rev.Qty':           qty,
        'Scrip Code':        order.scrip_code || order.symbol,
        'Rate':              '',
        'Short/Client ID':   order.ucc,
        'Retention Status':  'EOSESS',
        'Client Type':       'CLIENT',
        'Order Type':        'G',
        'CP Code':           '',
        'TrgRate':           ''
    };
}

// ── Build BOLT FO row (for Excel) ─────────────────────────────────────────────
function buildBOLTFORow(order, qty) {
    return {
        'Buy/Sell':          order.side === 'BUY' ? 'B' : 'S',
        'Qty':               qty,
        'Rev.Qty':           qty,
        'Scrip Code':        order.scrip_code || order.symbol,
        'Rate':              '',
        'Short/Client ID':   order.ucc,
        'Retention Status':  'EOSESS',
        'Client Type':       'CLIENT',
        'Order Type':        'G',
        'CP Code':           '',
        'TrgRate':           ''
    };
}

// ── POST /api/admin/orders/download ──────────────────────────────────────────
router.post('/download', adminAuthenticate, async (req, res) => {
    const { order_ids, exchange, segment } = req.body;

    if (!order_ids || !order_ids.length) {
        return res.status(400).json({ error: 'No orders selected.' });
    }

    try {
        const pool = await getConnection();

        // Fetch selected orders
        const idList  = order_ids.map((_, i) => `@id${i}`).join(',');
        const request = pool.request();
        order_ids.forEach((id, i) => request.input(`id${i}`, sql.UniqueIdentifier, id));

        const ordersResult = await request.query(`
            SELECT order_id, ucc, exchange, segment, symbol, quantity,
                   order_type, side, placed_at, expiry_date, strike_price, option_type
            FROM squareoff_orders
            WHERE order_id IN (${idList})
            ORDER BY exchange, segment, placed_at
        `);

        const orders = ordersResult.recordset;
        if (!orders.length) {
            return res.status(404).json({ error: 'No orders found.' });
        }

        // Fetch slice quantities
        const sliceResult = await pool.request().query(`
            SELECT symbol, slice_qty FROM slice_qty_master
        `);
        const sliceMap = {};
        sliceResult.recordset.forEach(r => {
            sliceMap[r.symbol.toUpperCase()] = r.slice_qty;
        });

        // Group orders by exchange+segment
        const nseCM = orders.filter(o => o.exchange === 'NSE' && o.segment === 'CM');
        const nseFO = orders.filter(o => o.exchange === 'NSE' && o.segment === 'FO');
        const bseCM = orders.filter(o => o.exchange === 'BSE' && o.segment === 'CM');
        const bseFO = orders.filter(o => o.exchange === 'BSE' && o.segment === 'FO');

        const now      = new Date();
        const fileDate = formatFileDate(now);
        const fileTime = formatFileTime(now);

        const files = [];

        // ── NEAT NSE CM (txt) ────────────────────────────────────────────────
        if (nseCM.length > 0) {
            const lines = [];
            for (const order of nseCM) {
                const slices = splitIntoSlices(order.quantity, null); // No slicing for CM
                for (const qty of slices) {
                    lines.push(buildNEATCMRow(order, qty));
                }
            }
            files.push({
                filename:    `BasketCM${fileDate}-${fileTime}.txt`,
                content:     lines.join('\r\n'),
                contentType: 'text/plain',
                exchange:    'NSE',
                segment:     'CM'
            });
        }

        // ── NEAT NSE FO (txt) ────────────────────────────────────────────────
        if (nseFO.length > 0) {
            const lines = [];
            for (const order of nseFO) {
                const baseSymbol = extractBaseSymbol(order.symbol);
                const sliceQty   = sliceMap[baseSymbol.toUpperCase()] || null;
                const slices     = splitIntoSlices(order.quantity, sliceQty);
                for (const qty of slices) {
                    lines.push(buildNEATFORow(order, qty));
                }
            }
            files.push({
                filename:    `BasketFO${fileDate}-${fileTime}.txt`,
                content:     lines.join('\r\n'),
                contentType: 'text/plain',
                exchange:    'NSE',
                segment:     'FO'
            });
        }

        // ── BOLT BSE CM (xlsx) ───────────────────────────────────────────────
        if (bseCM.length > 0) {
            const workbook  = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Orders');
            worksheet.columns = [
                { header: 'Buy/Sell',         key: 'Buy/Sell',         width: 10 },
                { header: 'Qty',              key: 'Qty',              width: 8  },
                { header: 'Rev.Qty',          key: 'Rev.Qty',          width: 8  },
                { header: 'Scrip Code',       key: 'Scrip Code',       width: 12 },
                { header: 'Rate',             key: 'Rate',             width: 8  },
                { header: 'Short/Client ID',  key: 'Short/Client ID',  width: 14 },
                { header: 'Retention Status', key: 'Retention Status', width: 16 },
                { header: 'Client Type',      key: 'Client Type',      width: 12 },
                { header: 'Order Type',       key: 'Order Type',       width: 10 },
                { header: 'CP Code',          key: 'CP Code',          width: 10 },
                { header: 'TrgRate',          key: 'TrgRate',          width: 8  },
            ];

            for (const order of bseCM) {
                const slices = splitIntoSlices(order.quantity, null);
                for (const qty of slices) {
                    worksheet.addRow(buildBOLTCMRow(order, qty));
                }
            }

            const buffer = await workbook.xlsx.writeBuffer();
            files.push({
                filename:    `BasketCM${fileDate}-${fileTime}.xlsx`,
                content:     buffer,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                exchange:    'BSE',
                segment:     'CM'
            });
        }

        // ── BOLT BSE FO (xlsx) ───────────────────────────────────────────────
        if (bseFO.length > 0) {
            const workbook  = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Orders');
            worksheet.columns = [
                { header: 'Buy/Sell',         key: 'Buy/Sell',         width: 10 },
                { header: 'Qty',              key: 'Qty',              width: 8  },
                { header: 'Rev.Qty',          key: 'Rev.Qty',          width: 8  },
                { header: 'Scrip Code',       key: 'Scrip Code',       width: 12 },
                { header: 'Rate',             key: 'Rate',             width: 8  },
                { header: 'Short/Client ID',  key: 'Short/Client ID',  width: 14 },
                { header: 'Retention Status', key: 'Retention Status', width: 16 },
                { header: 'Client Type',      key: 'Client Type',      width: 12 },
                { header: 'Order Type',       key: 'Order Type',       width: 10 },
                { header: 'CP Code',          key: 'CP Code',          width: 10 },
                { header: 'TrgRate',          key: 'TrgRate',          width: 8  },
            ];

            for (const order of bseFO) {
                const baseSymbol = extractBaseSymbol(order.symbol);
                const sliceQty   = sliceMap[baseSymbol.toUpperCase()] || null;
                const slices     = splitIntoSlices(order.quantity, sliceQty);
                for (const qty of slices) {
                    worksheet.addRow(buildBOLTFORow(order, qty));
                }
            }

            const buffer = await workbook.xlsx.writeBuffer();
            files.push({
                filename:    `BasketFO${fileDate}-${fileTime}.xlsx`,
                content:     buffer,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                exchange:    'BSE',
                segment:     'FO'
            });
        }

        // ── Mark orders as file generated ────────────────────────────────────
        const updateRequest = pool.request();
        order_ids.forEach((id, i) => updateRequest.input(`id${i}`, sql.UniqueIdentifier, id));
        await updateRequest.query(`
            UPDATE squareoff_orders
            SET file_generated    = 1,
                file_generated_at = GETDATE()
            WHERE order_id IN (${idList})
        `);

        // ── Return file info for frontend to download ─────────────────────────
        if (files.length === 1) {
            const file = files[0];
            res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
            res.setHeader('Content-Type', file.contentType);
            return res.send(file.content);
        }

        // Multiple files — return as JSON with base64
        const responseFiles = files.map(f => ({
            filename:    f.filename,
            contentType: f.contentType,
            exchange:    f.exchange,
            segment:     f.segment,
            content:     Buffer.isBuffer(f.content)
                ? f.content.toString('base64')
                : Buffer.from(f.content).toString('base64')
        }));

        return res.json({ success: true, files: responseFiles });

    } catch (err) {
        console.error('[OrderDownload] Error:', err.message);
        return res.status(500).json({ error: 'Failed to generate file: ' + err.message });
    }
});

module.exports = router;

// POST /api/admin/orders/mark-generated
router.post('/mark-generated', adminAuthenticate, async (req, res) => {
    const { order_ids } = req.body;
    if (!order_ids?.length) return res.status(400).json({ error: 'No orders provided.' });
    try {
        const pool    = await getConnection();
        const idList  = order_ids.map((_, i) => `@id${i}`).join(',');
        const request = pool.request();
        order_ids.forEach((id, i) => request.input(`id${i}`, sql.UniqueIdentifier, id));
        await request.query(`
            UPDATE squareoff_orders
            SET file_generated    = 1,
                file_generated_at = GETDATE(),
                status            = 'FILE_GENERATED'
            WHERE order_id IN (${idList})
        `);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});