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

// Client-facing display fix (2026-07-28): for holdings/CM orders,
// order.symbol is stored internally as "CompanyName ; ISIN" (see
// Dashboard.jsx handleHoldingSquareOff / orders.js ISIN extraction) so it
// can be matched/reconciled correctly elsewhere. The ISIN has no meaning to
// a client reading their own trade confirmation, so it's stripped here for
// DISPLAY ONLY -- this function never receives or mutates the underlying
// order.symbol value, so every other consumer of order.symbol (matching,
// dedup, is_stale computation, etc.) is completely unaffected.
function stripIsinForDisplay(sym) {
    return sym.split(';')[0].trim();
}

// Builds the complete NSE/BSE-style trading symbol
// EQ:  WIPRO
// FUT: PERSISTENT26JUNFUT
// OPT: NIFTY23JUN25550CE
function buildTradingSymbol(order) {
    const sym = (order.symbol || '').toUpperCase().trim();
    const seg = (order.segment || '').toUpperCase();
    if (seg === 'CM') return stripIsinForDisplay(sym);

    const exp = ddmmm(order.expiry_date);
    if (order.option_type && order.option_type !== 'XX') {
        const strike = order.strike_price ? Math.round(Number(order.strike_price)) : '';
        return `${sym}${exp}${strike}${order.option_type}`;
    }
    return `${sym}${exp}FUT`;
}

// Spaced version of the trading symbol, used ONLY in the email subject line
// (per explicit request) -- e.g. "SENSEX 16 JUL 26 81000 CE" instead of
// "SENSEX16JUL81000CE". Does not touch buildTradingSymbol() itself, which
// stays exactly as-is for the body table and the WhatsApp template param.
function buildTradingSymbolSpaced(order) {
    const sym = (order.symbol || '').toUpperCase().trim();
    const seg = (order.segment || '').toUpperCase();
    if (seg === 'CM') return stripIsinForDisplay(sym);

    const d   = order.expiry_date ? new Date(order.expiry_date) : null;
    const dd  = d ? String(d.getUTCDate()).padStart(2, '0') : '';
    const mmm = d ? MONTHS[d.getUTCMonth()] : '';
    const yy  = d ? String(d.getUTCFullYear()).slice(-2) : '';
    const expSpaced = [dd, mmm, yy].filter(Boolean).join(' ');

    if (order.option_type && order.option_type !== 'XX') {
        const strike = order.strike_price ? Math.round(Number(order.strike_price)) : '';
        return [sym, expSpaced, strike, order.option_type].filter(Boolean).join(' ');
    }
    return [sym, expSpaced, 'FUT'].filter(Boolean).join(' ');
}

// WhatsApp trading-symbol fix (2026-07-28): the approved
// navia_trade_confirmation_01 template param {2} needs the F&O symbol broken
// into separate space-delimited words -- "NIFTY 28 JUL 25000 CE" instead of
// buildTradingSymbol()'s concatenated "NIFTY28JUL25000CE" -- per the live
// message samples reviewed. Kept as its own function rather than reusing
// buildTradingSymbolSpaced() (email subject only) because that one also
// includes the expiry year ("28 JUL 26"), which is not part of what was
// requested/shown in the reference WhatsApp messages -- reusing it here
// would silently add a year nobody asked for. CM/equity rows delegate
// straight to buildTradingSymbol(), which already strips the ISIN above, so
// WhatsApp and email both get the same ISIN-free holdings text.
function buildTradingSymbolForWhatsApp(order) {
    const seg = (order.segment || '').toUpperCase();
    if (seg === 'CM') return buildTradingSymbol(order);

    const sym = (order.symbol || '').toUpperCase().trim();
    const d   = order.expiry_date ? new Date(order.expiry_date) : null;
    const dd  = d ? String(d.getUTCDate()).padStart(2, '0') : '';
    const mmm = d ? MONTHS[d.getUTCMonth()] : '';

    if (order.option_type && order.option_type !== 'XX') {
        const strike = order.strike_price ? Math.round(Number(order.strike_price)) : '';
        return [sym, dd, mmm, strike, order.option_type].filter(Boolean).join(' ');
    }
    return [sym, dd, mmm, 'FUT'].filter(Boolean).join(' ');
}

function getSegmentLabel(segment, optionType) {
    const seg = (segment || '').toUpperCase();
    if (seg === 'CM') return 'EQ';
    if (optionType && optionType !== 'XX') return 'Options';
    return 'Futures';
}

