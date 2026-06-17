'use strict';
const sql = require('mssql');
require('dotenv').config();

const config = {
    server:   process.env.DB_SERVER,
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: {
        encrypt:                true,
        trustServerCertificate: false,
        connectTimeout:         30000,
        requestTimeout:         30000,
        cancelTimeout:          5000,
    },
    pool: {
        max:                  8,   // Azure SQL S1 safe limit
        min:                  1,
        idleTimeoutMillis:    20000,
        acquireTimeoutMillis: 10000,
    },
};

let pool;
let poolConnecting = false;

async function getConnection() {
    if (pool && pool.connected) return pool;
    if (poolConnecting) {
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 500));
            if (pool && pool.connected) return pool;
        }
        throw new Error('DB pool connect timeout');
    }
    poolConnecting = true;
    try {
        if (pool) { try { await pool.close(); } catch (_) {} pool = null; }
        // Retry up to 3 times with backoff on ECONNRESET
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                pool = await sql.connect(config);
                console.log('[DB] Pool connected');
                return pool;
            } catch (err) {
                pool = null;
                if (attempt < 3 && (err.code === 'ECONNRESET' || err.message.includes('socket hang up'))) {
                    console.warn(`[DB] Connect attempt ${attempt} failed, retrying in ${attempt}s...`);
                    await new Promise(r => setTimeout(r, attempt * 1000));
                } else {
                    throw err;
                }
            }
        }
    } finally {
        poolConnecting = false;
    }
}

// Alias for sync routes — uses same pool but signals intent
const getSyncConnection = getConnection;

module.exports = { getConnection, getSyncConnection, sql };