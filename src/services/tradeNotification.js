'use strict';
const nodemailer = require('nodemailer');
require('dotenv').config();

/* ── Email transporter — same pattern as otpService.js ──────────────────────*/
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
        connectionTimeout: 8000,
        greetingTimeout:   5000,
        socketTimeout:     10000,
    });
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function ddmmm(dateVal) {
    if (!dateVal) return '';
    const d = new Date(dateVal);
    return String(d.getUTCDate()).padStart(2,'0') + MONTHS[d.getUTCMonth()];
}

// Maps segment/option_type to a human instrument type
function getInstrumentLabel(segment, optionType) {
    const seg = (segment || '').toUpperCase();
    if (seg === 'CM') return 'Cash';
    if (optionType && optionType !== 'XX') return 'Options';
    return 'Futures';
}

// Builds the complete NSE/BSE-style trading symbol
// EQ:  WIPRO
// FUT: PERSISTENT26JUNFUT
// OPT: NIFTY23JUN25550CE
function buildTradingSymbol(order) {
    const sym = (order.symbol || '').toUpperCase().trim();
    const seg = (order.segment || '').toUpperCase();
    if (seg === 'CM') return sym;

    const exp = ddmmm(order.expiry_date);
    if (order.option_type && order.option_type !== 'XX') {
        const strike = order.strike_price ? Math.round(Number(order.strike_price)) : '';
        return `${sym}${exp}${strike}${order.option_type}`;
    }
    return `${sym}${exp}FUT`;
}

function getSegmentLabel(segment, optionType) {
    const seg = (segment || '').toUpperCase();
    if (seg === 'CM') return 'EQ';
    if (optionType && optionType !== 'XX') return 'Options';
    return 'Futures';
}

