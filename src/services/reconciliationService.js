'use strict';
const { getConnection, sql } = require('../config/database');

// ── Run every 5 seconds ───────────────────────────────────────────────────────
const RECON_INTERVAL_MS = 30000; // 30s — reduces DB load on Azure SQL S1

// ── Status constants ──────────────────────────────────────────────────────────
const STATUS = {
  RECEIVED:         'ORDER_RECEIVED',
  FILE_GENERATED:   'FILE_GENERATED',
  PARTIALLY_TRADED: 'PARTIALLY_TRADED',
  TRADED:           'ORDER_TRADED',
  REJECTED:         'REJECTED',
};

// Open statuses that need reconciliation
const OPEN_STATUSES = [STATUS.RECEIVED, STATUS.FILE_GENERATED, STATUS.PARTIALLY_TRADED];

// ── Main reconciliation function ──────────────────────────────────────────────
let _reconRunning = false;

async function reconcile() {
    if (_reconRunning) return; // Prevent overlapping runs
    _reconRunning = true;
    let pool;
    try {
        pool = await getConnection();

        // Quick count — skip if no open orders (saves DB connections on idle periods)
        const cntRes = await pool.request().query(
            `SELECT COUNT(*) AS cnt FROM squareoff_orders
             WHERE status IN ('ORDER_RECEIVED','FILE_GENERATED','PARTIALLY_TRADED')
             AND placed_at >= CAST(GETDATE()-1 AS DATE)`
        );
        if (!cntRes.recordset[0].cnt) return;

        // Step 1: Get all open orders
        const openOrders = await pool.request().query(`
            SELECT order_id, ucc, exchange, segment, symbol, isin,
                   side, quantity, executed_qty, remaining_qty,
                   status, placed_at,
                   expiry_date, strike_price, option_type
            FROM squareoff_orders
            WHERE status IN ('ORDER_RECEIVED','FILE_GENERATED','PARTIALLY_TRADED')
            AND placed_at >= CAST(GETDATE()-1 AS DATE)
        `);

        if (openOrders.recordset.length === 0) return;

        console.log(`[Recon] Processing ${openOrders.recordset.length} open orders`);

        for (const order of openOrders.recordset) {
            try {
                await reconcileOrder(pool, order);
            } catch (err) {
                console.error(`[Recon] Error on order ${order.order_id}:`, err.message);
            }
        }
    } catch (err) {
        console.error('[Recon] DB connection error:', err.message);
    } finally {
        _reconRunning = false;
    }
}

// ── Reconcile a single order ──────────────────────────────────────────────────
async function reconcileOrder(pool, order) {
    const isFO = order.segment === 'FO' || order.segment === 'FO' ||
                 ['FO','NSEFO','NFO'].includes((order.segment||'').toUpperCase().trim());
    const isCM = order.segment === 'CM' || ['CM','NSECM','BSECM'].includes((order.segment||'').toUpperCase().trim());

    let executedQty = 0;

    if (isFO) {
        executedQty = await getFOExecutedQty(pool, order);
    } else if (isCM) {
        executedQty = await getCMExecutedQty(pool, order);
    } else {
        return; // MCX - skip for now
    }

    const requestedQty  = Number(order.quantity)     || 0;
    const prevExecuted  = Number(order.executed_qty) || 0;
    const remainingQty  = Math.max(0, requestedQty - executedQty);

    // Determine new status
    let newStatus;
    if (executedQty <= 0) {
        newStatus = order.status; // no change
    } else if (executedQty >= requestedQty) {
        newStatus = STATUS.TRADED;
    } else {
        newStatus = STATUS.PARTIALLY_TRADED;
    }

    // Only update if something changed
    if (newStatus === order.status && executedQty === prevExecuted) return;
    if (newStatus === order.status && executedQty === 0) return;

    console.log(`[Recon] ${order.order_id} | ${order.symbol} | ${order.ucc} | ` +
                `${order.status} → ${newStatus} | Exec:${executedQty}/${requestedQty}`);

    // Update squareoff_orders
    await pool.request()
        .input('orderId',      sql.VarChar(50),   order.order_id)
        .input('status',       sql.VarChar(30),   newStatus)
        .input('executedQty',  sql.Decimal(18,2), executedQty)
        .input('remainingQty', sql.Decimal(18,2), remainingQty)
        .input('tradedAt',     sql.DateTime,      newStatus === STATUS.TRADED ? new Date() : null)
        .query(`
            UPDATE squareoff_orders
            SET status        = @status,
                executed_qty  = @executedQty,
                remaining_qty = @remainingQty,
                traded_at     = CASE WHEN @tradedAt IS NOT NULL THEN @tradedAt ELSE traded_at END
            WHERE order_id = @orderId
        `);

    // Write audit trail
    await pool.request()
        .input('orderId',      sql.VarChar(50),   order.order_id)
        .input('ucc',          sql.VarChar(20),   order.ucc)
        .input('oldStatus',    sql.VarChar(30),   order.status)
        .input('newStatus',    sql.VarChar(30),   newStatus)
        .input('executedQty',  sql.Decimal(18,2), executedQty)
        .input('remainingQty', sql.Decimal(18,2), remainingQty)
        .query(`
            INSERT INTO sqoff_status_audit
                (order_id, ucc, old_status, new_status, executed_qty, remaining_qty, changed_at)
            VALUES
                (@orderId, @ucc, @oldStatus, @newStatus, @executedQty, @remainingQty, GETDATE())
        `);
}

