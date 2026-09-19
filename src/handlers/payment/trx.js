'use strict';
const fetch = require('node-fetch');
const { d1All, d1Run, d1First } = require('../../db/d1');
const { isTrxHashUsed, markTrxHashUsed, isWalletBlacklisted, updatePaymentSession } = require('../../db/index');
const { processSuccessfulPayment } = require('./razorpay-webhook');

const TRONGRID_BASE = 'https://api.trongrid.io';
const SUN_PER_TRX = 1_000_000;

async function pollTrxPayments() {
  try {
    const pending = await d1All(
      "SELECT * FROM payment_sessions WHERE method = 'trx' AND status = 'pending' AND expires_at > ?",
      [Date.now()]
    );
    for (const session of pending) {
      await checkTrxSession(session);
    }
  } catch (err) {
    console.error('TRX poll error:', err.message);
  }
}

async function checkTrxSession(session) {
  try {
    if (!session.trx_wallet) return;

    // Fetch native TRX transactions to this wallet
    const url = `${TRONGRID_BASE}/v1/accounts/${session.trx_wallet}/transactions?limit=20&only_to=true`;
    const res = await fetch(url, {
      headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY || '' }
    });

    if (!res.ok) {
      console.error('TronGrid API error:', res.status);
      return;
    }

    const data = await res.json();
    if (!data.data?.length) return;

    for (const txn of data.data) {
      const valid = await validateTrxTransaction(txn, session);
      if (valid) {
        const txnHash = txn.txID;
        console.log(`TRX payment matched! Hash: ${txnHash} Session: ${session.session_id}`);
        await markTrxHashUsed(txnHash, session.user_id);
        await updatePaymentSession(session.session_id, { status: 'completed', trx_txn_hash: txnHash });
        await processSuccessfulPayment(session, { hash: txnHash, trxAmount: session.trx_amount_usdt }, 'TRX');
        break;
      }
    }
  } catch (err) {
    console.error('TRX session check error:', err.message);
  }
}

async function validateTrxTransaction(txn, session) {
  try {
    const txnHash = txn.txID;
    if (!txnHash) return false;

    // Must be TransferContract (native TRX)
    const contract = txn.raw_data?.contract?.[0];
    if (contract?.type !== 'TransferContract') return false;

    const value = contract?.parameter?.value;
    if (!value) return false;

    // ✅ Recipient address check (TronGrid returns base58 in to_address field)
    const toAddr = (value.to_address || '').toLowerCase().trim();
    const walletAddr = (session.trx_wallet || '').toLowerCase().trim();
    if (!toAddr || !walletAddr) return false;
    if (toAddr !== walletAddr) {
      // Some TronGrid responses encode as hex — skip those silently
      return false;
    }

    // ✅ Amount check with tolerance
    const receivedSun = parseInt(value.amount || 0);
    const receivedTrx = receivedSun / SUN_PER_TRX;
    const expectedTrx = parseFloat(session.trx_amount_usdt); // stored as TRX amount
    if (Math.abs(receivedTrx - expectedTrx) > 0.05) return false; // 0.05 TRX tolerance (amounts are small, ~1-2 TRX)

    // ✅ Not already used
    if (await isTrxHashUsed(txnHash)) return false;

    // ✅ Transaction must be AFTER session creation (with 2 min buffer)
    const txnTime = txn.block_timestamp || 0;
    if (txnTime < session.created_at - 2 * 60 * 1000) return false;

    // ✅ Transaction must be SUCCESS
    const ret = txn.ret?.[0];
    if (ret?.contractRet && ret.contractRet !== 'SUCCESS') return false;

    // ✅ Blacklist check
    const fromAddr = value.owner_address || '';
    if (fromAddr && await isWalletBlacklisted(fromAddr)) return false;

    return true;
  } catch (e) {
    console.error('validateTrxTransaction error:', e.message);
    return false;
  }
}

module.exports = { pollTrxPayments };
