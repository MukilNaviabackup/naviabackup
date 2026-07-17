'use strict';
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const { getConnection, sql } = require('../config/database');
require('dotenv').config();

const OTP_EXPIRY_MINUTES = 10;  // 10 min to allow for SMS delivery delay

/* ── Email transporter ───────────────────────────────────────────────────────*/
function createTransporter() {
    return nodemailer.createTransport({
        host:   process.env.SMTP_HOST || 'smtp.zatpatmail.com',
        port:   465,
        secure: true,
        auth: {
            user: process.env.SMTP_USER || 'emailapikey',
            pass: process.env.SMTP_PASSWORD
        },
        tls: { rejectUnauthorized: false },
        // ── FIX: hard connection + send timeouts so SMTP never hangs forever
        connectionTimeout: 8000,   // 8s to connect
        greetingTimeout:   5000,   // 5s for SMTP greeting
        socketTimeout:     10000,  // 10s per socket operation
    });
}

/* ── SMS sender ─────────────────────────────────────────────────────────────*/
async function sendSMS(mobile, clientName, otp) {
    try {
        // Validate env vars before making the call
        if (!process.env.SMARTPING_USERNAME || !process.env.SMARTPING_PASSWORD) {
            console.error('[OTP] SMS SKIPPED — SMARTPING_USERNAME or SMARTPING_PASSWORD not set in env');
            return false;
        }
        if (!process.env.SMARTPING_SENDER_ID || !process.env.SMARTPING_CONTENT_ID || !process.env.SMARTPING_ENTITY_ID) {
            console.error('[OTP] SMS SKIPPED — SMARTPING_SENDER_ID / CONTENT_ID / ENTITY_ID not set in env');
            return false;
        }

        const message = `Dear ${clientName}, Your OTP for Navia Backup Utility is ${otp} . This is valid for 10 minutes and can be used only once. Regards, Team Navia.`;
        const encodedMessage = encodeURIComponent(message);
        const url = `https://bulksmsapi.vispl.in/?username=${process.env.SMARTPING_USERNAME}&password=${process.env.SMARTPING_PASSWORD}&messageType=text&mobile=${mobile}&senderId=${process.env.SMARTPING_SENDER_ID}&ContentID=${process.env.SMARTPING_CONTENT_ID}&EntityID=${process.env.SMARTPING_ENTITY_ID}&message=${encodedMessage}`;

        console.log(`[OTP] SMS URL (masked): https://bulksmsapi.vispl.in/?username=***&mobile=${mobile}&senderId=${process.env.SMARTPING_SENDER_ID}`);

        const controller = new AbortController();
        const timer      = setTimeout(() => controller.abort(), 2000);  // 2s — fail fast, email is primary

        const response = await fetch(url, {
            method:  'GET',
            headers: { 'Cache-Control': 'no-cache' },
            signal:  controller.signal
        });
        clearTimeout(timer);

        const responseText = await response.text();
        // Log full response so we can diagnose API errors
        console.log(`[OTP] SMS API response for ${mobile} (status ${response.status}):`, responseText);

        // VISPL/Smartping returns non-200 or error codes in body on failure
        if (!response.ok) {
            console.error(`[OTP] SMS API HTTP error: ${response.status}`);
            return false;
        }
        // Check for common error strings in the response body
        const lowerResp = responseText.toLowerCase();
        if (lowerResp.includes('error') || lowerResp.includes('fail') || lowerResp.includes('invalid')) {
            console.error(`[OTP] SMS API returned error body: ${responseText}`);
            return false;
        }

        console.log(`[OTP] SMS dispatched to ${mobile}`);
        return true;
    } catch (err) {
        if (err.name === 'AbortError') {
            console.error(`[OTP] SMS TIMEOUT — bulksmsapi.vispl.in did not respond within 10s for mobile ${mobile}`);
        } else {
            console.error(`[OTP] SMS ERROR for ${mobile}:`, err.name, err.message);
        }
        return false;
    }
}

