// ============================================================
//  TECHNOVAPHY AI – COMPLETE BACKEND (FIXED)
//  Fixes: duplicate conversation on POST /api/conversations
// ============================================================

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// ---- Redis (optional) ----
let redisClient = null;
let redisAvailable = false;
try {
    const redis = require('redis');
    if (process.env.REDIS_URL) {
        redisClient = redis.createClient({ url: process.env.REDIS_URL });
        redisClient.on('error', () => { redisAvailable = false; });
        redisClient.connect().then(() => { redisAvailable = true; }).catch(() => { redisAvailable = false; });
    }
} catch (e) {}

const app = express();
app.set('trust proxy', 1);

app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    credentials: true
}));

// ---- Environment checks ----
const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET', 'OPENROUTER_API_KEY', 'PAYSTACK_SECRET_KEY'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) {
    console.error('❌ Missing env:', missing.join(', '));
    process.exit(1);
}

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://your-frontend.netlify.app';
const OWNER_EMAIL = process.env.OWNER_EMAIL || null;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---- Paystack webhook ----
app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signature = req.headers['x-paystack-signature'];
        if (!signature) return res.sendStatus(401);
        const expectedHash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
        if (expectedHash !== signature) return res.sendStatus(401);
        const payload = JSON.parse(req.body.toString('utf8'));
        if (payload.event === 'charge.success') {
            const metadata = payload.data.metadata || {};
            const userId = metadata.userId;
            const idempotencyKey = metadata.idempotencyKey;
            const type = metadata.type;
            const { data: paymentRecord } = await supabase.from('payments').select('*').eq('transaction_id', idempotencyKey).maybeSingle();
            if (!paymentRecord || paymentRecord.status === 'completed') return res.sendStatus(200);
            await supabase.from('payments').update({ status: 'completed' }).eq('transaction_id', idempotencyKey);
            if (userId) {
                if (type === 'code_runner') {
                    await supabase.from('users').update({ code_runner_unlocked: true }).eq('id', userId);
                } else {
                    const tier = metadata.tier || 'pro';
                    await supabase.from('users').update({ tier, usage_count: 0 }).eq('id', userId);
                }
            }
        }
        res.sendStatus(200);
    } catch (err) {
        console.error('Webhook error:', err);
        res.sendStatus(500);
    }
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ---- Constants ----
const TIER_PRICES_KES = { starter: 200, pro: 1700, enterprise: 17000, ultimate: 100000 };
const TIER_LIMITS = { free: 200, starter: 200, pro: 2500, enterprise: Infinity, ultimate: 1000000 };
const TIER_NAMES = { free: 'Free', starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise', ultimate: 'Ultimate' };
const TIER_FEATURES = {
    free: ['200 messages / month', 'Standard models', 'Community support'],
    starter: ['200 messages / month', 'Priority queueing', 'Email support'],
    pro: ['2,500 messages / month', 'All AI models', 'Priority support'],
    enterprise: ['Unlimited messages', 'All AI models', 'Dedicated support'],
    ultimate: ['Unlimited messages', 'Early access to new models', 'White-glove support']
};
const CODE_RUNNER_PRICE_KES = 1000;
const MAX_CONVERSATION_HISTORY = 20;
const PAYMENT_CHANNELS = {
    KE: { country: 'Kenya', currency: 'KES', channels: ['mpesa', 'mobile_money', 'bank_transfer'], displayNames: { 'mpesa': '📱 M-Pesa', 'mobile_money': '📱 Airtel Money', 'bank_transfer': '🏦 Bank Transfer (Paybill)' } },
    NG: { country: 'Nigeria', currency: 'NGN', channels: ['bank_transfer'], displayNames: { 'bank_transfer': '🏦 Bank Transfer' } },
    GH: { country: 'Ghana', currency: 'GHS', channels: ['bank_transfer'], displayNames: { 'bank_transfer': '🏦 Bank Transfer' } },
    UG: { country: 'Uganda', currency: 'UGX', channels: ['bank_transfer'], displayNames: { 'bank_transfer': '🏦 Bank Transfer' } },
    TZ: { country: 'Tanzania', currency: 'TZS', channels: ['bank_transfer'], displayNames: { 'bank_transfer': '🏦 Bank Transfer' } }
};

// ---- System prompt ----
function buildSystemPrompt({ memoryPrompt, languageInstruction }) {
    return `You are TechNovaphy AI, built for African freelancers and businesses.

RESPOND WITH THIS FORMAT:

<thinking>
Brief thoughts on the question.
</thinking>
<answer>
Your response here.
</answer>

RULES:
- Match length to the question.
- Be direct. No throat‑clearing.
- If uncertain, say "I don't know".
- Never invent facts, statistics, or legal advice.
- For financial/legal topics, flag uncertainty plainly.

${memoryPrompt}
${languageInstruction}`;
}

function parseThinkingAndAnswer(rawText) {
    const thinkClosed = rawText.match(/<thinking>([\s\S]*?)<\/thinking>/i);
    const thinkOpen = rawText.match(/<thinking>([\s\S]*)$/i);
    const answerClosed = rawText.match(/<answer>([\s\S]*?)<\/answer>/i);
    const answerOpen = rawText.match(/<answer>([\s\S]*)$/i);
    let thinking = '', answer = '';
    if (thinkClosed) thinking = thinkClosed[1];
    else if (thinkOpen && !answerOpen) thinking = thinkOpen[1];
    if (answerClosed) answer = answerClosed[1];
    else if (answerOpen) answer = answerOpen[1];
    if (!thinking && !answer && rawText.trim()) answer = rawText;
    return { thinking: thinking.trim(), answer: answer.trim() };
}

// ---- AI failover (MiniMax → Groq) ----
async function fetchAIResponseWithFailover(messages, userSelectedModel) {
    if (!OPENROUTER_API_KEY) throw new Error('OpenRouter API key missing.');
    const primary = userSelectedModel || 'minimax/minimax-m3-preview';
    const fallback = (primary === 'minimax/minimax-m3-preview') ? 'groq/llama-3.3-70b-versatile' : 'minimax/minimax-m3-preview';
    const models = [primary, fallback];
    for (const model of models) {
        try {
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://technovaphy.ai'
                },
                body: JSON.stringify({
                    model,
                    messages,
                    temperature: 0.7,
                    top_p: 0.9,
                    stream: true,
                    max_tokens: 4000
                })
            });
            if (response.ok) return { response, source: model };
            const err = await response.text();
            console.warn(`⚠️ ${model} failed: ${err}`);
        } catch (err) {
            console.warn(`⚠️ ${model} error: ${err.message}`);
        }
    }
    throw new Error('All AI models failed.');
}

