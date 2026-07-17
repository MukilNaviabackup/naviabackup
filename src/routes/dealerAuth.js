const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const { getConnection, sql } = require('../config/database');
const { queueRMSEmailAlert } = require('../services/rmsEmailAlert');
require('dotenv').config();

// ── IST end-of-day helper ─────────────────────────────────────────────────────
function getISTEndOfDay() {
    const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const eodUTC = new Date(Date.UTC(
        nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate(),
        18, 29, 59, 0  // 23:59:59 IST
    ));
    return eodUTC > new Date() ? eodUTC : new Date(eodUTC.getTime() + 24*60*60*1000);
}

/* ── Fire-and-forget system log writer ───────────────────────────────────────*/
function writeLog(logType, actor, actorType, ucc, ip, details, status, recipientName, recipientMobile, recipientEmail, otpCode) {
    setImmediate(async () => {
        try {
            const pool = await getConnection();
            await pool.request()
                .input('logType',   sql.VarChar(100),  logType         || 'UNKNOWN')
                .input('actor',     sql.VarChar(100),  actor           || null)
                .input('actorType', sql.VarChar(20),   actorType       || 'DEALER')
                .input('ucc',       sql.VarChar(20),   ucc             || null)
                .input('ip',        sql.VarChar(50),   ip              || null)
                .input('details',   sql.NVarChar(500), details         || null)
                .input('status',    sql.VarChar(20),   status          || 'SUCCESS')
                .input('recName',   sql.VarChar(150),  recipientName   || null)
                .input('recMobile', sql.VarChar(20),   recipientMobile || null)
                .input('recEmail',  sql.VarChar(150),  recipientEmail  || null)
                .input('otpCode',   sql.VarChar(6),    otpCode         || null)
                .query(`INSERT INTO system_logs
                            (log_type,actor,actor_type,ucc,ip_address,details,status,created_at,
                             recipient_name,recipient_mobile,recipient_email,otp_code)
                        VALUES
                            (@logType,@actor,@actorType,@ucc,@ip,@details,@status,GETDATE(),
                             @recName,@recMobile,@recEmail,@otpCode)`);
        } catch (err) {
            console.error('[SystemLog] dealer write failed:', err.message);
        }
    });
}

function createTransporter() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.zatpatmail.com',
        port: 465, secure: true,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 8000, greetingTimeout: 5000, socketTimeout: 10000,
    });
}

async function sendDealerOTPEmail(email, fullName, otp, dealerId) {
    try {
        const transporter = createTransporter();
        await transporter.sendMail({
            from: `"Navia Backup" <${process.env.SMTP_FROM || 'updates@navia.co.in'}>`,
            to: email,
            subject: 'Navia Backup Dealer Portal — Your OTP',
            html: `<div style="max-width:480px;margin:40px auto;font-family:Arial,sans-serif;border:1px solid #eef0f3;border-radius:12px;overflow:hidden">
                <div style="background:#1e3a5f;padding:24px 32px"><span style="color:#fff;font-size:18px;font-weight:700">Navia Backup — Dealer Portal</span></div>
                <div style="padding:32px">
                    <p style="color:#374151;font-size:15px">Dear <strong>${fullName}</strong> (${dealerId}),</p>
                    <p style="color:#6b7280;font-size:14px">Your dealer login OTP is:</p>
                    <div style="background:#f7f8fa;border:2px dashed #1e3a5f;border-radius:10px;padding:20px;text-align:center;margin:20px 0">
                        <div style="font-size:36px;font-weight:700;letter-spacing:12px;color:#1e3a5f">${otp}</div>
                        <div style="font-size:12px;color:#6b7280;margin-top:8px">Valid for 24 hours</div>
                    </div>
                    <p style="color:#dc2626;font-size:12px">Do not share this OTP with anyone.</p>
                </div>
            </div>`
        });
        console.log(`Dealer OTP email sent to ${email}`);
        return true;
    } catch (err) {
        console.error('Dealer OTP email error:', err.message);
        return false;
    }
}

