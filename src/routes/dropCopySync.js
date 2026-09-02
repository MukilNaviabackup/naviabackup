'use strict';
const express      = require('express');
const router       = express.Router();
const { getConnection, sql } = require('../config/database');
const authenticate           = require('../middleware/authenticate');
require('dotenv').config();
function validateSyncKey(req, res, next) {
    const key = req.headers['x-sync-key'] || req.body?.sync_key;
    if (!key || key !== process.env.SYNC_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized sync request.' });
    }
    next();
}

// 2026-08-28 fix: every Decimal column in the TVP below is Decimal(10,4) --
// max 6 integer digits (up to 999999.9999). Root-caused via improved error
// logging on the BSE CM feed: one row's avg_sell_price (sell_value /
// sell_qty) came out far larger than that, almost certainly from an
// abnormally tiny sell_qty for that specific position -- and because a TVP
// insert is all-or-nothing, that ONE bad row failed the entire batch of
// 90-130 otherwise-good BSE CM positions, three times in a row (matching
// the "HTTP 500 after 3 attempts" alert email). This guard nulls out any
// value that wouldn't fit the column rather than letting the whole batch
// fail, and logs which position triggered it so the underlying data
// anomaly can still be investigated -- it does not change any value that
// was already going to be valid, so existing good rows behave identically
// to before.
const MAX_DECIMAL_10_4 = 999999.9999;
function sanitizeDecimal10_4(value, context) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || Math.abs(n) > MAX_DECIMAL_10_4) {
        console.warn(`[DropCopy] Out-of-range decimal value dropped (${context.field}=${value}) for ucc=${context.ucc} symbol=${context.symbol} -- nulled to avoid failing the whole batch. Investigate source data.`);
        return null;
    }
    return n;
}