/* ── Email sender ────────────────────────────────────────────────────────────*/
async function sendEmail(email, clientName, otp) {
    try {
        if (!process.env.SMTP_PASSWORD) {
            console.error('[OTP] EMAIL SKIPPED — SMTP_PASSWORD not set in env');
            return false;
        }

        const transporter = createTransporter();

        const fromAddress = process.env.SMTP_FROM || 'updates@navia.co.in';

        const info = await transporter.sendMail({
            from:       `"Navia Backup | Navia Markets" <${fromAddress}>`,
            to:         email,
            subject:    `${otp} is your Navia Backup OTP`,
            replyTo:    'support@navia.co.in',
            // Plain text fallback (critical for spam scoring)
            text: `Dear ${clientName},

Your OTP for Navia Backup is: ${otp}

This OTP is valid for 10 minutes. Do not share it with anyone.

Regards,
Navia Markets Ltd`,
            html: `
                <div style="max-width:480px;margin:40px auto;font-family:Arial,sans-serif;border:1px solid #eef0f3;border-radius:12px;overflow:hidden">
                    <div style="background:#1d4ed8;padding:24px 32px">
                        <span style="color:#fff;font-size:18px;font-weight:700">Navia Backup</span>
                        <span style="color:rgba(255,255,255,.75);font-size:13px;margin-left:8px">by Navia Markets Ltd</span>
                    </div>
                    <div style="padding:32px">
                        <p style="color:#374151;font-size:15px;margin-bottom:8px">Dear <strong>${clientName}</strong>,</p>
                        <p style="color:#6b7280;font-size:14px;margin-bottom:20px">Your one-time password for Navia Backup emergency square-off portal:</p>
                        <div style="background:#f0f4ff;border:2px solid #1d4ed8;border-radius:10px;padding:24px;text-align:center;margin:20px 0">
                            <div style="font-size:40px;font-weight:700;letter-spacing:14px;color:#1d4ed8;font-family:monospace">${otp}</div>
                            <div style="font-size:12px;color:#6b7280;margin-top:10px">Valid for 10 minutes &nbsp;·&nbsp; Single use only</div>
                        </div>
                        <div style="background:#fef9c3;border-left:4px solid #ca8a04;border-radius:4px;padding:12px 16px;margin:20px 0">
                            <p style="color:#713f12;font-size:12px;margin:0;line-height:1.6">
                                <strong>Security notice:</strong> Do not share this OTP with anyone.
                                Navia staff will never ask for your OTP.
                            </p>
                        </div>
                        <p style="color:#9ca3af;font-size:12px;margin-top:20px">
                            Not you? Contact <a href="mailto:support@navia.co.in" style="color:#1d4ed8">support@navia.co.in</a>
                        </p>
                    </div>
                    <div style="background:#f9fafb;border-top:1px solid #eef0f3;padding:14px 32px;text-align:center">
                        <p style="color:#9ca3af;font-size:11px;margin:0">
                            Navia Markets Ltd &nbsp;·&nbsp; SEBI Registered &nbsp;·&nbsp; naviabackup.co.in
                        </p>
                    </div>
                </div>
            `
        });

        // Log full delivery info for debugging
        console.log(`[OTP] Email dispatched to ${email}`);
        console.log(`[OTP] Message-ID: ${info.messageId}`);
        console.log(`[OTP] Accepted:`, info.accepted);
        console.log(`[OTP] Rejected:`, info.rejected);
        console.log(`[OTP] Response:`, info.response);

        if (info.rejected && info.rejected.length > 0) {
            console.error(`[OTP] Email REJECTED by server for: ${info.rejected.join(', ')}`);
            return false;
        }

        return true;
    } catch (err) {
        console.error('[OTP] Email ERROR:', err.message);
        if (err.code) console.error('[OTP] Email error code:', err.code);
        if (err.response) console.error('[OTP] SMTP response:', err.response);
        return false;
    }
}

/* ── generateAndSendOTP ─────────────────────────────────────────────────────
 *
 *  THE FIX — three-step optimisation:
 *
 *  1. bcrypt with cost 8 instead of 10  →  ~80ms instead of ~300ms
 *     (still cryptographically strong for a 6-digit OTP with 3-attempt limit)
 *
 *  2. DB INSERT first, return sessionId immediately
 *     The caller gets sessionId as soon as the row is saved (~50ms after bcrypt).
 *     The HTTP response goes back to the client in under 200ms total.
 *
 *  3. SMS + Email fire in background (detached Promise.all)
 *     .catch() swallows errors so unhandled rejections don't crash the process.
 *     Delivery happens in parallel, each with its own timeout guard.
 *
 *  Net result: client sees OTP screen in < 1 second.
 *  OTP arrives on mobile/email within 5–30s depending on SMS provider.
 * ─────────────────────────────────────────────────────────────────────────── */
