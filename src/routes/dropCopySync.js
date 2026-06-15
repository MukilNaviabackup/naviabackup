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
            const positionMap = new Map();
            for (const trade of trades) {
                const { ucc, symbol, isin, company_name, instrument_type,
                        expiry_date, strike_price, option_type,
                        side, quantity, price, lot_size } = trade;
                if (!ucc || !symbol || !side || !quantity) continue;
                const qty = parseFloat(quantity) || 0;
                const px  = parseFloat(price)    || 0;
                const lot = parseInt(lot_size)   || 1;
                if (qty <= 0) continue;
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
            const netQty    = pos.net_qty        !== undefined ? pos.net_qty        : (pos.buy_qty - pos.sell_qty);
            const avgBuyPx  = pos.avg_buy_price  !== undefined ? pos.avg_buy_price  : null;
            const avgSellPx = pos.avg_sell_price !== undefined ? pos.avg_sell_price : null;

            tvp.rows.add(
                (pos.ucc          || '').toString().substring(0, 20),
                exchange.trim(),
                segment.trim(),
                (pos.symbol       || '').toString().substring(0, 50),
                (pos.isin         || '').toString().substring(0, 20),
                (pos.company_name || '').toString().substring(0, 200),
                (pos.instrument_type || 'EQUITY').substring(0, 20),
                pos.expiry_date ? new Date(pos.expiry_date) : null,
                pos.strike_price  || null,
                pos.option_type   || null,
                pos.buy_qty       || 0,
                pos.sell_qty      || 0,
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

        // ── Upsert symbol_master for CM (ISIN mapping) ────────────────────────
        const cmPositions = positions.filter(p =>
            (p.isin || '').length > 5 &&
            (p.instrument_type || '').toUpperCase() === 'EQUITY'
        );

        if (cmPositions.length > 0) {
            for (const pos of cmPositions) {
                try {
                    await pool.request()
                        .input('isin',        sql.VarChar(20),  pos.isin)
                        .input('nseSymbol',   sql.VarChar(50),  exchange === 'NSE' ? pos.symbol : null)
                        .input('bseSymbol',   sql.VarChar(50),  exchange === 'BSE' ? pos.symbol : null)
                        .input('companyName', sql.VarChar(200), pos.company_name || null)
                        .query(`
                            MERGE symbol_master AS target
                            USING (SELECT @isin AS isin) AS src ON target.isin = src.isin
                            WHEN MATCHED THEN
                                UPDATE SET
                                    nse_symbol   = COALESCE(@nseSymbol, nse_symbol),
                                    bse_symbol   = COALESCE(@bseSymbol, bse_symbol),
                                    company_name = COALESCE(@companyName, company_name)
                            WHEN NOT MATCHED THEN
                                INSERT (isin, nse_symbol, bse_symbol, company_name)
                                VALUES (@isin, @nseSymbol, @bseSymbol, @companyName);
                        `);
                } catch (smErr) {
                    // Non-blocking — symbol_master failure doesn't break sync
                    console.error('[DropCopy] symbol_master upsert error:', smErr.message);
                }
            }
            console.log(`[DropCopy] symbol_master: ${cmPositions.length} ISIN records upserted`);
        }

        return res.json({
            success:  true,
            inserted: positions.length,
            updated:  0,
            skipped:  0,
            total:    positions.length
        });

    } catch (err) {
        console.error('[DropCopy] Sync error:', err.message);
        return res.status(500).json({ error: 'Sync failed: ' + err.message });
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
            file_size_bytes, trade_date } = req.body;
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
            .query(`
                INSERT INTO sync_logs
                (file_source, exchange, segment, status, trades_count,
                 positions_count, sync_duration_ms, error_message,
                 file_size_bytes, trade_date)
                VALUES
                (@file_source, @exchange, @segment, @status, @trades_count,
                 @positions_count, @sync_duration_ms, @error_message,
                 @file_size_bytes, @trade_date)
            `);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.get('/sync-logs', async (req, res) => {
    const key = req.headers['x-sync-key'] || req.query.key;
    if (!key || key !== process.env.SYNC_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized.' });
    }
    try {
        const pool    = await getConnection();
        const request = pool.request();
        let query = `
            SELECT TOP 200
                id, log_time, file_source, exchange, segment,
                status, trades_count, positions_count,
                sync_duration_ms, error_message, file_size_bytes, trade_date
            FROM sync_logs
            WHERE 1=1
        `;
        if (req.query.date_from) { query += ' AND CAST(log_time AS DATE) >= @dateFrom'; request.input('dateFrom', sql.Date, req.query.date_from); }
        if (req.query.date_to)   { query += ' AND CAST(log_time AS DATE) <= @dateTo';   request.input('dateTo',   sql.Date, req.query.date_to);   }
        if (req.query.exchange && req.query.exchange !== 'ALL') { query += ' AND exchange = @exchange'; request.input('exchange', sql.VarChar(10), req.query.exchange); }
        if (req.query.status   && req.query.status   !== 'ALL') { query += ' AND status = @status';    request.input('status',   sql.VarChar(20), req.query.status);   }
        query += ' ORDER BY log_time DESC';
        const result = await request.query(query);
        return res.json({ success: true, logs: result.recordset });
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