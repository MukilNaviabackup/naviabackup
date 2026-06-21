const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const { getConnection, sql } = require('../config/database');
const { adminAuthenticate } = require('../middleware/adminAuthenticate');
require('dotenv').config();

// ── IST end-of-day helper ─────────────────────────────────────────────────────
function getISTEndOfDay() {
    // Returns end of current calendar day in IST (23:59:59 IST = 18:29:59 UTC)
    const nowIST    = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const eodUTC    = new Date(Date.UTC(
        nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate(),
        18, 29, 59, 0   // 23:59:59 IST
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
                .input('actorType', sql.VarChar(20),   actorType || 'ADMIN')
                .input('ucc',       sql.VarChar(20),   ucc       || null)
                .input('ip',        sql.VarChar(50),   ip        || null)
                .input('details',   sql.NVarChar(500), details   || null)
                .input('status',    sql.VarChar(20),   status    || 'SUCCESS')
                .query(`INSERT INTO system_logs (log_type,actor,actor_type,ucc,ip_address,details,status,created_at)
                        VALUES (@logType,@actor,@actorType,@ucc,@ip,@details,@status,GETDATE())`);
        } catch (err) {
            console.error('[SystemLog] admin write failed:', err.message);
        }
    });
}

function createTransporter() {
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.zatpatmail.com',
        port: 465, secure: true,
        auth: { user: process.env.SMTP_USER || 'emailapikey', pass: process.env.SMTP_PASSWORD },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 8000, greetingTimeout: 5000, socketTimeout: 10000,
    });
}

async function sendAdminOTPEmail(email, fullName, otp) {
    try {
        const transporter = createTransporter();
        await transporter.sendMail({
            from: `"Navia Backup Admin" <${process.env.SMTP_FROM || 'updates@navia.co.in'}>`,
            to: email,
            subject: 'Navia Backup Admin — Your OTP',
            html: `<div style="max-width:480px;margin:40px auto;font-family:Arial,sans-serif;border:1px solid #eef0f3;border-radius:12px;overflow:hidden">
                <div style="background:#1e3a5f;padding:24px 32px"><span style="color:#fff;font-size:18px;font-weight:700">Navia Backup — Admin Portal</span></div>
                <div style="padding:32px">
                    <p style="color:#374151;font-size:15px">Dear <strong>${fullName}</strong>,</p>
                    <p style="color:#6b7280;font-size:14px">Your admin login OTP is:</p>
                    <div style="background:#f7f8fa;border:2px dashed #1e3a5f;border-radius:10px;padding:20px;text-align:center;margin:20px 0">
                        <div style="font-size:36px;font-weight:700;letter-spacing:12px;color:#1e3a5f">${otp}</div>
                        <div style="font-size:12px;color:#6b7280;margin-top:8px">Valid for 24 hours</div>
                    </div>
                    <p style="color:#dc2626;font-size:12px">Do not share this OTP with anyone.</p>
                </div>
            </div>`
        });
        console.log(`Admin OTP email sent to ${email}`);
        return true;
    } catch (err) {
        console.error('Admin OTP email error:', err.message);
        return false;
    }
}