async function generateAndSendOTP(clientId, mobile, email, clientName, ucc) {

    // Step 1 — generate OTP + hash (cost 8 = ~80ms, down from ~300ms at cost 10)
    const otp       = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash   = await bcrypt.hash(otp, 6);  // cost 6 = ~20ms vs 80ms at cost 8
    const sessionId = uuidv4();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // Step 2 — save session to DB (fast ~50ms) — do this BEFORE sending SMS/email
    const pool = await getConnection();
    await pool.request()
        .input('sessionId', sql.VarChar,  sessionId)
        .input('clientId',  sql.Int,      clientId)
        .input('otpHash',   sql.VarChar,  otpHash)
        .input('expiresAt', sql.DateTime, expiresAt)
        .query(`INSERT INTO otp_sessions
                    (session_id, client_id, otp_hash, expires_at, is_used, attempt_count)
                VALUES
                    (@sessionId, @clientId, @otpHash, @expiresAt, 0, 0)`);

    // Step 3 — fire SMS + email in BACKGROUND (do NOT await)
    // Return sessionId to caller immediately after DB save.
    Promise.all([
        sendSMS(mobile,   clientName || 'Client', otp),
        sendEmail(email,  clientName || 'Client', otp)
    ]).then(([smsSent, emailSent]) => {
        console.log(`[OTP] Delivery complete — clientId:${clientId} | SMS:${smsSent} | Email:${emailSent}`);
        // Log OTP delivery result to system_logs
        setImmediate(async () => {
            try {
                const pool = await getConnection();
                await pool.request()
                    .input('logType',   sql.VarChar(100),  'CLIENT_OTP_SENT')
                    .input('actor',     sql.VarChar(100),  clientName || String(clientId))
                    .input('actorType', sql.VarChar(20),   'CLIENT')
                    .input('ucc',       sql.VarChar(20),   ucc || null)
                    .input('ip',        sql.VarChar(50),   null)
                    .input('details',   sql.NVarChar(500), `SMS:${smsSent} | Email:${emailSent} | Mobile:${mobile}`)
                    .input('status',    sql.VarChar(20),   (smsSent || emailSent) ? 'SUCCESS' : 'FAILED')
                    .input('recName',   sql.VarChar(150),  clientName || null)
                    .input('recMobile', sql.VarChar(20),   mobile || null)
                    .input('recEmail',  sql.VarChar(150),  email || null)
                    .input('otpCode',   sql.VarChar(6),    otp || null)
                    .query(`INSERT INTO system_logs (log_type,actor,actor_type,ucc,ip_address,details,status,
                                recipient_name,recipient_mobile,recipient_email,otp_code,created_at)
                            VALUES (@logType,@actor,@actorType,@ucc,@ip,@details,@status,
                                @recName,@recMobile,@recEmail,@otpCode,GETDATE())`);
            } catch(e) { console.error('[OTP] system_log write failed:', e.message); }
        });
    }).catch(err => {
        console.error('[OTP] Background delivery error:', err.message);
    });

    console.log(`[OTP] Session created for clientId:${clientId} — SMS+email dispatched in background`);

    // Return immediately — client gets OTP screen in < 1 second
    return { sessionId };
}

/* ── verifyOTP ───────────────────────────────────────────────────────────────*/
async function verifyOTP(sessionId, otp) {
    const pool   = await getConnection();
    const result = await pool.request()
        .input('sessionId', sql.VarChar, sessionId)
        .query(`SELECT *
                FROM   otp_sessions
                WHERE  session_id   = @sessionId
                  AND  expires_at   > GETDATE()
                  AND  is_used      = 0
                  AND  attempt_count < 3`);

    if (result.recordset.length === 0) return null;

    const session = result.recordset[0];
    const isValid = await bcrypt.compare(otp, session.otp_hash);

    if (!isValid) {
        await pool.request()
            .input('sessionId', sql.VarChar, sessionId)
            .query(`UPDATE otp_sessions
                    SET attempt_count = attempt_count + 1
                    WHERE session_id = @sessionId`);
        return null;
    }

    await pool.request()
        .input('sessionId', sql.VarChar, sessionId)
        .query(`UPDATE otp_sessions
                SET is_used = 1
                WHERE session_id = @sessionId`);

    return session.client_id;
}

module.exports = { generateAndSendOTP, verifyOTP };