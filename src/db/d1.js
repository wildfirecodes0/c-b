'use strict';
const fetch = require('node-fetch');

// ============================================
// CLOUDFLARE D1 HTTP API CLIENT
// ============================================

const D1_BASE = () =>
  `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/d1/database/${process.env.CF_DATABASE_ID}`;

const CF_HEADERS = () => ({
  'Authorization': `Bearer ${process.env.CF_API_TOKEN}`,
  'Content-Type': 'application/json',
});

// Execute a single SQL query
async function d1Query(sql, params = []) {
  const res = await fetch(`${D1_BASE()}/query`, {
    method: 'POST',
    headers: CF_HEADERS(),
    body: JSON.stringify({ sql, params }),
  });
  const data = await res.json();
  if (!data.success) {
    console.error('D1 query error:', data.errors, '\nSQL:', sql);
    throw new Error(data.errors?.[0]?.message || 'D1 query failed');
  }
  return data.result?.[0];
}

// Execute multiple SQL queries in one batch (faster)
async function d1Batch(queries) {
  const res = await fetch(`${D1_BASE()}/raw`, {
    method: 'POST',
    headers: CF_HEADERS(),
    body: JSON.stringify({ sql: queries.map(q => q.sql).join(';\n'), params: [] }),
  });
  const data = await res.json();
  if (!data.success) {
    console.error('D1 batch error:', data.errors);
    throw new Error(data.errors?.[0]?.message || 'D1 batch failed');
  }
  return data.result;
}

// Helper — get first row
async function d1First(sql, params = []) {
  const result = await d1Query(sql, params);
  return result?.results?.[0] || null;
}

// Helper — get all rows
async function d1All(sql, params = []) {
  const result = await d1Query(sql, params);
  return result?.results || [];
}

// Helper — run (insert/update/delete)
async function d1Run(sql, params = []) {
  const result = await d1Query(sql, params);
  return result?.meta || {};
}

module.exports = { d1Query, d1Batch, d1First, d1All, d1Run };
