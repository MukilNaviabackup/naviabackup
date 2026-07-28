const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const { getConnection, sql } = require('../config/database');
const { adminAuthenticate, requireFullAdmin } = require('../middleware/adminAuthenticate');
require('dotenv').config();

// System Logs fix (2026-07-27): successful WhatsApp alert campaigns never
// wrote to system_logs, so the "WhatsApp Alerts Today" card on the System
// Logs page was always stuck at 0 no matter how many Alert Clients sends
// went out. One row per campaign (not per recipient) is written here,
// mirroring how the Segment Control admin_logs entries summarize a single
// admin action rather than flooding the log with one row per client.
async function writeSystemLog(pool, logType, actor, actorType, details, status) {
    try {
        await pool.request()
            .input('logType',   sql.VarChar(100),  logType)
            .input('actor',     sql.VarChar(100),  actor     || null)
            .input('actorType', sql.VarChar(20),   actorType || 'ADMIN')
            .input('details',   sql.NVarChar(500), details   || null)
            .input('status',    sql.VarChar(20),   status    || 'SUCCESS')
            .query(`INSERT INTO system_logs (log_type,actor,actor_type,ucc,ip_address,details,status,created_at)
                    VALUES (@logType,@actor,@actorType,NULL,NULL,@details,@status,GETDATE())`);
    } catch (err) {
        console.error('[SystemLog] adminControl write failed:', err.message);
    }
}

// Segment Control (2026-07-25, terminal-first redesign): a segment's
// is_enabled/terminals are now DERIVED from which terminals are switched on
// and which exchange+segment combinations each one covers -- there is no
// more manual per-segment Enable/Disable click or single-terminal dropdown.
// XTS is added as a third terminal alongside the existing INHOUSE/BOW.
const VALID_TERMINALS     = ['INHOUSE', 'BOW', 'XTS'];
const VALID_EXCHANGES     = ['NSE', 'BSE', 'MCX'];
const VALID_SEGMENT_TYPES = ['CM', 'FO'];
// The 5 real (exchange, segment) rows that exist in segment_controls.
// MCX has no Cash Market segment, so MCX+CM is intentionally absent here.
const KNOWN_SEGMENTS = [
    { exchange: 'NSE', segment: 'CM' }, { exchange: 'NSE', segment: 'FO' },
    { exchange: 'BSE', segment: 'CM' }, { exchange: 'BSE', segment: 'FO' },
    { exchange: 'MCX', segment: 'FO' },
];

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

// Recomputes every known segment's is_enabled/terminals from the current
// terminal_configs rows, and records enabled_at/enabled_by or
// disabled_at/disabled_by + an admin_logs entry for any segment whose
// computed status actually flipped. Called after every terminal config save.
async function recomputeSegmentStatuses(pool, adminId) {
    const tcResult = await pool.request().query(`SELECT terminal, is_enabled, exchanges, segments FROM terminal_configs`);
    const terminalConfigs = tcResult.recordset;

    for (const { exchange, segment } of KNOWN_SEGMENTS) {
        const servingTerminals = terminalConfigs
            .filter(tc => tc.is_enabled
                && (tc.exchanges || '').split(',').map(v => v.trim()).includes(exchange)
                && (tc.segments  || '').split(',').map(v => v.trim()).includes(segment))
            .map(tc => tc.terminal);

        const nowEnabled = servingTerminals.length > 0;
        const termsStr    = servingTerminals.length > 0 ? servingTerminals.join(',') : null;

        const current = await pool.request()
            .input('exchange', sql.VarChar, exchange)
            .input('segment',  sql.VarChar, segment)
            .query(`SELECT is_enabled FROM segment_controls WHERE exchange = @exchange AND segment = @segment`);
        const wasEnabled = !!current.recordset[0]?.is_enabled;

        await pool.request()
            .input('exchange',  sql.VarChar, exchange)
            .input('segment',   sql.VarChar, segment)
            .input('enabled',   sql.Bit, nowEnabled ? 1 : 0)
            .input('adminId',   sql.Int, adminId)
            .input('terminals', sql.VarChar(50), termsStr)
            .query(`UPDATE segment_controls SET
                    is_enabled  = @enabled,
                    terminals   = @terminals,
                    enabled_by  = CASE WHEN @enabled = 1 AND is_enabled = 0 THEN @adminId ELSE enabled_by  END,
                    enabled_at  = CASE WHEN @enabled = 1 AND is_enabled = 0 THEN GETDATE() ELSE enabled_at  END,
                    disabled_by = CASE WHEN @enabled = 0 AND is_enabled = 1 THEN @adminId ELSE disabled_by END,
                    disabled_at = CASE WHEN @enabled = 0 AND is_enabled = 1 THEN GETDATE() ELSE disabled_at END
                    WHERE exchange = @exchange AND segment = @segment`);

        if (wasEnabled !== nowEnabled) {
            await pool.request()
                .input('adminId', sql.Int,     adminId)
                .input('action',  sql.VarChar, nowEnabled ? 'SEGMENT_ENABLED' : 'SEGMENT_DISABLED')
                .input('details', sql.VarChar, `${exchange} ${segment} ${nowEnabled ? 'enabled' : 'disabled'} (terminal config change, served by: ${termsStr || 'none'})`)
                .query(`INSERT INTO admin_logs (admin_id, action, details) VALUES (@adminId, @action, @details)`);
        }
    }
}

