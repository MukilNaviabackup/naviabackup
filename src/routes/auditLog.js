'use strict';
const express = require('express');
const router  = express.Router();
const { getConnection, sql } = require('../config/database');
require('dotenv').config();

// ── Validate read-only audit token ────────────────────────────────────────────
const crypto = require('crypto');

function validateAuditToken(req, res, next) {
    const token = req.headers['x-audit-token'] || req.query.token;
    if (!token) {
        return res.status(401).json({ error: 'Audit token required.' });
    }
    const tokenHash = crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');
    if (tokenHash !== process.env.AUDIT_READ_TOKEN) {
        return res.status(401).json({ error: 'Invalid audit token.' });
    }
    next();
}

// ── Helper: get IST date string ───────────────────────────────────────────────
function getISTDate(dateStr) {
    if (dateStr) return dateStr;
    const now     = new Date();
    const istDate = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    return istDate.toISOString().slice(0, 10);
}

// ── GET /api/audit/logs ───────────────────────────────────────────────────────
// Query params: date (YYYY-MM-DD), type (all/client/admin/dealer/order/dropcopy)
// Headers: x-audit-token OR query param: token
router.get('/logs', validateAuditToken, async (req, res) => {
    const date   = getISTDate(req.query.date);
    const type   = req.query.type || 'all';
    const format = req.query.format || 'json';
    const page   = parseInt(req.query.page)  || 1;
    const limit  = parseInt(req.query.limit) || 500;
    const offset = (page - 1) * limit;

    try {
        const pool = await getConnection();
        const logs = [];

        // ── 1. Client login activity ──────────────────────────────────────────
        if (type === 'all' || type === 'client') {
            const clientLogs = await pool.request()
                .input('date', sql.Date, new Date(date))
                .query(`
                    SELECT
                        sl.created_at,
                        'CLIENT'         AS actor_type,
                        sl.actor         AS actor,
                        c.ucc            AS ucc,
                        c.client_name    AS name,
                        sl.log_type      AS action,
                        sl.details       AS details,
                        sl.ip_address    AS ip,
                        sl.status        AS status
                    FROM system_logs sl
                    LEFT JOIN clients c ON sl.ucc = c.ucc
                    WHERE CAST(sl.created_at AS DATE) = @date
                    AND sl.actor_type = 'CLIENT'
                    ORDER BY sl.created_at DESC
                `);
            clientLogs.recordset.forEach(r => logs.push(r));
        }

        // ── 2. Admin activity ─────────────────────────────────────────────────
        if (type === 'all' || type === 'admin') {
            const adminLogs = await pool.request()
                .input('date', sql.Date, new Date(date))
                .query(`
                    SELECT
                        sl.created_at,
                        'ADMIN'          AS actor_type,
                        sl.actor         AS actor,
                        NULL             AS ucc,
                        a.full_name      AS name,
                        sl.log_type      AS action,
                        sl.details       AS details,
                        sl.ip_address    AS ip,
                        sl.status        AS status
                    FROM system_logs sl
                    LEFT JOIN admin_users a ON sl.actor = a.username
                    WHERE CAST(sl.created_at AS DATE) = @date
                    AND sl.actor_type = 'ADMIN'
                    ORDER BY sl.created_at DESC
                `);
            adminLogs.recordset.forEach(r => logs.push(r));
        }

        // ── 3. Dealer activity ────────────────────────────────────────────────
        if (type === 'all' || type === 'dealer') {
            const dealerLogs = await pool.request()
                .input('date', sql.Date, new Date(date))
                .query(`
                    SELECT
                        sl.created_at,
                        'DEALER'         AS actor_type,
                        sl.actor         AS actor,
                        sl.ucc           AS ucc,
                        NULL             AS name,
                        sl.log_type      AS action,
                        sl.details       AS details,
                        sl.ip_address    AS ip,
                        sl.status        AS status
                    FROM system_logs sl
                    WHERE CAST(sl.created_at AS DATE) = @date
                    AND sl.actor_type = 'DEALER'
                    ORDER BY sl.created_at DESC
                `);
            dealerLogs.recordset.forEach(r => logs.push(r));
        }

        // ── 4. Square-off orders ──────────────────────────────────────────────
        if (type === 'all' || type === 'order') {
            const orderLogs = await pool.request()
                .input('date', sql.Date, new Date(date))
                .query(`
                    SELECT
                        o.placed_at      AS created_at,
                        'ORDER'          AS actor_type,
                        c.ucc            AS actor,
                        c.ucc            AS ucc,
                        c.client_name    AS name,
                        'SQUAREOFF_' + o.side AS action,
                        o.exchange + ' ' + o.segment + ' ' + o.symbol
                            + ' Qty:' + CAST(o.quantity AS VARCHAR)
                            + ' Status:' + o.status
                                         AS details,
                        NULL             AS ip,
                        o.status         AS status
                    FROM orders o
                    LEFT JOIN clients c ON o.ucc = c.ucc
                    WHERE CAST(o.placed_at AS DATE) = @date
                    ORDER BY o.placed_at DESC
                `);
            orderLogs.recordset.forEach(r => logs.push(r));
        }

        // ── 5. DropCopy sync activity ─────────────────────────────────────────
        if (type === 'all' || type === 'dropcopy') {
            const syncLogs = await pool.request()
                .input('date', sql.Date, new Date(date))
                .query(`
                    SELECT
                        last_updated     AS created_at,
                        'DROPCOPY'       AS actor_type,
                        'SYSTEM'         AS actor,
                        ucc              AS ucc,
                        NULL             AS name,
                        'DAY_POSITION_SYNC' AS action,
                        exchange + ' ' + segment + ' ' + symbol
                            + ' BuyQty:' + CAST(buy_qty AS VARCHAR)
                            + ' SellQty:' + CAST(sell_qty AS VARCHAR)
                            + ' NetQty:' + CAST(net_qty AS VARCHAR)
                                         AS details,
                        NULL             AS ip,
                        'SUCCESS'        AS status
                    FROM day_positions
                    WHERE trade_date = @date
                    ORDER BY last_updated DESC
                `);
            syncLogs.recordset.forEach(r => logs.push(r));
        }

        // ── 6. B/F upload activity ────────────────────────────────────────────
        if (type === 'all' || type === 'admin') {
            const bfLogs = await pool.request()
                .input('date', sql.Date, new Date(date))
                .query(`
                    SELECT
                        created_at,
                        'ADMIN'          AS actor_type,
                        uploaded_by      AS actor,
                        NULL             AS ucc,
                        uploaded_by      AS name,
                        'BF_FILE_UPLOAD' AS action,
                        'Exchange:' + exchange
                            + ' BizDate:' + CONVERT(VARCHAR, biz_date, 23)
                            + ' Inserted:' + CAST(inserted AS VARCHAR)
                            + ' Skipped:' + CAST(skipped AS VARCHAR)
                            + ' File:' + filename
                                         AS details,
                        NULL             AS ip,
                        'SUCCESS'        AS status
                    FROM bf_upload_logs
                    WHERE CAST(created_at AS DATE) = @date
                    ORDER BY created_at DESC
                `);
            bfLogs.recordset.forEach(r => logs.push(r));
        }

        // ── Sort all logs by time descending ──────────────────────────────────
        logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        const total      = logs.length;
        const paginated  = logs.slice(offset, offset + limit);

        // ── Summary stats ─────────────────────────────────────────────────────
        const summary = {
            date,
            total_events:      total,
            client_logins:     logs.filter(l => l.action === 'CLIENT_LOGIN_SUCCESS').length,
            failed_logins:     logs.filter(l => l.action === 'CLIENT_LOGIN_FAILED').length,
            otp_sent:          logs.filter(l => l.action === 'CLIENT_OTP_SENT').length,
            squareoffs_placed: logs.filter(l => l.actor_type === 'ORDER').length,
            admin_actions:     logs.filter(l => l.actor_type === 'ADMIN').length,
            dealer_actions:    logs.filter(l => l.actor_type === 'DEALER').length,
            day_pos_syncs:     logs.filter(l => l.actor_type === 'DROPCOPY').length,
            unique_clients:    [...new Set(logs.filter(l => l.ucc).map(l => l.ucc))].length,
        };

        // ── CSV format ────────────────────────────────────────────────────────
        if (format === 'csv') {
            const headers = ['Timestamp', 'Actor Type', 'Actor', 'UCC', 'Name', 'Action', 'Details', 'IP', 'Status'];
            const rows    = paginated.map(l => [
                l.created_at ? new Date(l.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '',
                l.actor_type || '',
                l.actor      || '',
                l.ucc        || '',
                l.name       || '',
                l.action     || '',
                (l.details   || '').replace(/,/g, ';'),
                l.ip         || '',
                l.status     || ''
            ].join(','));

            const csv = [headers.join(','), ...rows].join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="navia_audit_log_${date}.csv"`);
            return res.send(csv);
        }

        // ── JSON format (default) ─────────────────────────────────────────────
        return res.json({
            success: true,
            summary,
            pagination: {
                date,
                page,
                limit,
                total,
                total_pages: Math.ceil(total / limit),
                has_next:    page * limit < total,
            },
            logs: paginated
        });

    } catch (err) {
        console.error('[Audit] Error:', err.message);
        return res.status(500).json({ error: 'Failed to fetch audit logs: ' + err.message });
    }
});

// ── GET /api/audit/orders ─────────────────────────────────────────────────────
// All square-off orders for a date with client details
router.get('/orders', validateAuditToken, async (req, res) => {
    const date   = getISTDate(req.query.date);
    const format = req.query.format || 'json';

    try {
        const pool   = await getConnection();
        const result = await pool.request()
            .input('date', sql.Date, new Date(date))
            .query(`
                SELECT
                    o.order_id,
                    o.placed_at,
                    o.ucc,
                    c.client_name,
                    c.mobile,
                    o.exchange,
                    o.segment,
                    o.symbol,
                    o.side,
                    o.quantity,
                    o.order_type,
                    o.status,
                    o.placed_by,
                    o.dealer_id
                FROM orders o
                LEFT JOIN clients c ON o.ucc = c.ucc
                WHERE CAST(o.placed_at AS DATE) = @date
                ORDER BY o.placed_at DESC
            `);

        if (format === 'csv') {
            const headers = ['Order ID', 'Time (IST)', 'UCC', 'Client Name', 'Mobile', 'Exchange', 'Segment', 'Symbol', 'Side', 'Quantity', 'Type', 'Status', 'Placed By', 'Dealer ID'];
            const rows    = result.recordset.map(o => [
                o.order_id,
                new Date(o.placed_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                o.ucc, o.client_name, o.mobile,
                o.exchange, o.segment, o.symbol,
                o.side, o.quantity, o.order_type, o.status,
                o.placed_by || 'CLIENT', o.dealer_id || ''
            ].join(','));
            const csv = [headers.join(','), ...rows].join('\n');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="navia_orders_${date}.csv"`);
            return res.send(csv);
        }

        return res.json({
            success: true,
            date,
            total:  result.recordset.length,
            orders: result.recordset
        });

    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch orders: ' + err.message });
    }
});

