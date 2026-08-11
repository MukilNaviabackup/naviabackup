const express      = require('express');
const router       = express.Router();
const authenticate = require('../middleware/authenticate');
const { getConnection, sql } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { sendRMSAlert } = require('../services/notificationService');
const { queueRMSEmailAlert } = require('../services/rmsEmailAlert');

// System Logs fix (2026-07-27): square-off placement never wrote to
// system_logs at all, so the "Sq-Offs Today" card on the System Logs page
// was always stuck at 0 regardless of actual activity. Fire-and-forget,
// matching the same non-blocking pattern used by writeLog() in
// auth.js/dealerAuth.js -- never allowed to slow down or fail the response.
function writeLog(logType, actor, actorType, ucc, ip, details, status) {
    setImmediate(async () => {
        try {
            const pool = await getConnection();
            await pool.request()
                .input('logType',   sql.VarChar(100),  logType   || 'UNKNOWN')
                .input('actor',     sql.VarChar(100),  actor     || null)
                .input('actorType', sql.VarChar(20),   actorType || 'CLIENT')
                .input('ucc',       sql.VarChar(20),   ucc       || null)
                .input('ip',        sql.VarChar(50),   ip        || null)
                .input('details',   sql.NVarChar(500), details   || null)
                .input('status',    sql.VarChar(20),   status    || 'SUCCESS')
                .query(`INSERT INTO system_logs (log_type,actor,actor_type,ucc,ip_address,details,status,created_at)
                        VALUES (@logType,@actor,@actorType,@ucc,@ip,@details,@status,GETDATE())`);
        } catch (err) {
            console.error('[SystemLog] orders write failed:', err.message);
        }
    });
}

// Place a square-off order
router.post('/squareoff', authenticate, async (req, res) => {
    const {
        exchange, segment, symbol, quantity, side,
        expiry_date, strike_price, option_type,   // F&O / B/F fields
        dealerId, placedBy
    } = req.body;
    const { ucc, loginType } = req.user;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;

    // isDealer distinguishes a dealer placing on a client's behalf (used
    // below for placed_by/dealer_id) from a client placing their own order.
    const isDealer = !!(dealerId || placedBy);

    // FIX (2026-08-11): removed the old blanket "loginType === 'SSO' && !isDealer"
    // block that used to sit here. It unconditionally rejected every square-off
    // from a client who arrived via the trading app's Account-menu SSO handoff
    // (loginType is set to 'SSO' for that session, exactly like every other
    // client session it creates) -- regardless of whether the segment was
    // actually enabled in Segment Control. That made self-service square-off
    // via SSO impossible even when Inhouse/NSE/BSE/MCX/CM/FO were all switched
    // on, which is the bug reported: SSO clients got "Square-off unavailable
    // / Trading platform is functioning" on every attempt, while the exact
    // same client logging in directly (UCC+DOB+OTP) could place the same
    // order without issue. Whether square-off is actually allowed right now
    // is already correctly decided by the segment_controls check directly
    // below (the same gate every other login path goes through) -- this
    // extra SSO-specific block was redundant with it at best, and at worst a
    // leftover from before the segment_controls gate existed, and simply
    // never got reconciled with it. Removing it here does not weaken any
    // check: is_enabled in Segment Control is still the single source of
    // truth for whether square-off is allowed, for every login path alike.

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

        // ── Capture baseline qty for reconciliation (compliance fix) ──────
        // day_positions.buy_qty/sell_qty are CUMULATIVE totals for the whole
        // trading day, not a log of individual trades. If this client already
        // completed an earlier buy/sell round-trip in this same symbol today,
        // that leftover quantity must NOT be allowed to satisfy THIS order.
        // Snapshot the current cumulative quantity (matching this order's
        // side) right now, at placement time, so reconciliationService can
        // later look only at the INCREMENT since this moment -- not the
        // day's raw running total. This fixes the case where an order was
        // matched (and the client was told "successfully executed") against
        // a trade that happened BEFORE the order was even placed.
        const baselineSideCol = side.toUpperCase() === 'BUY' ? 'buy_qty' : 'sell_qty';
        const baselineResult = await pool.request()
            .input('ucc',        sql.VarChar,       ucc)
            .input('symbol',     sql.VarChar,       symbol.toUpperCase())
            .input('exchange',   sql.VarChar,       exchange.toUpperCase())
            .input('segment',    sql.VarChar,       segment.toUpperCase())
            .input('expiry',     sql.Date,          expiryDate)
            .input('strike',     sql.Decimal(18,2), strikePrice)
            .input('optionType', sql.VarChar(5),    optType)
            .query(`
                SELECT ISNULL(SUM(${baselineSideCol}), 0) AS baseline_qty
                FROM day_positions
                WHERE ucc          = @ucc
                AND   symbol       = @symbol
                AND   exchange     = @exchange
                AND   segment      = @segment
                AND   trade_date   = CAST(GETDATE() AS DATE)
                AND   (
                    (@expiry IS NULL AND expiry_date IS NULL)
                    OR expiry_date = @expiry
                )
                AND   (
                    (@strike IS NULL AND strike_price IS NULL)
                    OR ABS(strike_price - @strike) < 0.01
                )
                AND   (
                    (@optionType IS NULL AND option_type IS NULL)
                    OR option_type = @optionType
                )
            `);
        const baselineQty = Number(baselineResult.recordset[0]?.baseline_qty) || 0;
        console.log(`[Orders] Step 4.5: baseline qty captured = ${baselineQty} (${baselineSideCol})`);

        // FIX (2026-07-21, rev1): squareoff_orders.isin was never populated
        // at insert time, even though the table has the column and
        // reconciliationService.js specifically checks `if (!order.isin)` to
        // decide whether to use its clean, unambiguous ISIN-based CM match
        // (getCMExecutedQty -- JOIN symbol_master ON isin) or fall back to a
        // fragile first-word/company-name LIKE match
        // (getCMExecutedQtyBySymbol) against symbol_master. That fallback
        // takes symbol.split(' ')[0] -- for a Holdings-tab compound symbol
        // like "BHARAT ELECTRONICS LIMITED EQ ; INE263A01024" that's just
        // "BHARAT" -- and runs `TOP 1 ... company_name LIKE '%BHARAT%'` with
        // NO ORDER BY, which can silently resolve to the wrong company when
        // two share a first word (confirmed live on the dealer-placed
        // equivalent of this same order: this client also holds "BHARAT
        // ROAD NETWORK LIMITED EQ"). Extracting and storing the ISIN here
        // (same identical fix already shipped on the dealer route's
        // /place-squareoff, dealerAuth.js) lets reconciliation use its
        // intended ISIN JOIN path instead of the fallback for client-placed
        // Holdings square-offs too. Extracted from the SAME upper-cased
        // symbol string that actually gets stored below, so the delimiter
        // check/extraction always matches what's in the row.
        const symbolUpper = symbol.toUpperCase();
        const orderIsin = symbolUpper.includes(' ; ')
            ? symbolUpper.substring(symbolUpper.indexOf(' ; ') + 3).trim()
            : null;

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
            .input('baselineQty', sql.Decimal(18,2), baselineQty)
            .input('isin',        sql.VarChar(20), orderIsin)
            .query(`INSERT INTO squareoff_orders
                        (order_id, ucc, exchange, segment, symbol, quantity,
                         order_type, side, status, placed_at, rms_notified,
                         placed_by, dealer_id, expiry_date, strike_price, option_type,
                         executed_qty, remaining_qty, baseline_qty, isin)
                    VALUES
                        (@orderId, @ucc, @exchange, @segment, @symbol, @qty,
                         'MARKET', @side, 'ORDER_RECEIVED', GETDATE(), 0,
                         @placedBy, @dealerId, @expiryDate, @strikePrice, @optType,
                         0, @qty, @baselineQty, @isin)`);

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

        writeLog('SQUAREOFF_PLACED', ucc, placedByVal, ucc, ip,
            `${symbol.toUpperCase()} ${side.toUpperCase()} ${quantity} sq-off placed (${exchange.toUpperCase()} ${segment.toUpperCase()})`,
            'SUCCESS');

        // Send RMS notification in background — never blocks the response
        sendRMSAlert({
            orderId, ucc, exchange, segment, symbol,
            quantity, side, expiry_date, strike_price, option_type,
            dealerId: dealerIdVal, placedBy: placedByVal
        }).catch(err => console.error('[Orders] RMS alert (non-critical):', err.message));

        // Queue RMS email alert (batched, no attachment) -- non-blocking.
        queueRMSEmailAlert({
            ucc, exchange, segment, symbol, quantity, side,
            expiry_date, strike_price, option_type,
        });

    } catch (err) {
        console.error('Square-off error:', err.message);
        return res.status(500).json({ error: 'Failed to place square-off. Please try again.' });
    }
});