// Step 1: Admin enters username → send OTP
router.post('/login/initiate', async (req, res) => {
    const { username } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    if (!username) return res.status(400).json({ error: 'Username is required.' });
    try {
        const pool = await getConnection();
        const result = await pool.request()
            .input('username', sql.VarChar, username.replace('?force=1','').toLowerCase().trim())
            .query(`SELECT admin_id, email, full_name, role FROM admin_users WHERE username = @username AND is_active = 1`);

        if (result.recordset.length === 0) {
            writeLog('ADMIN_LOGIN_FAILED', username, 'ADMIN', null, ip, 'Invalid username', 'FAILED');
            return res.status(401).json({ error: 'Invalid username.' });
        }

        const admin = result.recordset[0];

        // Check if force retrigger requested (sent as separate field)
        const forceNew = !!(req.body.force);

        // ── One-OTP-per-calendar-day rule ───────────────────────────────────
        // If this admin already successfully verified an OTP today (is_used=1,
        // session not yet expired), skip OTP entirely and log them straight in.
        // Confirmed tradeoff: after the first OTP today, username alone is
        // sufficient for the rest of the day — no password exists in this flow.
        if (!forceNew) {
            const alreadyVerified = await pool.request()
                .input('adminId', sql.Int, admin.admin_id)
                .query(`SELECT TOP 1 session_id FROM admin_otp_sessions
                        WHERE admin_id=@adminId AND is_used=1 AND expires_at>GETDATE()
                        ORDER BY expires_at DESC`);

            if (alreadyVerified.recordset.length > 0) {
                const token = jwt.sign(
                    { adminId: admin.admin_id, username: admin.username || username.toLowerCase().trim(), role: admin.role, name: admin.full_name },
                    process.env.JWT_SECRET, { expiresIn: '12h' }
                );
                writeLog('ADMIN_LOGIN_SUCCESS', admin.full_name, 'ADMIN', null, ip, `Admin ${username} re-logged in (already verified today, no OTP required)`, 'SUCCESS');
                console.log(`Admin already verified today, skipping OTP: ${username}`);
                return res.json({
                    success: true,
                    alreadyVerifiedToday: true,
                    token,
                    admin: { username: admin.username || username.toLowerCase().trim(), name: admin.full_name, role: admin.role }
                });
            }
        }

        // Reuse existing valid (unused) session (unless force=1)
        if (!forceNew) {
            const existingSession = await pool.request()
                .input('adminId', sql.Int, admin.admin_id)
                .query(`SELECT TOP 1 session_id FROM admin_otp_sessions
                        WHERE admin_id=@adminId AND is_used=0 AND attempt_count<3 AND expires_at>GETDATE()
                        ORDER BY expires_at DESC`);

            if (existingSession.recordset.length > 0) {
                writeLog('ADMIN_OTP_SENT', admin.full_name, 'ADMIN', null, ip, `OTP reused for ${admin.email}`, 'SUCCESS');
                return res.json({
                    success: true,
                    sessionId: existingSession.recordset[0].session_id,
                    email: admin.email.replace(/(.{2})(.*)(@.*)/, '$1***$3'),
                    message: 'OTP already sent today.',
                    reused: true
                });
            }
        }

        const otp       = Math.floor(100000 + Math.random() * 900000).toString();
        const otpHash   = await bcrypt.hash(otp, 10);
        const sessionId = uuidv4();
        const expiresAt = getISTEndOfDay(); // Expires at 23:59:59 IST today

        await pool.request()
            .input('sessionId', sql.VarChar, sessionId)
            .input('adminId',   sql.Int,     admin.admin_id)
            .input('otpHash',   sql.VarChar, otpHash)
            .input('expiresAt', sql.DateTime, expiresAt)
            .query(`INSERT INTO admin_otp_sessions (session_id,admin_id,otp_hash,expires_at,is_used,attempt_count)
                    VALUES (@sessionId,@adminId,@otpHash,@expiresAt,0,0)`);

        const emailSent = await sendAdminOTPEmail(admin.email, admin.full_name, otp);
        writeLog('ADMIN_OTP_SENT', admin.full_name, 'ADMIN', null, ip,
            `OTP sent to ${admin.email} | Email:${emailSent}`,
            emailSent ? 'SUCCESS' : 'FAILED');
        console.log(`Admin OTP for ${username}: ${otp}`);

        return res.json({ success: true, sessionId, email: admin.email.replace(/(.{2})(.*)(@.*)/, '$1***$3'), message: 'OTP sent to registered email.', reused: false });

    } catch (err) {
        console.error('Admin login initiate error:', err);
        return res.status(500).json({ error: 'Login failed: ' + err.message });
    }
});