// ---- Helpers ----
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
function getLimit(tier) { return TIER_LIMITS[tier] || 200; }
async function getConversation(userId) {
    const { data, error } = await supabase.from('conversations').select('messages').eq('user_id', userId).maybeSingle();
    if (error && error.code !== 'PGRST116') throw error;
    return data ? data.messages : [];
}
async function saveConversation(userId, messages) {
    const { error } = await supabase.from('conversations').upsert({
        user_id: userId,
        messages,
        updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (error) throw new Error('Failed to save conversation: ' + error.message);
}

// ---- Rate limiting ----
const inMemoryRate = new Map();
async function checkRateLimit(userId) {
    if (redisAvailable && redisClient) {
        const key = `rate:${userId}`;
        const count = await redisClient.incr(key);
        if (count === 1) await redisClient.expire(key, 60);
        return count <= 10;
    } else {
        const now = Date.now();
        if (!inMemoryRate.has(userId)) { inMemoryRate.set(userId, [now]); return true; }
        const timestamps = inMemoryRate.get(userId).filter(t => now - t < 60000);
        if (timestamps.length >= 10) return false;
        timestamps.push(now);
        inMemoryRate.set(userId, timestamps);
        return true;
    }
}
if (!redisAvailable) {
    setInterval(() => {
        const now = Date.now();
        for (const [userId, timestamps] of inMemoryRate) {
            const filtered = timestamps.filter(t => now - t < 60000);
            if (filtered.length === 0) inMemoryRate.delete(userId);
            else inMemoryRate.set(userId, filtered);
        }
    }, 60000);
}

// ---- Concurrency ----
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_REQUESTS) || 10000;
let activeRequests = 0;
const concurrencyQueue = [];
function acquireConcurrency() {
    return new Promise(resolve => {
        if (activeRequests < MAX_CONCURRENT) { activeRequests++; resolve(); }
        else concurrencyQueue.push(resolve);
    });
}
function releaseConcurrency() {
    activeRequests--;
    if (concurrencyQueue.length > 0) {
        const next = concurrencyQueue.shift();
        activeRequests++;
        next();
    }
}

// ---- Auth middleware ----
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
    } catch (e) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// ---- PUBLIC ROUTES ----