// ── Real open-position lookup (2026-07-28) ────────────────────────────────────
// Replaces the old static clients.<seg> flag (which only ever recorded which
// segments a client is PROVISIONED for, not what they currently hold) and a
// separate attempt that wrongly queried a disused generic `positions` table.
// The actual live source of truth -- confirmed against DealerDashboard.jsx's
// own Net-position merge (bfPos + dayPos, keyed by symbol+expiry+strike+
// option_type, buy-sell summed across both sources) -- is two tables:
//   - bf_positions: today's carried-forward qty (biz_date = today, IST)
//   - day_positions: today's own trades (trade_date = today, IST)
// FO: a client counts as "open" if the combined buy-sell across both sources
// is non-zero for ANY contract (so a B/F position fully closed out by today's
// trading is correctly excluded, same as the Net tab showing 0 for it).
// CM (equity): Net/Square-off there is Day-only (no B/F carry-forward concept
// for equity in this app), so it's just day_positions.net_qty != 0.
async function getOpenPositionUccs(pool, exchange, segmentUpper) {
    if (segmentUpper === 'FO') {
        const result = await pool.request()
            .input('exchange', sql.VarChar(10), exchange)
            .query(`
                WITH bf_contrib AS (
                    SELECT ucc, symbol, expiry_date, strike_price, option_type,
                        CASE WHEN ISNULL(opng_lng_qty,0) > 0 THEN opng_lng_qty
                             WHEN ISNULL(total_open_qty,0) > 0 THEN total_open_qty ELSE 0 END AS buy_qty,
                        CASE WHEN ISNULL(opng_shrt_qty,0) > 0 THEN opng_shrt_qty
                             WHEN ISNULL(total_open_qty,0) < 0 THEN -total_open_qty ELSE 0 END AS sell_qty
                    FROM bf_positions
                    WHERE instrument_type IN ('OPTIONS','FUTURES')
                      AND exchange = @exchange
                      AND biz_date = CAST(DATEADD(MINUTE, 330, GETDATE()) AS DATE)
                ),
                day_contrib AS (
                    SELECT ucc, symbol, expiry_date, strike_price, option_type,
                           ISNULL(buy_qty,0) AS buy_qty, ISNULL(sell_qty,0) AS sell_qty
                    FROM day_positions
                    WHERE instrument_type IN ('OPTIONS','FUTURES')
                      AND exchange = @exchange
                      AND trade_date = CAST(DATEADD(MINUTE, 330, GETDATE()) AS DATE)
                )
                SELECT ucc
                FROM (SELECT * FROM bf_contrib UNION ALL SELECT * FROM day_contrib) x
                GROUP BY ucc, symbol, expiry_date, strike_price, option_type
                HAVING SUM(buy_qty) - SUM(sell_qty) != 0
            `);
        return [...new Set(result.recordset.map(r => r.ucc))];
    }

    const result = await pool.request()
        .input('exchange', sql.VarChar(10), exchange)
        .query(`
            SELECT DISTINCT ucc
            FROM day_positions
            WHERE instrument_type = 'EQUITY'
              AND exchange = @exchange
              AND trade_date = CAST(DATEADD(MINUTE, 330, GETDATE()) AS DATE)
              AND net_qty != 0
        `);
    return result.recordset.map(r => r.ucc);
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
function classifyClient(client, prior, sendEmail, sendWhatsapp) {
    const p = prior || { emailOk: false, waOk: false };

    const emailRequested = !!sendEmail;
    const waRequested    = !!sendWhatsapp;
    const emailHasContact = emailRequested && !!client.email;
    const waHasContact    = waRequested    && !!client.mobile;

    const needEmail = emailHasContact && !p.emailOk;
    const needWa    = waHasContact    && !p.waOk;

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

// ── GET /api/admin/control/terminals ──────────────────────────────────────────
router.get('/terminals', adminAuthenticate, async (req, res) => {
    try {
        const pool   = await getConnection();
        const result = await pool.request()
            .query(`SELECT terminal, is_enabled, exchanges, segments, updated_at FROM terminal_configs ORDER BY terminal`);
        return res.json({ success: true, terminals: result.recordset });
    } catch (err) {
        return res.status(500).json({ error: 'Could not fetch terminal configs.' });
    }
});

// ── POST /api/admin/control/terminals/save ────────────────────────────────────
// Saves ONE terminal's configuration (on/off + which exchanges + which
// segments it covers), then recomputes every segment's Active/Inactive
// status and served-by terminal list. Replaces the old per-segment
// Enable/Disable + single-terminal-dropdown flow (POST /segments/toggle
// below is left in place, unused, in case anything else still calls it).
router.post('/terminals/save', adminAuthenticate, requireFullAdmin, async (req, res) => {
    const { terminal, enabled, exchanges, segments } = req.body;
    if (!terminal || !VALID_TERMINALS.includes(terminal.toUpperCase()))
        return res.status(400).json({ error: 'Unknown terminal.' });

    const exList  = Array.isArray(exchanges) ? exchanges.map(e => (e || '').toUpperCase()).filter(e => VALID_EXCHANGES.includes(e)) : [];
    const segList = Array.isArray(segments)  ? segments.map(s => (s || '').toUpperCase()).filter(s => VALID_SEGMENT_TYPES.includes(s)) : [];

    try {
        const pool = await getConnection();
        await pool.request()
            .input('terminal',  sql.VarChar(10), terminal.toUpperCase())
            .input('enabled',   sql.Bit,         enabled ? 1 : 0)
            .input('exchanges', sql.VarChar(50), exList.length  ? exList.join(',')  : null)
            .input('segments',  sql.VarChar(50), segList.length ? segList.join(',') : null)
            .input('adminId',   sql.Int,         req.admin.adminId)
            .query(`UPDATE terminal_configs SET
                    is_enabled = @enabled,
                    exchanges  = @exchanges,
                    segments   = @segments,
                    updated_by = @adminId,
                    updated_at = GETDATE()
                    WHERE terminal = @terminal`);

        await recomputeSegmentStatuses(pool, req.admin.adminId);

        await pool.request()
            .input('adminId', sql.Int,     req.admin.adminId)
            .input('action',  sql.VarChar, 'TERMINAL_CONFIG_SAVED')
            .input('details', sql.VarChar, `${terminal.toUpperCase()} set to ${enabled ? 'ON' : 'OFF'} (exchanges: ${exList.join(',') || 'none'}, segments: ${segList.join(',') || 'none'})`)
            .query(`INSERT INTO admin_logs (admin_id, action, details) VALUES (@adminId, @action, @details)`);

        const [tcResult, segResult] = await Promise.all([
            pool.request().query(`SELECT terminal, is_enabled, exchanges, segments, updated_at FROM terminal_configs ORDER BY terminal`),
            pool.request().query(`SELECT sc.*, e.full_name as enabled_by_name, d.full_name as disabled_by_name
                                   FROM segment_controls sc
                                   LEFT JOIN admin_users e ON sc.enabled_by  = e.admin_id
                                   LEFT JOIN admin_users d ON sc.disabled_by = d.admin_id
                                   ORDER BY sc.exchange, sc.segment`)
        ]);

        return res.json({ success: true, terminals: tcResult.recordset, segments: segResult.recordset });
    } catch (err) {
        console.error('Terminal config save error:', err);
        return res.status(500).json({ error: 'Failed to save terminal configuration.' });
    }
});

// ── POST /api/admin/control/segments/toggle ───────────────────────────────────
// Superseded by POST /terminals/save (terminal-first redesign, 2026-07-25).
// Left in place unused rather than removed, in case anything else still
// calls it -- it no longer has a caller in the admin UI.
router.post('/segments/toggle', adminAuthenticate, requireFullAdmin, async (req, res) => {
    const { exchange, segment, enable, notes, terminal } = req.body;
    if (!exchange || !segment)
        return res.status(400).json({ error: 'Exchange and segment are required.' });
    if (enable && !terminal)
        return res.status(400).json({ error: 'Please select a terminal (INHOUSE or BOW) before enabling a segment.', code: 'TERMINAL_REQUIRED' });
    try {
        const pool = await getConnection();
        await pool.request()
            .input('exchange', sql.VarChar, exchange.toUpperCase())
            .input('segment',  sql.VarChar, segment.toUpperCase())
            .input('enable',   sql.Bit,     enable ? 1 : 0)
            .input('adminId',  sql.Int,     req.admin.adminId)
            .input('notes',    sql.VarChar, notes || '')
            .input('terminal', sql.VarChar(10), terminal ? terminal.toUpperCase() : null)
            .query(`UPDATE segment_controls SET
                    is_enabled  = @enable,
                    enabled_by  = CASE WHEN @enable = 1 THEN @adminId ELSE enabled_by  END,
                    enabled_at  = CASE WHEN @enable = 1 THEN GETDATE() ELSE enabled_at  END,
                    disabled_by = CASE WHEN @enable = 0 THEN @adminId ELSE disabled_by END,
                    disabled_at = CASE WHEN @enable = 0 THEN GETDATE() ELSE disabled_at END,
                    notes       = @notes,
                    terminal    = CASE WHEN @terminal IS NOT NULL THEN @terminal WHEN @enable = 0 THEN NULL ELSE terminal END
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
// Rewired (2026-07-28) to the same real open-position source as /communicate
// below, replacing the disused `positions` table join -- same bug, same fix,
// kept consistent since both endpoints answer the identical question ("who
// currently has an open position here").
router.get('/clients/:exchange/:segment', adminAuthenticate, async (req, res) => {
    const { exchange, segment } = req.params;
    const EX  = exchange.toUpperCase();
    const SEG = segment.toUpperCase();
    try {
        const pool = await getConnection();
        const openUccs = await getOpenPositionUccs(pool, EX, SEG);
        if (openUccs.length === 0)
            return res.json({ success: true, clients: [], count: 0 });

        const result = await pool.request()
            .input('uccList', sql.VarChar(sql.MAX), openUccs.join(','))
            .query(`SELECT DISTINCT c.ucc, c.client_name, c.mobile, c.email
                    FROM clients c
                    WHERE c.ucc IN (SELECT value FROM STRING_SPLIT(@uccList, ','))
                    AND   c.is_active = 1
                    ORDER BY c.ucc`);
        return res.json({ success: true, clients: result.recordset, count: result.recordset.length });
    } catch (err) {
        console.error('Clients-by-segment error:', err.message);
        return res.status(500).json({ error: 'Could not fetch clients.' });
    }
});

// ── POST /api/admin/control/communicate ──────────────────────────────────────
// Redesigned (2026-07-28) per RMS request, corrected same day after finding
// the first version was built against a stale codebase snapshot that
// predated the terminal-first redesign (2026-07-25) and System Logs fix
// (2026-07-27) -- both of those are fully preserved below (terminal_configs/
// segment_controls.terminals filtering, and the ALERT_WHATSAPP_SENT
// system_logs write). What changed from the previous static-flag version:
//   1. Client selection now comes from real open positions (bf_positions +
//      day_positions, the same two tables DealerDashboard.jsx's own Net-tab
//      merge reads -- see getOpenPositionUccs above), not the static
//      clients.<seg> provisioning flag and not the unrelated `positions`
//      table an earlier attempt this session wrongly used.
//   2. Dedupe -- a client can hold several open positions in the same
//      exchange+segment (different symbols/expiries), collapsed to one row.
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
// ever sent historically.
router.post('/communicate', adminAuthenticate, requireFullAdmin, async (req, res) => {
    const { exchange, segment, send_email, send_whatsapp } = req.body;
    if (!exchange || !segment)
        return res.status(400).json({ error: 'Exchange and segment are required.' });

    const backupUrl = process.env.BACKUP_URL || 'https://backup.navia.co.in';
    const EX  = exchange.toUpperCase();
    const SEG = segment.toUpperCase();

    try {
        const pool = await getConnection();

        // 1) Real open-position clients for this exchange/segment.
        const openUccs = await getOpenPositionUccs(pool, EX, SEG);

        if (openUccs.length === 0)
            return res.json({
                success: true, message: 'No clients found.',
                total_clients: 0, selected: 0, already_alerted: 0,
                sent: 0, failed: 0, skipped: 0,
                emails_sent: 0, emails_failed: 0, whatsapp_sent: 0, whatsapp_failed: 0
            });

        // Preserve the terminal-serving filter from the terminal-first
        // redesign -- a segment can now be served by more than one terminal
        // at once; NULL/empty terminals means no terminal is currently
        // serving it, so (matching the prior permissive fallback) every
        // matching client is still notified rather than none.
        const scRes = await pool.request()
            .input('exchange', sql.VarChar(10), EX)
            .input('segment',  sql.VarChar(10), SEG)
            .query(`SELECT terminals FROM segment_controls WHERE exchange = @exchange AND segment = @segment`);
        const segTerminals = scRes.recordset[0]?.terminals || null;

        const clientResult = await pool.request()
            .input('uccList',      sql.VarChar(sql.MAX), openUccs.join(','))
            .input('segTerminals', sql.VarChar(50),      segTerminals)
            .query(`SELECT ucc, client_name, mobile, email
                    FROM clients
                    WHERE ucc IN (SELECT value FROM STRING_SPLIT(@uccList, ','))
                    AND is_active = 1
                    AND account_status = 'ACTIVE'
                    AND (@segTerminals IS NULL OR CHARINDEX(',' + terminal + ',', ',' + @segTerminals + ',') > 0)`);
        const rawRows = clientResult.recordset;

        // 2) Dedupe to one row per UCC (defensive -- getOpenPositionUccs
        // already de-duplicates, and `clients` is naturally one row per
        // UCC, so this should be a no-op in practice, kept for safety).
        const byUcc = new Map();
        rawRows.forEach(r => { if (!byUcc.has(r.ucc)) byUcc.set(r.ucc, r); });
        const clients           = [...byUcc.values()];
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

        // Recipients_count stays the whole selected open-position population
        // (matching what it always meant), NOT narrowed to clients actually
        // attempted this run -- so the Communication History page
        // ("ClientAlerts.jsx", which sums this column into its "Total
        // Clients Alerted" stat and never reads any of the new fields below)
        // requires zero changes and shows exactly the numbers it always has.
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

        // System Logs instrumentation (2026-07-27 fix, preserved) -- fires
        // whenever at least one WhatsApp send succeeded this run, same
        // trigger condition as before.
        if (send_whatsapp && whatsappSent > 0) {
            await writeSystemLog(pool, 'ALERT_WHATSAPP_SENT', String(req.admin.adminId), 'ADMIN',
                `WhatsApp alert sent for ${EX} ${SEG} to ${whatsappSent} of ${clients.length} clients`,
                'SUCCESS');
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