const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authenticate');
const { getConnection, sql } = require('../config/database');

// Get all NET positions for logged-in client — sourced from day_positions (DropCopy)
// This is the single source of truth for FO/CM positions including expiry/strike/option_type
router.get('/', authenticate, async (req, res) => {
    const { ucc } = req.user;
    try {
        const pool = await getConnection();
        const result = await pool.request()
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
                    AND net_qty != 0
                    AND trade_date = (
                        SELECT MAX(trade_date) FROM day_positions
                        WHERE ucc = @ucc
                        AND trade_date >= CAST(DATEADD(day,-1,GETDATE()) AS DATE)
                    )
                    ORDER BY instrument_type, symbol`);
        return res.json({ success: true, positions: result.recordset });
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
        const result = await pool.request()
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
                    AND net_qty != 0
                    AND trade_date = (
                        SELECT MAX(trade_date) FROM day_positions
                        WHERE ucc = @ucc
                        AND trade_date >= CAST(DATEADD(day,-1,GETDATE()) AS DATE)
                    )
                    ORDER BY segment, symbol`);
        return res.json({ success: true, positions: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Could not fetch positions.' });
    }
});

module.exports = router;