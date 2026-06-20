const express      = require('express');
const router       = express.Router();
const authenticate = require('../middleware/authenticate');
const { getConnection, sql } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { sendRMSAlert } = require('../services/notificationService');

// Place a square-off order
router.post('/squareoff', authenticate, async (req, res) => {
    const {
        exchange, segment, symbol, quantity, side,
        expiry_date, strike_price, option_type,   // F&O / B/F fields
        dealerId, placedBy
    } = req.body;
    const { ucc, loginType } = req.user;

    // ── Block SSO only if it is NOT a dealer SSO ──────────────────────────
    const isDealer = !!(dealerId || placedBy);
    if (loginType === 'SSO' && !isDealer) {
        return res.status(403).json({
            error: 'SSO_BLOCKED',
            message: 'It seems our trading application is functioning. You cannot place a square-off request via Navia Backup at this time.'
        });
    }

    if (!exchange || !segment || !symbol || !quantity || !side) {
        return res.status(400).json({ error: 'All fields are required.' });
    }
    if (!['BUY', 'SELL'].includes(side.toUpperCase())) {
        return res.status(400).json({ error: 'Side must be BUY or SELL.' });
    }

    try {
        console.log(`[Orders] Step 1: getConnection UCC=${ucc} SYMBOL=${symbol} EXCH=${exchange} SEG=${segment}`);
        const pool = await getConnection();
        console.log(`[Orders] Step 2: DB connected`);

        // ── Check if segment is enabled ───────────────────────────────────
        const segResult = await pool.request()
            .input('exchange', sql.VarChar, exchange.toUpperCase())
            .input('segment',  sql.VarChar, segment.toUpperCase())
            .query(`SELECT is_enabled FROM segment_controls
                    WHERE exchange = @exchange AND segment = @segment`);

        console.log(`[Orders] Step 3: segment check done is_enabled=${segResult.recordset[0]?.is_enabled}`);
        if (!segResult.recordset.length ||
            segResult.recordset[0].is_enabled === false ||
            segResult.recordset[0].is_enabled === 0) {
            return res.status(403).json({
                error: 'SEGMENT_DISABLED',
                message: 'It seems our trading application is functioning. You cannot place a square-off request via Navia Backup at this time.'
            });
        }

        // ── Check duplicate ───────────────────────────────────────────────
        const existing = await pool.request()
            .input('ucc',      sql.VarChar, ucc)
            .input('symbol',     sql.VarChar,       symbol.toUpperCase())
            .input('exchange',   sql.VarChar,       exchange.toUpperCase())
            .input('expiry',     sql.Date,           expiry_date   ? new Date(expiry_date)  : null)
            .input('strike',     sql.Decimal(18,2),  strike_price  ? Number(strike_price)   : null)
            .input('optionType', sql.VarChar(5),     option_type   || null)
            .query(`SELECT order_id FROM squareoff_orders
                    WHERE ucc      = @ucc
                    AND   symbol   = @symbol
                    AND   exchange = @exchange
                    AND   status NOT IN ('FAILED','REJECTED','ORDER_TRADED','TRADED')
                    AND   CAST(placed_at AS DATE) = CAST(GETDATE() AS DATE)
                    AND   (expiry_date  = @expiry     OR (@expiry     IS NULL AND expiry_date  IS NULL))
                    AND   (ABS(ISNULL(strike_price,0) - ISNULL(@strike,0)) < 0.01)
                    AND   (option_type  = @optionType OR (@optionType IS NULL AND option_type  IS NULL))`);

        console.log(`[Orders] Step 4: duplicate check done count=${existing.recordset.length}`);
        if (existing.recordset.length > 0) {
            return res.status(409).json({
                error: 'DUPLICATE_ORDER',
                message: 'A square-off order has already been placed for this security.'
            });
        }

        // ── Create the order ──────────────────────────────────────────────
        const orderId     = uuidv4();
        const placedByVal = isDealer ? 'DEALER' : 'CLIENT';
        const dealerIdVal = isDealer ? (dealerId || placedBy || null) : null;

        // Parse F&O fields safely
        const expiryDate  = expiry_date  ? new Date(expiry_date)  : null;
        const strikePrice = strike_price ? parseFloat(strike_price) : null;
        const optType     = option_type  || null;

        await pool.request()
            .input('orderId',     sql.VarChar,     orderId)
            .input('ucc',         sql.VarChar,     ucc)
            .input('exchange',    sql.VarChar,     exchange.toUpperCase())
            .input('segment',     sql.VarChar,     segment.toUpperCase())
            .input('symbol',      sql.VarChar,     symbol.toUpperCase())
            .input('qty',         sql.Int,         quantity)
            .input('side',        sql.VarChar,     side.toUpperCase())
            .input('placedBy',    sql.VarChar,     placedByVal)
            .input('dealerId',    sql.VarChar,     dealerIdVal)
            .input('expiryDate',  sql.Date,        expiryDate)
            .input('strikePrice', sql.Decimal(12,2), strikePrice)
            .input('optType',     sql.VarChar(5),  optType)
            .query(`INSERT INTO squareoff_orders
                        (order_id, ucc, exchange, segment, symbol, quantity,
                         order_type, side, status, placed_at, rms_notified,
                         placed_by, dealer_id, expiry_date, strike_price, option_type,
                         executed_qty, remaining_qty)
                    VALUES
                        (@orderId, @ucc, @exchange, @segment, @symbol, @qty,
                         'MARKET', @side, 'ORDER_RECEIVED', GETDATE(), 0,
                         @placedBy, @dealerId, @expiryDate, @strikePrice, @optType,
                         0, @qty)`);

        console.log(`[Orders] Step 5: order inserted orderId=${orderId}`);
        // ── Update positions table (non-critical) ─────────────────────────
        pool.request()
            .input('ucc',      sql.VarChar, ucc)
            .input('symbol',   sql.VarChar, symbol.toUpperCase())
            .input('exchange', sql.VarChar, exchange.toUpperCase())
            .input('orderId',  sql.VarChar, orderId)
            .query(`UPDATE positions
                    SET squareoff_placed = 1, squareoff_order_id = @orderId
                    WHERE ucc = @ucc AND symbol = @symbol AND exchange = @exchange`)
            .catch(err => console.error('[Orders] positions update (non-critical):', err.message));

        // ── Respond immediately ───────────────────────────────────────────
        res.json({
            success: true,
            orderId,
            message: 'Square-off request received. RMS team has been notified.'
        });

        // Send RMS notification in background — never blocks the response
        sendRMSAlert({
            orderId, ucc, exchange, segment, symbol,
            quantity, side, expiry_date, strike_price, option_type,
            dealerId: dealerIdVal, placedBy: placedByVal
        }).catch(err => console.error('[Orders] RMS alert (non-critical):', err.message));

    } catch (err) {
        console.error('Square-off error:', err.message);
        return res.status(500).json({ error: 'Failed to place square-off. Please try again.' });
    }
});

// Get orders for logged-in client (includes dealer-placed orders for this UCC)
router.get('/my-orders', authenticate, async (req, res) => {
    const { ucc } = req.user;
    try {
        const pool   = await getConnection();
        const result = await pool.request()
            .input('ucc', sql.VarChar, ucc)
            .query(`SELECT
                        order_id, ucc, exchange, segment, symbol,
                        quantity, side, order_type, status,
                        placed_at, traded_at, trade_price,
                        placed_by, dealer_id,
                        expiry_date, strike_price, option_type,
                        file_generated, file_generated_at
                    FROM squareoff_orders
                    WHERE ucc = @ucc
                    ORDER BY placed_at DESC`);
        return res.json({ success: true, orders: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Could not fetch orders.' });
    }
});

module.exports = router;