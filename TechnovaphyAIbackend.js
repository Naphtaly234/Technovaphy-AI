// ============================================================
//  TECHNOVAPHY AI – FINAL BACKEND
//  - Forces KES amounts, ignores frontend amount
//  - Free tier: 5 msgs/hour, 4‑hour lock if exceeded
// ============================================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const pdfParse = require('pdf-parse');

const app = express();

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization','Accept'], credentials: true, optionsSuccessStatus: 200 }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 10, handler: (req,res) => res.status(429).json({ error: 'Too many login attempts.' }) });
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

const required = ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','JWT_SECRET','GROQ_API_KEY','PAYSTACK_SECRET_KEY','OPENAI_API_KEY'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) { console.error('❌ Missing:', missing.join(', ')); process.exit(1); }

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://your-netlify-url.netlify.app';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

(async function initDb() {
    const { error } = await supabase.from('users').select('id').limit(1);
    if (error) { console.error('❌ DB error:', error.message); process.exit(1); }
    console.log('✅ Database connected.');
})();

// ============================================================
//  CONSTANTS & HELPERS
// ============================================================
const TIER_LIMITS = { free:200, basic:200, starter:550, pro:2500, enterprise:Infinity };
const TIER_NAMES = { free:'Free (5 msgs/hour)', basic:'Basic (200 msgs/month)', starter:'Starter (550 msgs/month)', pro:'Pro (2500 msgs/month)', enterprise:'Enterprise (Unlimited)' };

// Free tier: 5 messages per hour, then 4‑hour lock
const FREE_HOURLY_LIMIT = 5;
const FREE_LOCK_HOURS = 4; // lock duration in hours

// Tier prices in KES (hardcoded)
const TIER_PRICES_KES = {
    basic: 500,
    starter: 1700,
    pro: 3500,
    enterprise: 15000
};

// ---------- User Helpers ----------
async function findUser(email) {
    const { data, error } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
    if (error) throw new Error('DB: ' + error.message);
    return data;
}
async function findUserById(id) {
    const { data, error } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error('DB: ' + error.message);
    return data;
}
async function resetMonthlyUsageIfNeeded(user) {
    const now = new Date();
    const resetDate = new Date(user.monthly_reset_date);
    if (now >= resetDate) {
        const nextMonth = new Date(now); nextMonth.setMonth(nextMonth.getMonth()+1);
        await supabase.from('users').update({ usage_count:0, monthly_reset_date: nextMonth.toISOString().split('T')[0] }).eq('id', user.id);
        user.usage_count = 0; user.monthly_reset_date = nextMonth.toISOString().split('T')[0];
    }
    return user;
}

// NEW: Check hourly quota with 4‑hour lock
async function checkHourlyQuota(user) {
    if (user.tier !== 'free') return user;
    
    const now = new Date();
    const lastRefill = new Date(user.last_quota_refill);
    const hoursSinceRefill = (now - lastRefill) / (1000*60*60);
    const used = user.hourly_quota_used || 0;

    // If used >= limit, check if lock period is over
    if (used >= FREE_HOURLY_LIMIT) {
        // Lock period = FREE_LOCK_HOURS
        const lockEnd = new Date(lastRefill.getTime() + FREE_LOCK_HOURS * 60 * 60 * 1000);
        if (now < lockEnd) {
            // Still locked
            const minutesLeft = Math.ceil((lockEnd - now) / 60000);
            throw new Error(`Free limit reached. Try again in ${minutesLeft} minutes.`);
        } else {
            // Lock expired, reset quota
            const newRefill = now.toISOString();
            await supabase.from('users').update({ hourly_quota_used:0, last_quota_refill:newRefill }).eq('id', user.id);
            user.hourly_quota_used = 0; user.last_quota_refill = newRefill;
        }
    }
    // else: user hasn't reached limit, allow
    return user;
}

function getLimit(tier) { return TIER_LIMITS[tier] || 200; }