// Step 1: Dealer enters dealer ID → send OTP
router.post('/login/initiate', async (req, res) => {
    const { dealer_id } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    if (!dealer_id) return res.status(400).json({ error: 'Dealer ID is required.' });
    try {
        const pool = await getConnection();
        const result = await pool.request()
            .input('dealerId', sql.VarChar(10), dealer_id.toUpperCase().trim())
            .query('SELECT dealer_id,email,full_name FROM dealers WHERE dealer_id=@dealerId AND is_active=1');

        if (result.recordset.length === 0) {
            writeLog('DEALER_LOGIN_FAILED', dealer_id, 'DEALER', null, ip, 'Invalid Dealer ID', 'FAILED');
            return res.status(401).json({ error: 'Invalid Dealer ID.' });
        }

        const dealer = result.recordset[0];
        // Check force retrigger (sent as separate field)
        const forceNew = !!(req.body.force);

        // ── One-OTP-per-calendar-day rule ───────────────────────────────────
        // If this dealer already successfully verified an OTP today (is_used=1,
        // session not yet expired), skip OTP entirely and log them straight in.
        if (!forceNew) {
            const alreadyVerified = await pool.request()
                .input('dealerId', sql.VarChar(10), String(dealer.dealer_id).trim())
                .query(`SELECT TOP 1 session_id FROM dealer_otp_sessions
                        WHERE dealer_id=@dealerId AND is_used=1 AND expires_at>GETDATE()
                        ORDER BY expires_at DESC`);

            if (alreadyVerified.recordset.length > 0) {
                const dealerIdValue = String(dealer.dealer_id).trim();
                const token = jwt.sign(
                    { dealerId: dealerIdValue, name: dealer.full_name, role: 'DEALER' },
                    process.env.JWT_SECRET, { expiresIn: '12h' }
                );
                writeLog('DEALER_LOGIN_SUCCESS', dealer.full_name, 'DEALER', null, ip, `Dealer ${dealerIdValue} re-logged in (already verified today, no OTP required)`, 'SUCCESS');
                console.log(`Dealer already verified today, skipping OTP: ${dealerIdValue}`);
                return res.json({
                    success: true,
                    alreadyVerifiedToday: true,
                    token,
                    dealer: { dealer_id: dealerIdValue, name: dealer.full_name }
                });
            }
        }

        // Reuse existing valid (unused) session (unless force=1)
        if (!forceNew) {
            const existingSession = await pool.request()
                .input('dealerId', sql.VarChar(10), String(dealer.dealer_id).trim())
                .query(`SELECT TOP 1 session_id FROM dealer_otp_sessions
                        WHERE dealer_id=@dealerId AND is_used=0 AND attempt_count<3 AND expires_at>GETDATE()
                        ORDER BY expires_at DESC`);

            if (existingSession.recordset.length > 0) {
                // No fresh OTP code exists on reuse (session_id points at an earlier,
                // already-sent code) -- pass null rather than a wrong/misleading value.
                writeLog('DEALER_OTP_SENT', dealer.full_name, 'DEALER', null, ip, `OTP reused for ${dealer.email}`, 'SUCCESS',
                    dealer.full_name, null, dealer.email, null);
                return res.json({
                    success: true,
                    sessionId: existingSession.recordset[0].session_id,
                    email: dealer.email.replace(/(.{2})(.*)(@.*)/, '$1***$3'),
                    message: 'OTP already sent today.',
                    reused: true
                });
            }
        }

        const otp       = Math.floor(100000 + Math.random() * 900000).toString();
        const otpHash   = await bcrypt.hash(otp, 10);
        const sessionId = uuidv4();
        const expiresAt = getISTEndOfDay();

        await pool.request()
            .input('sessionId', sql.VarChar(36), sessionId)
            .input('dealerId',  sql.VarChar(10), String(dealer.dealer_id).trim())
            .input('otpHash',   sql.VarChar(255), otpHash)
            .input('expiresAt', sql.DateTime, expiresAt)
            .query('INSERT INTO dealer_otp_sessions (session_id,dealer_id,otp_hash,expires_at,is_used,attempt_count) VALUES (@sessionId,@dealerId,@otpHash,@expiresAt,0,0)');

        const emailSent = await sendDealerOTPEmail(dealer.email, dealer.full_name, otp, dealer.dealer_id);
        writeLog('DEALER_OTP_SENT', dealer.full_name, 'DEALER', null, ip,
            `OTP sent to ${dealer.email} for dealer ${dealer.dealer_id} | Email:${emailSent}`,
            emailSent ? 'SUCCESS' : 'FAILED',
            dealer.full_name, null, dealer.email, otp);
        console.log(`Dealer OTP for ${dealer_id}: ${otp}`);

        return res.json({ success: true, sessionId, email: dealer.email.replace(/(.{2})(.*)(@.*)/, '$1***$3'), message: 'OTP sent to registered email.' });
    } catch (err) {
        console.error('Dealer login error:', err);
        return res.status(500).json({ error: 'Login failed.' });
    }
});

