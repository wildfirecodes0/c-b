# 🌟 Crevio Bot — Render + Cloudflare D1

## Stack
- **Hosting:** Render.com (Node.js)
- **Database:** Cloudflare D1 (via HTTP API)
- **Cache:** In-memory (fast, no external service)

## Setup

### Step 1: Cloudflare D1 Setup
1. Go to cloudflare.com → Workers & Pages → D1
2. Create database: `crevio-db`
3. Copy your `Account ID` and `Database ID`
4. Create API Token: My Profile → API Tokens → Create Token → D1 Edit permission
5. Run schema: Paste `schema.sql` content in D1 console → Execute

### Step 2: Deploy on Render
1. Push to GitHub
2. Render → New Web Service → Connect repo
3. Build: `npm install` | Start: `npm start`

### Step 3: Environment Variables (Render Dashboard)
```
BOT_TOKEN=
BOT_USERNAME=CrevioBot
WEBHOOK_SECRET=random_32_chars
MAIN_CHANNEL=@CrevioUpdates
CF_ACCOUNT_ID=your_cloudflare_account_id
CF_DATABASE_ID=your_d1_database_id
CF_API_TOKEN=your_cloudflare_api_token
RAZORPAY_KEY=rzp_live_xxx
RAZORPAY_SECRET=xxx
RAZORPAY_WEBHOOK_SECRET=xxx
TRONGRID_API_KEY=xxx
AES_SECRET_KEY=random_32_chars
APP_URL=https://your-app.onrender.com
PORT=3000
NODE_ENV=production
```

### Step 4: Set Webhook
```bash
BOT_TOKEN=xxx APP_URL=https://your-app.onrender.com node scripts/set-webhook.js
```

### Step 5: Setup Admin
Send `/bot-adm` to your bot → first user becomes admin permanently.

### Step 6: Keep Alive (Free Render plan)
Add uptimerobot.com monitor:
- URL: `https://your-app.onrender.com/health`
- Interval: 5 minutes