// ── GET /api/audit/day-positions ──────────────────────────────────────────────
// All client day positions for a date
router.get('/day-positions', validateAuditToken, async (req, res) => {
    const date   = getISTDate(req.query.date);
    const ucc    = req.query.ucc    || null;
    const format = req.query.format || 'json';

    try {
        const pool    = await getConnection();
        const request = pool.request().input('date', sql.Date, new Date(date));
        if (ucc) request.input('ucc', sql.VarChar(20), ucc);

        const result = await request.query(`
            SELECT
                dp.ucc,
                c.client_name,
                dp.exchange,
                dp.segment,
                dp.symbol,
                dp.instrument_type,
                dp.expiry_date,
                dp.strike_price,
                dp.option_type,
                dp.buy_qty,
                dp.sell_qty,
                dp.net_qty,
                dp.avg_buy_price,
                dp.avg_sell_price,
                dp.lot_size,
                dp.trade_date,
                dp.last_updated,
                dp.file_source
            FROM day_positions dp
            LEFT JOIN clients c ON dp.ucc = c.ucc
            WHERE dp.trade_date = @date
            ${ucc ? 'AND dp.ucc = @ucc' : ''}
            ORDER BY dp.ucc, dp.instrument_type, dp.symbol
        `);

        if (format === 'csv') {
            const headers = ['UCC', 'Client Name', 'Exchange', 'Segment', 'Symbol', 'Instrument', 'Expiry', 'Strike', 'Option Type', 'Buy Qty', 'Sell Qty', 'Net Qty', 'Avg Buy', 'Avg Sell', 'Lot Size', 'Trade Date', 'Last Updated'];
            const rows    = result.recordset.map(r => [
                r.ucc, r.client_name, r.exchange, r.segment, r.symbol,
                r.instrument_type, r.expiry_date || '', r.strike_price || '',
                r.option_type || '', r.buy_qty, r.sell_qty, r.net_qty,
                r.avg_buy_price || '', r.avg_sell_price || '', r.lot_size,
                r.trade_date ? new Date(r.trade_date).toISOString().slice(0,10) : '',
                r.last_updated ? new Date(r.last_updated).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : ''
            ].join(','));
            const csv = [headers.join(','), ...rows].join('\n');
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="navia_day_positions_${date}.csv"`);
            return res.send(csv);
        }

        const summary = {
            date,
            total_positions: result.recordset.length,
            unique_clients:  [...new Set(result.recordset.map(r => r.ucc))].length,
            equity:          result.recordset.filter(r => r.instrument_type === 'EQUITY').length,
            options:         result.recordset.filter(r => r.instrument_type === 'OPTIONS').length,
            futures:         result.recordset.filter(r => r.instrument_type === 'FUTURES').length,
        };

        return res.json({ success: true, summary, positions: result.recordset });

    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch day positions: ' + err.message });
    }
});

// ── GET /api/audit/client-activity ───────────────────────────────────────────
// Specific client full activity for a date
router.get('/client-activity', validateAuditToken, async (req, res) => {
    const date = getISTDate(req.query.date);
    const ucc  = req.query.ucc;

    if (!ucc) return res.status(400).json({ error: 'ucc parameter is required.' });

    try {
        const pool = await getConnection();

        const [clientInfo, orders, dayPos, bfPos] = await Promise.all([
            pool.request().input('ucc', sql.VarChar(20), ucc)
                .query(`SELECT ucc, client_name, mobile, email FROM clients WHERE ucc = @ucc`),
            pool.request().input('ucc', sql.VarChar(20), ucc).input('date', sql.Date, new Date(date))
                .query(`SELECT * FROM orders WHERE ucc = @ucc AND CAST(placed_at AS DATE) = @date ORDER BY placed_at DESC`),
            pool.request().input('ucc', sql.VarChar(20), ucc).input('date', sql.Date, new Date(date))
                .query(`SELECT * FROM day_positions WHERE ucc = @ucc AND trade_date = @date ORDER BY instrument_type, symbol`),
            // FIX: was always pulling the MOST RECENT biz_date ever uploaded,
            // ignoring the @date being looked up — inconsistent with orders
            // and day_positions above, which both correctly use @date.
            // Now filters by the same requested date as the rest of this route.
            pool.request().input('ucc', sql.VarChar(20), ucc).input('date', sql.Date, new Date(date))
                .query(`SELECT * FROM bf_positions WHERE ucc = @ucc AND biz_date = @date ORDER BY instrument_type, symbol`)
        ]);

        return res.json({
            success: true,
            date,
            client:        clientInfo.recordset[0] || null,
            orders:        orders.recordset,
            day_positions: dayPos.recordset,
            bf_positions:  bfPos.recordset,
            summary: {
                orders_placed:    orders.recordset.length,
                day_positions:    dayPos.recordset.length,
                bf_positions:     bfPos.recordset.length,
                traded_orders:    orders.recordset.filter(o => o.status === 'TRADED').length,
                pending_orders:   orders.recordset.filter(o => o.status === 'RECEIVED').length,
            }
        });

    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch client activity: ' + err.message });
    }
});

module.exports = router;