const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/authenticate');
const { getConnection, sql } = require('../config/database');

// Get all positions for logged-in client
router.get('/', authenticate, async (req, res) => {
    const { ucc } = req.user;

    try {
        const pool = await getConnection();
        const result = await pool.request()
            .input('ucc', sql.VarChar, ucc)
            .query(`SELECT 
                        position_id,
                        exchange,
                        segment,
                        symbol,
                        position_type,
                        buy_qty,
                        sell_qty,
                        net_qty,
                        avg_price,
                        ltp,
                        pnl,
                        squareoff_placed,
                        squareoff_order_id,
                        last_updated
                    FROM positions 
                    WHERE ucc = @ucc 
                    AND net_qty != 0
                    ORDER BY exchange, segment, symbol`);

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
            .query(`SELECT * FROM positions 
                    WHERE ucc = @ucc 
                    AND exchange = @exchange
                    AND net_qty != 0
                    ORDER BY segment, symbol`);

        return res.json({ success: true, positions: result.recordset });

    } catch (err) {
        return res.status(500).json({ error: 'Could not fetch positions.' });
    }
});

module.exports = router;