app.get('/', (req, res) => res.send('TechNovaphy AI Backend'));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/ping', (req, res) => res.json({ status: 'ok' }));

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, ageConfirmed, country } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        if (!ageConfirmed) return res.status(400).json({ error: 'Must be 18+' });
        if (!country || !PAYMENT_CHANNELS[country]) return res.status(400).json({ error: 'Invalid country' });
        const existing = await findUser(email);
        if (existing) return res.status(400).json({ error: 'Email already exists' });
        const hashed = await bcrypt.hash(password, 10);
        const now = new Date();
        const nextMonth = new Date(now); nextMonth.setMonth(nextMonth.getMonth() + 1);
        const { data, error } = await supabase.from('users').insert({
            email,
            password_hash: hashed,
            tier: 'free',
            usage_count: 0,
            monthly_reset_date: nextMonth.toISOString().split('T')[0],
            verified: true,
            free_session_start: now.toISOString(),
            memory: '',
            role: 'user',
            country,
            code_runner_unlocked: false
        }).select().single();
        if (error) throw new Error('DB insert: ' + error.message);
        await supabase.from('conversations').insert({ user_id: data.id, messages: [] });
        res.status(201).json({ message: 'User created', userId: data.id, country });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: err.message });
    }
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
        res.json({ token, verified: true, country: user.country });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/user/profile', auth, async (req, res) => {
    try {
        const user = req.user;
        const isOwner = (OWNER_EMAIL && user.email === OWNER_EMAIL);
        const limit = isOwner ? Infinity : getLimit(user.tier);
        res.json({
            email: user.email,
            tier: user.tier,
            tier_name: TIER_NAMES[user.tier] || 'Free',
            usage_count: user.usage_count,
            limit,
            verified: true,
            country: user.country || 'KE',
            code_runner_unlocked: isOwner ? true : (user.code_runner_unlocked || false),
            is_owner: isOwner
        });
    } catch (err) {
        console.error('Profile error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/update-memory', auth, async (req, res) => {
    try {
        const { memory } = req.body;
        await supabase.from('users').update({ memory }).eq('id', req.user.id);
        res.json({ message: 'Memory updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---- CONVERSATIONS (CRUD) ----
app.get('/api/conversations', auth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('conversations')
            .select('id, user_id, created_at, updated_at, messages')
            .eq('user_id', req.user.id)
            .order('updated_at', { ascending: false });
        if (error) throw error;
        const withSummary = (data || []).map(conv => {
            const firstUserMsg = conv.messages?.find(m => m.role === 'user');
            const summary = firstUserMsg?.content?.substring(0, 50) + '...' || 'Untitled';
            return { id: conv.id, created_at: conv.created_at, updated_at: conv.updated_at, summary };
        });
        res.json({ conversations: withSummary });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/conversations/:conversationId', auth, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const { data, error } = await supabase
            .from('conversations')
            .select('*')
            .eq('id', conversationId)
            .eq('user_id', req.user.id)
            .single();
        if (error || !data) return res.status(404).json({ error: 'Not found' });
        res.json({ conversation: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =============== FIXED: POST /api/conversations ===============
app.post('/api/conversations', auth, async (req, res) => {
    try {
        // 1. Check if a conversation already exists for this user
        const { data: existing, error: findError } = await supabase
            .from('conversations')
            .select('*')
            .eq('user_id', req.user.id)
            .maybeSingle();

        if (findError && findError.code !== 'PGRST116') throw findError;

        // 2. If it exists, return it
        if (existing) {
            return res.status(200).json({ conversation: existing });
        }

        // 3. Otherwise create a new one
        const { data, error } = await supabase.from('conversations').insert({
            user_id: req.user.id,
            messages: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }).select().single();

        if (error) throw error;
        res.status(201).json({ conversation: data });
    } catch (err) {
        console.error('Create conversation error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/conversations/:conversationId', auth, async (req, res) => {
    try {
        const { error } = await supabase.from('conversations').delete()
            .eq('id', req.params.conversationId)
            .eq('user_id', req.user.id);
        if (error) throw error;
        res.json({ message: 'Deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---- PROJECTS ----
app.get('/api/projects', auth, async (req, res) => {
    try {
        const { data, error } = await supabase.from('projects').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ projects: data || [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/projects', auth, async (req, res) => {
    try {
        const { name, description } = req.body;
        if (!name) return res.status(400).json({ error: 'Project name required' });
        const { data, error } = await supabase.from('projects').insert({
            user_id: req.user.id,
            name,
            description: description || '',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }).select().single();
        if (error) throw error;
        res.status(201).json({ project: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/projects/:id', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description } = req.body;
        if (!name) return res.status(400).json({ error: 'Project name required' });
        const { data, error } = await supabase.from('projects')
            .update({ name, description, updated_at: new Date().toISOString() })
            .eq('id', id)
            .eq('user_id', req.user.id)
            .select().single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Project not found' });
        res.json({ project: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/projects/:id', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('projects').delete().eq('id', id).eq('user_id', req.user.id);
        if (error) throw error;
        res.json({ message: 'Project deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- CHAT STREAM ----
app.post('/api/chat/stream', auth, async (req, res) => {
    try {
        const user = req.user;
        const isOwner = (OWNER_EMAIL && user.email === OWNER_EMAIL);

        if (!isOwner) await acquireConcurrency();
        if (!isOwner && !await checkRateLimit(user.id)) {
            releaseConcurrency();
            return res.status(429).json({ error: 'Too many requests' });
        }
        const monthlyLimit = getLimit(user.tier);
        if (!isOwner && user.usage_count >= monthlyLimit) {
            releaseConcurrency();
            return res.status(403).json({ error: 'Monthly limit reached' });
        }

        let conversation = await getConversation(user.id);
        let newMessages;
        try { newMessages = JSON.parse(req.body.messages); } catch (e) {
            releaseConcurrency();
            return res.status(400).json({ error: 'Invalid messages format' });
        }
        conversation = conversation.concat(newMessages);
        if (conversation.length > MAX_CONVERSATION_HISTORY) {
            conversation = conversation.slice(-MAX_CONVERSATION_HISTORY);
        }
        const userContent = conversation[conversation.length - 1]?.content || '';
        const finalUserMessage = { role: 'user', content: userContent };
        conversation.pop();
        conversation.push(finalUserMessage);

        if (!isOwner) {
            await supabase.from('users').update({ usage_count: (user.usage_count || 0) + 1 }).eq('id', user.id);
        }

        const language = req.body.language || 'auto';
        let languageInstruction = language !== 'auto' ? `\n\nRespond in **${language}**.\n` : '';
        const memoryPrompt = user.memory ? `\n\nUser context: ${user.memory}` : '';
        const systemPrompt = buildSystemPrompt({ memoryPrompt, languageInstruction });

        const groqMessages = [{ role: 'system', content: systemPrompt }, ...conversation];
        const userModel = req.body.model || 'minimax/minimax-m3-preview';

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const originalEnd = res.end;
        res.end = function(...args) { releaseConcurrency(); originalEnd.apply(res, args); };

        const { response: aiResponse, source } = await fetchAIResponseWithFailover(groqMessages, userModel);
        if (!aiResponse.ok) throw new Error(`AI error ${aiResponse.status}`);

        const reader = aiResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', rawContent = '';
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
                            rawContent += text;
                            const { thinking, answer } = parseThinkingAndAnswer(rawContent);
                            if (answer) {
                                res.write(`data: ${JSON.stringify({ type: 'chunk', text: answer })}\n\n`);
                            }
                        }
                    } catch (e) {}
                }
            }
        }
        const { thinking: finalThinking, answer: finalAnswer } = parseThinkingAndAnswer(rawContent);
        conversation.push({ role: 'assistant', content: finalAnswer });
        await saveConversation(user.id, conversation);

        res.write(`data: ${JSON.stringify({ type: 'done', text: finalAnswer, model: source })}\n\n`);
        res.end();
    } catch (err) {
        console.error('Chat error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
        else res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
        res.end();
        releaseConcurrency();
    }
});

// ---- EXCHANGE RATES ----
let exchangeRates = { KES: 1 };
let ratesLastFetched = 0;
async function fetchExchangeRates() {
    const now = Date.now();
    if (now - ratesLastFetched < 60 * 60 * 1000) return exchangeRates;
    try {
        const response = await fetch('https://api.exchangerate-api.com/v4/latest/KES');
        const data = await response.json();
        exchangeRates = data.rates;
        exchangeRates.KES = 1;
        ratesLastFetched = now;
    } catch (err) {
        console.warn('⚠️ Exchange rate fetch failed');
        exchangeRates = { KES: 1, NGN: 12.5, GHS: 18.5, UGX: 3700, TZS: 2600 };
    }
    return exchangeRates;
}

// ---- PRICING ----
app.get('/api/pricing', auth, async (req, res) => {
    try {
        const user = req.user;
        const countryCode = user.country || 'KE';
        const countryInfo = PAYMENT_CHANNELS[countryCode] || PAYMENT_CHANNELS['KE'];
        const currency = countryInfo.currency;
        const rates = await fetchExchangeRates();
        const rate = currency === 'KES' ? 1 : (rates[currency] || 1);
        const tiers = Object.keys(TIER_PRICES_KES).map(tier => ({
            tier,
            name: TIER_NAMES[tier],
            amount: Math.round(TIER_PRICES_KES[tier] * rate),
            currency,
            features: TIER_FEATURES[tier] || [],
            limit: TIER_LIMITS[tier] === Infinity ? 'Unlimited' : TIER_LIMITS[tier]
        }));
        const codeRunner = { amount: Math.round(CODE_RUNNER_PRICE_KES * rate), currency, interval: 'monthly' };
        res.json({
            currentTier: user.tier,
            codeRunnerUnlocked: user.code_runner_unlocked || false,
            tiers,
            codeRunner,
            channels: countryInfo.channels,
            country: countryCode
        });
    } catch (err) {
        console.error('Pricing error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---- PAYMENT STATUS ----
app.get('/api/payment-status/:key', auth, async (req, res) => {
    try {
        const { key } = req.params;
        const { data, error } = await supabase
            .from('payments')
            .select('status, tier, currency, amount')
            .eq('transaction_id', key)
            .eq('user_id', req.user.id)
            .maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Payment not found' });
        res.json({ status: data.status, tier: data.tier, currency: data.currency, amount: data.amount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---- TIER UPGRADE CHECKOUT ----
app.post('/api/create-checkout', auth, async (req, res) => {
    try {
        const { idempotencyKey, tier } = req.body;
        if (!idempotencyKey) return res.status(400).json({ error: 'idempotencyKey required' });
        if (!['starter', 'pro', 'enterprise', 'ultimate'].includes(tier)) {
            return res.status(400).json({ error: 'Invalid tier' });
        }
        const user = req.user;
        const countryCode = user.country || 'KE';
        const countryInfo = PAYMENT_CHANNELS[countryCode] || PAYMENT_CHANNELS['KE'];
        const finalCurrency = countryInfo.currency;
        let humanAmount = TIER_PRICES_KES[tier];
        if (finalCurrency !== 'KES') {
            const rates = await fetchExchangeRates();
            const rate = rates[finalCurrency] || rates.NGN;
            humanAmount = Math.round(TIER_PRICES_KES[tier] * rate);
        }
        const amount = Math.round(humanAmount * 100);
        const { data: existing } = await supabase.from('payments').select('*').eq('transaction_id', idempotencyKey).maybeSingle();
        if (existing && existing.status === 'completed') return res.json({ alreadyProcessed: true });
        if (existing) return res.status(409).json({ error: 'Payment processing' });
        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: user.email,
                amount,
                currency: finalCurrency,
                channels: countryInfo.channels,
                metadata: { idempotencyKey, tier, userId: user.id, country: countryCode },
                callback_url: `${FRONTEND_URL}/?success=true&key=${idempotencyKey}`
            })
        });
        const data = await response.json();
        if (!data.status) throw new Error(data.message || 'Paystack init failed');
        await supabase.from('payments').insert({
            user_id: user.id,
            transaction_id: idempotencyKey,
            amount,
            currency: finalCurrency,
            status: 'pending',
            tier,
            country: countryCode
        });
        res.json({ url: data.data.authorization_url, amount: humanAmount, currency: finalCurrency });
    } catch (err) {
        console.error('Checkout error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---- CODE RUNNER SUBSCRIPTION ----
app.post('/api/subscribe-code', auth, async (req, res) => {
    try {
        const { idempotencyKey } = req.body;
        if (!idempotencyKey) return res.status(400).json({ error: 'idempotencyKey required' });
        const user = req.user;
        if (user.code_runner_unlocked) {
            return res.status(200).json({ alreadyActive: true, message: 'Already subscribed.' });
        }
        const countryCode = user.country || 'KE';
        const countryInfo = PAYMENT_CHANNELS[countryCode] || PAYMENT_CHANNELS['KE'];
        const currency = countryInfo.currency;
        const rates = await fetchExchangeRates();
        const rate = currency === 'KES' ? 1 : (rates[currency] || 1);
        const humanAmount = Math.round(CODE_RUNNER_PRICE_KES * rate);
        const amountInMinor = Math.round(humanAmount * 100);
        const planName = `TechNovaphy Code Runner (${currency} ${humanAmount})`;
        let planCode = null;
        try {
            const listPlans = await fetch('https://api.paystack.co/plan?perPage=50', {
                headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
            });
            const planData = await listPlans.json();
            if (planData.status) {
                const match = planData.data.find(p => p.name === planName && p.amount === amountInMinor && p.currency === currency);
                if (match) planCode = match.plan_code;
            }
        } catch (e) {}
        if (!planCode) {
            const createPlan = await fetch('https://api.paystack.co/plan', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: planName,
                    amount: amountInMinor,
                    currency,
                    interval: 'monthly',
                    description: 'Monthly subscription to unlock code runner'
                })
            });
            const planData = await createPlan.json();
            if (planData.status) planCode = planData.data.plan_code;
            else throw new Error('Failed to create plan');
        }
        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: user.email,
                amount: amountInMinor,
                currency,
                channels: countryInfo.channels,
                plan: planCode,
                metadata: { userId: user.id, idempotencyKey, country: countryCode, type: 'code_runner' },
                callback_url: `${FRONTEND_URL}/?success=true&key=${idempotencyKey}`
            })
        });
        const data = await response.json();
        if (!data.status) {
            console.error('Code subscription error:', data.message);
            return res.status(502).json({ error: data.message || 'Subscription init failed' });
        }
        await supabase.from('payments').insert({
            user_id: user.id,
            transaction_id: idempotencyKey,
            amount: amountInMinor,
            currency,
            status: 'pending',
            tier: 'code_runner',
            country: countryCode
        });
        res.json({ url: data.data.authorization_url, amount: humanAmount, currency, subscription: true });
    } catch (err) {
        console.error('Code subscription error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ---- CODE RUNNER EXECUTION ----
app.post('/api/run-code', auth, async (req, res) => {
    try {
        const user = req.user;
        const isOwner = (OWNER_EMAIL && user.email === OWNER_EMAIL);
        if (!isOwner) await acquireConcurrency();
        if (!isOwner && !user.code_runner_unlocked) {
            releaseConcurrency();
            return res.status(403).json({ error: '💳 Subscribe to Code Runner to run code.', lock: true });
        }
        const { language, version, code } = req.body;
        if (!code) { releaseConcurrency(); return res.status(400).json({ error: 'No code provided' }); }
        const systemPrompt = `You are MiniMax M3, an expert coding assistant with strong reasoning.
Analyse the code and provide:
1. Brief summary.
2. Potential issues or bugs.
3. Suggestions for improvement.
4. Simulation of the output.

LANGUAGE: ${language} (${version})
CODE:
\`\`\`
${code}
\`\`\`
`;
        const messages = [{ role: 'system', content: systemPrompt }];
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://technovaphy.ai'
            },
            body: JSON.stringify({
                model: 'minimax/minimax-m3-preview',
                messages,
                temperature: 0.7,
                stream: true,
                max_tokens: 2000
            })
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`MiniMax error: ${err}`);
        }
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
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
                            res.write(`data: ${JSON.stringify({ type: 'chunk', text: fullContent })}\n\n`);
                        }
                    } catch (e) {}
                }
            }
        }
        res.write(`data: ${JSON.stringify({ type: 'done', text: fullContent })}\n\n`);
        res.end();
        releaseConcurrency();
    } catch (err) {
        console.error('Code execution error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
        else res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
        res.end();
        releaseConcurrency();
    }
});

app.listen(PORT, () => console.log(`🚀 TechNovaphy AI running on port ${PORT}`));
