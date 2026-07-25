const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const { getConnection, sql } = require('../config/database');
const { adminAuthenticate, requireFullAdmin } = require('../middleware/adminAuthenticate');
require('dotenv').config();

// Segment Control (2026-07-25): the terminals a segment can be routed
// through. XTS added as a third terminal alongside the existing INHOUSE/BOW.
// A segment now supports MULTIPLE terminals at once, stored as a
// comma-separated string in segment_controls.terminals (e.g. "INHOUSE,XTS").
// The legacy single-value `terminal` column is left in place, untouched by
// reads, so nothing else that may reference it elsewhere breaks.
const VALID_TERMINALS = ['INHOUSE', 'BOW', 'XTS'];

function createTransporter() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.zatpatmail.com',
        port: 465,
        secure: true,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
        tls: { rejectUnauthorized: false }
    });
}

async function sendWhatsApp(mobile, clientName, ucc) {
    try {
        const mobileClean = mobile.toString().replace(/\D/g, '');
        const waNumber = mobileClean.startsWith('91') ? mobileClean : `91${mobileClean}`;
        const waPayload = {
            messaging_product: 'whatsapp',
            to: waNumber,
            type: 'template',
            template: {
                name: 'azure_navia_test_u',
                language: { policy: 'deterministic', code: 'en' },
                components: [{
                    type: 'body',
                    parameters: [
                        { type: 'text', text: clientName || ucc },
                        { type: 'text', text: ucc }
                    ]
                }]
            }
        };
        const waRes  = await fetch('https://waba-v2.360dialog.io/messages', {
            method: 'POST',
            headers: {
                'D360-API-KEY': process.env.WABA_API_KEY || 'fMEhZfQoSD1T80Q7a8Dez1OpAK',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(waPayload)
        });
        const waData = await waRes.json();
        if (waData.messages && waData.messages[0]?.id) {
            console.log(`WhatsApp sent to ${ucc} (${waNumber}): ${waData.messages[0].id}`);
            return { success: true };
        } else {
            console.error(`WhatsApp failed for ${ucc}:`, JSON.stringify(waData));
            return { success: false, error: JSON.stringify(waData) };
        }
    } catch (err) {
        console.error(`WhatsApp error for ${ucc}:`, err.message);
        return { success: false, error: err.message };
    }
}

// ── GET /api/admin/control/segments ──────────────────────────────────────────
router.get('/segments', adminAuthenticate, async (req, res) => {
    try {
        const pool   = await getConnection();
        const result = await pool.request()
            .query(`SELECT sc.*,
                    e.full_name as enabled_by_name,
                    d.full_name as disabled_by_name
                    FROM segment_controls sc
                    LEFT JOIN admin_users e ON sc.enabled_by  = e.admin_id
                    LEFT JOIN admin_users d ON sc.disabled_by = d.admin_id
                    ORDER BY sc.exchange, sc.segment`);
        return res.json({ success: true, segments: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Could not fetch segments.' });
    }
});

// ── POST /api/admin/control/segments/toggle ───────────────────────────────────
router.post('/segments/toggle', adminAuthenticate, requireFullAdmin, async (req, res) => {
    const { exchange, segment, enable, notes, terminals } = req.body;
    if (!exchange || !segment)
        return res.status(400).json({ error: 'Exchange and segment are required.' });
    const termList = Array.isArray(terminals)
        ? terminals.map(t => (t || '').toUpperCase()).filter(t => VALID_TERMINALS.includes(t))
        : [];
    if (enable && termList.length === 0)
        return res.status(400).json({ error: 'Please select at least one terminal (Inhouse, BoW or XTS) before enabling a segment.', code: 'TERMINAL_REQUIRED' });
    const termsStr = termList.length > 0 ? termList.join(',') : null;
    try {
        const pool = await getConnection();
        await pool.request()
            .input('exchange',  sql.VarChar, exchange.toUpperCase())
            .input('segment',   sql.VarChar, segment.toUpperCase())
            .input('enable',    sql.Bit,     enable ? 1 : 0)
            .input('adminId',   sql.Int,     req.admin.adminId)
            .input('notes',     sql.VarChar, notes || '')
            .input('terminals', sql.VarChar(50), termsStr)
            .query(`UPDATE segment_controls SET
                    is_enabled  = @enable,
                    enabled_by  = CASE WHEN @enable = 1 THEN @adminId ELSE enabled_by  END,
                    enabled_at  = CASE WHEN @enable = 1 THEN GETDATE() ELSE enabled_at  END,
                    disabled_by = CASE WHEN @enable = 0 THEN @adminId ELSE disabled_by END,
                    disabled_at = CASE WHEN @enable = 0 THEN GETDATE() ELSE disabled_at END,
                    notes       = @notes,
                    terminals   = CASE WHEN @terminals IS NOT NULL THEN @terminals WHEN @enable = 0 THEN NULL ELSE terminals END,
                    terminal    = CASE WHEN @enable = 0 THEN NULL ELSE terminal END
                    WHERE exchange = @exchange AND segment = @segment`);
        await pool.request()
            .input('adminId', sql.Int,     req.admin.adminId)
            .input('action',  sql.VarChar, enable ? 'SEGMENT_ENABLED' : 'SEGMENT_DISABLED')
            .input('details', sql.VarChar, `${exchange} ${segment} ${enable ? 'enabled' : 'disabled'}`)
            .query(`INSERT INTO admin_logs (admin_id, action, details) VALUES (@adminId, @action, @details)`);
        return res.json({ success: true, message: `${exchange} ${segment} ${enable ? 'enabled' : 'disabled'} successfully` });
    } catch (err) {
        console.error('Segment toggle error:', err);
        return res.status(500).json({ error: 'Failed to update segment.' });
    }
});

// ── POST /api/admin/control/segments/terminals ────────────────────────────────
// Updates which terminal(s) are actively serving an ALREADY-ENABLED segment,
// without touching is_enabled/enabled_at/disabled_at. Lets an admin swap a
// terminal live (e.g. Inhouse goes down mid-day -> tick BoW, untick Inhouse)
// without a disable/enable cycle that would interrupt client access.
router.post('/segments/terminals', adminAuthenticate, requireFullAdmin, async (req, res) => {
    const { exchange, segment, terminals } = req.body;
    if (!exchange || !segment)
        return res.status(400).json({ error: 'Exchange and segment are required.' });
    const termList = Array.isArray(terminals)
        ? terminals.map(t => (t || '').toUpperCase()).filter(t => VALID_TERMINALS.includes(t))
        : [];
    const termsStr = termList.length > 0 ? termList.join(',') : null;
    try {
        const pool  = await getConnection();
        const check = await pool.request()
            .input('exchange', sql.VarChar, exchange.toUpperCase())
            .input('segment',  sql.VarChar, segment.toUpperCase())
            .query(`SELECT is_enabled FROM segment_controls WHERE exchange = @exchange AND segment = @segment`);
        if (!check.recordset[0])
            return res.status(404).json({ error: 'Segment not found.' });
        if (!check.recordset[0].is_enabled)
            return res.status(400).json({ error: 'Segment is disabled. Use Enable to set its terminal(s).' });

        await pool.request()
            .input('exchange',  sql.VarChar, exchange.toUpperCase())
            .input('segment',   sql.VarChar, segment.toUpperCase())
            .input('terminals', sql.VarChar(50), termsStr)
            .query(`UPDATE segment_controls SET terminals = @terminals
                    WHERE exchange = @exchange AND segment = @segment`);
        await pool.request()
            .input('adminId', sql.Int,     req.admin.adminId)
            .input('action',  sql.VarChar, 'SEGMENT_TERMINALS_UPDATED')
            .input('details', sql.VarChar, `${exchange} ${segment} terminals set to ${termsStr || 'none'}`)
            .query(`INSERT INTO admin_logs (admin_id, action, details) VALUES (@adminId, @action, @details)`);
        return res.json({ success: true, message: `Terminal(s) updated for ${exchange} ${segment}.` });
    } catch (err) {
        console.error('Segment terminals update error:', err);
        return res.status(500).json({ error: 'Failed to update terminals.' });
    }
});

// ── GET /api/admin/control/clients/:exchange/:segment ─────────────────────────
router.get('/clients/:exchange/:segment', adminAuthenticate, async (req, res) => {
    const { exchange, segment } = req.params;
    try {
        const pool   = await getConnection();
        const result = await pool.request()
            .input('exchange', sql.VarChar, exchange.toUpperCase())
            .input('segment',  sql.VarChar, segment.toUpperCase())
            .query(`SELECT DISTINCT c.ucc, c.client_name, c.mobile, c.email
                    FROM clients c
                    INNER JOIN positions p ON c.ucc = p.ucc
                    WHERE p.exchange = @exchange
                    AND   p.segment  = @segment
                    AND   p.net_qty != 0
                    AND   c.is_active = 1
                    ORDER BY c.ucc`);
        return res.json({ success: true, clients: result.recordset, count: result.recordset.length });
    } catch (err) {
        return res.status(500).json({ error: 'Could not fetch clients.' });
    }
});

// ── POST /api/admin/control/communicate ──────────────────────────────────────
router.post('/communicate', adminAuthenticate, requireFullAdmin, async (req, res) => {
    const { exchange, segment, send_email, send_whatsapp } = req.body;
    if (!exchange || !segment)
        return res.status(400).json({ error: 'Exchange and segment are required.' });

    const backupUrl = process.env.BACKUP_URL || 'https://backup.navia.co.in';

    try {
        const pool = await getConnection();

        const segmentColumnMap = {
            'NSE_CM': 'nse_cm', 'NSE_FO': 'nse_fo', 'NSE_CD': 'nse_cd',
            'BSE_CM': 'bse_cm', 'BSE_FO': 'bse_fo', 'BSE_CD': 'bse_cd',
            'MCX_FO': 'mcx_fo',
        };
        const segKey    = `${exchange.toUpperCase()}_${segment.toUpperCase()}`;
        const segColumn = segmentColumnMap[segKey];
        if (!segColumn)
            return res.status(400).json({ error: `Unknown segment: ${exchange} ${segment}` });

        // Fetch this segment's active terminal(s), then filter clients by
        // them. `terminals` is a comma-separated list (e.g. "INHOUSE,XTS")
        // now that a segment can be served by more than one terminal at
        // once; fall back to the legacy single `terminal` column for any row
        // not yet migrated.
        const scRes = await pool.request()
            .input('exchange', sql.VarChar(10), exchange.toUpperCase())
            .input('segment',  sql.VarChar(10), segment.toUpperCase())
            .query(`SELECT terminals, terminal FROM segment_controls WHERE exchange = @exchange AND segment = @segment`);
        const segTerminals = scRes.recordset[0]?.terminals || scRes.recordset[0]?.terminal || null;

        const clientResult = await pool.request()
            .input('segTerminals', sql.VarChar(50), segTerminals)
            .query(`SELECT ucc, client_name, mobile, email
                    FROM clients
                    WHERE ${segColumn} = 1
                    AND is_active = 1
                    AND account_status = 'ACTIVE'
                    AND (@segTerminals IS NULL OR CHARINDEX(',' + terminal + ',', ',' + @segTerminals + ',') > 0)`);
        const clients = clientResult.recordset;

        if (clients.length === 0)
            return res.json({ success: true, message: 'No clients found.', sent: 0 });

        // ── Insert communication_log first to get comm_id ─────────────────────
        const commResult = await pool.request()
            .input('adminId',  sql.Int,         req.admin.adminId)
            .input('exchange', sql.VarChar(10),  exchange.toUpperCase())
            .input('segment',  sql.VarChar(10),  segment.toUpperCase())
            .input('count',    sql.Int,          clients.length)
            .input('content',  sql.VarChar(500), `Downtime notification sent for ${exchange.toUpperCase()} ${segment.toUpperCase()}`)
            .query(`INSERT INTO communication_log
                    (admin_id, exchange, segment, message_type, recipients_count, message_content)
                    OUTPUT INSERTED.comm_id
                    VALUES (@adminId, @exchange, @segment, 'BOTH', @count, @content)`);

        const commId = commResult.recordset[0].comm_id;

        let emailsSent    = 0;
        let whatsappSent  = 0;
        const transporter = createTransporter();

        for (const client of clients) {
            let emailStatus    = 'SKIPPED';
            let whatsappStatus = 'SKIPPED';
            let errorMsg       = null;

            // ── Send Email ────────────────────────────────────────────────────
            if (send_email && client.email) {
                try {
                    await transporter.sendMail({
                        from:    `"Navia Markets" <${process.env.SMTP_FROM || 'updates@navia.co.in'}>`,
                        to:      client.email,
                        subject: 'Important: Trading Platform Downtime — Use Navia Backup',
                        html: `
                            <div style="max-width:600px;margin:40px auto;font-family:Arial,sans-serif;border:1px solid #eef0f3;border-radius:12px;overflow:hidden">
                                <div style="background:#1e3a5f;padding:24px 32px">
                                    <span style="color:#fff;font-size:18px;font-weight:700">Navia Markets — Important Notice</span>
                                </div>
                                <div style="padding:32px">
                                    <p style="color:#374151;font-size:15px">Dear <strong>${client.client_name}</strong> (UCC: ${client.ucc}),</p>
                                    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:16px 0">
                                        <p style="color:#dc2626;font-size:14px;margin:0;font-weight:600">⚠️ Our trading platform is currently experiencing downtime.</p>
                                    </div>
                                    <p style="color:#374151;font-size:14px;line-height:1.7">
                                        You have open positions in <strong>${exchange} ${segment}</strong>.
                                        To square off your positions, please use <strong>Navia Backup</strong> —
                                        our emergency square-off portal.
                                    </p>
                                    <div style="text-align:center;margin:24px 0">
                                        <a href="${backupUrl}" style="background:#2563eb;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">
                                            Access Navia Backup Portal
                                        </a>
                                    </div>
                                    <div style="background:#f9fafb;border-radius:8px;padding:16px;margin:16px 0">
                                        <p style="color:#374151;font-size:13px;margin:0 0 8px;font-weight:600">Login Instructions:</p>
                                        <ol style="color:#6b7280;font-size:13px;margin:0;padding-left:20px;line-height:1.8">
                                            <li>Visit: <a href="${backupUrl}" style="color:#2563eb">${backupUrl}</a></li>
                                            <li>Enter your UCC: <strong>${client.ucc}</strong></li>
                                            <li>Enter your Date of Birth</li>
                                            <li>Enter OTP received on your mobile/email</li>
                                            <li>Select position and click Square Off</li>
                                        </ol>
                                    </div>
                                    <p style="color:#6b7280;font-size:12px;line-height:1.6">
                                        Only market orders are accepted. Trades via Navia Backup will not
                                        reflect immediately in the main app. Please reconcile after platform resumes.
                                    </p>
                                    <div style="margin-top:20px;padding-top:16px;border-top:1px solid #e5e7eb">
                                        <a href="https://support.navia.co.in/support/solutions/articles/1000321790-navia-backup-your-safety-net-during-trading-downtime"
                                           style="color:#2563eb;font-size:13px">Contact Support</a>
                                    </div>
                                </div>
                                <div style="background:#f9fafb;border-top:1px solid #eef0f3;padding:16px 32px;text-align:center">
                                    <p style="color:#9ca3af;font-size:11px;margin:0">
                                        Navia Markets Ltd ·
                                        <a href="mailto:support@navia.co.in" style="color:#2563eb">support@navia.co.in</a>
                                    </p>
                                </div>
                            </div>`
                    });
                    emailStatus = 'SUCCESS';
                    emailsSent++;
                } catch (emailErr) {
                    emailStatus = 'FAILED';
                    errorMsg    = 'Email: ' + emailErr.message;
                    console.error(`Email failed for ${client.ucc}:`, emailErr.message);
                }
            }

            // ── Send WhatsApp ─────────────────────────────────────────────────
            if (send_whatsapp && client.mobile) {
                const waResult = await sendWhatsApp(client.mobile, client.client_name, client.ucc);
                if (waResult.success) {
                    whatsappStatus = 'SUCCESS';
                    whatsappSent++;
                } else {
                    whatsappStatus = 'FAILED';
                    errorMsg = (errorMsg ? errorMsg + ' | ' : '') + 'WhatsApp: ' + (waResult.error || 'Unknown error');
                }
            }

            // ── Log per-recipient delivery status ─────────────────────────────
            try {
                await pool.request()
                    .input('commId',   sql.Int,          commId)
                    .input('ucc',      sql.VarChar(20),  client.ucc)
                    .input('name',     sql.VarChar(200), client.client_name || '')
                    .input('email',    sql.VarChar(100), client.email   || null)
                    .input('mobile',   sql.VarChar(15),  client.mobile  || null)
                    .input('emailSt',  sql.VarChar(20),  emailStatus)
                    .input('waSt',     sql.VarChar(20),  whatsappStatus)
                    .input('errMsg',   sql.VarChar(500), errorMsg || null)
                    .query(`INSERT INTO communication_recipients
                            (comm_id, ucc, client_name, email, mobile,
                             email_status, whatsapp_status, error_message)
                            VALUES (@commId, @ucc, @name, @email, @mobile,
                                    @emailSt, @waSt, @errMsg)`);
            } catch (logErr) {
                console.error('Recipient log error:', logErr.message);
            }

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 150));
        }

        return res.json({
            success:       true,
            message:       'Communication sent successfully',
            total_clients: clients.length,
            emails_sent:   emailsSent,
            whatsapp_sent: whatsappSent
        });

    } catch (err) {
        console.error('Communication error:', err);
        return res.status(500).json({ error: 'Failed to send communications.' });
    }
});

// ── GET /api/admin/control/communications/:commId/recipients ──────────────────
router.get('/communications/:commId/recipients', adminAuthenticate, async (req, res) => {
    try {
        const pool   = await getConnection();
        const result = await pool.request()
            .input('commId', sql.Int, parseInt(req.params.commId))
            .query(`SELECT id, ucc, client_name, email, mobile,
                           email_status, whatsapp_status, error_message, sent_at
                    FROM communication_recipients
                    WHERE comm_id = @commId
                    ORDER BY ucc`);
        return res.json({ success: true, recipients: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch recipients.' });
    }
});

// ── GET /api/admin/control/communications ─────────────────────────────────────
router.get('/communications', adminAuthenticate, async (req, res) => {
    try {
        const pool   = await getConnection();
        const result = await pool.request()
            .query(`SELECT cl.*, a.full_name as sent_by
                    FROM communication_log cl
                    LEFT JOIN admin_users a ON cl.admin_id = a.admin_id
                    ORDER BY cl.sent_at DESC`);
        return res.json({ success: true, communications: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Could not fetch communications.' });
    }
});

// ── GET /api/admin/control/logs ───────────────────────────────────────────────
router.get('/logs', adminAuthenticate, async (req, res) => {
    try {
        const pool   = await getConnection();
        const result = await pool.request()
            .query(`SELECT al.*, a.full_name, a.username
                    FROM admin_logs al
                    LEFT JOIN admin_users a ON al.admin_id = a.admin_id
                    ORDER BY al.created_at DESC`);
        return res.json({ success: true, logs: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Could not fetch logs.' });
    }
});

module.exports = router;