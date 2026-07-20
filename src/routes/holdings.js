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
// quantity here, with the dashboard still inviting a duplicate square-off.
//
// FIX (2026-07-20, rev2): the first version of this fix netted against
// day_positions, which logs ALL intraday activity for a symbol regardless of
// source -- including trades placed outside Navia Backup, or trades that
// executed on the wrong side due to a broker/RMS-side error. That wrongly
// pulled unrelated activity into Holdings. Day Position and Holdings are
// different concepts: Day Position is a raw intraday log; Holdings should
// move only when the client's OWN square-off order (placed through this app)
// actually completed. Reads squareoff_orders (ORDER_TRADED/PARTIALLY_TRADED
// only, CM only), resolving ISIN via symbol_master since squareoff_orders
// itself doesn't store one.
//
// FIX (2026-07-20, rev3): filtered on placed_at = today, which is wrong -- an
// order can be PLACED days ago (e.g. a previously stuck/stale order that only
// later got manually or automatically reconciled) and only actually TRADE
// later. What matters is whether the trade has already been absorbed into
// Sharepro's own (T-1-style) snapshot yet -- that's governed by traded_at,
// not placed_at. Orders with a NULL traded_at (older rows / manual
// corrections that never set it) are still included rather than silently
// dropped.
//
// FIX (2026-07-20, rev4): the symbol_master JOIN silently failed for orders
// placed via the Holdings tab's own "Square off" button -- that flow stores
// symbol as the FULL company name plus ISIN (e.g. "VODAFONE IDEA LIMITED EQ
// ; INE669E01016"), not the short ticker ("IDEA") that Day-Position-
// originated orders and symbol_master.nse_symbol/bse_symbol use. That
// mismatch is why a Holdings-tab-placed square-off order never netted
// correctly in ANY earlier revision of this fix, regardless of the date
// filter used. Extract the ISIN directly out of the "Company Name ; ISIN"
// string when present; fall back to the symbol_master JOIN (now LEFT JOIN,
// so a compound-symbol row isn't excluded just for having no symbol_master
// match) for normal short-ticker orders.
//
// FIX (2026-07-20, rev5): the "traded_at IS NULL" safety-net fallback was
// wrong -- it doesn't just catch today's orders that are missing a
// timestamp, it also catches OLD stuck orders (e.g. a PARTIALLY_TRADED row
// placed 6 days ago that never got traded_at set) and double-counts them
// against Sharepro's holdings balance, which already reflects anything that
// settled on a previous day. Confirmed live: an old 2026-07-14
// PARTIALLY_TRADED VODAFONE IDEA row with traded_at=NULL was being netted
// alongside today's genuine 13-share sell, wrongly producing 14-13-1=0
// instead of the correct 14-13=1. traded_at is reliably set by
// reconciliationService when an order reaches ORDER_TRADED/PARTIALLY_TRADED,
// so requiring it to be strictly today (no NULL fallback) is the correct,
// non-double-counting filter.
// FIX (2026-07-20, rev7): dropped the symbol_master JOIN/fallback entirely.
// That fallback let a Day-Position-placed order (short ticker, e.g. "BEL")
// resolve to the same ISIN as a Holdings row and affect Holdings -- which is
// exactly the cross-contamination the user has repeatedly said must never
// happen. Holdings must ONLY ever be affected by orders placed through the
// Holdings tab's own Square-off button, which is the only flow that stores
// symbol as the compound "Company Name ; ISIN" string. Restricting to
// CHARINDEX(' ; ', o.symbol) > 0 makes that the sole, unambiguous signal --
// a Day-Position-originated order (plain short ticker, no ' ; ') can no
// longer match here no matter what its ISIN would otherwise resolve to.
async function fetchTodayTradedSquareoffsByIsin(ucc) {
    try {
        const pool = await getConnection();
        const result = await pool.request()
            .input('ucc', sql.VarChar(20), ucc.trim())
            .query(`SELECT
                        LTRIM(RTRIM(SUBSTRING(o.symbol, CHARINDEX(' ; ', o.symbol) + 3, 50))) AS isin,
                        o.side, o.executed_qty
                    FROM squareoff_orders o
                    WHERE o.ucc = @ucc
                    AND o.segment = 'CM'
                    AND CHARINDEX(' ; ', o.symbol) > 0
                    AND o.status IN ('ORDER_TRADED', 'PARTIALLY_TRADED')
                    AND CAST(o.traded_at AS DATE) = CAST(GETDATE() AS DATE)`);

        const isinNet = new Map();
        for (const o of result.recordset) {
            if (!o.isin) continue;
            const agg = isinNet.get(o.isin) || { buy_qty: 0, sell_qty: 0 };
            const qty = Number(o.executed_qty) || 0;
            if ((o.side || '').toUpperCase() === 'BUY') agg.buy_qty += qty;
            else agg.sell_qty += qty;
            isinNet.set(o.isin, agg);
        }
        return isinNet;
    } catch (e) {
        console.error('[Holdings] squareoff_orders fetch error (non-fatal, holdings shown unadjusted):', e.message);
        return new Map();
    }
}

