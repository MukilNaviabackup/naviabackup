'use strict';
const express = require('express');
const router  = express.Router();
const https   = require('https');
const NodeCache = require('node-cache');
const { getConnection, sql } = require('../config/database');
require('dotenv').config();

// ─── Cache holdings for 5 minutes per UCC ────────────────────────────────────
const holdingsCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// ─── Sharepro API config ──────────────────────────────────────────────────────
const SHAREPRO_URL = 'https://backoffice.navia.co.in/shrdbms/dotnet/api/stansoft/GetDpHoldingData';
const SHAREPRO_KEY = process.env.SHAREPRO_API_KEY || 'e0JDQzRGQzRCLTU1QTEtNEM0Qi04M0E1LURGRjA0NERCNzgxRX0=';
const SEGMENT      = 'NSDL';

// ─── Get today's date in DD/MM/YYYY format ────────────────────────────────────
function getTodayDate() {
    const now = new Date();
    const dd  = String(now.getDate()).padStart(2, '0');
    const mm  = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
}

// ─── Call Sharepro Holdings API ───────────────────────────────────────────────
function fetchShareproHoldings(ucc, date) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            key:      SHAREPRO_KEY,
            ucc:      ucc,
            segments: SEGMENT,
            date:     date
        });

        const urlObj = new URL(SHAREPRO_URL);
        const options = {
            hostname: urlObj.hostname,
            path:     urlObj.pathname,
            method:   'POST',
            headers:  {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 15000
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ status: res.statusCode, data: parsed });
                } catch (e) {
                    reject(new Error('Invalid response from Sharepro API'));
                }
            });
        });

        req.on('error',   err => reject(err));
        req.on('timeout', ()  => { req.destroy(); reject(new Error('Sharepro API timeout')); });

        req.write(body);
        req.end();
    });
}

// FIX (2026-07-20): Sharepro's holdings snapshot does not reflect TODAY's own
// trades at all (it's a settled/T-1-style snapshot) -- so a holding that's
// already been fully squared off today still shows its PRE-square-off
// quantity here, with the client-facing dashboard still inviting a duplicate
// square-off. Same root cause and same fix as routes/dealerAuth.js's
// /client-data route: net today's CM buy/sell activity (matched by ISIN)
// into the raw holdings numbers before returning/caching them.
//
// Holdings from Sharepro have no exchange dimension -- a client's holding of
// ISIN X is one number regardless of which exchange they traded it on. But
// day_positions rows are stored per exchange+segment, so the same ISIN can
// appear in more than one day_positions row today (e.g. bought on NSE CM,
// sold on BSE CM). Sum buy_qty/sell_qty across all matching rows per ISIN
// rather than keying off a single row.
async function fetchTodayDayPositionsByIsin(ucc) {
    try {
        const now       = new Date();
        const istDate   = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
        const tradeDate = istDate.toISOString().slice(0, 10);

        const pool = await getConnection();
        const result = await pool.request()
            .input('ucc', sql.VarChar(20), ucc.trim())
            .input('tradeDate', sql.Date, new Date(tradeDate))
            .query(`SELECT isin, instrument_type, buy_qty, sell_qty
                    FROM day_positions
                    WHERE ucc = @ucc AND trade_date = @tradeDate`);

        const dayPosByIsin = new Map();
        for (const dp of result.recordset) {
            if ((dp.instrument_type || '').toUpperCase() !== 'EQUITY' || !dp.isin) continue;
            const agg = dayPosByIsin.get(dp.isin) || { buy_qty: 0, sell_qty: 0 };
            agg.buy_qty  += Number(dp.buy_qty)  || 0;
            agg.sell_qty += Number(dp.sell_qty) || 0;
            dayPosByIsin.set(dp.isin, agg);
        }
        return dayPosByIsin;
    } catch (e) {
        console.error('[Holdings] day_positions fetch error (non-fatal, holdings shown unadjusted):', e.message);
        return new Map();
    }
}