// Step 2: Verify OTP → issue JWT
router.post('/login/verify-otp', async (req, res) => {
    const { sessionId, otp } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    if (!sessionId || !otp) return res.status(400).json({ error: 'Session ID and OTP required.' });
    try {
        const pool = await getConnection();
        const result = await pool.request()
            .input('sessionId', sql.VarChar(36), sessionId)
            .query(`SELECT s.session_id,s.otp_hash,s.attempt_count,s.is_used,d.dealer_id,d.full_name,d.email
                    FROM dealer_otp_sessions s
                    JOIN dealers d ON s.dealer_id=d.dealer_id
                    WHERE s.session_id=@sessionId AND s.expires_at>GETDATE() AND s.attempt_count<3`);

        if (result.recordset.length === 0) return res.status(401).json({ error: 'Invalid or expired session. Please login again.' });

        const session = result.recordset[0];
        const dealerIdValue = String(session.dealer_id).trim();
        console.log(`[Dealer verify] sessionId=${sessionId} dealer=${dealerIdValue} otp_len=${otp.trim().length}`);
        const isValid = await bcrypt.compare(otp.trim(), session.otp_hash);
        console.log(`[Dealer verify] bcrypt result=${isValid}`);

        if (!isValid) {
            await pool.request().input('sessionId', sql.VarChar(36), sessionId)
                .query('UPDATE dealer_otp_sessions SET attempt_count=attempt_count+1 WHERE session_id=@sessionId');
            const remaining = 2 - session.attempt_count;
            writeLog('DEALER_LOGIN_FAILED', dealerIdValue, 'DEALER', null, ip, 'Invalid OTP attempt', 'FAILED');
            return res.status(401).json({
                error: `Incorrect OTP. Please check the latest email sent to your registered address. ${remaining > 0 ? remaining + ' attempt(s) remaining.' : 'Click Back and request a new OTP.'}`
            });
        }

        await pool.request().input('sessionId', sql.VarChar(36), sessionId)
            .query('UPDATE dealer_otp_sessions SET is_used=1 WHERE session_id=@sessionId');
        await pool.request().input('dealerId', sql.VarChar(10), dealerIdValue)
            .query('UPDATE dealers SET last_login=GETDATE() WHERE dealer_id=@dealerId');

        const token = jwt.sign(
            { dealerId: dealerIdValue, name: session.full_name, role: 'DEALER' },
            process.env.JWT_SECRET, { expiresIn: '12h' }
        );

        writeLog('DEALER_LOGIN_SUCCESS', session.full_name, 'DEALER', null, ip, `Dealer ${dealerIdValue} logged in`, 'SUCCESS');
        console.log(`Dealer login success: ${dealerIdValue}`);

        return res.json({ success: true, token, dealer: { dealer_id: dealerIdValue, name: session.full_name } });
    } catch (err) {
        console.error('Dealer OTP verify error:', err);
        return res.status(500).json({ error: 'Verification failed.' });
    }
});