// ===== CONVERSATION HELPERS =====
async function getConversation(userId) {
    const { data, error } = await supabase.from('conversations').select('messages').eq('user_id', userId).maybeSingle();
    if (error && error.code !== 'PGRST116') throw error;
    return data ? data.messages : [];
}
async function saveConversation(userId, messages) {
    const { error } = await supabase.from('conversations').upsert({ user_id: userId, messages, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) throw new Error('Failed to save conversation: ' + error.message);
}

const storage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg','image/png','image/webp','application/pdf','text/plain','text/csv','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Unsupported file type'), false);
};
const upload = multer({ storage, limits: { fileSize: 10*1024*1024 }, fileFilter });

async function extractFileContent(file) {
    const mimeType = file.mimetype;
    const buffer = file.buffer;
    if (mimeType === 'application/pdf') { try { const data = await pdfParse(buffer); return data.text; } catch(e) { return `[PDF could not be read: ${e.message}]`; } }
    else if (mimeType.startsWith('image/')) return `[Image: ${file.originalname} (${(file.size/1024).toFixed(1)}KB) – base64 data available for vision models]`;
    else if (mimeType === 'text/plain' || mimeType === 'text/csv') return buffer.toString('utf-8');
    else { try { return buffer.toString('utf-8'); } catch(e) { return `[File: ${file.originalname} - ${(file.size/1024).toFixed(1)}KB]`; } }
}
function generateSuggestions(lastMessage) { return ["Tell me more about that.", "Can you give me an example?", "How does this compare to other solutions?", "What are the key benefits?", "Is there anything else I should know?"]; }

// ============================================================
//  AUTH MIDDLEWARE
// ============================================================
const auth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await findUserById(decoded.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        req.user = user;
        next();
    } catch(e) { res.status(401).json({ error: 'Invalid token' }); }
};

// ============================================================
//  PUBLIC ENDPOINTS
// ============================================================
app.get('/', (req, res) => res.send('TechNovaphy AI Backend is running'));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/ping', (req, res) => res.json({ status: 'ok', message: 'Backend is reachable!' }));