// ── FO Matching ───────────────────────────────────────────────────────────────
// Match: UCC + symbol + exchange + segment + expiry + strike + option_type
// Trade time must be AFTER order placed_at
async function getFOExecutedQty(pool, order) {
    const sideCol = (order.side || '').toUpperCase() === 'BUY' ? 'buy_qty' : 'sell_qty';

    const result = await pool.request()
        .input('ucc',         sql.VarChar(20),   order.ucc)
        .input('symbol',      sql.VarChar(50),   order.symbol)
        .input('exchange',    sql.VarChar(10),   order.exchange)
        .input('placedAt',    sql.DateTime,      new Date(order.placed_at))
        .input('expiry',      sql.Date,          order.expiry_date ? new Date(order.expiry_date) : null)
        .input('strike',      sql.Decimal(18,2), order.strike_price || null)
        .input('optionType',  sql.VarChar(5),    order.option_type || null)
        .query(`
            SELECT SUM(${sideCol}) AS executed_qty
            FROM day_positions
            WHERE ucc          = @ucc
            AND   symbol       = @symbol
            AND   exchange     = @exchange
            AND   last_updated > @placedAt
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

    return Number(result.recordset[0]?.executed_qty) || 0;
}

// ── CM Matching ───────────────────────────────────────────────────────────────
// Match: UCC + ISIN (via symbol_master) + exchange + trade date
// Trade time must be AFTER order placed_at
async function getCMExecutedQty(pool, order) {
    if (!order.isin) {
        // Try matching by symbol directly if no ISIN stored yet
        return getCMExecutedQtyBySymbol(pool, order);
    }

    const sideCol = (order.side || '').toUpperCase() === 'BUY' ? 'buy_qty' : 'sell_qty';

    const result = await pool.request()
        .input('ucc',      sql.VarChar(20),  order.ucc)
        .input('isin',     sql.VarChar(20),  order.isin)
        .input('placedAt', sql.DateTime,     new Date(order.placed_at))
        .query(`
            SELECT SUM(dp.${sideCol}) AS executed_qty
            FROM day_positions dp
            JOIN symbol_master sm ON dp.symbol = sm.nse_symbol OR dp.symbol = sm.bse_symbol
            WHERE dp.ucc          = @ucc
            AND   sm.isin         = @isin
            AND   dp.last_updated > @placedAt
            AND   dp.trade_date   = CAST(GETDATE() AS DATE)
            AND   dp.segment      = 'CM'
        `);

    return Number(result.recordset[0]?.executed_qty) || 0;
}

// CM matching by direct symbol (squareoff_orders.symbol = day_positions.symbol for CM)
async function getCMExecutedQtyBySymbol(pool, order) {
    const sideCol = (order.side || '').toUpperCase() === 'BUY' ? 'buy_qty' : 'sell_qty';

    // PRIMARY: Direct symbol match — squareoff_orders.symbol matches day_positions.symbol
    // e.g. both have 'WIPRO' for NSE CM trades
    const directResult = await pool.request()
        .input('ucc',      sql.VarChar(20), order.ucc)
        .input('symbol',   sql.VarChar(100), order.symbol.trim())
        .input('exchange', sql.VarChar(10),  order.exchange)
        .input('placedAt', sql.DateTime,     new Date(order.placed_at))
        .query(`
            SELECT SUM(dp.${sideCol}) AS executed_qty
            FROM day_positions dp
            WHERE dp.ucc          = @ucc
            AND   dp.symbol       = @symbol
            AND   dp.exchange     = @exchange
            AND   dp.segment      = 'CM'
            AND   dp.last_updated > @placedAt
            AND   dp.trade_date   = CAST(GETDATE() AS DATE)
        `);

    const directQty = Number(directResult.recordset[0]?.executed_qty) || 0;
    if (directQty > 0) return directQty;

    // FALLBACK: symbol_master lookup using first word of symbol name
    // (handles cases where squareoff_orders stores full name like 'WIPRO LTD')
    const firstWord = order.symbol.trim().split(/\s+/)[0];
    const symResult = await pool.request()
        .input('symbol',   sql.VarChar(50),  firstWord)
        .input('nameLike', sql.VarChar(200), `%${firstWord}%`)
        .query(`
            SELECT TOP 1 nse_symbol, bse_symbol FROM symbol_master
            WHERE (nse_symbol = @symbol OR bse_symbol = @symbol
                   OR company_name LIKE @nameLike)
            AND is_active = 1
        `);

    if (symResult.recordset.length === 0) return 0;

    const nseSymbol = symResult.recordset[0].nse_symbol || '';
    const bseSymbol = symResult.recordset[0].bse_symbol || '';
    if (!nseSymbol && !bseSymbol) return 0;

    const fallbackResult = await pool.request()
        .input('ucc',       sql.VarChar(20), order.ucc)
        .input('nseSymbol', sql.VarChar(50), nseSymbol)
        .input('bseSymbol', sql.VarChar(50), bseSymbol)
        .input('placedAt',  sql.DateTime,    new Date(order.placed_at))
        .query(`
            SELECT SUM(dp.${sideCol}) AS executed_qty
            FROM day_positions dp
            WHERE dp.ucc      = @ucc
            AND  (dp.symbol   = @nseSymbol OR dp.symbol = @bseSymbol)
            AND   dp.segment  = 'CM'
            AND   dp.last_updated > @placedAt
            AND   dp.trade_date   = CAST(GETDATE() AS DATE)
        `);

    return Number(fallbackResult.recordset[0]?.executed_qty) || 0;
}

// ── Start service ─────────────────────────────────────────────────────────────
function startReconciliationService() {
    console.log('[Recon] Trade reconciliation service starting — interval: 5s');
    // Run immediately on start
    reconcile();
    // Then every 5 seconds
    setInterval(reconcile, RECON_INTERVAL_MS);
}

module.exports = { startReconciliationService, reconcile };