// Generate SSO token for client UCC access
router.post('/sso/generate', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    if (!token) return res.status(401).json({ error: 'Unauthorized.' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.dealerId) return res.status(401).json({ error: 'Invalid dealer token.' });

        const { ucc } = req.body;
        if (!ucc) return res.status(400).json({ error: 'UCC is required.' });

        const pool = await getConnection();
        const clientResult = await pool.request()
            .input('ucc', sql.VarChar(20), ucc.trim())
            .query('SELECT ucc,client_name FROM clients WHERE ucc=@ucc AND is_active=1');

        if (clientResult.recordset.length === 0) return res.status(404).json({ error: 'Client UCC not found.' });

        const client = clientResult.recordset[0];
        const ssoToken = jwt.sign(
            { ucc: client.ucc, clientName: client.client_name, dealerId: decoded.dealerId, isDealer: true },
            process.env.JWT_SECRET, { expiresIn: '4h' }
        );

        await pool.request()
            .input('dealerId', sql.VarChar(10), String(decoded.dealerId).trim())
            .input('ucc',      sql.VarChar(20), ucc.trim())
            .input('action',   sql.VarChar(100), 'SSO_GENERATED')
            .input('details',  sql.VarChar(500), `Dealer ${decoded.dealerId} accessed client ${ucc}`)
            .query('INSERT INTO dealer_logs (dealer_id,ucc,action,details) VALUES (@dealerId,@ucc,@action,@details)');

        writeLog('DEALER_SSO_GENERATED', String(decoded.dealerId), 'DEALER', ucc, ip,
            `Dealer ${decoded.dealerId} generated SSO for client ${ucc}`, 'SUCCESS');

        const ssoUrl = `${process.env.BACKUP_URL || 'http://localhost:3000'}/dealer-client?token=${ssoToken}`;
        return res.json({ success: true, ssoUrl, client: client.client_name });
    } catch (err) {
        console.error('SSO generate error:', err);
        if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Dealer session expired. Please login again.' });
        return res.status(500).json({ error: 'SSO generation failed.' });
    }
});

// Validate SSO token
router.post('/sso/validate', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required.' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.isDealer) return res.status(401).json({ error: 'Invalid SSO token.' });
        return res.json({ success: true, ucc: decoded.ucc, clientName: decoded.clientName, dealerId: decoded.dealerId });
    } catch {
        return res.status(401).json({ error: 'Invalid or expired SSO token.' });
    }
});

// Get dealer logs
router.get('/logs', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized.' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const pool = await getConnection();
        const result = await pool.request()
            .input('dealerId', sql.VarChar(10), String(decoded.dealerId).trim())
            .query('SELECT * FROM dealer_logs WHERE dealer_id=@dealerId ORDER BY created_at DESC');
        return res.json({ success: true, logs: result.recordset });
    } catch { return res.status(500).json({ error: 'Failed to fetch logs.' }); }
});


// ── GET /api/dealer/recent-clients ───────────────────────────────────────────
// Fetch dealer's recent client access from dealer_logs (persistent across sessions)
router.get('/recent-clients', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.json({ success: true, clients: [] }); // No token = return empty, not 401
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.dealerId) return res.status(401).json({ error: 'Invalid dealer token.' });
        const pool = await getConnection();
        const result = await pool.request()
            .input('dealerId', sql.VarChar(10), String(decoded.dealerId).trim())
            .query(`
                SELECT DISTINCT TOP 10
                    dl.ucc,
                    c.client_name,
                    MAX(dl.created_at) AS last_accessed
                FROM dealer_logs dl
                LEFT JOIN clients c ON dl.ucc = c.ucc
                WHERE dl.dealer_id = @dealerId
                AND dl.ucc IS NOT NULL
                GROUP BY dl.ucc, c.client_name
                ORDER BY last_accessed DESC
            `);
        return res.json({ success: true, clients: result.recordset });
    } catch (err) {
        if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Session expired.' });
        return res.status(500).json({ error: 'Failed to fetch recent clients.' });
    }
});