const HOLDINGS_STATUS_PRIORITY = {
    ORDER_TRADED: 3, TRADED: 3,
    PARTIALLY_TRADED: 2,
    ORDER_RECEIVED: 1, RECEIVED: 1, FILE_GENERATED: 1
};
function normalizeHoldingsStatus(st) {
    if (st === 'ORDER_TRADED' || st === 'TRADED') return 'TRADED';
    if (st === 'PARTIALLY_TRADED') return 'PARTIALLY_TRADED';
    if (st === 'ORDER_RECEIVED' || st === 'RECEIVED' || st === 'FILE_GENERATED') return 'ORDER_RECEIVED';
    return null;
}

// NEW (2026-07-20, rev6): status-only lookup for the Holdings tab's action
// pill, matching the "Order received / Partially traded / Traded" pill the
// Day/Net tabs already show instead of a Holdings row just silently changing
// its quantity number. Deliberately SEPARATE from
// fetchTodayTradedSquareoffsByIsin above (which stays untouched and only
// cares about completed trades for the quantity math) -- this one also needs
// to see ORDER_RECEIVED/FILE_GENERATED (order placed, not yet executed) so
// the pill survives a page reload, scoped to today by EITHER placed_at or
// traded_at. Traded/Partially traded require file_generated=true, the same
// compliance gate used elsewhere in the app.
// FIX (2026-07-20, rev7): same fix as fetchTodayTradedSquareoffsByIsin above
// -- dropped the symbol_master JOIN/fallback so a Day-Position-placed order
// (short ticker) can never resolve to a Holdings row's ISIN and show a
// status pill here. Only compound "Company ; ISIN" symbols (Holdings tab's
// own Square-off flow) are eligible.
async function fetchTodayHoldingsStatusByIsin(ucc) {
    try {
        const pool = await getConnection();
        const result = await pool.request()
            .input('ucc', sql.VarChar(20), ucc.trim())
            .query(`SELECT
                        LTRIM(RTRIM(SUBSTRING(o.symbol, CHARINDEX(' ; ', o.symbol) + 3, 50))) AS isin,
                        o.status, o.file_generated
                    FROM squareoff_orders o
                    WHERE o.ucc = @ucc
                    AND o.segment = 'CM'
                    AND CHARINDEX(' ; ', o.symbol) > 0
                    AND (
                        CAST(o.placed_at AS DATE) = CAST(GETDATE() AS DATE)
                        OR CAST(o.traded_at AS DATE) = CAST(GETDATE() AS DATE)
                    )`);

        const statusMap = new Map();
        for (const o of result.recordset) {
            if (!o.isin) continue;
            const st = (o.status || '').toUpperCase();
            if ((st === 'ORDER_TRADED' || st === 'TRADED' || st === 'PARTIALLY_TRADED') && !o.file_generated) continue;
            const priority = HOLDINGS_STATUS_PRIORITY[st];
            if (!priority) continue;
            const existing = statusMap.get(o.isin);
            if (!existing || priority > existing.priority) {
                statusMap.set(o.isin, { status: st, priority });
            }
        }
        return statusMap;
    } catch (e) {
        console.error('[Holdings] status lookup error (non-fatal, no pill shown):', e.message);
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

        // ── Fetch from Sharepro (and today's traded square-offs, in parallel) ──
        console.log(`[Holdings] Fetching from Sharepro: UCC=${ucc} Date=${today}`);
        const [result, isinNet, isinStatus] = await Promise.all([
            fetchShareproHoldings(ucc, today),
            fetchTodayTradedSquareoffsByIsin(ucc),
            fetchTodayHoldingsStatusByIsin(ucc)
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

        // FIX (2026-07-20, rev2): net only this app's own completed square-off
        // orders into the raw Sharepro quantity. total_value is recomputed
        // from the adjusted quantity (qty * close_price) rather than left at
        // Sharepro's raw pre-adjustment value -- otherwise a fully squared-off
        // holding would show quantity 0 next to a stale non-zero rupee value.
        // Holdings with no matching traded square-off today are left
        // completely untouched.
        // today_status attaches the same "Order received / Partially traded /
        // Traded" pill the Day/Net tabs already use for a Holdings row,
        // instead of the row just silently changing its quantity number.
        holdings = holdings.map(h => {
            const net = h.isin ? isinNet.get(h.isin) : null;
            const today_status = h.isin ? normalizeHoldingsStatus(isinStatus.get(h.isin)?.status) : null;
            if (!net) return { ...h, today_status };
            const adjustedQty = Math.max(0, Number(h.quantity) - net.sell_qty + net.buy_qty);
            return {
                ...h,
                quantity:    adjustedQty,
                total_value: Math.round(adjustedQty * h.close_price * 100) / 100,
                today_status
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