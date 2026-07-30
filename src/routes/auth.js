const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { getConnection, sql } = require('../config/database');
const { generateAndSendOTP, verifyOTP } = require('../services/otpService');
require('dotenv').config();

/* ── Masking helpers for OTP screen display ──────────────────────────────────
 * Mask the client's own registered mobile/email before sending to the
 * frontend, so the OTP screen can show "OTP sent to ******5065 and
 * ela*****@*****.***" instead of a generic message -- without ever
 * transmitting the full mobile/email over this endpoint. */
function maskMobile(mobile) {
    if (!mobile) return '';
    const digits = mobile.toString().trim();
    if (digits.length <= 4) return digits;
    return '*'.repeat(digits.length - 4) + digits.slice(-4);
}
function maskEmail(email) {
    if (!email) return '';
    const parts = email.split('@');
    if (parts.length !== 2) return email;
    const [local, domain] = parts;
    const visibleLen   = Math.min(3, local.length);
    const maskedLocal   = local.slice(0, visibleLen) + '*'.repeat(Math.max(local.length - visibleLen, 1));
    const maskedDomain  = domain.split('.').map(p => '*'.repeat(p.length)).join('.');
    return `${maskedLocal}@${maskedDomain}`;
}

/* ── Helper: write to system_logs (non-blocking) ────────────────────────────*/
// Fire-and-forget system log writer — NEVER throws, NEVER blocks response
function writeLog(logType, actor, actorType, ucc, ipAddress, details, status) {
    setImmediate(async () => {
        try {
            const pool = await getConnection();
            await pool.request()
                .input('logType',   sql.VarChar(100),  logType              || 'UNKNOWN')
                .input('actor',     sql.VarChar(100),  actor                || null)
                .input('actorType', sql.VarChar(20),   actorType            || 'CLIENT')
                .input('ucc',       sql.VarChar(20),   ucc                  || null)
                .input('ip',        sql.VarChar(50),   ipAddress            || null)
                .input('details',   sql.NVarChar(500), details              || null)
                .input('status',    sql.VarChar(20),   status               || 'SUCCESS')
                .query(`INSERT INTO system_logs
                            (log_type, actor, actor_type, ucc, ip_address, details, status, created_at)
                        VALUES
                            (@logType, @actor, @actorType, @ucc, @ip, @details, @status, GETDATE())`);
        } catch (err) {
            console.error('[SystemLog] write failed (non-critical):', err.message);
        }
    });
}

/* ── Account status gate (2026-07-29) ────────────────────────────────────────
 * Client Account Status / Segment Status compliance requirement. Checked in
 * ADDITION to the existing `is_active = 1` filter already present in every
 * query below -- that filter is untouched, so any client who could log in
 * before this change can still reach this check exactly as before. This gate
 * only adds a new blocking layer for accounts whose account_status is now
 * CLOSED or SUSPENDED (previously not checked at login at all).
 *
 * Returns null if the account may proceed (ACTIVE / REACTIVE, or status is
 * somehow blank/unrecognised -- fails open to current behaviour rather than
 * locking out a client over unexpected data), or a {status, body} object
 * describing the HTTP response to send back if login must be blocked. */
// Account status codes (numeric, 2026-07-30): 1=ACTIVE, 2=SUSPENDED, 3=CLOSED.
// Kept in sync with clientRoutes.js's ACCOUNT_STATUS_LABELS -- there's no
// shared module between these two route files today, so the mapping is
// duplicated here deliberately rather than silently drifting.
const ACC_SUSPENDED = '2', ACC_CLOSED = '3';

