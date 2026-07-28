const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const { getConnection, sql } = require('../config/database');
const { adminAuthenticate, requireFullAdmin } = require('../middleware/adminAuthenticate');
require('dotenv').config();

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

// ── Retry helper (2026-07-28) ──────────────────────────────────────────────────
// Generic bounded retry for the two outbound sends below. Only retries on
// failure (happy-path sends are completely unaffected -- no added latency),
// and only a fixed number of times so one genuinely bad address/number can't
// stall the whole run. `fn` must return either a thrown error (email path) or
// a { success, error } object (WhatsApp path) -- both call sites adapt to
// this uniformly via the two wrappers below it.
async function withRetry(fn, { maxAttempts = 2, delayMs = 800 } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return { success: true, result: await fn() };
        } catch (err) {
            lastErr = err;
            if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs));
        }
    }
    return { success: false, error: lastErr };
}

async function sendWhatsAppWithRetry(mobile, clientName, ucc, { maxAttempts = 2, delayMs = 800 } = {}) {
    let last = { success: false, error: 'Not attempted' };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        last = await sendWhatsApp(mobile, clientName, ucc);
        if (last.success) return last;
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs));
    }
    return last;
}

// ── Per-client channel classification (2026-07-28) ─────────────────────────────
// Pure/dependency-free so it can be unit-tested in isolation (no DB, no
// network). Decides, for one client, which of the two requested channels
// still need attempting this run vs. have already succeeded for the current
// incident vs. can't be attempted at all (no contact info on file).
//
// `prior` = { emailOk: bool, waOk: bool } -- whether this UCC already has a
// SUCCESS record for that channel since the current incident started (see
// incident-anchor note on the /communicate route below).
//
// Returns one of five buckets matching the requested reporting shape
// (selected / already_alerted / sent / failed / skipped are all rollups of
// this per-client bucket, computed after channels are actually attempted):
//   'ALREADY_ALERTED' -- every channel the admin asked for is already a
//                        confirmed SUCCESS this incident; nothing to send.
//   'UNREACHABLE'      -- no channel the admin asked for can be attempted
//                        (no email/mobile on file, and no prior success
//                        either) -- this is the "skipped" bucket.
//   'NEEDS_WORK'        -- at least one requested channel still needs an
//                        attempt this run (bucket resolves to sent/failed
//                        only after the attempt is actually made).
function classifyClient(client, prior, sendEmail, sendWhatsapp) {
    const p = prior || { emailOk: false, waOk: false };

    const emailRequested = !!sendEmail;
    const waRequested    = !!sendWhatsapp;
    const emailHasContact = emailRequested && !!client.email;
    const waHasContact    = waRequested    && !!client.mobile;

    const needEmail = emailHasContact && !p.emailOk;
    const needWa    = waHasContact    && !p.waOk;

    // "already fully alerted" only applies to channels that were actually
    // requested AND actually reachable -- a channel that was never requested,
    // or that the client has no contact info for, doesn't count against them
    // here (that's the UNREACHABLE bucket below, not ALREADY_ALERTED).
    const emailSatisfied = !emailHasContact || p.emailOk;
    const waSatisfied     = !waHasContact    || p.waOk;

    if (needEmail || needWa) {
        return { bucket: 'NEEDS_WORK', needEmail, needWa };
    }
    if (emailSatisfied && waSatisfied && (emailHasContact || waHasContact || p.emailOk || p.waOk)) {
        return { bucket: 'ALREADY_ALERTED', needEmail: false, needWa: false };
    }
    return { bucket: 'UNREACHABLE', needEmail: false, needWa: false };
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
    const { exchange, segment, enable, notes } = req.body;
    if (!exchange || !segment)
        return res.status(400).json({ error: 'Exchange and segment are required.' });
    try {
        const pool = await getConnection();
        await pool.request()
            .input('exchange', sql.VarChar, exchange.toUpperCase())
            .input('segment',  sql.VarChar, segment.toUpperCase())
            .input('enable',   sql.Bit,     enable ? 1 : 0)
            .input('adminId',  sql.Int,     req.admin.adminId)
            .input('notes',    sql.VarChar, notes || '')
            .query(`UPDATE segment_controls SET
                    is_enabled  = @enable,
                    enabled_by  = CASE WHEN @enable = 1 THEN @adminId ELSE enabled_by  END,
                    enabled_at  = CASE WHEN @enable = 1 THEN GETDATE() ELSE enabled_at  END,
                    disabled_by = CASE WHEN @enable = 0 THEN @adminId ELSE disabled_by END,
                    disabled_at = CASE WHEN @enable = 0 THEN GETDATE() ELSE disabled_at END,
                    notes       = @notes
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
// Redesigned (2026-07-28) per RMS request. Was: pull every client with a
// static `clients.<seg>` flag set to 1, email+WhatsApp all of them, every
// time, with no memory of who was already told. Now:
//   1. Select from real open positions (net_qty != 0), not the static flag.
//   2. Dedupe -- a client can hold several open positions in the same
//      exchange+segment (different symbols/expiries), which would otherwise
//      join into multiple rows for one client.
//   3. Check who's already been successfully notified for the *current*
//      incident before sending again.
//   4. Only send the channels that still need it.
//   5. Email/WhatsApp status is still recorded separately per client, as
//      before -- untouched.
//   6. Retry each channel once on failure (withRetry / sendWhatsAppWithRetry).
//   7. Response now reports selected / already_alerted / sent / failed /
//      skipped counts, in addition to the original fields the frontend
//      already reads (total_clients, emails_sent, whatsapp_sent) so the
//      existing "Sent to X clients" toast keeps working unchanged.
//
// Incident-anchor assumption (flagging this explicitly -- please confirm):
// "current incident" = since this exchange+segment was last *enabled* in
// segment_controls (that's the moment Navia Backup becomes the live channel
// for it, i.e. the primary platform is confirmed down for that segment) --
// falls back to the start of today if it's never been toggled, so the
// already-alerted check always has a bound rather than matching every alert
// ever sent historically. If "incident" should instead reset on disable, or
// use a dedicated incident id, this is the one place to change (the
// `incidentStart` lookup below) -- nothing else in this route depends on how
// it's derived.
router.post('/communicate', adminAuthenticate, requireFullAdmin, async (req, res) => {
    const { exchange, segment, send_email, send_whatsapp } = req.body;
    if (!exchange || !segment)
        return res.status(400).json({ error: 'Exchange and segment are required.' });

    const backupUrl = process.env.BACKUP_URL || 'https://backup.navia.co.in';
    const EX  = exchange.toUpperCase();
    const SEG = segment.toUpperCase();

    try {
        const pool = await getConnection();

        // 1) Real open-position clients for this exchange/segment (same join
        // already proven out by GET /clients/:exchange/:segment above) --
        // replaces the old static clients.<seg> flag lookup.
        const posResult = await pool.request()
            .input('exchange', sql.VarChar(10), EX)
            .input('segment',  sql.VarChar(10), SEG)
            .query(`SELECT c.ucc, c.client_name, c.mobile, c.email
                    FROM clients c
                    INNER JOIN positions p ON c.ucc = p.ucc
                    WHERE p.exchange = @exchange
                    AND   p.segment  = @segment
                    AND   p.net_qty != 0
                    AND   c.is_active = 1
                    AND   c.account_status = 'ACTIVE'`);
        const rawRows = posResult.recordset;

        // 2) Dedupe to one row per UCC (a client with 5 open F&O positions in
        // this segment would otherwise appear as 5 identical rows here).
        const byUcc = new Map();
        rawRows.forEach(r => { if (!byUcc.has(r.ucc)) byUcc.set(r.ucc, r); });
        const clients          = [...byUcc.values()];
        const duplicatesRemoved = rawRows.length - clients.length;

        if (clients.length === 0)
            return res.json({
                success: true, message: 'No clients found.',
                total_clients: 0, selected: 0, already_alerted: 0,
                sent: 0, failed: 0, skipped: 0,
                emails_sent: 0, emails_failed: 0, whatsapp_sent: 0, whatsapp_failed: 0
            });

        // 3) Current-incident anchor (see comment above the route).
        const segRow = (await pool.request()
            .input('exchange', sql.VarChar(10), EX)
            .input('segment',  sql.VarChar(10), SEG)
            .query(`SELECT is_enabled, enabled_at FROM segment_controls
                    WHERE exchange = @exchange AND segment = @segment`)).recordset[0];

        const startOfToday = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
        const incidentStart = (segRow && segRow.enabled_at) ? segRow.enabled_at : startOfToday;

        // Prior successes this incident, per UCC, per channel.
        const priorResult = await pool.request()
            .input('exchange', sql.VarChar(10), EX)
            .input('segment',  sql.VarChar(10), SEG)
            .input('since',    sql.DateTime,     incidentStart)
            .query(`SELECT cr.ucc,
                           MAX(CASE WHEN cr.email_status    = 'SUCCESS' THEN 1 ELSE 0 END) AS email_ok,
                           MAX(CASE WHEN cr.whatsapp_status = 'SUCCESS' THEN 1 ELSE 0 END) AS wa_ok
                    FROM communication_recipients cr
                    INNER JOIN communication_log cl ON cr.comm_id = cl.comm_id
                    WHERE cl.exchange = @exchange AND cl.segment = @segment AND cl.sent_at >= @since
                    GROUP BY cr.ucc`);
        const priorMap = {};
        priorResult.recordset.forEach(r => {
            priorMap[r.ucc] = { emailOk: !!r.email_ok, waOk: !!r.wa_ok };
        });

        // 4) Classify every client: already-alerted / unreachable / needs-work.
        const alreadyAlerted = [];
        const unreachable    = [];
        const toProcess      = [];
        clients.forEach(c => {
            const cls = classifyClient(c, priorMap[c.ucc], send_email, send_whatsapp);
            if (cls.bucket === 'ALREADY_ALERTED')      alreadyAlerted.push(c);
            else if (cls.bucket === 'UNREACHABLE')     unreachable.push(c);
            else                                        toProcess.push({ ...c, ...cls, prior: priorMap[c.ucc] || { emailOk: false, waOk: false } });
        });

        // Recipients_count (2026-07-28, kept as-is on review): stays the whole
        // selected open-position population, exactly as before this change --
        // NOT narrowed to "clients actually attempted this run". ClientAlerts.jsx
        // (Communication History page) sums this column straight into its
        // "Total Clients Alerted" stat card and per-row "Recipients" figure, and
        // never reads anything else new added by this fix -- keeping this field's
        // meaning identical means that page requires zero changes and shows
        // exactly the numbers it always has, on every run including repeat
        // alerts for an already-partially-notified incident.
        const commResult = await pool.request()
            .input('adminId',  sql.Int,         req.admin.adminId)
            .input('exchange', sql.VarChar(10), EX)
            .input('segment',  sql.VarChar(10), SEG)
            .input('count',    sql.Int,         clients.length)
            .input('content',  sql.VarChar(500), `Downtime notification sent for ${EX} ${SEG}`)
            .query(`INSERT INTO communication_log
                    (admin_id, exchange, segment, message_type, recipients_count, message_content)
                    OUTPUT INSERTED.comm_id
                    VALUES (@adminId, @exchange, @segment, 'BOTH', @count, @content)`);
        const commId = commResult.recordset[0].comm_id;

        let emailsSent = 0, emailsFailed = 0, whatsappSent = 0, whatsappFailed = 0;
        let sentClients = 0, failedClients = 0;
        const transporter = createTransporter();

        // ── Log already-alerted / unreachable clients (no attempt made) ────
        // Kept in communication_recipients under the same comm_id so the
        // per-run drill-down (GET /communications/:commId/recipients) shows
        // the complete picture -- who was skipped and why -- not just who was
        // actively contacted.
        async function logNoAttempt(client, emailSt, waSt) {
            try {
                await pool.request()
                    .input('commId',  sql.Int,          commId)
                    .input('ucc',     sql.VarChar(20),  client.ucc)
                    .input('name',    sql.VarChar(200), client.client_name || '')
                    .input('email',   sql.VarChar(100), client.email  || null)
                    .input('mobile',  sql.VarChar(15),  client.mobile || null)
                    .input('emailSt', sql.VarChar(20),  emailSt)
                    .input('waSt',    sql.VarChar(20),  waSt)
                    .input('errMsg',  sql.VarChar(500), null)
                    .query(`INSERT INTO communication_recipients
                            (comm_id, ucc, client_name, email, mobile,
                             email_status, whatsapp_status, error_message)
                            VALUES (@commId, @ucc, @name, @email, @mobile,
                                    @emailSt, @waSt, @errMsg)`);
            } catch (logErr) {
                console.error('Recipient log error:', logErr.message);
            }
        }

        for (const client of alreadyAlerted) {
            const emailSt = (send_email && client.email) ? 'ALREADY_ALERTED' : 'SKIPPED';
            const waSt    = (send_whatsapp && client.mobile) ? 'ALREADY_ALERTED' : 'SKIPPED';
            await logNoAttempt(client, emailSt, waSt);
        }
        for (const client of unreachable) {
            await logNoAttempt(client, 'SKIPPED', 'SKIPPED');
        }

        // ── Attempt the clients that still need at least one channel ──────
        for (const client of toProcess) {
            let emailStatus    = 'SKIPPED';
            let whatsappStatus = 'SKIPPED';
            let errorMsg       = null;
            let attemptedAny   = false;
            let succeededAny   = false;

            if (client.prior.emailOk && send_email && client.email) emailStatus = 'ALREADY_ALERTED';
            if (client.prior.waOk    && send_whatsapp && client.mobile) whatsappStatus = 'ALREADY_ALERTED';

            // ── Send Email (retried once on failure) ───────────────────────
            if (client.needEmail) {
                attemptedAny = true;
                const attempt = await withRetry(() => transporter.sendMail({
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
                }), { maxAttempts: 2, delayMs: 800 });

                if (attempt.success) {
                    emailStatus = 'SUCCESS'; emailsSent++; succeededAny = true;
                } else {
                    emailStatus = 'FAILED'; emailsFailed++;
                    errorMsg = 'Email: ' + (attempt.error?.message || 'Unknown error');
                    console.error(`Email failed for ${client.ucc} after retry:`, attempt.error?.message);
                }
            }

            // ── Send WhatsApp (retried once on failure) ────────────────────
            if (client.needWa) {
                attemptedAny = true;
                const waResult = await sendWhatsAppWithRetry(client.mobile, client.client_name, client.ucc, { maxAttempts: 2, delayMs: 800 });
                if (waResult.success) {
                    whatsappStatus = 'SUCCESS'; whatsappSent++; succeededAny = true;
                } else {
                    whatsappStatus = 'FAILED'; whatsappFailed++;
                    errorMsg = (errorMsg ? errorMsg + ' | ' : '') + 'WhatsApp: ' + (waResult.error || 'Unknown error');
                }
            }

            if (attemptedAny) { if (succeededAny) sentClients++; else failedClients++; }

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

            // Only throttle when a network call actually happened -- no need
            // to sleep between clients we skipped without any outbound send.
            if (attemptedAny) await new Promise(resolve => setTimeout(resolve, 150));
        }

        return res.json({
            success:            true,
            message:            'Communication sent successfully',
            exchange:           EX,
            segment:            SEG,
            duplicates_removed: duplicatesRemoved,
            selected:           clients.length,
            already_alerted:    alreadyAlerted.length,
            sent:               sentClients,
            failed:             failedClients,
            skipped:            unreachable.length,
            // Kept for the existing frontend toast ("Sent to X clients") --
            // clients actually processed this run (excludes fully
            // already-alerted and unreachable clients, who got no attempt).
            total_clients:      toProcess.length,
            emails_sent:        emailsSent,
            emails_failed:      emailsFailed,
            whatsapp_sent:      whatsappSent,
            whatsapp_failed:    whatsappFailed
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