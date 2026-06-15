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
        max:                  20,
        min:                  2,
        idleTimeoutMillis:    30000,
        acquireTimeoutMillis: 15000,
    },
};

let pool;
let poolConnecting = false;

async function getConnection() {
    if (pool && pool.connected) return pool;
    if (poolConnecting) {
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 500));
            if (pool && pool.connected) return pool;
        }
        throw new Error('DB pool connect timeout');
    }
    poolConnecting = true;
    try {
        if (pool) { try { await pool.close(); } catch (_) {} pool = null; }
        pool = await sql.connect(config);
        console.log('[DB] Pool connected');
        return pool;
    } catch (err) {
        pool = null;
        throw err;
    } finally {
        poolConnecting = false;
    }
}

// Alias for sync routes — uses same pool but signals intent
const getSyncConnection = getConnection;

module.exports = { getConnection, getSyncConnection, sql };