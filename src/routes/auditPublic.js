'use strict';
const express = require('express');
const router  = express.Router();
const { getConnection, sql } = require('../config/database');
require('dotenv').config();

// ── HTTP Basic Auth ───────────────────────────────────────────────────────────
function basicAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Navia Backup Audit Portal"');
        return res.status(401).send('Authentication required.');
    }
    const base64 = authHeader.slice(6);
    const [user, pass] = Buffer.from(base64, 'base64').toString().split(':');
    const validUser = process.env.AUDIT_USERNAME || 'naviaaudit';
    const validPass = process.env.AUDIT_PASSWORD || 'NaviaAudit@2026';
    if (user !== validUser || pass !== validPass) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Navia Backup Audit Portal"');
        return res.status(401).send('Invalid credentials.');
    }
    next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getToday() {
    return new Date(Date.now() + 5.5*60*60*1000).toISOString().slice(0, 10);
}

function fmtIST(val) {
    if (!val) return '—';
    return new Date(val).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
        year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    });
}

function maskMobile(m) {
    if (!m) return '—';
    const s = String(m);
    return s.slice(0, 2) + '******' + s.slice(-2);
}

function maskEmail(e) {
    if (!e) return '—';
    const [user, domain] = e.split('@');
    return user[0] + '****@' + domain;
}