// ── POST /api/dealer/client-data ─────────────────────────────────────────────
// Securely load client data within dealer session (replaces SSO new-tab flow)
// Returns positions, orders, BF from DB — squareoff state always from server
router.post('/client-data', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized.' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.dealerId) return res.status(401).json({ error: 'Invalid dealer token.' });

        const { ucc } = req.body;
        if (!ucc) return res.status(400).json({ error: 'UCC is required.' });

        const pool = await getConnection();
        console.log(`[ClientData] Step 1: pool connected for UCC=${ucc} dealer=${decoded.dealerId}`);

        // Verify client exists and is active
        const clientResult = await pool.request()
            .input('ucc', sql.VarChar(20), ucc.trim())
            .query(`SELECT ucc, client_name, mobile, email,
                           nse_cm, nse_fo, bse_cm, bse_fo, mcx_fo
                    FROM clients WHERE ucc = @ucc AND is_active = 1`);

        if (clientResult.recordset.length === 0) {
            return res.status(404).json({ error: 'Client UCC not found or inactive.' });
        }

        const client = clientResult.recordset[0];

        // Fetch all data in parallel
        const now       = new Date();
        const istDate   = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
        const tradeDate = istDate.toISOString().slice(0, 10);

        console.log(`[ClientData] Step 2: client verified ${client.client_name}`);
        // Step 1: Fetch all DB data in parallel (fast, no external calls)
        const [positions, orders, dayPos, bfPos] = await Promise.all([
            pool.request().input('ucc', sql.VarChar(20), ucc.trim())
                .query(`SELECT * FROM positions WHERE ucc = @ucc ORDER BY symbol`)
                .catch(() => ({ recordset: [] })),
            pool.request().input('ucc', sql.VarChar(20), ucc.trim())
                // file_generated / file_generated_at added: DealerDashboard.jsx's
                // action-column logic requires ord.file_generated to show "Traded"
                // (mirrors the client's own file_generated compliance gate), but
                // this query never selected it -- so ord.file_generated was always
                // undefined and the Traded/Partially-traded badges could never
                // render here, regardless of actual order status. That's why the
                // dealer view showed "No open position" for orders the client view
                // correctly showed as Traded.
                //
                // FIX: scoped to TODAY only (CAST(o.placed_at AS DATE) = today) --
                // this list was previously the client's ENTIRE order history, which
                // made the "My orders"/"Orders" tab grow unbounded and unreadable
                // over time. Same is_stale computation as adminOrders.js's /orders
                // route (day_positions for CM, positions for FO) so the dealer sees
                // the same "target position already closed" warning the RMS admin
                // now sees, instead of just a bare, unexplained "Order received".
                .query(`SELECT o.order_id, o.ucc, o.exchange, o.segment, o.symbol,
                               o.quantity, o.executed_qty, o.remaining_qty,
                               o.side, o.status, o.placed_at, o.placed_by, o.dealer_id,
                               o.expiry_date, o.strike_price, o.option_type,
                               o.file_generated, o.file_generated_at,
                               o.traded_at, o.trade_price,
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
                        ORDER BY o.placed_at DESC`)
                .catch(() => ({ recordset: [] })),
            pool.request()
                .input('ucc', sql.VarChar(20), ucc.trim())
                .input('tradeDate', sql.Date, new Date(tradeDate))
                .query(`SELECT * FROM day_positions
                        WHERE ucc = @ucc AND trade_date = @tradeDate
                        ORDER BY instrument_type, symbol`)
                .catch(() => ({ recordset: [] })),
            pool.request().input('ucc', sql.VarChar(20), ucc.trim())
                .query(`SELECT * FROM bf_positions
                        WHERE ucc = @ucc
                        AND biz_date = CAST(DATEADD(MINUTE, 330, GETDATE()) AS DATE)
                        ORDER BY instrument_type, symbol`)
                .catch(() => ({ recordset: [] })),
        ]);

        console.log(`[ClientData] Step 3: DB data fetched positions=${positions.recordset.length} orders=${orders.recordset.length} day=${dayPos.recordset.length} bf=${bfPos.recordset.length}`);
        // Step 2: Fetch holdings from Sharepro separately with strict timeout
        let holdingsRes = { recordset: [] };
        try {
            const holdingsPromise = fetchHoldingsForUCC(ucc.trim());
            // FIX (16-Jul-2026): was 8000ms here, shorter than the 15000ms the
            // client-side holdings.js route allows the SAME Sharepro API call.
            // Sharepro is measured taking 8-10s to respond under normal load
            // (see [Perf] Slow: POST /client-data | 9926ms in production logs,
            // same moment the client route's 15s-timeout call to Sharepro
            // succeeded with 15 holdings) -- so this outer race was killing a
            // holdings fetch that would have succeeded, well before Sharepro
            // itself had a chance to respond. Bumped to 16000ms, matching (and
            // just above) fetchHoldingsForUCC's own https timeout below so
            // this outer race is a true safety net, not the thing that fires
            // first in the normal "Sharepro is just a bit slow" case.
            const timeoutPromise  = new Promise(resolve =>
                setTimeout(() => resolve({ recordset: [] }), 16000)
            );
            holdingsRes = await Promise.race([holdingsPromise, timeoutPromise]);
        } catch (he) {
            console.error('[ClientData] Holdings error (non-fatal):', he.message);
        }

        // Log dealer access
        await pool.request()
            .input('dealerId', sql.VarChar(10), String(decoded.dealerId).trim())
            .input('ucc',      sql.VarChar(20), ucc.trim())
            .input('action',   sql.VarChar(100), 'CLIENT_DATA_ACCESSED')
            .input('details',  sql.VarChar(500), `Dealer ${decoded.dealerId} accessed client ${ucc} data`)
            .query(`INSERT INTO dealer_logs (dealer_id, ucc, action, details)
                    VALUES (@dealerId, @ucc, @action, @details)`);

        return res.json({
            success:       true,
            client,
            dealerId:      decoded.dealerId,
            positions:     positions.recordset,
            orders:        orders.recordset,
            day_positions: dayPos.recordset,
            bf_positions:  bfPos.recordset,
            holdings:      holdingsRes.recordset || [],
            trade_date:    tradeDate
        });

    } catch (err) {
        console.error('[ClientData] ERROR:', err.message, err.stack);
        if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Session expired. Please login again.' });
        // Return full error detail to help debug
        return res.status(500).json({
            error: 'Failed to load client data: ' + err.message,
            detail: err.message
        });
    }
});

