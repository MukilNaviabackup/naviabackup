const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { getConnection, sql } = require('../config/database');
const { generateAndSendOTP, verifyOTP } = require('../services/otpService');
require('dotenv').config();

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
            .query(`SELECT client_id, mobile, email, client_name
                    FROM clients
                    WHERE ucc = @ucc AND dob = @dob AND is_active = 1`);

        if (result.recordset.length === 0) {
            writeLog('CLIENT_LOGIN_FAILED', ucc.toUpperCase(), 'CLIENT', ucc.toUpperCase(), ip, 'Invalid UCC or DOB', 'FAILED');
            return res.status(401).json({ error: 'Invalid UCC or Date of Birth.' });
        }

        const client = result.recordset[0];

        // Clean up stale OTP sessions
        await pool.request()
            .input('cid', sql.Int, client.client_id)
            .query(`DELETE FROM otp_sessions WHERE client_id = @cid`);

        const { sessionId } = await generateAndSendOTP(
            client.client_id,
            client.mobile,
            client.email,
            client.client_name
        );

        // Log OTP sent (non-blocking)
        writeLog('CLIENT_OTP_SENT', client.client_name, 'CLIENT', client.ucc, ip,
            `OTP sent to ${client.email}`, 'SUCCESS');

        return res.json({
            success:    true,
            sessionId,
            message:    'OTP sent to registered mobile and email.',
            clientName: client.client_name
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
            .query(`SELECT ucc, client_name, mobile, email, dob
                    FROM clients WHERE client_id = @id`);

        const client = result.recordset[0];

        const token = jwt.sign(
            { clientId, ucc: client.ucc, name: client.client_name, mobile: client.mobile, email: client.email, loginType: 'OTP' },
            process.env.JWT_SECRET,
            { expiresIn: '4h' }
        );

        // Log successful client login (non-blocking)
        writeLog('CLIENT_LOGIN_SUCCESS', client.client_name, 'CLIENT', client.ucc, ip,
            `Client ${client.ucc} logged in via OTP`, 'SUCCESS');

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
            .query(`SELECT client_id, client_name, mobile, email, ucc
                    FROM clients WHERE ucc = @ucc AND is_active = 1`);

        if (result.recordset.length === 0) {
            return res.status(401).json({ error: 'Client not found.' });
        }

        const client = result.recordset[0];

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