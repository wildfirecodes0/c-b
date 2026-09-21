const CryptoJS = require('crypto-js');
const crypto = require('crypto');

function encrypt(text) {
  return CryptoJS.AES.encrypt(text, process.env.AES_SECRET_KEY).toString();
}

function decrypt(encryptedText) {
  const bytes = CryptoJS.AES.decrypt(encryptedText, process.env.AES_SECRET_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

function hmacSHA256(message, secret) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

function generateToken(length = 32) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

function formatDate(date) {
  return new Date(date).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

module.exports = { encrypt, decrypt, hmacSHA256, generateToken, formatDate };