// ── POST /api/dealer/place-squareoff ─────────────────────────────────────────
// Place sq-off on behalf of client (dealer session, same page)
router.post('/place-squareoff', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized.' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.dealerId) return res.status(401).json({ error: 'Invalid dealer token.' });

        const { ucc, exchange, segment, symbol, quantity, side,
                expiry_date, strike_price, option_type } = req.body;

        if (!ucc || !exchange || !segment || !symbol || !quantity || !side) {
            return res.status(400).json({ error: 'Missing required fields.' });
        }

        const pool = await getConnection();

        // Verify client exists
        const clientCheck = await pool.request()
            .input('ucc', sql.VarChar(20), ucc)
            .query(`SELECT ucc, client_name FROM clients WHERE ucc = @ucc AND is_active = 1`);
        if (clientCheck.recordset.length === 0) {
            return res.status(404).json({ error: 'Client not found.' });
        }

        // Check segment enabled
        const segCtrl = await pool.request()
            .input('exchange', sql.VarChar(10), exchange)
            .input('segment',  sql.VarChar(10), segment)
            .query(`SELECT is_enabled FROM segment_controls
                    WHERE exchange = @exchange AND segment = @segment`);
        if (segCtrl.recordset.length > 0 && !segCtrl.recordset[0].is_enabled) {
            return res.status(403).json({ error: 'SEGMENT_DISABLED', message: 'Trading application is functioning normally.' });
        }

        // ── Check duplicate ───────────────────────────────────────────────────
        // Fixed to match the client route's logic exactly (orders.js /squareoff):
        // - Must also exclude ORDER_TRADED/TRADED as resolved -- the old version
        //   here only excluded REJECTED/FAILED, so an already-successfully-traded
        //   order for this symbol earlier today would wrongly keep blocking new
        //   square-offs for the rest of the day.
        // - Must also match expiry_date/strike_price/option_type -- the old
        //   version matched only symbol+exchange+segment, so two DIFFERENT
        //   contracts of the same symbol (e.g. GOLDPETAL 31/7 FUT vs 31/8 FUT)
        //   would incorrectly conflict with each other.
        const dupCheck = await pool.request()
            .input('ucc',        sql.VarChar(20),  ucc)
            .input('symbol',     sql.VarChar(100), symbol)
            .input('exchange',   sql.VarChar(10),  exchange)
            .input('segment',    sql.VarChar(10),  segment)
            .input('expiry',     sql.Date,          expiry_date  ? new Date(expiry_date)  : null)
            .input('strike',     sql.Decimal(18,2), strike_price ? Number(strike_price)   : null)
            .input('optionType', sql.VarChar(5),    option_type  || null)
            .query(`SELECT order_id FROM squareoff_orders
                    WHERE ucc = @ucc AND symbol = @symbol
                    AND exchange = @exchange AND segment = @segment
                    AND status NOT IN ('FAILED','REJECTED','ORDER_TRADED','TRADED')
                    AND CAST(placed_at AS DATE) = CAST(GETDATE() AS DATE)
                    AND (expiry_date  = @expiry     OR (@expiry     IS NULL AND expiry_date  IS NULL))
                    AND (ABS(ISNULL(strike_price,0) - ISNULL(@strike,0)) < 0.01)
                    AND (option_type  = @optionType OR (@optionType IS NULL AND option_type  IS NULL))`);
        if (dupCheck.recordset.length > 0) {
            return res.status(409).json({ error: 'DUPLICATE_ORDER', message: 'A square-off order has already been placed for this security.' });
        }

        const client  = clientCheck.recordset[0];
        const orderId = 'SQ' + Date.now() + Math.random().toString(36).slice(2,6).toUpperCase();

        // ── Capture baseline qty for reconciliation (compliance fix) ──────────
        // Same fix as orders.js /squareoff: day_positions.buy_qty/sell_qty are
        // CUMULATIVE totals for the whole trading day, not a per-trade log. This
        // route did not previously capture a baseline at all, meaning dealer-
        // placed orders were NOT protected by the reconciliation fix for the
        // 2026-07-08 IDEA false-match incident (a brand-new order could still be
        // matched against an older, already-closed trade from earlier the same
        // day). Snapshot the current cumulative quantity now, at placement time.
        const baselineSideCol = side.toUpperCase() === 'BUY' ? 'buy_qty' : 'sell_qty';
        const baselineResult = await pool.request()
            .input('ucc',        sql.VarChar(20),  ucc)
            .input('symbol',     sql.VarChar(100), symbol)
            .input('exchange',   sql.VarChar(10),  exchange)
            .input('segment',    sql.VarChar(10),  segment)
            .input('expiry',     sql.Date,          expiry_date  ? new Date(expiry_date)  : null)
            .input('strike',     sql.Decimal(18,2), strike_price ? Number(strike_price)   : null)
            .input('optionType', sql.VarChar(5),    option_type  || null)
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
        console.log(`[DealerOrders] Baseline qty captured = ${baselineQty} (${baselineSideCol}) for order ${orderId}`);

        await pool.request()
            .input('orderId',     sql.VarChar(50),   orderId)
            .input('ucc',         sql.VarChar(20),   ucc)
            .input('exchange',    sql.VarChar(10),   exchange)
            .input('segment',     sql.VarChar(10),   segment)
            .input('symbol',      sql.VarChar(100),  symbol)
            .input('quantity',    sql.Decimal(18,2), quantity)
            .input('side',        sql.VarChar(4),    side)
            .input('clientName',  sql.VarChar(200),  client.client_name || '')
            .input('placedBy',    sql.VarChar(20),   'DEALER')
            .input('dealerId',    sql.VarChar(10),   String(decoded.dealerId).trim())
            .input('expiry',      sql.Date,          expiry_date  ? new Date(expiry_date)  : null)
            .input('strike',      sql.Decimal(18,2), strike_price || null)
            .input('optionType',  sql.VarChar(5),    option_type  || null)
            .input('baselineQty', sql.Decimal(18,2), baselineQty)
            .query(`INSERT INTO squareoff_orders
                    (order_id, ucc, exchange, segment, symbol, quantity, side,
                     status, client_name, placed_by, dealer_id,
                     expiry_date, strike_price, option_type, placed_at,
                     executed_qty, remaining_qty, baseline_qty)
                    VALUES
                    (@orderId, @ucc, @exchange, @segment, @symbol, @quantity, @side,
                     'ORDER_RECEIVED', @clientName, @placedBy, @dealerId,
                     @expiry, @strike, @optionType, GETDATE(),
                     0, @quantity, @baselineQty)`);

        res.json({ success: true, orderId, message: 'Square-off placed successfully.' });

        // ── RMS email alert (fire-and-forget, non-blocking) ───────────────────
        // This route previously never notified RMS admin by email at all for
        // dealer-placed square-offs -- only the client-facing /squareoff route
        // in orders.js called this. That's why dealer orders showed up fine in
        // the dashboard/DB but no RMS alert email was ever sent for them.
        queueRMSEmailAlert({
            ucc, exchange, segment, symbol, quantity, side,
            expiry_date, strike_price, option_type,
        });

    } catch (err) {
        console.error('Dealer place-squareoff error:', err);
        if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Session expired.' });
        return res.status(500).json({ error: 'Failed to place order.' });
    }
});



