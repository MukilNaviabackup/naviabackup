const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const { getConnection, sql } = require('../config/database');
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
function writeLog(logType, actor, actorType, ucc, ip, details, status) {
    setImmediate(async () => {
        try {
            const pool = await getConnection();
            await pool.request()
                .input('logType',   sql.VarChar(100),  logType   || 'UNKNOWN')
                .input('actor',     sql.VarChar(100),  actor     || null)
                .input('actorType', sql.VarChar(20),   actorType || 'DEALER')
                .input('ucc',       sql.VarChar(20),   ucc       || null)
                .input('ip',        sql.VarChar(50),   ip        || null)
                .input('details',   sql.NVarChar(500), details   || null)
                .input('status',    sql.VarChar(20),   status    || 'SUCCESS')
                .query(`INSERT INTO system_logs (log_type,actor,actor_type,ucc,ip_address,details,status,created_at)
                        VALUES (@logType,@actor,@actorType,@ucc,@ip,@details,@status,GETDATE())`);
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

        // Reuse existing valid session (unless force=1)
        if (!forceNew) {
            const existingSession = await pool.request()
                .input('dealerId', sql.VarChar(10), String(dealer.dealer_id).trim())
                .query(`SELECT TOP 1 session_id FROM dealer_otp_sessions
                        WHERE dealer_id=@dealerId AND is_used=0 AND attempt_count<3 AND expires_at>GETDATE()
                        ORDER BY expires_at DESC`);

            if (existingSession.recordset.length > 0) {
                writeLog('DEALER_OTP_SENT', dealer.full_name, 'DEALER', null, ip, `OTP reused for ${dealer.email}`, 'SUCCESS');
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

        writeLog('DEALER_OTP_SENT', dealer.full_name, 'DEALER', null, ip, `OTP sent to ${dealer.email} for dealer ${dealer.dealer_id}`, 'SUCCESS');
        sendDealerOTPEmail(dealer.email, dealer.full_name, otp, dealer.dealer_id);
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
            writeLog('DEALER_LOGIN_FAILED', dealerIdValue, 'DEALER', null, ip, 'Invalid OTP attempt', 'FAILED');
            return res.status(401).json({ error: 'Invalid OTP. Please try again.' });
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

        const [positions, orders, dayPos, bfPos, holdingsRes] = await Promise.all([
            // Broker positions
            pool.request().input('ucc', sql.VarChar(20), ucc.trim())
                .query(`SELECT * FROM positions WHERE ucc = @ucc ORDER BY symbol`),
            // Sq-off orders — source of truth for squareoff_placed state
            pool.request().input('ucc', sql.VarChar(20), ucc.trim())
                .query(`SELECT order_id, ucc, exchange, segment, symbol,
                               quantity, executed_qty, remaining_qty,
                               side, status, placed_at, placed_by, dealer_id,
                               expiry_date, strike_price, option_type
                        FROM squareoff_orders
                        WHERE ucc = @ucc
                        ORDER BY placed_at DESC`),
            // Day positions from DropCopy
            pool.request()
                .input('ucc', sql.VarChar(20), ucc.trim())
                .input('tradeDate', sql.Date, new Date(tradeDate))
                .query(`SELECT * FROM day_positions
                        WHERE ucc = @ucc AND trade_date = @tradeDate
                        ORDER BY instrument_type, symbol`),
            // B/F positions
            pool.request().input('ucc', sql.VarChar(20), ucc.trim())
                .query(`SELECT * FROM bf_positions
                        WHERE ucc = @ucc
                        AND biz_date = (SELECT MAX(biz_date) FROM bf_positions WHERE ucc = @ucc)
                        ORDER BY instrument_type, symbol`),
            // Holdings — fetch from Sharepro via holdings.js route logic
            // Call internal holdings fetch function directly
            fetchHoldingsForUCC(ucc.trim())
        ]);

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
        console.error('Dealer client-data error:', err);
        if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Session expired. Please login again.' });
        return res.status(500).json({ error: 'Failed to load client data.' });
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

        // Check duplicate
        const dupCheck = await pool.request()
            .input('ucc',     sql.VarChar(20), ucc)
            .input('symbol',  sql.VarChar(100), symbol)
            .input('exchange',sql.VarChar(10),  exchange)
            .input('segment', sql.VarChar(10),  segment)
            .query(`SELECT order_id FROM squareoff_orders
                    WHERE ucc = @ucc AND symbol = @symbol
                    AND exchange = @exchange AND segment = @segment
                    AND status NOT IN ('REJECTED','FAILED')
                    AND CAST(placed_at AS DATE) = CAST(GETDATE() AS DATE)`);
        if (dupCheck.recordset.length > 0) {
            return res.status(409).json({ error: 'DUPLICATE_ORDER', message: 'Square-off already placed for this security.' });
        }

        const client  = clientCheck.recordset[0];
        const orderId = 'SQ' + Date.now() + Math.random().toString(36).slice(2,6).toUpperCase();

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
            .query(`INSERT INTO squareoff_orders
                    (order_id, ucc, exchange, segment, symbol, quantity, side,
                     status, client_name, placed_by, dealer_id,
                     expiry_date, strike_price, option_type, placed_at)
                    VALUES
                    (@orderId, @ucc, @exchange, @segment, @symbol, @quantity, @side,
                     'ORDER_RECEIVED', @clientName, @placedBy, @dealerId,
                     @expiry, @strike, @optionType, GETDATE())`);

        return res.json({ success: true, orderId, message: 'Square-off placed successfully.' });

    } catch (err) {
        console.error('Dealer place-squareoff error:', err);
        if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Session expired.' });
        return res.status(500).json({ error: 'Failed to place order.' });
    }
});



// ── Internal helper: fetch holdings from Sharepro for a given UCC ────────────
// Mirrors the logic in holdings.js but callable without HTTP overhead
async function fetchHoldingsForUCC(ucc) {
    try {
        const holdingsRoute = require('./holdings');
        // holdings.js exports a getHoldingsData function if available
        if (holdingsRoute.getHoldingsData) {
            const data = await holdingsRoute.getHoldingsData(ucc);
            return { recordset: data || [] };
        }
    } catch(e) {}
    // Fallback: call via internal HTTP if module export not available
    try {
        const http = require('http');
        return new Promise((resolve) => {
            const req = http.get(
                `http://localhost:${process.env.PORT || 3000}/api/holdings?ucc=${ucc}&internal=1`,
                { headers: { 'x-internal-key': process.env.SYNC_API_KEY || '' } },
                (res) => {
                    let body = '';
                    res.on('data', d => body += d);
                    res.on('end', () => {
                        try {
                            const data = JSON.parse(body);
                            resolve({ recordset: data.holdings || [] });
                        } catch { resolve({ recordset: [] }); }
                    });
                }
            );
            req.on('error', () => resolve({ recordset: [] }));
            req.setTimeout(5000, () => { req.abort(); resolve({ recordset: [] }); });
        });
    } catch(e) {
        return { recordset: [] };
    }
}

module.exports = router;