function fmtDate(d) {
    // FIX: explicit timeZone -- without this, toLocaleString falls back to the
    // server process's own timezone (Azure App Service Linux runs in UTC),
    // so the "Time" row in the trade-confirmation email showed the trade
    // timestamp 5.5 hours behind actual IST, even though the en-IN locale
    // made the date/month layout look correct at a glance.
    return new Date(d).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
        timeZone: 'Asia/Kolkata'
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
        tradingSymbol:       buildTradingSymbol(order),
        tradingSymbolSpaced: buildTradingSymbolSpaced(order),
        tradingSymbolWA:     buildTradingSymbolForWhatsApp(order),
        side:            (order.side || '').toUpperCase(),
        executedQty:     order.executed_qty,
        requestedQty:    order.quantity,
        remainingQty:    order.remaining_qty,
        statusLabel,                                  // 'Fully Traded' | 'Partially Traded'
        tradedAt:        fmtDate(order.traded_at || new Date()),
        orderId:         order.order_id,
        // trade_price is set when admin manually confirms price via update-status,
        // or auto-populated if available from DropCopy reconciliation.
        tradePrice:      order.trade_price ? Number(order.trade_price).toFixed(2) : '0.00',
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
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:18px;border:1px solid #cbd5e1">
          <tr style="background:#f8fafc">
            <th style="padding:8px;border:1px solid #cbd5e1;color:#0f172a;text-align:left">Segment</th>
            <th style="padding:8px;border:1px solid #cbd5e1;color:#0f172a;text-align:left">Trading Symbol</th>
            <th style="padding:8px;border:1px solid #cbd5e1;color:#0f172a;text-align:left">Side</th>
            <th style="padding:8px;border:1px solid #cbd5e1;color:#0f172a;text-align:left">Traded Quantity</th>
            <th style="padding:8px;border:1px solid #cbd5e1;color:#0f172a;text-align:left">Order Status</th>
            <th style="padding:8px;border:1px solid #cbd5e1;color:#0f172a;text-align:left">Trade Price</th>
          </tr>
          <tr>
            <td style="padding:8px;border:1px solid #cbd5e1;color:#0f172a">${ctx.segmentLabel}</td>
            <td style="padding:8px;border:1px solid #cbd5e1;color:#0f172a">${ctx.tradingSymbol}</td>
            <td style="padding:8px;border:1px solid #cbd5e1;color:#0f172a">${ctx.side}</td>
            <td style="padding:8px;border:1px solid #cbd5e1;color:#0f172a">${ctx.executedQty} / ${ctx.requestedQty}</td>
            <td style="padding:8px;border:1px solid #cbd5e1">
              <span style="background:${statusBg};color:${statusColor};padding:3px 10px;border-radius:12px;font-weight:600;font-size:12px">${ctx.statusLabel}</span>
            </td>
            <td style="padding:8px;border:1px solid #cbd5e1;color:#0f172a">Rs.${ctx.tradePrice}</td>
          </tr>
        </table>
        <p style="font-size:12px;color:#9BA3B0;line-height:1.6;margin:0">
          This is an automated confirmation from Navia Backup, the emergency square-off platform.
          For any discrepancy, please <a href="https://support.navia.co.in/support/solutions/articles/1000321790-navia-backup-your-safety-net-during-trading-downtime" style="color:#1B4FD8;text-decoration:underline">raise a ticket</a>.
        </p>
      </div>
    </div>`;

    try {
        const transporter = createTransporter();
        await transporter.sendMail({
            from:    process.env.SMTP_FROM || 'updates@navia.co.in',
            to:      client.email,
            subject: `Navia Backup Trade Confirmation — ${ctx.tradingSymbolSpaced} (${ctx.exchange})`,
            html,
        });
        console.log(`[TradeNotify] Email sent to ${client.email} for order ${order.order_id}`);
        return true;
    } catch (err) {
        console.error('[TradeNotify] Email send failed:', err.message);
        return false;
    }
}

/* ── Persistent WhatsApp API log (2026-08-25) ────────────────────────────────*/
// Durable copy of every Engati request/response, in whatsapp_api_log --
// see Migration_whatsapp_api_log.sql. Console logs (below) are unchanged and
// stay as the fast/live view; this is the "never depend on Log Stream's
// rolling buffer again" copy. A DB write failure here must never break
// notification delivery, so this is wrapped in its own try/catch and never
// awaited-and-thrown by any caller.
async function logWhatsAppAttempt(pool, sql, entry) {
    if (!pool || !sql) return; // defensive -- caller always passes both today
    try {
        await pool.request()
            .input('source',         sql.VarChar(30),   entry.source || 'TRADE_NOTIFY')
            .input('ucc',            sql.VarChar(20),   entry.ucc || null)
            .input('orderId',        sql.VarChar(50),   entry.orderId || null)
            .input('mobile',         sql.VarChar(20),   entry.mobile || null)
            .input('templateName',   sql.VarChar(100),  entry.templateName || null)
            .input('requestPayload', sql.NVarChar(sql.MAX), entry.requestPayload || null)
            .input('httpStatus',     sql.Int,           entry.httpStatus ?? null)
            .input('responseBody',   sql.NVarChar(sql.MAX), entry.responseBody || null)
            .input('messageId',      sql.VarChar(150),  entry.messageId || null)
            .input('success',        sql.Bit,           entry.success ? 1 : 0)
            .input('errorMessage',   sql.NVarChar(500), entry.errorMessage || null)
            .query(`INSERT INTO whatsapp_api_log
                    (source, ucc, order_id, mobile, template_name, request_payload,
                     http_status, response_body, message_id, success, error_message)
                    VALUES
                    (@source, @ucc, @orderId, @mobile, @templateName, @requestPayload,
                     @httpStatus, @responseBody, @messageId, @success, @errorMessage)`);
    } catch (err) {
        console.error('[TradeNotify] whatsapp_api_log write failed:', err.message);
    }
}

/* ── WhatsApp via Engati WABA (migrated from 360dialog 2026-08-04) ──────────*/
// URL/provider changed: WABA management moved from 360dialog to Engati.
// Endpoint, header name (D360-API-KEY), and payload shape below are UNCHANGED
// from the prior 360dialog integration on purpose -- confirm with Engati/the
// WABA management team that wabm.engati.ai/v1/messages accepts the identical
// Cloud-API-style header + body before relying on this in production. If it
// doesn't, sends will fail with a non-2xx/JSON-shape error from waData below
// (visible in the [TradeNotify] WhatsApp failed log line) rather than silently.
async function sendTradeWhatsApp(pool, sql, client, order, statusLabel) {
    if (!client.mobile) {
        console.warn(`[TradeNotify] No mobile on file for UCC ${order.ucc} — skipping WhatsApp`);
        return false;
    }

    const ctx = buildNotificationContext(order, client, statusLabel);

    // Status text: 'Fully Traded' -> 'TRADED', 'Partially Traded' -> 'PARTIALLY TRADED'
    const statusText = statusLabel === 'Fully Traded' ? 'TRADED' : 'PARTIALLY TRADED';

    // Approved WhatsApp template: 'navia_trade_confirmation_01' (4 params)
    // Template text:
    //   "Your square-off {1} order for {2} for a quantity of {3} has been
    //    successfully executed at Rs.{4}.
    //    This is an automated confirmation from Navia Backup. Please contact
    //    support desk for any queries. Team Navia."
    // {1} = BUY / SELL
    // {2} = Exchange + Scrip name with strike (e.g. "NSE NIFTY 23 JUN 25550 CE")
    // {3} = executed quantity
    // {4} = trade price (e.g. "299.90")
    const templateName = process.env.TRADE_CONFIRM_TEMPLATE_NAME || 'navia_trade_confirmation_01';

    const mobileClean = client.mobile.toString().replace(/\D/g, '');
    const waNumber     = mobileClean.startsWith('91') ? mobileClean : `91${mobileClean}`;

    const waPayload = {
        messaging_product: 'whatsapp',
        to:   waNumber,
        type: 'template',
        template: {
            name: templateName,
            // 2026-08-20: Engati changed the approved template's language
            // code from 'en' to 'en_US' on their side -- a mismatched code
            // makes the template lookup fail silently (message never sends).
            language: { policy: 'deterministic', code: 'en_US' },
            components: [{
                type: 'body',
                parameters: [
                    { type: 'text', text: ctx.side },                                       // {1} BUY/SELL
                    { type: 'text', text: `${ctx.exchange} ${ctx.tradingSymbolWA}` },       // {2} exchange + scrip (spaced, ISIN-free for holdings)
                    { type: 'text', text: String(ctx.requestedQty) },                       // {3} qty placed by client (not recon-computed executedQty which can reflect total day position)
                    { type: 'text', text: ctx.tradePrice },                                 // {4} trade price
                ]
            }]
        }
    };

    try {
        // Auth header confirmed by Engati support (2026-08-04): Engati's own
        // wabm.engati.ai endpoint uses standard 'Authorization: Bearer <key>',
        // NOT the 360dialog-style 'D360-API-KEY' header the old integration
        // used -- despite the URL path and payload shape being identical.
        const waRes = await fetch('https://wabm.engati.ai/v1/messages', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.WABA_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(waPayload)
        });

        // Read as text first so a non-JSON or empty body (e.g. a 401/502/504
        // from the Engati gateway with no payload) doesn't just surface as an
        // opaque "Unexpected end of JSON input" -- we log the real HTTP status
        // and raw body instead, which is what actually tells us what broke.
        const waRawBody = await waRes.text();

        let waData;
        try {
            waData = waRawBody ? JSON.parse(waRawBody) : {};
        } catch (parseErr) {
            console.error(
                `[TradeNotify] WhatsApp non-JSON response for ${order.ucc} — ` +
                `HTTP ${waRes.status} ${waRes.statusText}, body: ${waRawBody.slice(0, 500) || '(empty)'}`
            );
            await logWhatsAppAttempt(pool, sql, {
                source: 'TRADE_NOTIFY', ucc: order.ucc, orderId: order.order_id,
                mobile: waNumber, templateName, requestPayload: JSON.stringify(waPayload),
                httpStatus: waRes.status, responseBody: waRawBody, success: false,
                errorMessage: `Non-JSON response: ${waRes.status} ${waRes.statusText}`,
            });
            return false;
        }

        if (!waRes.ok) {
            console.error(
                `[TradeNotify] WhatsApp HTTP ${waRes.status} for ${order.ucc}:`,
                JSON.stringify(waData).slice(0, 500)
            );
            await logWhatsAppAttempt(pool, sql, {
                source: 'TRADE_NOTIFY', ucc: order.ucc, orderId: order.order_id,
                mobile: waNumber, templateName, requestPayload: JSON.stringify(waPayload),
                httpStatus: waRes.status, responseBody: waRawBody, success: false,
                errorMessage: `HTTP ${waRes.status}`,
            });
            return false;
        }

        if (waData.messages && waData.messages[0]?.id) {
            console.log(`[TradeNotify] WhatsApp sent to ${order.ucc} (${waNumber}): ${waData.messages[0].id}`);
            // 2026-08-25: additive diagnostic log -- full raw Engati response
            // body (contacts[], messages[], any status fields Engati includes
            // on accept) so send-side details are visible directly in our own
            // logs without needing the Engati dashboard. Purely additive --
            // does not change return value, control flow, or the line above.
            console.log(`[TradeNotify] WhatsApp full response for ${order.ucc}: ${waRawBody.slice(0, 1000)}`);
            await logWhatsAppAttempt(pool, sql, {
                source: 'TRADE_NOTIFY', ucc: order.ucc, orderId: order.order_id,
                mobile: waNumber, templateName, requestPayload: JSON.stringify(waPayload),
                httpStatus: waRes.status, responseBody: waRawBody,
                messageId: waData.messages[0].id, success: true,
            });
            return true;
        }
        console.error(`[TradeNotify] WhatsApp failed for ${order.ucc}:`, JSON.stringify(waData));
        await logWhatsAppAttempt(pool, sql, {
            source: 'TRADE_NOTIFY', ucc: order.ucc, orderId: order.order_id,
            mobile: waNumber, templateName, requestPayload: JSON.stringify(waPayload),
            httpStatus: waRes.status, responseBody: waRawBody, success: false,
            errorMessage: 'No message id in response',
        });
        return false;
    } catch (err) {
        console.error(`[TradeNotify] WhatsApp error for ${order.ucc}:`, err.message);
        await logWhatsAppAttempt(pool, sql, {
            source: 'TRADE_NOTIFY', ucc: order.ucc, orderId: order.order_id,
            mobile: client.mobile, templateName, success: false,
            errorMessage: err.message,
        });
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
            sendTradeWhatsApp(pool, sql, client, order, statusLabel),
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