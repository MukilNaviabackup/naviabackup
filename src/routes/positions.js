const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authenticate');
const { getConnection, sql } = require('../config/database');

// FIX (2026-07-21, rev1): Day/Net Position must show ONLY activity that is
// NOT attributable to a Holdings-tab-placed order. Root cause: day_positions
// is populated by the broker/RMS trade feed for the WHOLE underlying
// security, regardless of which tab (Day Position or Holdings) the client
// used to place the order -- so when the client sells shares from the
// HOLDINGS tab, that same sell also lands in the raw day_positions row for
// the underlying ISIN's short ticker, inflating sell_qty and making an
// already-flat day position (e.g. IDEA: 1 buy / 1 sell, net 0) look like it
// still has an open short position (buy=1/sell=14/net=-13) purely because
// Holdings and Day Position share the same underlying broker feed. Per the
// client's explicit design requirement, Day Position and Holdings must stay
// visually independent in BOTH directions -- the equivalent fix already
// shipped on the dealer route (dealerAuth.js) subtracts Holdings-only order
// quantity back out of the displayed day_positions row; this does the exact
// same thing for the client's own /positions route. Conveniently,
// day_positions already stores its own `isin` column directly (no
// symbol_master join needed here, unlike the dealer route which had to
// resolve it separately).
//
// Because the original SQL filtered on the RAW net_qty != 0, that filter is
// now applied in JS AFTER adjustment -- otherwise a row that only nets to 0
// post-adjustment (like IDEA here) would still show up with its
// pre-adjustment, inflated net_qty instead of correctly disappearing as "no
// open position". Non-equity (FO/MCX) rows and equity rows with no matching
// Holdings-tab order pass through with the exact same net_qty != 0 filter
// behavior as before -- only genuinely Holdings-affected rows are touched.
async function fetchTodayHoldingsNetByIsin(pool, ucc) {
    try {
        const result = await pool.request()
            .input('ucc', sql.VarChar(20), String(ucc).trim())
            .query(`SELECT
                        LTRIM(RTRIM(SUBSTRING(o.symbol, CHARINDEX(' ; ', o.symbol) + 3, 50))) AS isin,
                        o.side, o.executed_qty
                    FROM squareoff_orders o
                    WHERE o.ucc = @ucc
                    AND o.segment = 'CM'
                    AND CHARINDEX(' ; ', o.symbol) > 0
                    AND o.status IN ('ORDER_TRADED', 'PARTIALLY_TRADED')
                    AND CAST(o.traded_at AS DATE) = CAST(GETDATE() AS DATE)`);

        const isinNet = new Map();
        for (const o of result.recordset) {
            if (!o.isin) continue;
            const agg = isinNet.get(o.isin) || { buy_qty: 0, sell_qty: 0 };
            const qty = Number(o.executed_qty) || 0;
            if ((o.side || '').toUpperCase() === 'BUY') agg.buy_qty += qty;
            else agg.sell_qty += qty;
            isinNet.set(o.isin, agg);
        }
        return isinNet;
    } catch (e) {
        console.error('[Positions] Holdings-net lookup error (non-fatal, positions shown unadjusted):', e.message);
        return new Map();
    }
}

function adjustAndFilterPositions(rows, isinNet) {
    return rows
        .map(p => {
            if (p.segment !== 'CM' || p.instrument_type !== 'EQUITY' || !p.isin) return p;
            const net = isinNet.get(p.isin);
            if (!net) return p;
            const adjBuy  = Math.max(0, Number(p.buy_qty)  - net.buy_qty);
            const adjSell = Math.max(0, Number(p.sell_qty) - net.sell_qty);
            return { ...p, buy_qty: adjBuy, sell_qty: adjSell, net_qty: adjBuy - adjSell };
        })
        .filter(p => Number(p.net_qty) !== 0);
}

// Get all NET positions for logged-in client — sourced from day_positions (DropCopy)
// This is the single source of truth for FO/CM positions including expiry/strike/option_type
router.get('/', authenticate, async (req, res) => {
    const { ucc } = req.user;
    try {
        const pool = await getConnection();
        const [result, isinNet] = await Promise.all([
            pool.request()
                .input('ucc', sql.VarChar, ucc)
                .query(`SELECT
                            symbol,
                            exchange,
                            segment,
                            instrument_type,
                            expiry_date,
                            strike_price,
                            option_type,
                            buy_qty,
                            sell_qty,
                            net_qty,
                            avg_buy_price,
                            avg_sell_price,
                            lot_size,
                            isin,
                            company_name,
                            bse_scrip_code,
                            last_updated
                        FROM day_positions
                        WHERE ucc = @ucc
                        AND trade_date = (
                            SELECT MAX(trade_date) FROM day_positions
                            WHERE ucc = @ucc
                            AND trade_date >= CAST(DATEADD(day,-1,GETDATE()) AS DATE)
                        )
                        ORDER BY instrument_type, symbol`),
            fetchTodayHoldingsNetByIsin(pool, ucc)
        ]);
        const adjustedPositions = adjustAndFilterPositions(result.recordset, isinNet);
        return res.json({ success: true, positions: adjustedPositions });
    } catch (err) {
        console.error('Positions fetch error:', err);
        return res.status(500).json({ error: 'Could not fetch positions.' });
    }
});

// Get positions filtered by exchange
router.get('/:exchange', authenticate, async (req, res) => {
    const { ucc } = req.user;
    const { exchange } = req.params;
    try {
        const pool = await getConnection();
        const [result, isinNet] = await Promise.all([
            pool.request()
                .input('ucc', sql.VarChar, ucc)
                .input('exchange', sql.VarChar, exchange.toUpperCase())
                .query(`SELECT
                            symbol,
                            exchange,
                            segment,
                            instrument_type,
                            expiry_date,
                            strike_price,
                            option_type,
                            buy_qty,
                            sell_qty,
                            net_qty,
                            avg_buy_price,
                            avg_sell_price,
                            lot_size,
                            isin,
                            company_name,
                            bse_scrip_code,
                            last_updated
                        FROM day_positions
                        WHERE ucc = @ucc
                        AND exchange = @exchange
                        AND trade_date = (
                            SELECT MAX(trade_date) FROM day_positions
                            WHERE ucc = @ucc
                            AND trade_date >= CAST(DATEADD(day,-1,GETDATE()) AS DATE)
                        )
                        ORDER BY segment, symbol`),
            fetchTodayHoldingsNetByIsin(pool, ucc)
        ]);
        const adjustedPositions = adjustAndFilterPositions(result.recordset, isinNet);
        return res.json({ success: true, positions: adjustedPositions });
    } catch (err) {
        return res.status(500).json({ error: 'Could not fetch positions.' });
    }
});

module.exports = router;