'use strict';

/* ── In-app order notification store ────────────────────────────────────────
 * Stores new sq-off orders in memory.
 * Admin dashboard polls /api/admin/notifications/pending every 3 seconds.
 * Each order appears on admin screen within 3 seconds of client placing it.
 * No SSE, no WebSocket — works reliably on Azure Windows App Service + IIS.
 * ─────────────────────────────────────────────────────────────────────────*/

// Global singleton — survives across require() calls
if (!global._naviaOrderQueue) {
    global._naviaOrderQueue = [];      // pending alerts not yet seen by admin
    global._naviaSeenOrders = new Set(); // order IDs already delivered to admin
}

const orderQueue  = global._naviaOrderQueue;
const seenOrders  = global._naviaSeenOrders;

function pushOrderAlert(orderDetails) {
    if (seenOrders.has(orderDetails.orderId)) return;

    const alert = {
        type:      'NEW_ORDER',
        orderId:   orderDetails.orderId,
        ucc:       orderDetails.ucc,
        symbol:    orderDetails.symbol,
        exchange:  orderDetails.exchange,
        segment:   orderDetails.segment,
        side:      orderDetails.side,
        quantity:  orderDetails.quantity,
        placedBy:  orderDetails.placedBy || 'CLIENT',
        timestamp: new Date().toISOString(),
    };

    orderQueue.push(alert);
    console.log(`[NOTIF] Order queued for admin: ${orderDetails.symbol} UCC:${orderDetails.ucc} | Queue: ${orderQueue.length}`);

    // Keep queue size bounded — max 100 pending alerts
    if (orderQueue.length > 100) orderQueue.shift();
}

function getPendingAlerts(sinceTimestamp) {
    if (!sinceTimestamp) return [...orderQueue];
    const since = new Date(sinceTimestamp).getTime();
    return orderQueue.filter(a => new Date(a.timestamp).getTime() > since);
}

function markAlertsSeen(orderIds) {
    if (!Array.isArray(orderIds)) return;
    orderIds.forEach(id => {
        seenOrders.add(id);
        const idx = orderQueue.findIndex(a => a.orderId === id);
        if (idx !== -1) orderQueue.splice(idx, 1);
    });
}

function getQueueLength() { return orderQueue.length; }

/* ── sendRMSAlert — called from orders.js ───────────────────────────────────*/
async function sendRMSAlert(orderDetails) {
    console.log(`[RMS] SQ-OFF: UCC=${orderDetails.ucc} SYMBOL=${orderDetails.symbol} ` +
                `${orderDetails.exchange}/${orderDetails.segment} ` +
                `${orderDetails.side} QTY=${orderDetails.quantity}`);
    pushOrderAlert(orderDetails);
}

async function sendTradeConfirmation(ucc, mobile, orderDetails) {
    console.log(`[RMS] Trade confirmation for ${ucc}:`, orderDetails.orderId);
}

module.exports = {
    sendRMSAlert, sendTradeConfirmation,
    pushOrderAlert, getPendingAlerts, markAlertsSeen, getQueueLength,
};