// ── Internal helper: fetch holdings from Sharepro (mirrors holdings.js exactly) ─
const https_mod = require('https');
// NodeCache loaded lazily to avoid crash if package not installed
let holdingsDealerCache = null;
function getDealerCache() {
    if (!holdingsDealerCache) {
        try { const NC = require('node-cache'); holdingsDealerCache = new NC({ stdTTL: 300, checkperiod: 60 }); }
        catch(e) { holdingsDealerCache = { get: () => null, set: () => {} }; }
    }
    return holdingsDealerCache;
}

const SHAREPRO_URL_DEALER = 'https://backoffice.navia.co.in/shrdbms/dotnet/api/stansoft/GetDpHoldingData';
const SHAREPRO_KEY_DEALER = process.env.SHAREPRO_API_KEY || 'e0JDQzRGQzRCLTU1QTEtNEM0Qi04M0E1LURGRjA0NERCNzgxRX0=';

function getDealerTodayDate() {
    const now  = new Date();
    const dd   = String(now.getDate()).padStart(2, '0');
    const mm   = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
}

async function fetchHoldingsForUCC(ucc) {
    const today    = getDealerTodayDate();
    const cacheKey = `dealer-holdings:${ucc}:${today}`;

    const cached = getDealerCache().get(cacheKey);
    if (cached) {
        console.log(`[Holdings-Dealer] Cache hit: ${ucc}`);
        return { recordset: cached };
    }

    return new Promise((resolve) => {
        const body = JSON.stringify({
            key:      SHAREPRO_KEY_DEALER,
            ucc:      ucc,
            segments: 'NSDL',
            date:     today
        });

        const urlObj  = new URL(SHAREPRO_URL_DEALER);
        const options = {
            hostname: urlObj.hostname,
            path:     urlObj.pathname,
            method:   'POST',
            headers:  {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            // FIX (16-Jul-2026): was 6000ms -- 9 seconds shorter than the
            // client-side holdings.js route's 15000ms timeout for the exact
            // same Sharepro endpoint/UCC. Root-caused live via production
            // logs: "[Holdings] Fetched 15 holdings for 88707169" (client
            // route, 15s timeout, succeeded) followed 350ms later by
            // "[Holdings-Dealer] Timeout" / "socket hang up" (this route, 6s
            // timeout, killed mid-flight) for the SAME UCC in the SAME
            // second -- Sharepro was simply taking 8-10s to respond, well
            // within the client route's budget but past this one's. Matched
            // to 15000ms so both routes give Sharepro the same amount of time.
            timeout: 15000
        };

        const req = https_mod.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed     = JSON.parse(data);
                    const rawHoldings = parsed.curdata || [];
                    const holdings   = rawHoldings.map((h, idx) => ({
                        id:           idx + 1,
                        isin:         h.isincd?.trim()    || '',
                        symbol:       h.compname?.trim()  || '',
                        company_name: h.compname?.trim()  || '',
                        quantity:     Number(h.balance)   || 0,
                        close_price:  Number(h.closerate) || 0,
                        total_value:  Number(h.holding)   || 0,
                        idn:          h.idn?.trim()       || '',
                    })).filter(h => h.quantity > 0);

                    getDealerCache().set(cacheKey, holdings);
                    console.log(`[Holdings-Dealer] Fetched ${holdings.length} holdings for ${ucc}`);
                    resolve({ recordset: holdings });
                } catch (e) {
                    console.error('[Holdings-Dealer] Parse error:', e.message);
                    resolve({ recordset: [] });
                }
            });
        });

        req.on('error',   err => { console.error('[Holdings-Dealer] Error:', err.message); resolve({ recordset: [] }); });
        req.on('timeout', ()  => { req.destroy(); console.error('[Holdings-Dealer] Timeout'); resolve({ recordset: [] }); });

        req.write(body);
        req.end();
    });
}


module.exports = router;