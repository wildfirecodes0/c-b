'use strict';
const fetch = require('node-fetch');
const { d1All, d1Run } = require('../../db/d1');
const { isTrxHashUsed, markTrxHashUsed, isWalletBlacklisted, getUSDTRate, updatePaymentSession } = require('../../db/index');
const { processSuccessfulPayment } = require('./razorpay-webhook');

const TRONGRID_BASE = 'https://api.trongrid.io';
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

async function pollTrxPayments() {
  try {
    const pending = await d1All(
      "SELECT * FROM payment_sessions WHERE method = 'trx' AND status = 'pending' AND expires_at > ?",
      [Date.now()]
    );
    for (const session of pending) {
      await checkTrxSession(session);
    }
    // Expire old sessions
    await d1Run(
      "UPDATE payment_sessions SET status = 'expired', updated_at = ? WHERE method = 'trx' AND status = 'pending' AND expires_at <= ?",
      [Date.now(), Date.now()]
    );
  } catch (err) {
    console.error('TRX poll error:', err.message);
  }
}

async function checkTrxSession(session) {
  try {
    if (!session.trx_wallet) return;
    const res = await fetch(
      `${TRONGRID_BASE}/v1/accounts/${session.trx_wallet}/transactions/trc20?limit=20&contract_address=${USDT_CONTRACT}`,
      { headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY } }
    );
    if (!res.ok) return;
    const data = await res.json();
    if (!data.data?.length) return;

    for (const txn of data.data) {
      const valid = await validateTrxTransaction(txn, session);
      if (valid) {
        await markTrxHashUsed(txn.transaction_id, session.user_id);
        await updatePaymentSession(session.session_id, { status: 'completed', trx_txn_hash: txn.transaction_id });
        await processSuccessfulPayment(session, { hash: txn.transaction_id, usdtAmount: session.trx_amount_usdt }, 'TRX');
        break;
      }
    }
  } catch (err) {
    console.error('TRX session check error:', err.message);
  }
}

async function validateTrxTransaction(txn, session) {
  try {
    if (await isTrxHashUsed(txn.transaction_id)) return false;
    if (txn.to?.toLowerCase() !== session.trx_wallet?.toLowerCase()) return false;
    if (txn.token_info?.address !== USDT_CONTRACT) return false;

    const received = parseInt(txn.value) / 1_000_000;
    const expected = parseFloat(session.trx_amount_usdt);
    if (Math.abs(received - expected) > 0.01) return false;

    const confirmRes = await fetch(
      `${TRONGRID_BASE}/v1/transactions/${txn.transaction_id}`,
      { headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY } }
    );
    const confirmData = await confirmRes.json();
    const confirmations = confirmData.data?.[0]?.confirmations || 0;
    if (confirmations < 20) return false;
    if (confirmData.data?.[0]?.ret?.[0]?.contractRet !== 'SUCCESS') return false;
    if (await isWalletBlacklisted(txn.from)) return false;
    if (txn.block_timestamp < session.created_at - 60000) return false;

    return true;
  } catch { return false; }
}

module.exports = { pollTrxPayments };