// Get orders for logged-in client (includes dealer-placed orders for this UCC)
router.get('/my-orders', authenticate, async (req, res) => {
    // This endpoint reflects live order status (placed/traded/etc). Without an
    // explicit no-store directive, a browser's HTTP cache, a corporate/office
    // network proxy, or any CDN sitting in front of the API can silently serve
    // a stale cached copy of this exact GET response -- which is why a client
    // could place a square-off on mobile and still see "not placed" on a web
    // session that happens to be behind a caching layer, no matter how many
    // times they click Refresh (the browser never actually re-asks the server).
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    const { ucc } = req.user;
    try {
        const pool   = await getConnection();
        const result = await pool.request()
            .input('ucc', sql.VarChar, ucc)
            // FIX: scoped to TODAY only (CAST(o.placed_at AS DATE) = today) --
            // this list was previously the client's ENTIRE order history, which
            // made My Orders grow unbounded and unreadable over time.
            //
            // is_stale: flags an order still sitting at ORDER_RECEIVED whose
            // target position has ALREADY gone flat (net_qty = 0) via some
            // other route -- e.g. the client squared off the same position
            // from their own live trading app instead of via Navia Backup.
            // Same computation already deployed on the admin Sq-Off Orders
            // table (adminOrders.js) and the dealer Orders tab (orders.js's
            // sibling dealerAuth.js /client-data route) -- day_positions for
            // CM/equity, positions for FO, matched the same way in both.
            .query(`SELECT
                        o.order_id, o.ucc, o.exchange, o.segment, o.symbol,
                        o.quantity, o.executed_qty, o.side, o.order_type, o.status,
                        o.placed_at, o.traded_at, o.trade_price,
                        o.placed_by, o.dealer_id,
                        o.expiry_date, o.strike_price, o.option_type,
                        o.file_generated, o.file_generated_at,
                        CASE
                            WHEN o.status <> 'ORDER_RECEIVED' THEN 0
                            WHEN o.segment = 'CM' AND dp.net_qty = 0 THEN 1
                            WHEN o.segment = 'FO' AND p.net_qty  = 0 THEN 1
                            ELSE 0
                        END AS is_stale
                    FROM squareoff_orders o
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
                    WHERE o.ucc = @ucc
                    AND CAST(o.placed_at AS DATE) = CAST(GETDATE() AS DATE)
                    ORDER BY o.placed_at DESC`);
        return res.json({ success: true, orders: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Could not fetch orders.' });
    }
});

module.exports = router;