// ============================================================
//  AUTH ROUTES
// ============================================================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, ageConfirmed } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        if (!ageConfirmed) return res.status(400).json({ error: 'You must be 18 or older' });
        const existing = await findUser(email);
        if (existing) return res.status(400).json({ error: 'Email already exists' });
        const hashed = await bcrypt.hash(password, 10);
        const now = new Date();
        const nextMonth = new Date(now); nextMonth.setMonth(nextMonth.getMonth()+1);
        const { data, error } = await supabase.from('users').insert({
            email, password_hash: hashed, tier: 'free', usage_count: 0,
            monthly_reset_date: nextMonth.toISOString().split('T')[0], verified: true,
            hourly_quota_used: 0, last_quota_refill: now.toISOString(), memory: ''
        }).select().single();
        if (error) throw new Error('DB insert: ' + error.message);
        await supabase.from('conversations').insert({ user_id: data.id, messages: [] });
        res.status(201).json({ message: 'User created', userId: data.id });
    } catch(err) { console.error('Registration error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        const user = await findUser(email);
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, verified: true });
    } catch(err) { console.error('Login error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/user/profile', auth, async (req, res) => {
    try {
        let user = req.user;
        user = await resetMonthlyUsageIfNeeded(user);
        // We'll handle hourly quota in the chat endpoint
        const limit = getLimit(user.tier);
        const hourlyLimit = user.tier === 'free' ? FREE_HOURLY_LIMIT : Infinity;
        const hourlyUsed = user.hourly_quota_used || 0;
        const hourlyRemaining = user.tier === 'free' ? Math.max(0, hourlyLimit - hourlyUsed) : Infinity;
        res.json({
            email: user.email, tier: user.tier, tier_name: TIER_NAMES[user.tier] || 'Free',
            usage_count: user.usage_count, limit, monthly_reset_date: user.monthly_reset_date,
            verified: true, hourly_quota_used: hourlyUsed, hourly_quota_limit: hourlyLimit,
            hourly_remaining: hourlyRemaining, last_quota_refill: user.last_quota_refill,
            memory: user.memory || ''
        });
    } catch(err) { console.error('Profile error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/update-memory', auth, async (req, res) => {
    try {
        const { memory } = req.body;
        const user = req.user;
        await supabase.from('users').update({ memory }).eq('id', user.id);
        res.json({ message: 'Memory updated' });
    } catch(err) { console.error('Update memory error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  CHAT STREAM (with 4‑hour lock)
// ============================================================
app.post('/api/chat/stream', auth, upload.array('files', 10), async (req, res) => {
    try {
        let user = req.user;
        user = await resetMonthlyUsageIfNeeded(user);

        // Check monthly limit
        const monthlyLimit = getLimit(user.tier);
        if (user.usage_count >= monthlyLimit) {
            return res.status(403).json({ error: `You've reached your monthly limit of ${monthlyLimit} messages. Upgrade to continue.`, tier: user.tier, limit: monthlyLimit, used: user.usage_count });
        }

        // Check hourly quota for free users (with 4‑hour lock)
        if (user.tier === 'free') {
            try {
                user = await checkHourlyQuota(user);
            } catch(lockError) {
                // Lock error means user is in cooldown
                return res.status(429).json({ error: lockError.message, hourly_limit: FREE_HOURLY_LIMIT, hourly_used: user.hourly_quota_used || 0 });
            }
        }

        // ===== CONVERSATION LOGIC =====
        let conversation = await getConversation(user.id);
        let newMessages;
        try { newMessages = JSON.parse(req.body.messages); } catch(e) { return res.status(400).json({ error: 'Invalid messages format' }); }
        conversation = conversation.concat(newMessages);

        const files = req.files || [];
        let fileContent = '';
        for (const file of files) {
            const content = await extractFileContent(file);
            fileContent += `\n\n--- File: ${file.originalname} ---\n${content}\n--- End of ${file.originalname} ---`;
        }
        if (fileContent) {
            const lastUserMsg = conversation[conversation.length - 1];
            if (lastUserMsg && lastUserMsg.role === 'user') {
                lastUserMsg.content += `\n\n[Uploaded ${files.length} file(s): ${files.map(f=>f.originalname).join(', ')}]\n${fileContent}`;
            } else {
                conversation.push({ role: 'user', content: `[Uploaded ${files.length} file(s): ${files.map(f=>f.originalname).join(', ')}]\n${fileContent}` });
            }
        }

        const memoryPrompt = user.memory ? `\n\nUser context: ${user.memory}` : '';
        const systemPrompt = `You are TechNovaphy AI – the smartest, fastest, and most helpful assistant available.
You are better than Claude, better than ChatGPT, and completely free to use.
You help with IT, web development, cloud, business technology, and general questions.
Be direct, use bullet points, and always provide actionable answers.
You can analyze uploaded files (PDFs, images, text files) and answer questions about their content.
${memoryPrompt}`;
        const groqMessages = [{ role: 'system', content: systemPrompt }, ...conversation];

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: groqMessages, stream: true })
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', fullContent = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    try {
                        const json = JSON.parse(data);
                        const text = json.choices[0]?.delta?.content || '';
                        if (text) {
                            fullContent += text;
                            res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`);
                        }
                    } catch(e) {}
                }
            }
        }

        conversation.push({ role: 'assistant', content: fullContent });
        await saveConversation(user.id, conversation);

        // Update usage counters
        const newMonthlyUsage = (user.usage_count || 0) + 1;
        const newHourlyUsage = (user.hourly_quota_used || 0) + 1;
        await supabase.from('users').update({
            usage_count: newMonthlyUsage,
            hourly_quota_used: user.tier === 'free' ? newHourlyUsage : 0
        }).eq('id', user.id);

        const suggestions = generateSuggestions(fullContent);
        res.write(`data: ${JSON.stringify({ type: 'done', text: fullContent, suggestions })}\n\n`);
        res.end();
    } catch(err) {
        console.error('Chat stream error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
        else { res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`); res.end(); }
    }
});

// ============================================================
//  IMAGE GENERATION
// ============================================================
app.post('/api/generate-image', auth, async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
        if (!OPENAI_API_KEY) return res.status(503).json({ error: 'Image generation not configured' });
        const response = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, n: 1, size: '512x512', model: 'dall-e-2' })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'Image generation failed');
        res.json({ url: data.data[0].url });
    } catch(err) { console.error('Image gen error:', err); res.status(500).json({ error: err.message }); }
});