function fmtDate(d) {
    return new Date(d).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

/* ── Build the notification context once, reuse for email + WhatsApp ────────*/
function buildNotificationContext(order, client, statusLabel) {
    return {
        clientName:     client.client_name || '',
        ucc:             order.ucc,
        exchange:        order.exchange,
        segmentLabel:    getSegmentLabel(order.segment, order.option_type),
        instrumentType:  getInstrumentLabel(order.segment, order.option_type),
        tradingSymbol:   buildTradingSymbol(order),
        side:            (order.side || '').toUpperCase(),
        executedQty:     order.executed_qty,
        requestedQty:    order.quantity,
        remainingQty:    order.remaining_qty,
        statusLabel,                                  // 'Fully Traded' | 'Partially Traded'
        tradedAt:        fmtDate(order.traded_at || new Date()),
        orderId:         order.order_id,
    };
}

/* ── Email ────────────────────────────────────────────────────────────────── */
async function sendTradeEmail(client, order, statusLabel) {
    if (!client.email) {
        console.warn(`[TradeNotify] No email on file for UCC ${order.ucc} — skipping email`);
        return false;
    }
    const ctx = buildNotificationContext(order, client, statusLabel);

    const statusColor = statusLabel === 'Fully Traded' ? '#15803d' : '#d97706';
    const statusBg     = statusLabel === 'Fully Traded' ? '#f0fdf4' : '#fffbeb';

    const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1B4FD8;padding:20px;border-radius:8px 8px 0 0">
        <span style="color:#fff;font-size:16px;font-weight:700">Navia Backup — Trade Confirmation</span>
      </div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:0 0 8px 8px;padding:24px">
        <p style="font-size:14px;color:#374151;margin:0 0 16px">Dear ${ctx.clientName},</p>
        <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 18px">
          Your square-off order has been <strong style="color:${statusColor}">${ctx.statusLabel}</strong> on
          <strong>${ctx.exchange}</strong>. Details below:
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:18px">
          <tr><td style="padding:8px 0;color:#64748b;width:45%">Exchange</td><td style="padding:8px 0;color:#0f172a;font-weight:600">${ctx.exchange}</td></tr>
          <tr style="background:#f8fafc"><td style="padding:8px 10px;color:#64748b">Segment</td><td style="padding:8px 10px;color:#0f172a;font-weight:600">${ctx.segmentLabel}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b">Trading Symbol</td><td style="padding:8px 0;color:#0f172a;font-weight:600">${ctx.tradingSymbol}</td></tr>
          <tr style="background:#f8fafc"><td style="padding:8px 10px;color:#64748b">Instrument Type</td><td style="padding:8px 10px;color:#0f172a;font-weight:600">${ctx.instrumentType}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b">Side</td><td style="padding:8px 0;color:#0f172a;font-weight:600">${ctx.side}</td></tr>
          <tr style="background:#f8fafc"><td style="padding:8px 10px;color:#64748b">Quantity Traded</td><td style="padding:8px 10px;color:#0f172a;font-weight:600">${ctx.executedQty} / ${ctx.requestedQty}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b">Status</td><td style="padding:8px 0">
            <span style="background:${statusBg};color:${statusColor};padding:3px 10px;border-radius:12px;font-weight:600;font-size:12px">${ctx.statusLabel}</span>
          </td></tr>
          <tr style="background:#f8fafc"><td style="padding:8px 10px;color:#64748b">Time</td><td style="padding:8px 10px;color:#0f172a;font-weight:600">${ctx.tradedAt}</td></tr>
        </table>
        <p style="font-size:12px;color:#9BA3B0;line-height:1.6;margin:0">
          This is an automated confirmation from Navia Backup, the emergency square-off platform.
          For any discrepancy, please contact your dealer or RMS desk immediately.
        </p>
      </div>
    </div>`;

    try {
        const transporter = createTransporter();
        await transporter.sendMail({
            from:    process.env.SMTP_FROM || 'updates@navia.co.in',
            to:      client.email,
            subject: `Trade ${ctx.statusLabel} — ${ctx.tradingSymbol} (${ctx.exchange})`,
            html,
        });
        console.log(`[TradeNotify] Email sent to ${client.email} for order ${order.order_id}`);
        return true;
    } catch (err) {
        console.error('[TradeNotify] Email send failed:', err.message);
        return false;
    }
}

/* ── WhatsApp via 360dialog (same proven integration as adminControl.js) ────*/
// Reuses the exact endpoint, auth header, and payload shape already live
// for downtime client communication — see backend/src/routes/adminControl.js
async function sendTradeWhatsApp(client, order, statusLabel) {
    if (!client.mobile) {
        console.warn(`[TradeNotify] No mobile on file for UCC ${order.ucc} — skipping WhatsApp`);
        return false;
    }

    const ctx = buildNotificationContext(order, client, statusLabel);

    // Status text: 'Fully Traded' -> 'TRADED', 'Partially Traded' -> 'PARTIALLY TRADED'
    const statusText = statusLabel === 'Fully Traded' ? 'TRADED' : 'PARTIALLY TRADED';

    // Approved 360dialog template: 'navia_trade_confirmation' (3 params:
    // client name, exchange+side+symbol, status). Separate from the
    // downtime-alert template 'azure_navia_test_u' (2 params: name, ucc)
    // used in adminControl.js. Override via Azure App Setting if it ever
    // needs to change without a code deploy.
    const templateName = process.env.TRADE_CONFIRM_TEMPLATE_NAME || 'navia_trade_confirmation';

    const mobileClean = client.mobile.toString().replace(/\D/g, '');
    const waNumber     = mobileClean.startsWith('91') ? mobileClean : `91${mobileClean}`;

    const waPayload = {
        messaging_product: 'whatsapp',
        to:   waNumber,
        type: 'template',
        template: {
            name: templateName,
            language: { policy: 'deterministic', code: 'en' },
            components: [{
                type: 'body',
                parameters: [
                    { type: 'text', text: ctx.clientName || order.ucc },
                    { type: 'text', text: `${ctx.exchange} ${ctx.side} ${ctx.tradingSymbol}` },
                    { type: 'text', text: statusText },
                ]
            }]
        }
    };

    try {
        const waRes = await fetch('https://waba-v2.360dialog.io/messages', {
            method: 'POST',
            headers: {
                'D360-API-KEY': process.env.WABA_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(waPayload)
        });
        const waData = await waRes.json();
        if (waData.messages && waData.messages[0]?.id) {
            console.log(`[TradeNotify] WhatsApp sent to ${order.ucc} (${waNumber}): ${waData.messages[0].id}`);
            return true;
        }
        console.error(`[TradeNotify] WhatsApp failed for ${order.ucc}:`, JSON.stringify(waData));
        return false;
    } catch (err) {
        console.error(`[TradeNotify] WhatsApp error for ${order.ucc}:`, err.message);
        return false;
    }
}

/* ── Main entry point — called from reconciliationService.js ────────────────*/
async function notifyTradeStatusChange(pool, sql, order, newStatus) {
    // Only notify on these two transitions
    if (newStatus !== 'ORDER_TRADED' && newStatus !== 'PARTIALLY_TRADED') return;

    try {
        const clientRes = await pool.request()
            .input('ucc', sql.VarChar(20), order.ucc)
            .query('SELECT client_name, email, mobile FROM clients WHERE ucc = @ucc');

        if (!clientRes.recordset.length) {
            console.warn(`[TradeNotify] No client record for UCC ${order.ucc} — skipping notify`);
            return;
        }
        const client = clientRes.recordset[0];
        const statusLabel = newStatus === 'ORDER_TRADED' ? 'Fully Traded' : 'Partially Traded';

        // Fire both, don't let one failure block the other
        await Promise.allSettled([
            sendTradeEmail(client, order, statusLabel),
            sendTradeWhatsApp(client, order, statusLabel),
        ]);
    } catch (err) {
        console.error('[TradeNotify] notifyTradeStatusChange error:', err.message);
    }
}

module.exports = {
    notifyTradeStatusChange,
    buildTradingSymbol,
    buildNotificationContext,
};