function checkAccountStatusGate(accountStatus) {
    const status = (accountStatus || '').toString().trim();

    // NOTE (2026-07-29): the human-readable text lives in `error` (not
    // `message`) deliberately -- every other error response in this file
    // uses `{ error: '<readable text>' }`, and the frontend's existing
    // fallback chain (`err.response?.data?.error || ... `) already reads
    // that field first. Putting the message there means the Closed/
    // Suspended text displays correctly even without any frontend change,
    // via the exact same code path that already handles every other error.
    // `errorCode` is a new, additional field the frontend can optionally
    // key off of for a richer popup (e.g. the Dormant/reactivate modal).
    if (status === ACC_CLOSED) {
        return {
            status: 403,
            body: {
                error:     'Your account is in closed status. We could not authorize your login.',
                errorCode: 'ACCOUNT_CLOSED'
            }
        };
    }

    if (status === ACC_SUSPENDED) {
        return {
            status: 403,
            body: {
                error:         'Your account is in Dormant status. Please reactivate your account to continue.',
                errorCode:     'ACCOUNT_SUSPENDED',
                reactivateUrl: 'https://rekyc.navia.co.in/login.php'
            }
        };
    }

    // ACTIVE (1), or blank/unrecognised -> allow (fail open). No code is 0,
    // so the `(accountStatus || '')` truthy-coercion above can never
    // mistake a real status value for "not set".
    return null;
}