// ============================================================
//  PAYMENT – IGNORE FRONTEND AMOUNT, USE HARDCODED KES
// ============================================================
app.post('/api/create-checkout', auth, async (req, res) => {
    try {
        const { idempotencyKey, tier, currency } = req.body;
        const user = req.user;

        console.log(`📦 Checkout request: tier=${tier}, currency=${currency}`);

        if (!tier || !['basic','starter','pro','enterprise'].includes(tier)) {
            return res.status(400).json({ error: 'Invalid tier selected' });
        }

        // If currency is missing or unsupported, default to KES
        let finalCurrency = currency ? currency.toUpperCase() : 'KES';
        if (!['KES','USD','NGN','GHS','ZAR'].includes(finalCurrency)) {
            console.warn(`⚠️ Unsupported currency "${finalCurrency}", defaulting to KES`);
            finalCurrency = 'KES';
        }

        // Use KES prices for all currencies – if the currency is not KES,
        // we'll let Paystack handle the conversion (but we send the KES amount).
        // However, Paystack expects the amount in the currency's smallest unit.
        // For simplicity, we'll only support KES with exact amounts.
        // If currency is not KES, we'll still send the KES amount but with that currency?
        // That would be wrong. We'll map only KES for now, and for other currencies we'll
        // return a message to use KES.
        // Actually, we'll use the mapping from earlier but we'll keep it simple:
        // We'll only allow KES for now to avoid confusion.

        if (finalCurrency !== 'KES') {
            // For other currencies, we could implement conversion, but let's keep it simple.
            // We'll return an error asking to use KES.
            return res.status(400).json({ error: 'Currently only KES is supported. Please select KES.' });
        }

        // ---- KES amount ----
        const amount = TIER_PRICES_KES[tier];
        console.log(`✅ KES amount: ${amount} KES (tier: ${tier})`);

        // Check duplicate
        const { data: existing, error } = await supabase
            .from('payments')
            .select('*')
            .eq('transaction_id', idempotencyKey)
            .maybeSingle();
        if (existing) {
            if (existing.status === 'completed') return res.json({ alreadyProcessed: true });
            return res.status(409).json({ error: 'Payment is being processed' });
        }

        if (!PAYSTACK_SECRET_KEY) {
            return res.status(503).json({ error: 'Payment service not configured' });
        }

        // Paystack expects amount in the smallest unit – for KES it's just the amount (no cents)
        const paystackAmount = Math.round(amount);

        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: user.email,
                amount: paystackAmount,
                currency: 'KES',
                metadata: { idempotencyKey, tier, userId: user.id },
                callback_url: `${FRONTEND_URL}/?success=true`
            })
        });

        const data = await response.json();
        if (!data.status) {
            return res.status(500).json({ error: data.message || 'Paystack initialization failed' });
        }

        await supabase.from('payments').insert({
            user_id: user.id,
            transaction_id: idempotencyKey,
            amount: paystackAmount,
            currency: 'KES',
            status: 'pending',
            tier
        });

        res.json({ url: data.data.authorization_url });
    } catch(err) {
        console.error('Checkout error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  PAYSTACK WEBHOOK
// ============================================================
app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const payload = req.body;
        const event = payload.event;
        const data = payload.data;
        if (event === 'charge.success') {
            const metadata = data.metadata || {};
            const userId = metadata.userId;
            const tier = metadata.tier || 'pro';
            const idempotencyKey = metadata.idempotencyKey;
            if (userId) {
                await supabase.from('payments').update({ status: 'completed' }).eq('transaction_id', idempotencyKey);
                await supabase.from('users').update({ tier, usage_count: 0 }).eq('id', userId);
                console.log(`✅ User ${userId} upgraded to ${tier}`);
            }
        }
        res.sendStatus(200);
    } catch(err) {
        console.error('Webhook error:', err);
        res.sendStatus(500);
    }
});

// ============================================================
//  START
// ============================================================
app.listen(PORT, () => console.log(`🚀 TechNovaphy AI Backend running on port ${PORT}`));