router.post('/sync', validateSyncKey, async (req, res) => {
    const { trades, positions: preAggPositions, trade_date, exchange, segment, file_source } = req.body;
    const hasPositions = preAggPositions && Array.isArray(preAggPositions) && preAggPositions.length > 0;
    const hasTrades    = trades && Array.isArray(trades) && trades.length > 0;
    if (!hasPositions && !hasTrades) {
        return res.status(400).json({ error: 'No trades or positions provided.' });
    }
    if (!trade_date || !exchange || !segment) {
        return res.status(400).json({ error: 'trade_date, exchange and segment are required.' });
    }
    try {
        const pool      = await getConnection();
        let   positions = [];
        if (hasPositions) {
            positions = preAggPositions;
        } else {
            // ── DropCopy duplicate-trade guard ────────────────────────────────
            // Some BSE DropCopy files report the exact same trade twice (confirmed
            // against real 06-Jul-2026 Trade_BSE_CM/FO files: every duplicate pair
            // shares ClntId + TradQty + UnqTradIdr + OrdrRef with zero exceptions
            // across 6,472 checked rows; UnqTradIdr alone is NOT safe to dedupe on
            // since it collides across unrelated trades, and exact TradDtTm is NOT
            // safe to require either, since resends can arrive seconds to hours
            // later with a bumped timestamp). Without a code change here, every
            // resent trade silently doubles buy_qty/sell_qty/net_qty in
            // day_positions - this was the root cause of a client's 1-share order
            // showing as 2 in Navia Backup.
            //
            // If the upstream caller forwards the exchange's own trade identifiers
            // (unq_trad_idr/unqTradIdr/UnqTradIdr and ordr_ref/ordrRef/OrdrRef),
            // dedupe using the exact verified key. If it does not forward them
            // (current payload shape has no such fields), fall back to an exact
            // full-tuple match on every field this endpoint already receives -
            // still a safe backstop, since a genuine DropCopy resend reproduces
            // every field identically, and two independent real fills sharing
            // identical ucc+symbol+side+qty+price+contract-details within one
            // sync batch is not a realistic scenario for this platform.
            const seenTradeKeys = new Set();
            let duplicatesSkipped = 0;
            const positionMap = new Map();
            for (const trade of trades) {
                const { ucc, symbol, isin, company_name, instrument_type,
                        expiry_date, strike_price, option_type,
                        side, quantity, price, lot_size,
                        unq_trad_idr, unqTradIdr, UnqTradIdr,
                        ordr_ref, ordrRef, OrdrRef } = trade;
                if (!ucc || !symbol || !side || !quantity) continue;
                const qty = parseFloat(quantity) || 0;
                const px  = parseFloat(price)    || 0;
                const lot = parseInt(lot_size)   || 1;
                if (qty <= 0) continue;
                const tradeUtid = unq_trad_idr || unqTradIdr || UnqTradIdr || null;
                const tradeOref = ordr_ref     || ordrRef     || OrdrRef     || null;
                // FIX (07-Jul-2026): include symbol in the UTID-branch key too --
                // a multi-scrip BSE basket square-off can report the same
                // UnqTradIdr+OrdrRef across different symbols in the same basket
                // (all legs execute together), which the old key wrongly treated
                // as a duplicate and dropped. Confirmed against a real BSE CM file
                // where UCC 59784853's POWERGRID and BEL SELL legs shared the same
                // UnqTradIdr/OrdrRef -- BEL's leg was silently discarded before this fix.
                const dedupeKey = (tradeUtid && tradeOref)
                    ? `UTID|${ucc}|${symbol.trim()}|${quantity}|${tradeUtid}|${tradeOref}`
                    : `FULL|${ucc}|${symbol.trim()}|${expiry_date||''}|${strike_price||''}|${option_type||''}|${side.toUpperCase()}|${quantity}|${price}`;
                if (seenTradeKeys.has(dedupeKey)) {
                    duplicatesSkipped++;
                    continue;
                }
                seenTradeKeys.add(dedupeKey);
                const lotQty = lot > 0 ? qty / lot : qty;
                const isBuy  = side.toUpperCase() === 'B';
                const key    = `${ucc}|${symbol.trim()}|${expiry_date||''}|${strike_price||''}|${option_type||''}`;
                if (!positionMap.has(key)) {
                    positionMap.set(key, {
                        ucc:             ucc.toString().substring(0, 20),
                        symbol:          symbol.trim().substring(0, 50),
                        isin:            (isin || '').trim().substring(0, 20),
                        company_name:    (company_name || '').trim().substring(0, 200),
                        instrument_type: (instrument_type || 'EQUITY').substring(0, 20),
                        expiry_date:     expiry_date || null,
                        strike_price:    strike_price ? parseFloat(strike_price) : null,
                        option_type:     option_type || null,
                        lot_size:        lot,
                        buy_qty: 0, sell_qty: 0, buy_value: 0, sell_value: 0
                    });
                }
                const pos = positionMap.get(key);
                if (isBuy) { pos.buy_qty += lotQty; pos.buy_value += lotQty * px; }
                else        { pos.sell_qty += lotQty; pos.sell_value += lotQty * px; }
            }
            if (duplicatesSkipped > 0) {
                console.log(`[DropCopy] Skipped ${duplicatesSkipped} duplicate trade row(s) (exact repeat within this sync batch)`);
            }
            for (const pos of positionMap.values()) {
                positions.push({
                    ucc:             pos.ucc,
                    symbol:          pos.symbol,
                    isin:            pos.isin,
                    company_name:    pos.company_name,
                    instrument_type: pos.instrument_type,
                    expiry_date:     pos.expiry_date,
                    strike_price:    pos.strike_price,
                    option_type:     pos.option_type,
                    lot_size:        pos.lot_size,
                    buy_qty:         pos.buy_qty,
                    sell_qty:        pos.sell_qty,
                    net_qty:         pos.buy_qty - pos.sell_qty,
                    avg_buy_price:   pos.buy_qty  > 0 ? pos.buy_value  / pos.buy_qty  : null,
                    avg_sell_price:  pos.sell_qty > 0 ? pos.sell_value / pos.sell_qty : null
                });
            }
        }
        // ── Build TVP — now includes isin + company_name ──────────────────────
        const tvp = new sql.Table();
        tvp.columns.add('ucc',             sql.VarChar(20));
        tvp.columns.add('exchange',        sql.VarChar(10));
        tvp.columns.add('segment',         sql.VarChar(10));
        tvp.columns.add('symbol',          sql.VarChar(50));
        tvp.columns.add('isin',            sql.VarChar(20));
        tvp.columns.add('company_name',    sql.VarChar(200));
        tvp.columns.add('bse_scrip_code',  sql.VarChar(20));
        tvp.columns.add('instrument_type', sql.VarChar(20));
        tvp.columns.add('expiry_date',     sql.Date);
        tvp.columns.add('strike_price',    sql.Decimal(10,4));
        tvp.columns.add('option_type',     sql.VarChar(5));
        tvp.columns.add('buy_qty',         sql.Decimal(10,4));
        tvp.columns.add('sell_qty',        sql.Decimal(10,4));
        tvp.columns.add('net_qty',         sql.Decimal(10,4));
        tvp.columns.add('avg_buy_price',   sql.Decimal(10,4));
        tvp.columns.add('avg_sell_price',  sql.Decimal(10,4));
        tvp.columns.add('lot_size',        sql.Int);
        tvp.columns.add('trade_date',      sql.Date);
        tvp.columns.add('file_source',     sql.VarChar(50));
        for (const pos of positions) {
            // 2026-08-28 fix: sanitize every Decimal(10,4) field before adding
            // the row -- see sanitizeDecimal10_4() above. Nothing else about
            // this row-building logic changed; a row that was already valid
            // produces the exact same values as before.
            const ctx = { ucc: pos.ucc, symbol: pos.symbol };
            const netQtyRaw    = pos.net_qty        !== undefined ? pos.net_qty        : (pos.buy_qty - pos.sell_qty);
            const avgBuyPxRaw  = pos.avg_buy_price  !== undefined ? pos.avg_buy_price  : null;
            const avgSellPxRaw = pos.avg_sell_price !== undefined ? pos.avg_sell_price : null;

            const buyQty    = sanitizeDecimal10_4(pos.buy_qty || 0, { ...ctx, field: 'buy_qty' })    ?? 0;
            const sellQty   = sanitizeDecimal10_4(pos.sell_qty || 0, { ...ctx, field: 'sell_qty' })   ?? 0;
            const netQty    = sanitizeDecimal10_4(netQtyRaw, { ...ctx, field: 'net_qty' })            ?? 0;
            const avgBuyPx  = sanitizeDecimal10_4(avgBuyPxRaw,  { ...ctx, field: 'avg_buy_price' });
            const avgSellPx = sanitizeDecimal10_4(avgSellPxRaw, { ...ctx, field: 'avg_sell_price' });
            const strikePx  = sanitizeDecimal10_4(pos.strike_price || null, { ...ctx, field: 'strike_price' });

            tvp.rows.add(
                (pos.ucc          || '').toString().substring(0, 20),
                exchange.trim(),
                segment.trim(),
                (pos.symbol       || '').toString().substring(0, 50),
                (pos.isin           || '').toString().substring(0, 20),
                (pos.company_name   || '').toString().substring(0, 200),
                (pos.bse_scrip_code || '').toString().substring(0, 20),
                (pos.instrument_type || 'EQUITY').substring(0, 20),
                pos.expiry_date ? new Date(pos.expiry_date) : null,
                strikePx,
                pos.option_type   || null,
                buyQty,
                sellQty,
                netQty,
                avgBuyPx,
                avgSellPx,
                pos.lot_size      || 1,
                new Date(trade_date),
                file_source       || ''
            );
        }
        // ── Bulk upsert day_positions ─────────────────────────────────────────
        await pool.request()
            .input('positions', tvp)
            .execute('usp_BulkUpsertDayPositions');
        console.log(`[DropCopy] ${file_source} - ${positions.length} positions bulk upserted`);
        // ── Batch upsert symbol_master via TVP (single SQL call) ────────────
        const cmPositions = positions.filter(p =>
            (p.isin || '').length > 5 &&
            (p.instrument_type || '').toUpperCase() === 'EQUITY'
        );
        if (cmPositions.length > 0) {
            try {
                // Deduplicate by ISIN — MERGE fails if source has duplicate ON-clause keys
                const isinMap = new Map();
                for (const pos of cmPositions) {
                    if (pos.isin && !isinMap.has(pos.isin)) {
                        isinMap.set(pos.isin, pos);
                    }
                }
                const uniquePositions = Array.from(isinMap.values());
                // Batch in chunks of 200 (200 × 4 params = 800, safely under 2100 limit)
                const CHUNK = 200;
                for (let ci = 0; ci < uniquePositions.length; ci += CHUNK) {
                    const chunk = uniquePositions.slice(ci, ci + CHUNK);
                    const vals  = chunk.map((_, i) => `(@i${i}, @ns${i}, @bs${i}, @cn${i})`).join(',');
                    const req   = pool.request();
                    chunk.forEach((pos, i) => {
                        req.input(`i${i}`,  sql.VarChar(20),  pos.isin || '');
                        req.input(`ns${i}`, sql.VarChar(50),  exchange === 'NSE' ? pos.symbol : null);
                        req.input(`bs${i}`, sql.VarChar(50),  exchange === 'BSE' ? pos.symbol : null);
                        req.input(`cn${i}`, sql.VarChar(200), pos.company_name || null);
                    });
                    await req.query(`
                        MERGE symbol_master AS target
                        USING (VALUES ${vals}) AS src(isin, nse_symbol, bse_symbol, company_name)
                        ON target.isin = src.isin
                        WHEN MATCHED THEN
                            UPDATE SET
                                nse_symbol   = COALESCE(src.nse_symbol,   target.nse_symbol),
                                bse_symbol   = COALESCE(src.bse_symbol,   target.bse_symbol),
                                company_name = COALESCE(src.company_name, target.company_name)
                        WHEN NOT MATCHED THEN
                            INSERT (isin, nse_symbol, bse_symbol, company_name)
                            VALUES (src.isin, src.nse_symbol, src.bse_symbol, src.company_name);
                    `);
                }
                console.log(`[DropCopy] symbol_master: ${uniquePositions.length} unique ISIN records upserted`);
            } catch (smErr) {
                console.error('[DropCopy] symbol_master batch upsert error:', smErr.message);
            }
        }
        return res.json({
            success:  true,
            inserted: positions.length,
            updated:  0,
            skipped:  0,
            total:    positions.length
        });
    } catch (err) {
        // 2026-08-28 fix: err.message alone can come back EMPTY for some
        // mssql RequestError shapes -- the actual SQL Server error text
        // lives in err.precedingErrors[]. Surface that, plus name/code, in
        // one concise line instead of a bare (and often blank) err.message.
        const precedingMsgs = Array.isArray(err.precedingErrors)
            ? err.precedingErrors.map(e => e.message).filter(Boolean)
            : [];
        console.error(
            `[DropCopy] Sync error for ${file_source || `${exchange}/${segment}`} - ` +
            `name: ${err.name} | code: ${err.code}` +
            (precedingMsgs.length ? ` | detail: ${precedingMsgs.join(' || ')}` : (err.message ? ` | message: ${err.message}` : ' | (no message available)'))
        );
        return res.status(500).json({ error: 'Sync failed: ' + (precedingMsgs[0] || err.message || err.name || 'Unknown error') });
    }
});
router.get('/positions', authenticate, async (req, res) => {
    try {
        const pool = await getConnection();
        const ucc  = req.user && req.user.ucc;
        if (!ucc) return res.status(401).json({ error: 'Unauthorized.' });
        const now       = new Date();
        const istDate   = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
        const tradeDate = istDate.toISOString().slice(0, 10);
        const result = await pool.request()
            .input('ucc',       sql.VarChar(20), ucc.toString().trim())
            .input('tradeDate', sql.Date,        new Date(tradeDate))
            .query(`
                SELECT id, ucc, exchange, segment, symbol, isin,
                    instrument_type, expiry_date, strike_price,
                    option_type, buy_qty, sell_qty, net_qty,
                    avg_buy_price, avg_sell_price, lot_size,
                    trade_date, last_updated
                FROM day_positions
                WHERE ucc = @ucc AND trade_date = @tradeDate
                ORDER BY instrument_type, symbol
            `);
        return res.json({
            success:    true,
            positions:  result.recordset,
            total:      result.recordset.length,
            trade_date: tradeDate
        });
    } catch (err) {
        console.error('[DayPos] Error:', err.message);
        return res.status(500).json({ error: 'Failed to fetch day positions.' });
    }
});
router.get('/status', async (req, res) => {
    try {
        const pool   = await getConnection();
        const result = await pool.request().query(`
            SELECT exchange, segment, file_source,
                COUNT(DISTINCT ucc) AS client_count,
                COUNT(*)            AS position_count,
                MAX(last_updated)   AS last_sync
            FROM day_positions
            WHERE trade_date = CAST(GETDATE() AS DATE)
            GROUP BY exchange, segment, file_source
            ORDER BY exchange, segment
        `);
        return res.json({ success: true, status: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch status.' });
    }
});
router.post('/log', validateSyncKey, async (req, res) => {
    const { file_source, exchange, segment, status, trades_count,
            positions_count, sync_duration_ms, error_message,
            file_size_bytes, trade_date, source_host } = req.body;
    try {
        const pool = await getConnection();
        await pool.request()
            .input('file_source',      sql.VarChar(50),  file_source      || '')
            .input('exchange',         sql.VarChar(10),  exchange         || '')
            .input('segment',          sql.VarChar(10),  segment          || '')
            .input('status',           sql.VarChar(20),  status           || 'SUCCESS')
            .input('trades_count',     sql.Int,          trades_count     || 0)
            .input('positions_count',  sql.Int,          positions_count  || 0)
            .input('sync_duration_ms', sql.Int,          sync_duration_ms || 0)
            .input('error_message',    sql.VarChar(500), error_message    || null)
            .input('file_size_bytes',  sql.BigInt,       file_size_bytes  || 0)
            .input('trade_date',       sql.Date,         new Date(trade_date))
            .input('source_host',      sql.VarChar(100), source_host      || null)
            .query(`
                INSERT INTO sync_logs
                (file_source, exchange, segment, status, trades_count,
                 positions_count, sync_duration_ms, error_message,
                 file_size_bytes, trade_date, source_host)
                VALUES
                (@file_source, @exchange, @segment, @status, @trades_count,
                 @positions_count, @sync_duration_ms, @error_message,
                 @file_size_bytes, @trade_date, @source_host)
            `);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});
router.get('/sync-logs', async (req, res) => {
    // Accept either the server-side sync key (used by Python services)
    // OR a valid admin JWT Bearer token (used by the SyncMonitor admin panel).
    // The sync key must never be sent to the browser, so the admin panel
    // authenticates with its normal JWT instead.
    const key = req.headers['x-sync-key'] || req.query.key;
    let isAuthorized = key && key === process.env.SYNC_API_KEY;
    if (!isAuthorized) {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (token) {
            try {
                const jwt     = require('jsonwebtoken');
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                isAuthorized  = decoded.role === 'ADMIN' || decoded.role === 'SUPERADMIN';
            } catch (_) {}
        }
    }
    if (!isAuthorized) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    try {
        const pool = await getConnection();
        // FIX (16-Jul-2026): this route used to be a flat "SELECT TOP 200 ...
        // ORDER BY log_time DESC" with no pagination, and the frontend derived
        // its Total/Success/Error counts from that same capped 200-row array.
        // With 5 feeds syncing every 60-90s during trading hours, a single day
        // blows past 200 rows well before market close -- so the table silently
        // dropped all earlier-in-the-day rows (confirmed: 16-Jul-2026's log
        // page bottomed out at 14:56 despite trading having started at 9:00),
        // and "Total: 200 / Success: 200" was really just "however many of the
        // 200 returned rows happened to be Success", not the day's real totals.
        // Now paginated with OFFSET/FETCH, and a separate un-paginated COUNT
        // query (same filters) supplies real full-range totals independent of
        // page size.
        const page   = parseInt(req.query.page)  || 1;
        const limit  = parseInt(req.query.limit) || 200;
        const offset = (page - 1) * limit;
        // Build the WHERE filters once, reused identically by both queries
        // below so the summary counts always match what the page is filtered to.
        const filters = [];
        if (req.query.date_from) filters.push({ clause: ' AND CAST(log_time AS DATE) >= @dateFrom', name: 'dateFrom', type: sql.Date,        val: req.query.date_from });
        if (req.query.date_to)   filters.push({ clause: ' AND CAST(log_time AS DATE) <= @dateTo',   name: 'dateTo',   type: sql.Date,        val: req.query.date_to   });
        if (req.query.exchange && req.query.exchange !== 'ALL') filters.push({ clause: ' AND exchange = @exchange', name: 'exchange', type: sql.VarChar(10), val: req.query.exchange });
        if (req.query.status   && req.query.status   !== 'ALL') filters.push({ clause: ' AND status = @status',    name: 'status',   type: sql.VarChar(20), val: req.query.status   });
        const whereClause = ' WHERE 1=1' + filters.map(f => f.clause).join('');
        // ── Paginated rows for the table ───────────────────────────────────
        const rowsReq = pool.request();
        filters.forEach(f => rowsReq.input(f.name, f.type, f.val));
        rowsReq.input('offset', sql.Int, offset);
        rowsReq.input('limit',  sql.Int, limit);
        const rowsResult = await rowsReq.query(`
            SELECT
                id, log_time, file_source, exchange, segment,
                status, trades_count, positions_count,
                sync_duration_ms, error_message, file_size_bytes, trade_date,
                source_host
            FROM sync_logs
            ${whereClause}
            ORDER BY log_time DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
        `);
        // ── True totals across the WHOLE filtered range, not just this page ─
        const countReq = pool.request();
        filters.forEach(f => countReq.input(f.name, f.type, f.val));
        const countResult = await countReq.query(`
            SELECT
                COUNT(*)                                             AS total,
                SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END)  AS success_count,
                SUM(CASE WHEN status = 'WARNING' THEN 1 ELSE 0 END)  AS warning_count,
                SUM(CASE WHEN status = 'ERROR'   THEN 1 ELSE 0 END)  AS error_count
            FROM sync_logs
            ${whereClause}
        `);
        const counts = countResult.recordset[0] || {};
        const total  = counts.total || 0;
        return res.json({
            success: true,
            logs:    rowsResult.recordset,
            summary: {
                total,
                success_count: counts.success_count || 0,
                warning_count: counts.warning_count || 0,
                error_count:   counts.error_count   || 0,
            },
            pagination: {
                page,
                limit,
                total,
                total_pages: Math.max(1, Math.ceil(total / limit)),
                has_next:    page * limit < total,
            }
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});
router.post('/refresh-lots', async (req, res) => {
    const key = req.headers['x-sync-key'] || req.query.key;
    if (!key || key !== process.env.SYNC_API_KEY)
        return res.status(401).json({ error: 'Unauthorized.' });
    try {
        const pool = await getConnection();
        const result = await pool.request().query(`
            MERGE lot_size_master AS target
            USING (
                SELECT symbol, exchange, lot_size
                FROM (
                    SELECT symbol, exchange, lot_size,
                           ROW_NUMBER() OVER (PARTITION BY symbol, exchange ORDER BY trade_date DESC) AS rn
                    FROM day_positions
                    WHERE lot_size > 1 AND trade_date = CAST(GETDATE() AS DATE)
                ) t WHERE rn = 1
            ) AS src
            ON target.symbol = src.symbol AND target.exchange = src.exchange
            WHEN MATCHED AND src.lot_size > 1 THEN
                UPDATE SET lot_size = src.lot_size, updated_at = GETDATE()
            WHEN NOT MATCHED THEN
                INSERT (symbol, exchange, lot_size) VALUES (src.symbol, src.exchange, src.lot_size);
            SELECT @@ROWCOUNT AS rows_affected;
        `);
        return res.json({ success: true, rows_affected: result.recordset[0]?.rows_affected });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});
module.exports = router;