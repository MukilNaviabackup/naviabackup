'use strict';
const express = require('express');
const router  = express.Router();
const { getConnection, sql } = require('../config/database');
const { adminAuthenticate }  = require('../middleware/adminAuthenticate');

// ─── GET /api/admin/logs ──────────────────────────────────────────────────────
// Main log viewer — with filters
router.get('/', adminAuthenticate, async (req, res) => {
    try {
        const {
            type, actor_type, ucc, status,
            from, to, search,
            page = 1, limit = 50
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);
        const pool   = await getConnection();
        const request = pool.request()
            .input('offset', sql.Int, offset)
            .input('limit',  sql.Int, parseInt(limit));

        let where = 'WHERE 1=1';

        if (type) {
            where += ' AND log_type = @type';
            request.input('type', sql.VarChar(100), type);
        }
        if (actor_type) {
            where += ' AND actor_type = @actorType';
            request.input('actorType', sql.VarChar(20), actor_type);
        }
        if (ucc) {
            where += ' AND ucc = @ucc';
            request.input('ucc', sql.VarChar(20), ucc);
        }
        if (status) {
            where += ' AND status = @status';
            request.input('status', sql.VarChar(20), status);
        }
        if (from) {
            where += ' AND created_at >= @from';
            request.input('from', sql.DateTime, new Date(from));
        }
        if (to) {
            where += ' AND created_at <= @to';
            request.input('to', sql.DateTime, new Date(to));
        }
        if (search) {
            where += ' AND (details LIKE @search OR actor LIKE @search OR ucc LIKE @search)';
            request.input('search', sql.VarChar(100), `%${search}%`);
        }

        const [logsResult, countResult] = await Promise.all([
            request.query(`
                SELECT log_id, log_type, actor, actor_type, ucc,
                       ip_address, details, status, meta, created_at
                FROM system_logs
                ${where}
                ORDER BY created_at DESC
                OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
            `),
            pool.request().query(`SELECT COUNT(*) AS total FROM system_logs ${where}`)
        ]);

        return res.json({
            success: true,
            logs:    logsResult.recordset,
            total:   countResult.recordset[0].total,
            page:    parseInt(page),
            limit:   parseInt(limit)
        });

    } catch (err) {
        console.error('[SystemLogs] Error:', err.message);
        return res.status(500).json({ error: 'Failed to fetch logs.' });
    }
});

// ─── GET /api/admin/logs/summary ─────────────────────────────────────────────
// Dashboard summary stats
router.get('/summary', adminAuthenticate, async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().query(`
            SELECT
                -- Today's counts
                SUM(CASE WHEN log_type = 'CLIENT_LOGIN_SUCCESS'  AND CAST(created_at AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS client_logins_today,
                SUM(CASE WHEN log_type = 'ADMIN_LOGIN_SUCCESS'   AND CAST(created_at AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS admin_logins_today,
                SUM(CASE WHEN log_type = 'DEALER_LOGIN_SUCCESS'  AND CAST(created_at AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS dealer_logins_today,
                SUM(CASE WHEN log_type = 'DEALER_SSO_GENERATED'  AND CAST(created_at AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS sso_generated_today,
                SUM(CASE WHEN log_type = 'CLIENT_OTP_SENT'       AND CAST(created_at AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS otp_sent_today,
                SUM(CASE WHEN log_type = 'SQUAREOFF_PLACED'      AND CAST(created_at AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS squareoff_today,
                SUM(CASE WHEN log_type = 'ALERT_WHATSAPP_SENT'   AND CAST(created_at AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS whatsapp_today,
                SUM(CASE WHEN log_type = 'CLIENT_LOGIN_FAILED'   AND CAST(created_at AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS failed_logins_today,
                SUM(CASE WHEN log_type = 'SECURITY_BLOCKED'      AND CAST(created_at AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS security_blocks_today,
                SUM(CASE WHEN log_type = 'CLIENT_CREATED'        AND CAST(created_at AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS clients_created_today,
                SUM(CASE WHEN log_type = 'BF_FILE_UPLOADED'      AND CAST(created_at AS DATE) = CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END) AS bf_uploads_today,
                -- All time
                SUM(CASE WHEN log_type = 'CLIENT_LOGIN_SUCCESS'  THEN 1 ELSE 0 END) AS total_client_logins,
                SUM(CASE WHEN log_type = 'SQUAREOFF_PLACED'      THEN 1 ELSE 0 END) AS total_squareoffs,
                SUM(CASE WHEN status   = 'FAILED'                THEN 1 ELSE 0 END) AS total_failures,
                SUM(CASE WHEN status   = 'BLOCKED'               THEN 1 ELSE 0 END) AS total_blocked,
                COUNT(*)                                                              AS total_logs
            FROM system_logs
        `);

        return res.json({ success: true, summary: result.recordset[0] });

    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch summary.' });
    }
});

// ─── GET /api/admin/logs/types ────────────────────────────────────────────────
router.get('/types', adminAuthenticate, async (req, res) => {
    try {
        const pool   = await getConnection();
        const result = await pool.request().query(`
            SELECT log_type, COUNT(*) AS count
            FROM system_logs
            GROUP BY log_type
            ORDER BY count DESC
        `);
        return res.json({ success: true, types: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch log types.' });
    }
});

// ─── GET /api/admin/logs/client/:ucc ─────────────────────────────────────────
// All logs for a specific client
router.get('/client/:ucc', adminAuthenticate, async (req, res) => {
    try {
        const pool   = await getConnection();
        const result = await pool.request()
            .input('ucc', sql.VarChar(20), req.params.ucc)
            .query(`
                SELECT log_id, log_type, actor, actor_type,
                       ip_address, details, status, created_at
                FROM system_logs
                WHERE ucc = @ucc
                ORDER BY created_at DESC
            `);
        return res.json({ success: true, logs: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch client logs.' });
    }
});

// ─── GET /api/admin/logs/export ───────────────────────────────────────────────
// Export logs as CSV
router.get('/export', adminAuthenticate, async (req, res) => {
    try {
        const { from, to, type } = req.query;
        const pool    = await getConnection();
        const request = pool.request();

        let where = 'WHERE 1=1';
        if (from) { where += ' AND created_at >= @from'; request.input('from', sql.DateTime, new Date(from)); }
        if (to)   { where += ' AND created_at <= @to';   request.input('to',   sql.DateTime, new Date(to)); }
        if (type) { where += ' AND log_type = @type';    request.input('type', sql.VarChar(100), type); }

        const result = await request.query(`
            SELECT log_id, log_type, actor, actor_type, ucc,
                   ip_address, details, status, created_at
            FROM system_logs ${where}
            ORDER BY created_at DESC
        `);

        // Build CSV
        const headers = ['log_id','log_type','actor','actor_type','ucc','ip_address','details','status','created_at'];
        const rows    = result.recordset.map(r =>
            headers.map(h => `"${(r[h] || '').toString().replace(/"/g, '""')}"`).join(',')
        );
        const csv = [headers.join(','), ...rows].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="navia_backup_logs_${new Date().toISOString().slice(0,10)}.csv"`);
        return res.send(csv);

    } catch (err) {
        return res.status(500).json({ error: 'Failed to export logs.' });
    }
});

module.exports = router;