// ─── GET /api/holdings ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized.' });

    try {
        const jwt     = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const ucc     = decoded.ucc?.toString();
        if (!ucc) return res.status(401).json({ error: 'Invalid token.' });

        const today    = getTodayDate();
        const cacheKey = `holdings:${ucc}:${today}`;

        // ── Return cached if available ────────────────────────────────────────
        const cached = holdingsCache.get(cacheKey);
        if (cached) {
            console.log(`[Holdings] Cache hit: ${ucc}`);
            return res.json({ ...cached, cached: true });
        }

        // ── Fetch from Sharepro (and today's day_positions, in parallel) ──────
        console.log(`[Holdings] Fetching from Sharepro: UCC=${ucc} Date=${today}`);
        const [result, dayPosByIsin] = await Promise.all([
            fetchShareproHoldings(ucc, today),
            fetchTodayDayPositionsByIsin(ucc)
        ]);
        console.log(`[Holdings] Sharepro status: ${result.status}, raw: ${JSON.stringify(result.data)}`);

        if (result.status !== 200) {
            console.warn(`[Holdings] Sharepro returned ${result.status} for ${ucc}`);
            return res.json({
                success:        true,
                ucc,
                date:           today,
                holdings:       [],
                total_holdings: 0,
                total_value:    0,
                total_quantity: 0,
                message:        'No holdings found'
            });
        }

        const rawHoldings = result.data?.curdata || [];

        if (!rawHoldings.length) {
            return res.json({
                success:        true,
                ucc,
                date:           today,
                holdings:       [],
                total_holdings: 0,
                total_value:    0,
                total_quantity: 0,
                message:        'No holdings found'
            });
        }

        // ── Map holdings data ─────────────────────────────────────────────────
        let holdings = rawHoldings.map((h, idx) => ({
            id:           idx + 1,
            isin:         h.isincd?.trim()    || '',
            symbol:       h.compname?.trim()  || '',
            company_name: h.compname?.trim()  || '',
            quantity:     Number(h.balance)   || 0,
            close_price:  Number(h.closerate) || 0,
            total_value:  Number(h.holding)   || 0,
            idn:          h.idn?.trim()       || '',
        }));

        // FIX (2026-07-20): net today's own buy/sell activity into the raw
        // Sharepro quantity. total_value is recomputed from the adjusted
        // quantity (qty * close_price) rather than left at Sharepro's raw
        // pre-adjustment value -- otherwise a fully squared-off holding would
        // show quantity 0 next to a stale non-zero rupee value, which is more
        // confusing than the original bug. Holdings with no matching
        // day_position today are left completely untouched.
        holdings = holdings.map(h => {
            const dp = h.isin ? dayPosByIsin.get(h.isin) : null;
            if (!dp) return h;
            const adjustedQty = Math.max(0, Number(h.quantity) - dp.sell_qty + dp.buy_qty);
            return {
                ...h,
                quantity:    adjustedQty,
                total_value: Math.round(adjustedQty * h.close_price * 100) / 100
            };
        });

        const totalValue    = holdings.reduce((s, h) => s + h.total_value, 0);
        const totalQuantity = holdings.reduce((s, h) => s + h.quantity,    0);

        const response = {
            success:        true,
            ucc,
            date:           today,
            holdings,
            total_holdings: holdings.length,
            total_value:    Math.round(totalValue    * 100) / 100,
            total_quantity: Math.round(totalQuantity * 100) / 100,
            cached:         false
        };

        holdingsCache.set(cacheKey, response);
        console.log(`[Holdings] Fetched ${holdings.length} holdings for ${ucc}`);

        return res.json(response);

    } catch (err) {
        console.error('[Holdings] Error:', err.message);
        return res.json({
            success:        true,
            holdings:       [],
            total_holdings: 0,
            total_value:    0,
            total_quantity: 0,
            error_detail:   'Unable to fetch holdings at this time.',
            message:        'Holdings temporarily unavailable'
        });
    }
});

module.exports = router;