// ── HTML shell ────────────────────────────────────────────────────────────────
function page(title, date, content, nav) {
    const today = getToday();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Navia Audit</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:#0D0F12;background:#F4F6F9;min-height:100vh}
.topbar{background:#1B4FD8;color:#fff;padding:12px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.topbar-title{font-size:15px;font-weight:600}
.topbar-sub{font-size:11px;opacity:.8;margin-top:2px}
.date-form{display:flex;gap:8px;align-items:center}
.date-form input[type=date]{padding:5px 9px;border:none;border-radius:5px;font-size:12px;font-family:inherit}
.date-form button{background:#fff;color:#1B4FD8;border:none;border-radius:5px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.wrap{max-width:1200px;margin:0 auto;padding:20px 16px}
.nav{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap}
.nav a{display:inline-block;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:500;text-decoration:none;border:0.5px solid #CBD5E0;background:#fff;color:#374151}
.nav a.active{background:#1B4FD8;color:#fff;border-color:#1B4FD8}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px}
.stat{background:#fff;border:0.5px solid #E2E8F0;border-radius:8px;padding:12px 14px}
.stat-lbl{font-size:10px;color:#64748B;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.stat-num{font-size:26px;font-weight:500;margin-top:4px;color:#0D0F12}
.stat-num.blue{color:#1B4FD8}
.card{background:#fff;border:0.5px solid #E2E8F0;border-radius:10px;overflow:hidden;margin-bottom:16px}
.card-hdr{padding:10px 14px;background:#F8FAFC;border-bottom:0.5px solid #E2E8F0;font-size:12px;font-weight:600;color:#374151;display:flex;justify-content:space-between;align-items:center}
table{width:100%;border-collapse:collapse}
th{background:#F8FAFC;border-bottom:0.5px solid #E2E8F0;color:#64748B;font-size:10px;font-weight:600;padding:8px 12px;text-align:left;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
td{color:#0D0F12;font-size:12px;padding:8px 12px;border-bottom:0.5px solid #F1F5F9;vertical-align:top}
tr:last-child td{border-bottom:none}
tr:hover td{background:#FAFBFC}
.mono{font-family:monospace;font-size:11px}
.badge{display:inline-block;font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;white-space:nowrap}
.b-green{background:#e1f5ee;color:#085041}
.b-red{background:#FEF2F2;color:#991B1B}
.b-blue{background:#EEF2FF;color:#1338A8}
.b-amber{background:#FFFBEB;color:#92400E}
.b-gray{background:#F0F2F5;color:#374151}
.b-purple{background:#EEEDFE;color:#3C3489}
.b-orange{background:#FFF7ED;color:#9A3412}
.pill{display:inline-block;font-size:10px;font-weight:600;padding:2px 9px;border-radius:99px;white-space:nowrap}
.p-client{background:#E0F2FE;color:#0C4A6E}
.p-admin{background:#EEEDFE;color:#3C3489}
.p-dealer{background:#FFF7ED;color:#9A3412}
.p-order{background:#FFFBEB;color:#78350F}
.p-dropcopy{background:#F0FDF4;color:#14532D}
a.ucc-link{color:#1B4FD8;text-decoration:underline;cursor:pointer}
.empty{padding:40px;text-align:center;color:#9BA3B0;font-size:13px}
.export-btn{display:inline-block;padding:5px 12px;background:#1B4FD8;color:#fff;border-radius:5px;font-size:11px;font-weight:600;text-decoration:none}
.back{color:#1B4FD8;font-size:12px;text-decoration:none;display:inline-flex;align-items:center;gap:4px;margin-bottom:12px}
.info-bar{background:#EEF2FF;border:0.5px solid #C7D2FE;border-radius:6px;padding:8px 12px;font-size:12px;color:#1338A8;margin-bottom:12px}
.client-hdr{background:#fff;border:0.5px solid #E2E8F0;border-radius:10px;padding:14px 18px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.avatar{width:44px;height:44px;background:#EEF2FF;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;color:#1B4FD8;flex-shrink:0}
.sec-title{font-size:13px;font-weight:600;margin-bottom:8px;margin-top:16px}
</style>
</head>
<body>
<div class="topbar">
  <div>
    <div class="topbar-title">🔒 Navia Backup — Audit Portal</div>
    <div class="topbar-sub">Internal use only · Navia Markets Ltd · SEBI Registered</div>
  </div>
  <form class="date-form" method="GET" action="/audit">
    <input type="date" name="goto" value="${date}" max="${today}">
    <button type="submit">Go</button>
  </form>
</div>
<div class="wrap">
  <div class="nav">${nav}</div>
  ${content}
</div>
</body>
</html>`;
}

function navLinks(date, active) {
    const links = [
        { href: `/audit/${date}`,          label: '📋 Summary' },
        { href: `/audit/${date}/logins`,   label: '🔐 Logins' },
        { href: `/audit/${date}/otp`,      label: '📱 OTP' },
        { href: `/audit/${date}/orders`,   label: '📦 Sq-Off Orders' },
        { href: `/audit/${date}/dropcopy`, label: '🔄 DropCopy' },
        { href: `/audit/${date}/export`,   label: '⬇ Export CSV' },
    ];
    return links.map(l =>
        `<a href="${l.href}" class="${active === l.label ? 'active' : ''}">${l.label}</a>`
    ).join('');
}

function actionBadge(action) {
    const a = (action || '').toUpperCase();
    if (a.includes('SUCCESS'))                          return 'badge b-green';
    if (a.includes('FAILED'))                           return 'badge b-red';
    if (a.includes('OTP') || a.includes('EMAIL') || a.includes('SMS')) return 'badge b-blue';
    if (a.includes('SQUAREOFF') || a.includes('ORDER')) return 'badge b-amber';
    if (a.includes('SSO'))                              return 'badge b-orange';
    if (a.includes('UPLOAD') || a.includes('BF'))       return 'badge b-purple';
    return 'badge b-gray';
}

function typePill(type) {
    const t = (type || '').toUpperCase();
    if (t === 'CLIENT')   return 'pill p-client';
    if (t === 'ADMIN')    return 'pill p-admin';
    if (t === 'DEALER')   return 'pill p-dealer';
    if (t === 'ORDER')    return 'pill p-order';
    if (t === 'DROPCOPY') return 'pill p-dropcopy';
    return 'pill p-client';
}

// ── Redirect / → today ────────────────────────────────────────────────────────
router.get('/', basicAuth, (req, res) => {
    if (req.query.goto) return res.redirect(`/audit/${req.query.goto}`);
    res.redirect(`/audit/${getToday()}`);
});

// ── GET /audit/:date — Summary ────────────────────────────────────────────────
router.get('/:date', basicAuth, async (req, res) => {
    const date = req.params.date;
    try {
        const pool = await getConnection();

        const [sysLogs, orders, syncCount] = await Promise.all([
            pool.request().input('date', sql.Date, new Date(date))
                .query(`SELECT log_type, actor_type, actor, ucc, details, ip_address, status, created_at
                        FROM system_logs WHERE CAST(created_at AS DATE)=@date ORDER BY created_at DESC`),
            pool.request().input('date', sql.Date, new Date(date))
                .query(`SELECT o.*, c.client_name, c.mobile FROM squareoff_orders o
                        LEFT JOIN clients c ON o.ucc=c.ucc
                        WHERE CAST(o.placed_at AS DATE)=@date ORDER BY o.placed_at DESC`),
            pool.request().input('date', sql.Date, new Date(date))
                .query(`SELECT COUNT(*) AS cnt FROM day_positions WHERE trade_date=@date`)
        ]);

        const logs   = sysLogs.recordset;
        const ords   = orders.recordset;
        const syncs  = syncCount.recordset[0]?.cnt || 0;
        const unique = [...new Set(logs.filter(l=>l.ucc).map(l=>l.ucc))];

        const stats = [
            { lbl: 'Total events',     num: logs.length + ords.length, cls: 'blue' },
            { lbl: 'Client logins',    num: logs.filter(l=>l.log_type==='CLIENT_LOGIN_SUCCESS').length },
            { lbl: 'Failed logins',    num: logs.filter(l=>l.log_type&&l.log_type.includes('FAILED')).length },
            { lbl: 'OTP sent',         num: logs.filter(l=>l.log_type==='CLIENT_OTP_SENT').length },
            { lbl: 'Sq-off orders',    num: ords.length },
            { lbl: 'Admin actions',    num: logs.filter(l=>l.actor_type==='ADMIN').length },
            { lbl: 'Dealer actions',   num: logs.filter(l=>l.actor_type==='DEALER').length },
            { lbl: 'Unique clients',   num: unique.length },
            { lbl: 'DropCopy syncs',   num: syncs },
        ];

        const statHtml = stats.map(s =>
            `<div class="stat"><div class="stat-lbl">${s.lbl}</div>
             <div class="stat-num ${s.cls||''}">${s.num}</div></div>`
        ).join('');

        // Recent 20 events combined
        const combined = [...logs, ...ords.map(o=>({
            created_at: o.placed_at, actor_type:'ORDER', actor:o.ucc,
            ucc:o.ucc, log_type:'SQUAREOFF_'+o.side,
            details:`${o.exchange} ${o.segment} ${o.symbol} Qty:${o.quantity} Status:${o.status}`,
            ip_address:null, status:o.status, client_name:o.client_name
        }))].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,30);

        const rows = combined.map(l =>
            `<tr>
              <td class="mono">${fmtIST(l.created_at)}</td>
              <td><span class="${typePill(l.actor_type)}">${l.actor_type}</span></td>
              <td>${l.actor||'—'}</td>
              <td>${l.ucc ? `<a class="ucc-link" href="/audit/${date}/client/${l.ucc}">${l.ucc}${l.client_name?' · '+l.client_name:''}</a>` : '—'}</td>
              <td><span class="${actionBadge(l.log_type)}">${l.log_type||'—'}</span></td>
              <td style="max-width:280px;font-size:11px">${(l.details||'—').slice(0,120)}</td>
              <td class="mono">${l.ip_address||'—'}</td>
              <td><span class="${l.status==='SUCCESS'?'badge b-green':l.status==='FAILED'?'badge b-red':'badge b-gray'}">${l.status||'—'}</span></td>
            </tr>`
        ).join('');

        const content = `
            <div class="info-bar">📅 Audit date: <b>${date}</b> · ${unique.length} unique clients · ${logs.length + ords.length} total events</div>
            <div class="stat-grid">${statHtml}</div>
            <div class="card">
              <div class="card-hdr">
                <span>Recent activity (last 30 events)</span>
                <a href="/audit/${date}/export" class="export-btn">⬇ Export full CSV</a>
              </div>
              ${combined.length===0 ? '<div class="empty">No activity for this date</div>' : `
              <div style="overflow-x:auto">
              <table>
                <thead><tr>
                  <th>Time (IST)</th><th>Type</th><th>Actor</th><th>UCC / Client</th>
                  <th>Action</th><th>Details</th><th>IP</th><th>Status</th>
                </tr></thead>
                <tbody>${rows}</tbody>
              </table></div>`}
            </div>`;

        res.send(page(`Audit Summary · ${date}`, date, content, navLinks(date,'📋 Summary')));
    } catch(err) {
        res.status(500).send(`<pre>Error: ${err.message}</pre>`);
    }
});

// ── GET /audit/:date/logins — Login events ────────────────────────────────────
router.get('/:date/logins', basicAuth, async (req, res) => {
    const date = req.params.date;
    try {
        const pool = await getConnection();
        const result = await pool.request().input('date', sql.Date, new Date(date))
            .query(`SELECT sl.log_type, sl.actor, sl.actor_type, sl.ucc, sl.details,
                           sl.ip_address, sl.status, sl.created_at,
                           c.client_name, c.mobile, c.email
                    FROM system_logs sl
                    LEFT JOIN clients c ON sl.ucc = c.ucc
                    WHERE CAST(sl.created_at AS DATE)=@date
                    AND sl.log_type IN ('CLIENT_LOGIN_SUCCESS','CLIENT_LOGIN_FAILED',
                                        'ADMIN_LOGIN_SUCCESS','ADMIN_LOGIN_FAILED',
                                        'DEALER_LOGIN_SUCCESS','DEALER_LOGIN_FAILED')
                    ORDER BY sl.created_at DESC`);

        const rows = result.recordset.map(l =>
            `<tr>
              <td class="mono">${fmtIST(l.created_at)}</td>
              <td><span class="${typePill(l.actor_type)}">${l.actor_type}</span></td>
              <td>${l.actor||'—'}</td>
              <td>${l.ucc ? `<a class="ucc-link" href="/audit/${date}/client/${l.ucc}">${l.ucc}</a>` : '—'}</td>
              <td>${l.client_name||'—'}</td>
              <td>${maskMobile(l.mobile)}</td>
              <td>${maskEmail(l.email)}</td>
              <td class="mono">${l.ip_address||'—'}</td>
              <td><span class="${l.status==='SUCCESS'?'badge b-green':'badge b-red'}">${l.status}</span></td>
              <td style="font-size:11px">${l.details||'—'}</td>
            </tr>`
        ).join('');

        const content = `
            <div class="info-bar">🔐 Login events for <b>${date}</b> · ${result.recordset.length} records</div>
            <div class="card">
              <div class="card-hdr">Login activity — all users</div>
              ${result.recordset.length===0 ? '<div class="empty">No login events</div>' : `
              <div style="overflow-x:auto">
              <table>
                <thead><tr>
                  <th>Time (IST)</th><th>Type</th><th>Actor</th><th>UCC</th>
                  <th>Client name</th><th>Mobile</th><th>Email</th>
                  <th>IP Address</th><th>Status</th><th>Details</th>
                </tr></thead>
                <tbody>${rows}</tbody>
              </table></div>`}
            </div>`;

        res.send(page(`Logins · ${date}`, date, content, navLinks(date,'🔐 Logins')));
    } catch(err) { res.status(500).send(`<pre>Error: ${err.message}</pre>`); }
});

// ── GET /audit/:date/otp — OTP events ────────────────────────────────────────
router.get('/:date/otp', basicAuth, async (req, res) => {
    const date = req.params.date;
    try {
        const pool = await getConnection();
        const result = await pool.request().input('date', sql.Date, new Date(date))
            .query(`SELECT sl.log_type, sl.actor, sl.actor_type, sl.ucc, sl.details,
                           sl.ip_address, sl.status, sl.created_at,
                           c.client_name, c.mobile, c.email
                    FROM system_logs sl
                    LEFT JOIN clients c ON sl.ucc = c.ucc
                    WHERE CAST(sl.created_at AS DATE)=@date
                    AND sl.log_type IN ('CLIENT_OTP_SENT','DEALER_OTP_SENT','ADMIN_OTP_SENT')
                    ORDER BY sl.created_at DESC`);

        const rows = result.recordset.map(l => {
            // Parse delivery details from details field
            const det   = l.details || '';
            const sms   = det.includes('SMS:true')   ? '<span class="badge b-green">SMS ✓</span>'   : det.includes('SMS:false')   ? '<span class="badge b-red">SMS ✗</span>'   : '—';
            const email = det.includes('Email:true') ? '<span class="badge b-green">Email ✓</span>' : det.includes('Email:false') ? '<span class="badge b-red">Email ✗</span>' : '—';
            return `<tr>
              <td class="mono">${fmtIST(l.created_at)}</td>
              <td><span class="${typePill(l.actor_type)}">${l.actor_type}</span></td>
              <td>${l.actor||'—'}</td>
              <td>${l.ucc ? `<a class="ucc-link" href="/audit/${date}/client/${l.ucc}">${l.ucc}</a>` : '—'}</td>
              <td>${l.client_name||'—'}</td>
              <td class="mono">${maskMobile(l.mobile)}</td>
              <td>${maskEmail(l.email)}</td>
              <td>${sms}</td>
              <td>${email}</td>
              <td style="font-size:11px">${det.slice(0,180)}</td>
              <td><span class="${l.status==='SUCCESS'?'badge b-green':l.status==='FAILED'?'badge b-red':'badge b-gray'}">${l.status}</span></td>
            </tr>`;
        }).join('');

        const content = `
            <div class="info-bar">📱 OTP delivery log for <b>${date}</b> · ${result.recordset.length} OTPs sent</div>
            <div class="card">
              <div class="card-hdr">OTP events — SMS · Email · WhatsApp delivery status</div>
              ${result.recordset.length===0 ? '<div class="empty">No OTP events</div>' : `
              <div style="overflow-x:auto">
              <table>
                <thead><tr>
                  <th>Time (IST)</th><th>Type</th><th>Actor</th><th>UCC</th>
                  <th>Client name</th><th>Mobile</th><th>Email</th>
                  <th>SMS</th><th>Email</th><th>Details</th><th>Status</th>
                </tr></thead>
                <tbody>${rows}</tbody>
              </table></div>`}
            </div>`;

        res.send(page(`OTP Log · ${date}`, date, content, navLinks(date,'📱 OTP')));
    } catch(err) { res.status(500).send(`<pre>Error: ${err.message}</pre>`); }
});

// ── GET /audit/:date/orders — Sq-off orders ───────────────────────────────────
router.get('/:date/orders', basicAuth, async (req, res) => {
    const date = req.params.date;
    try {
        const pool = await getConnection();
        const result = await pool.request().input('date', sql.Date, new Date(date))
            .query(`SELECT o.order_id, o.placed_at, o.ucc, c.client_name, c.mobile,
                           o.exchange, o.segment, o.symbol, o.side, o.quantity,
                           o.order_type, o.status, o.placed_by, o.dealer_id,
                           o.expiry_date, o.strike_price, o.option_type
                    FROM squareoff_orders o
                    LEFT JOIN clients c ON o.ucc=c.ucc
                    WHERE CAST(o.placed_at AS DATE)=@date
                    ORDER BY o.placed_at DESC`);

        const rows = result.recordset.map(o =>
            `<tr>
              <td class="mono">${fmtIST(o.placed_at)}</td>
              <td><a class="ucc-link" href="/audit/${date}/client/${o.ucc}">${o.ucc}</a></td>
              <td>${o.client_name||'—'}</td>
              <td class="mono">${maskMobile(o.mobile)}</td>
              <td>${o.exchange}/${o.segment}</td>
              <td><b>${o.symbol}</b>${o.strike_price?` ${o.strike_price}`:''}${o.option_type?` ${o.option_type}`:''}</td>
              <td style="color:${o.side==='SELL'?'#DC2626':'#059669'};font-weight:600">${o.side}</td>
              <td>${o.quantity}</td>
              <td>${o.order_type}</td>
              <td><span class="${o.status==='ORDER_TRADED'?'badge b-green':o.status==='FILE_GENERATED'?'badge b-blue':'badge b-amber'}">${o.status}</span></td>
              <td>${o.placed_by||'CLIENT'}</td>
              <td>${o.dealer_id||'—'}</td>
            </tr>`
        ).join('');

        const content = `
            <div class="info-bar">📦 Square-off orders for <b>${date}</b> · ${result.recordset.length} orders</div>
            <div class="card">
              <div class="card-hdr">
                <span>All sq-off orders</span>
                <a href="/audit/${date}/export?type=orders" class="export-btn">⬇ Export CSV</a>
              </div>
              ${result.recordset.length===0 ? '<div class="empty">No orders</div>' : `
              <div style="overflow-x:auto">
              <table>
                <thead><tr>
                  <th>Time (IST)</th><th>UCC</th><th>Client</th><th>Mobile</th>
                  <th>Exchange</th><th>Symbol</th><th>Side</th><th>Qty</th>
                  <th>Type</th><th>Status</th><th>Placed by</th><th>Dealer</th>
                </tr></thead>
                <tbody>${rows}</tbody>
              </table></div>`}
            </div>`;

        res.send(page(`Orders · ${date}`, date, content, navLinks(date,'📦 Sq-Off Orders')));
    } catch(err) { res.status(500).send(`<pre>Error: ${err.message}</pre>`); }
});

// ── GET /audit/:date/dropcopy — DropCopy sync ─────────────────────────────────
router.get('/:date/dropcopy', basicAuth, async (req, res) => {
    const date = req.params.date;
    try {
        const pool = await getConnection();
        const result = await pool.request().input('date', sql.Date, new Date(date))
            .query(`SELECT dp.ucc, c.client_name, dp.exchange, dp.segment,
                           dp.symbol, dp.instrument_type, dp.buy_qty, dp.sell_qty,
                           dp.net_qty, dp.trade_date, dp.last_updated
                    FROM day_positions dp
                    LEFT JOIN clients c ON dp.ucc=c.ucc
                    WHERE dp.trade_date=@date
                    ORDER BY dp.last_updated DESC`);

        const unique = [...new Set(result.recordset.map(r=>r.ucc))].length;
        const rows   = result.recordset.map(r =>
            `<tr>
              <td><a class="ucc-link" href="/audit/${date}/client/${r.ucc}">${r.ucc}</a></td>
              <td>${r.client_name||'—'}</td>
              <td>${r.exchange}/${r.segment}</td>
              <td><b>${r.symbol}</b></td>
              <td>${r.instrument_type}</td>
              <td style="color:#059669;font-weight:500">${r.buy_qty}</td>
              <td style="color:#DC2626;font-weight:500">${r.sell_qty}</td>
              <td style="font-weight:600">${r.net_qty}</td>
              <td class="mono">${fmtIST(r.last_updated)}</td>
            </tr>`
        ).join('');

        const content = `
            <div class="info-bar">🔄 DropCopy positions for <b>${date}</b> · ${result.recordset.length} records · ${unique} clients</div>
            <div class="card">
              <div class="card-hdr">Day positions from DropCopy sync</div>
              ${result.recordset.length===0 ? '<div class="empty">No sync data for this date</div>' : `
              <div style="overflow-x:auto">
              <table>
                <thead><tr>
                  <th>UCC</th><th>Client</th><th>Exchange</th><th>Symbol</th>
                  <th>Type</th><th>Buy qty</th><th>Sell qty</th><th>Net qty</th><th>Last updated</th>
                </tr></thead>
                <tbody>${rows}</tbody>
              </table></div>`}
            </div>`;

        res.send(page(`DropCopy · ${date}`, date, content, navLinks(date,'🔄 DropCopy')));
    } catch(err) { res.status(500).send(`<pre>Error: ${err.message}</pre>`); }
});

// ── GET /audit/:date/client/:ucc — Client drill-down ─────────────────────────
router.get('/:date/client/:ucc', basicAuth, async (req, res) => {
    const { date, ucc } = req.params;
    try {
        const pool = await getConnection();
        const [info, sysLogs, orders, dayPos, bfPos] = await Promise.all([
            pool.request().input('ucc', sql.VarChar(20), ucc)
                .query('SELECT ucc,client_name,mobile,email FROM clients WHERE ucc=@ucc'),
            pool.request().input('ucc', sql.VarChar(20), ucc).input('date', sql.Date, new Date(date))
                .query(`SELECT log_type, details, ip_address, status, created_at
                        FROM system_logs WHERE ucc=@ucc AND CAST(created_at AS DATE)=@date
                        ORDER BY created_at DESC`),
            pool.request().input('ucc', sql.VarChar(20), ucc).input('date', sql.Date, new Date(date))
                .query(`SELECT * FROM squareoff_orders WHERE ucc=@ucc AND CAST(placed_at AS DATE)=@date ORDER BY placed_at DESC`),
            pool.request().input('ucc', sql.VarChar(20), ucc).input('date', sql.Date, new Date(date))
                .query(`SELECT * FROM day_positions WHERE ucc=@ucc AND trade_date=@date ORDER BY instrument_type,symbol`),
            pool.request().input('ucc', sql.VarChar(20), ucc)
                .query(`SELECT * FROM bf_positions WHERE ucc=@ucc
                        AND biz_date=(SELECT MAX(biz_date) FROM bf_positions WHERE ucc=@ucc)
                        ORDER BY instrument_type,symbol`)
        ]);

        const client = info.recordset[0] || {};

        const logRows = sysLogs.recordset.map(l => {
            const det   = l.details||'';
            const sms   = det.includes('SMS:true')   ? '<span class="badge b-green">SMS ✓</span>'   : det.includes('SMS:false')   ? '<span class="badge b-red">SMS ✗</span>'   : '';
            const email = det.includes('Email:true') ? '<span class="badge b-green">Email ✓</span>' : det.includes('Email:false') ? '<span class="badge b-red">Email ✗</span>' : '';
            return `<tr>
              <td class="mono">${fmtIST(l.created_at)}</td>
              <td><span class="${actionBadge(l.log_type)}">${l.log_type}</span></td>
              <td>${sms} ${email}</td>
              <td class="mono">${l.ip_address||'—'}</td>
              <td style="font-size:11px">${det.slice(0,200)}</td>
              <td><span class="${l.status==='SUCCESS'?'badge b-green':'badge b-red'}">${l.status}</span></td>
            </tr>`;
        }).join('');

        const orderRows = orders.recordset.map(o =>
            `<tr>
              <td class="mono">${fmtIST(o.placed_at)}</td>
              <td>${o.exchange}/${o.segment}</td>
              <td><b>${o.symbol}</b>${o.strike_price?` ${o.strike_price}`:''}${o.option_type?` ${o.option_type}`:''}</td>
              <td style="color:${o.side==='SELL'?'#DC2626':'#059669'};font-weight:600">${o.side}</td>
              <td>${o.quantity}</td>
              <td><span class="${o.status==='ORDER_TRADED'?'badge b-green':'badge b-amber'}">${o.status}</span></td>
              <td>${o.placed_by||'CLIENT'}</td>
              <td>${o.dealer_id||'—'}</td>
            </tr>`
        ).join('');

        const posRows = dayPos.recordset.map(p =>
            `<tr>
              <td><b>${p.symbol}</b></td><td>${p.instrument_type}</td>
              <td>${p.expiry_date?new Date(p.expiry_date).toLocaleDateString('en-IN'):'—'}</td>
              <td>${p.strike_price||'—'}</td><td>${p.option_type||'—'}</td>
              <td style="color:#059669;font-weight:500">${p.buy_qty}</td>
              <td style="color:#DC2626;font-weight:500">${p.sell_qty}</td>
              <td style="font-weight:600">${p.net_qty}</td>
            </tr>`
        ).join('');

        const content = `
            <a class="back" href="/audit/${date}">← Back to summary</a>
            <div class="client-hdr">
              <div style="display:flex;align-items:center;gap:12px">
                <div class="avatar">${(client.client_name||ucc)[0]}</div>
                <div>
                  <div style="font-size:15px;font-weight:600">${client.client_name||'—'}</div>
                  <div style="font-size:12px;color:#5A6272;margin-top:2px">UCC: ${ucc}</div>
                </div>
              </div>
              <div style="display:flex;gap:24px;flex-wrap:wrap">
                <div><div style="font-size:10px;color:#64748B;text-transform:uppercase;font-weight:600">Mobile</div>
                  <div style="font-size:13px;font-weight:500;font-family:monospace">${maskMobile(client.mobile)}</div></div>
                <div><div style="font-size:10px;color:#64748B;text-transform:uppercase;font-weight:600">Email</div>
                  <div style="font-size:13px;font-weight:500">${maskEmail(client.email)}</div></div>
              </div>
            </div>

            ${sysLogs.recordset.length > 0 ? `
            <div class="sec-title">🔐 Login & OTP activity (${sysLogs.recordset.length} events)</div>
            <div class="card"><div style="overflow-x:auto"><table>
              <thead><tr>
                <th>Time (IST)</th><th>Action</th><th>Delivery</th>
                <th>IP Address</th><th>Details</th><th>Status</th>
              </tr></thead>
              <tbody>${logRows}</tbody>
            </table></div></div>` : '<div class="info-bar">No login/OTP events for this date</div>'}

            ${orders.recordset.length > 0 ? `
            <div class="sec-title">📦 Square-off orders (${orders.recordset.length})</div>
            <div class="card"><div style="overflow-x:auto"><table>
              <thead><tr>
                <th>Time (IST)</th><th>Exchange</th><th>Symbol</th><th>Side</th>
                <th>Qty</th><th>Status</th><th>Placed by</th><th>Dealer</th>
              </tr></thead>
              <tbody>${orderRows}</tbody>
            </table></div></div>` : ''}

            ${dayPos.recordset.length > 0 ? `
            <div class="sec-title">📊 Day positions (${dayPos.recordset.length})</div>
            <div class="card"><div style="overflow-x:auto"><table>
              <thead><tr>
                <th>Symbol</th><th>Type</th><th>Expiry</th><th>Strike</th>
                <th>Opt</th><th>Buy qty</th><th>Sell qty</th><th>Net qty</th>
              </tr></thead>
              <tbody>${posRows}</tbody>
            </table></div></div>` : ''}`;

        res.send(page(`Client ${ucc} · ${date}`, date, content, navLinks(date,'')));
    } catch(err) { res.status(500).send(`<pre>Error: ${err.message}</pre>`); }
});

// ── GET /audit/:date/export — CSV download ────────────────────────────────────
router.get('/:date/export', basicAuth, async (req, res) => {
    const date = req.params.date;
    const type = req.query.type || 'all';
    try {
        const pool = await getConnection();
        let csv = '', filename = '';

        if (type === 'orders') {
            const r = await pool.request().input('date', sql.Date, new Date(date))
                .query(`SELECT o.order_id, o.placed_at, o.ucc, c.client_name, c.mobile,
                               o.exchange, o.segment, o.symbol, o.side, o.quantity,
                               o.order_type, o.status, o.placed_by, o.dealer_id
                        FROM squareoff_orders o LEFT JOIN clients c ON o.ucc=c.ucc
                        WHERE CAST(o.placed_at AS DATE)=@date ORDER BY o.placed_at DESC`);
            const hdr = ['Order ID','Time (IST)','UCC','Client','Mobile','Exchange','Segment','Symbol','Side','Qty','Type','Status','Placed by','Dealer'];
            const rows = r.recordset.map(o => [
                o.order_id, fmtIST(o.placed_at), o.ucc, o.client_name||'', o.mobile||'',
                o.exchange, o.segment, o.symbol, o.side, o.quantity,
                o.order_type, o.status, o.placed_by||'CLIENT', o.dealer_id||''
            ].join(','));
            csv = [hdr.join(','), ...rows].join('\n');
            filename = `navia_orders_${date}.csv`;
        } else {
            const [sysLogs, orders] = await Promise.all([
                pool.request().input('date', sql.Date, new Date(date))
                    .query(`SELECT sl.created_at, sl.actor_type, sl.actor, sl.ucc,
                                   c.client_name, sl.log_type, sl.details, sl.ip_address, sl.status
                            FROM system_logs sl LEFT JOIN clients c ON sl.ucc=c.ucc
                            WHERE CAST(sl.created_at AS DATE)=@date ORDER BY sl.created_at DESC`),
                pool.request().input('date', sql.Date, new Date(date))
                    .query(`SELECT o.placed_at, 'ORDER' AS actor_type, o.ucc, o.ucc AS actor,
                                   c.client_name, 'SQUAREOFF_'+o.side AS log_type,
                                   o.exchange+' '+o.segment+' '+o.symbol+' Qty:'+CAST(o.quantity AS VARCHAR)+' '+o.status AS details,
                                   NULL AS ip_address, o.status
                            FROM squareoff_orders o LEFT JOIN clients c ON o.ucc=c.ucc
                            WHERE CAST(o.placed_at AS DATE)=@date ORDER BY o.placed_at DESC`)
            ]);
            const all = [...sysLogs.recordset, ...orders.recordset]
                .sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
            const hdr = ['Time (IST)','Type','Actor','UCC','Client Name','Action','Details','IP','Status'];
            const rows = all.map(l => [
                fmtIST(l.created_at), l.actor_type||'', l.actor||'', l.ucc||'',
                l.client_name||'', l.log_type||'', (l.details||'').replace(/,/g,';'),
                l.ip_address||'', l.status||''
            ].join(','));
            csv = [hdr.join(','), ...rows].join('\n');
            filename = `navia_audit_${date}.csv`;
        }

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
    } catch(err) { res.status(500).send(`Error: ${err.message}`); }
});

module.exports = router;