// Step 2: Verify OTP → issue JWT
router.post('/login/verify-otp', async (req, res) => {
    const { sessionId, otp } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    if (!sessionId || !otp) return res.status(400).json({ error: 'Session ID and OTP are required.' });
    try {
        const pool = await getConnection();
        const result = await pool.request()
            .input('sessionId', sql.VarChar, sessionId)
            .query(`SELECT s.otp_hash,s.admin_id,s.expires_at,s.is_used,s.attempt_count,
                           a.username,a.full_name,a.role,a.email
                    FROM admin_otp_sessions s
                    JOIN admin_users a ON s.admin_id=a.admin_id
                    WHERE s.session_id=@sessionId`);

        if (result.recordset.length === 0) return res.status(401).json({ error: 'Invalid session. Please login again.' });
        const session = result.recordset[0];
        // Note: is_used check removed - same-day sessions can be re-verified
        // The OTP hash remains valid for the entire calendar day
        if (new Date(session.expires_at) < new Date()) return res.status(401).json({ error: 'OTP expired. Please login again.' });
        if (session.attempt_count >= 3) return res.status(401).json({ error: 'Too many attempts. Please login again.' });

        console.log(`[Admin verify] sessionId=${sessionId} username=${session.username} otp_len=${otp.trim().length}`);
        const isValid = await bcrypt.compare(otp.trim(), session.otp_hash);
        console.log(`[Admin verify] bcrypt result=${isValid}`);
        if (!isValid) {
            await pool.request().input('sessionId', sql.VarChar, sessionId)
                .query('UPDATE admin_otp_sessions SET attempt_count=attempt_count+1 WHERE session_id=@sessionId');
            writeLog('ADMIN_LOGIN_FAILED', session.username, 'ADMIN', null, ip, 'Invalid OTP attempt', 'FAILED');
            const remaining = Math.max(0, 2 - session.attempt_count);
            return res.status(401).json({ error: `Incorrect OTP. Please check the latest email sent to your registered address. ${remaining > 0 ? remaining + ' attempt(s) remaining.' : 'Click Back and request a new OTP.'}` });
        }

        await pool.request().input('sessionId', sql.VarChar, sessionId)
            .query('UPDATE admin_otp_sessions SET is_used=1 WHERE session_id=@sessionId');
        await pool.request().input('adminId', sql.Int, session.admin_id)
            .query('UPDATE admin_users SET last_login=GETDATE() WHERE admin_id=@adminId');

        const token = jwt.sign(
            { adminId: session.admin_id, username: session.username, role: session.role, name: session.full_name },
            process.env.JWT_SECRET, { expiresIn: '12h' }
        );

        writeLog('ADMIN_LOGIN_SUCCESS', session.full_name, 'ADMIN', null, ip, `Admin ${session.username} logged in`, 'SUCCESS');
        console.log(`Admin login success: ${session.username}`);

        return res.json({ success: true, token, admin: { username: session.username, name: session.full_name, role: session.role } });

    } catch (err) {
        console.error('Admin OTP verify error:', err.message);
        return res.status(500).json({ error: 'Verification failed: ' + err.message });
    }
});

router.get('/profile', adminAuthenticate, async (req, res) => {
    try {
        const pool = await getConnection();
        const result = await pool.request().input('adminId', sql.Int, req.admin.adminId)
            .query('SELECT username,email,full_name,role,last_login FROM admin_users WHERE admin_id=@adminId');
        return res.json({ success: true, admin: result.recordset[0] });
    } catch (err) { return res.status(500).json({ error: 'Could not fetch profile.' }); }
});

router.post('/logout', adminAuthenticate, async (req, res) => {
    try {
        const pool = await getConnection();
        await pool.request().input('adminId', sql.Int, req.admin.adminId)
            .query('UPDATE admin_otp_sessions SET is_used=1 WHERE admin_id=@adminId AND is_used=0');
        return res.json({ success: true, message: 'Logged out successfully.' });
    } catch (err) { return res.status(500).json({ error: 'Logout failed.' }); }
});

module.exports = router;