/* ── Step 1: UCC + DOB → validate → send OTP ────────────────────────────────*/
router.post('/login/initiate', async (req, res) => {
    const { ucc, dob } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;

    if (!ucc || !dob) {
        return res.status(400).json({ error: 'UCC and Date of Birth are required.' });
    }

    try {
        const pool = await getConnection();
        const result = await pool.request()
            .input('ucc', sql.VarChar, ucc.toUpperCase().trim())
            .input('dob', sql.Date, dob)
            .query(`SELECT client_id, mobile, email, client_name, account_status
                    FROM clients
                    WHERE ucc = @ucc AND dob = @dob AND is_active = 1`);

        if (result.recordset.length === 0) {
            writeLog('CLIENT_LOGIN_FAILED', ucc.toUpperCase(), 'CLIENT', ucc.toUpperCase(), ip, 'Invalid UCC or DOB', 'FAILED');
            return res.status(401).json({ error: 'Invalid UCC or Date of Birth.' });
        }

        const client = result.recordset[0];

        // Account status gate (2026-07-29) — checked before an OTP is ever
        // sent, so a closed/suspended account never receives an OTP.
        const gate = checkAccountStatusGate(client.account_status);
        if (gate) {
            writeLog('CLIENT_LOGIN_BLOCKED', client.client_name, 'CLIENT', ucc.toUpperCase(), ip,
                `Login blocked at initiate — account_status=${client.account_status}`, 'FAILED');
            return res.status(gate.status).json(gate.body);
        }

        // Clean up stale OTP sessions
        await pool.request()
            .input('cid', sql.Int, client.client_id)
            .query(`DELETE FROM otp_sessions WHERE client_id = @cid`);

        const { sessionId } = await generateAndSendOTP(
            client.client_id,
            client.mobile,
            client.email,
            client.client_name,
            client.ucc
        );

        // Log OTP sent (non-blocking)
        writeLog('CLIENT_OTP_SENT', client.client_name, 'CLIENT', client.ucc, ip,
            `OTP dispatched | Mobile:${client.mobile} | Email:${client.email} | SMS+Email in background`, 'SUCCESS');

        return res.json({
            success:      true,
            sessionId,
            message:      'OTP sent to registered mobile and email.',
            clientName:   client.client_name,
            maskedMobile: maskMobile(client.mobile),
            maskedEmail:  maskEmail(client.email)
        });

    } catch (err) {
        console.error('Login initiate error:', err);
        return res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

/* ── Step 2: OTP → verify → issue JWT ───────────────────────────────────────*/
router.post('/login/verify-otp', async (req, res) => {
    const { sessionId, otp } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;

    if (!sessionId || !otp) {
        return res.status(400).json({ error: 'Session ID and OTP are required.' });
    }

    try {
        const clientId = await verifyOTP(sessionId, otp);

        if (!clientId) {
            writeLog('CLIENT_LOGIN_FAILED', null, 'CLIENT', null, ip, 'Invalid or expired OTP', 'FAILED');
            return res.status(401).json({ error: 'Invalid or expired OTP. Please try again.' });
        }

        const pool   = await getConnection();
        const result = await pool.request()
            .input('id', sql.Int, clientId)
            .query(`SELECT ucc, client_name, mobile, email, dob, account_status
                    FROM clients WHERE client_id = @id`);

        const client = result.recordset[0];

        // Account status gate (2026-07-29) — re-checked here in addition to
        // /login/initiate, as defense in depth in case an admin changes the
        // account's status in the window between OTP send and OTP verify.
        const gate = checkAccountStatusGate(client.account_status);
        if (gate) {
            writeLog('CLIENT_LOGIN_BLOCKED', client.client_name, 'CLIENT', client.ucc, ip,
                `Login blocked at verify-otp — account_status=${client.account_status}`, 'FAILED');
            return res.status(gate.status).json(gate.body);
        }

        const token = jwt.sign(
            { clientId, ucc: client.ucc, name: client.client_name, mobile: client.mobile, email: client.email, loginType: 'OTP' },
            process.env.JWT_SECRET,
            { expiresIn: '4h' }
        );

        // Log successful client login (non-blocking)
        writeLog('CLIENT_LOGIN_SUCCESS', client.client_name, 'CLIENT', client.ucc, ip,
            `Client ${client.ucc} logged in via OTP | Mobile:${client.mobile} | Session:${sessionId.slice(0,8)}`, 'SUCCESS');

        return res.json({
            success:    true,
            token,
            clientName: client.client_name,
            ucc:        client.ucc,
            mobile:     client.mobile,
            email:      client.email,
            dob: client.dob
                ? new Date(client.dob).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' })
                : null
        });

    } catch (err) {
        console.error('OTP verify error:', err);
        return res.status(500).json({ error: 'OTP verification failed. Please try again.' });
    }
});

/* ── Profile ─────────────────────────────────────────────────────────────────*/
router.get('/profile', require('../middleware/authenticate'), async (req, res) => {
    try {
        const pool   = await getConnection();
        const result = await pool.request()
            .input('ucc', sql.VarChar, req.user.ucc)
            .query(`SELECT ucc, client_name, mobile, email, dob,
                           nse_cm, nse_fo, bse_cm, bse_fo, mcx_fo
                    FROM clients WHERE ucc = @ucc`);
        return res.json({ success: true, client: result.recordset[0] });
    } catch (err) {
        return res.status(500).json({ error: 'Could not fetch profile.' });
    }
});

/* ── SSO login ───────────────────────────────────────────────────────────────*/
router.post('/sso', async (req, res) => {
    const { ucc, sso_token } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;

    if (!ucc || !sso_token) {
        return res.status(400).json({ error: 'UCC and SSO token are required.' });
    }

    const expectedToken = Buffer.from(`${ucc}:${process.env.SSO_SECRET}`).toString('base64');
    if (sso_token !== expectedToken) {
        writeLog('CLIENT_LOGIN_FAILED', ucc, 'CLIENT', ucc, ip, 'Invalid SSO token', 'FAILED');
        return res.status(401).json({ error: 'Invalid SSO token.' });
    }

    try {
        const pool   = await getConnection();
        const result = await pool.request()
            .input('ucc', sql.VarChar, ucc.toUpperCase().trim())
            .query(`SELECT client_id, client_name, mobile, email, ucc, account_status
                    FROM clients WHERE ucc = @ucc AND is_active = 1`);

        if (result.recordset.length === 0) {
            return res.status(401).json({ error: 'Client not found.' });
        }

        const client = result.recordset[0];

        // Account status gate (2026-07-29) — SSO bypasses OTP entirely, so
        // it needs the identical gate applied here.
        const gate = checkAccountStatusGate(client.account_status);
        if (gate) {
            writeLog('CLIENT_LOGIN_BLOCKED', client.client_name, 'CLIENT', client.ucc, ip,
                `SSO login blocked — account_status=${client.account_status}`, 'FAILED');
            return res.status(gate.status).json(gate.body);
        }

        const token = jwt.sign(
            { clientId: client.client_id, ucc: client.ucc, name: client.client_name, loginType: 'SSO' },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        writeLog('CLIENT_LOGIN_SUCCESS', client.client_name, 'CLIENT', client.ucc, ip,
            `Client ${client.ucc} SSO login`, 'SUCCESS');

        return res.json({ success: true, token, clientName: client.client_name, ucc: client.ucc, loginType: 'SSO' });

    } catch (err) {
        console.error('SSO login error:', err);
        return res.status(500).json({ error: 'SSO login failed.' });
    }
});

module.exports = router;