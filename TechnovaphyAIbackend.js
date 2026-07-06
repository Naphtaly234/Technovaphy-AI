// ============================================================
//  TECHNOVAPHY AI – BACKEND WITH LOCALIZED PAYMENTS
// ============================================================
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();

app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    optionsSuccessStatus: 200
}));

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET', 'GROQ_API_KEY', 'PAYSTACK_SECRET_KEY', 'AGNES_API_KEY'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) {
    console.error('❌ Missing:', missing.join(', '));
    process.exit(1);
}

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const AGNES_API_KEY = process.env.AGNES_API_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://your-frontend.netlify.app';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || null;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

(async function initDb() {
    try {
        const { error } = await supabase.from('users').select('id').limit(1);
        if (error) {
            console.warn('⚠️ DB connection issue:', error.message);
        } else {
            console.log('✅ Database connected.');
        }
    } catch (e) {
        console.warn('⚠️ Could not connect to Supabase:', e.message);
    }
})();

// PAYSTACK WEBHOOK
app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signature = req.headers['x-paystack-signature'];
        if (!signature) {
            console.warn('⚠️ Webhook rejected: no signature');
            return res.sendStatus(401);
        }

        const expectedHash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
        if (expectedHash !== signature) {
            console.warn('⚠️ Webhook rejected: signature mismatch');
            return res.sendStatus(401);
        }

        const payload = JSON.parse(req.body.toString('utf8'));
        const event = payload.event;
        const data = payload.data;

        if (event === 'charge.success') {
            const metadata = data.metadata || {};
            const userId = metadata.userId;
            const tier = metadata.tier || 'pro';
            const idempotencyKey = metadata.idempotencyKey;

            const { data: paymentRecord } = await supabase.from('payments').select('*').eq('transaction_id', idempotencyKey).maybeSingle();
            if (!paymentRecord) {
                return res.sendStatus(200);
            }

            if (paymentRecord.status === 'completed') {
                return res.sendStatus(200);
            }

            if (userId) {
                await supabase.from('payments').update({ status: 'completed' }).eq('transaction_id', idempotencyKey);
                await supabase.from('users').update({ tier: tier, usage_count: 0 }).eq('id', userId);
                console.log(`✅ User ${userId} upgraded to ${tier}`);
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

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    handler: (req, res) => res.status(429).json({ error: 'Too many attempts' })
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// CONSTANTS
const TIER_PRICES_KES = { starter: 200, pro: 1700, enterprise: 17000, ultimate: 100000 };
const TIER_LIMITS = { free: 200, starter: 200, pro: 2500, enterprise: Infinity, ultimate: 1000000 };
const TIER_NAMES = { free: 'Free', starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise', ultimate: 'Ultimate' };
const MAX_CONVERSATION_HISTORY = 12;

// COUNTRY-SPECIFIC PAYMENT CHANNELS
const PAYMENT_CHANNELS = {
    KE: {
        country: 'Kenya',
        currency: 'KES',
        channels: ['card', 'bank_transfer', 'mpesa'],
        displayNames: {
            'card': '💳 Card',
            'bank_transfer': '🏦 Bank Transfer',
            'mpesa': '📱 M-Pesa'
        }
    },
    NG: {
        country: 'Nigeria',
        currency: 'NGN',
        channels: ['card', 'bank_transfer', 'ussd', 'bank'],
        displayNames: {
            'card': '💳 Card',
            'bank_transfer': '🏦 Bank Transfer',
            'ussd': '📞 USSD',
            'bank': '📱 Mobile Banking'
        }
    },
    GH: {
        country: 'Ghana',
        currency: 'GHS',
        channels: ['card', 'bank_transfer'],
        displayNames: {
            'card': '💳 Card',
            'bank_transfer': '🏦 Bank Transfer'
        }
    },
    UG: {
        country: 'Uganda',
        currency: 'UGX',
        channels: ['card', 'bank_transfer'],
        displayNames: {
            'card': '💳 Card',
            'bank_transfer': '🏦 Bank Transfer'
        }
    },
    TZ: {
        country: 'Tanzania',
        currency: 'TZS',
        channels: ['card', 'bank_transfer'],
        displayNames: {
            'card': '💳 Card',
            'bank_transfer': '🏦 Bank Transfer'
        }
    }
};

// SYSTEM PROMPT
function buildSystemPrompt({ memoryPrompt, languageInstruction }) {
    return `You are TechNovaphy AI, built for African freelancers and businesses.

RESPOND WITH THIS FORMAT:

<thinking>
Brief thoughts on the question.
</thinking>
<answer>
Your response here.
</answer>

RULES: Match length to question. Be direct. No throat-clearing.
${memoryPrompt}
${languageInstruction}`;
}

function parseThinkingAndAnswer(rawText) {
    const thinkClosed = rawText.match(/<thinking>([\s\S]*?)<\/thinking>/i);
    const thinkOpen = rawText.match(/<thinking>([\s\S]*)$/i);
    const answerClosed = rawText.match(/<answer>([\s\S]*?)<\/answer>/i);
    const answerOpen = rawText.match(/<answer>([\s\S]*)$/i);

    let thinking = '';
    let answer = '';

    if (thinkClosed) thinking = thinkClosed[1];
    else if (thinkOpen && !answerOpen) thinking = thinkOpen[1];

    if (answerClosed) answer = answerClosed[1];
    else if (answerOpen) answer = answerOpen[1];

    if (!thinking && !answer && rawText.trim()) answer = rawText;

    return { thinking: thinking.trim(), answer: answer.trim() };
}

// SMART FAILOVER
async function fetchAIResponseWithFailover(groqMessages, model, groqApiKey, openrouterApiKey) {
    const actualGroqModel = model.includes('scout') ? model : 'llama-3.3-70b-versatile';

    try {
        console.log(`🔄 Groq (${actualGroqModel})`);
        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: actualGroqModel, messages: groqMessages, temperature: 0.7, top_p: 0.9, stream: true })
        });

        if (groqResponse.ok) {
            console.log('✅ Groq ok');
            return { response: groqResponse, source: 'groq' };
        }

        console.warn(`⚠️ Groq ${groqResponse.status}`);
        if (!openrouterApiKey) throw new Error(`Groq ${groqResponse.status}`);
    } catch (err) {
        console.warn(`⚠️ Groq: ${err.message}`);
        if (!openrouterApiKey) throw err;
    }

    console.log('🔄 OpenRouter (Claude Haiku)');
    const orResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${openrouterApiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://technovaphy.ai'
        },
        body: JSON.stringify({ model: 'anthropic/claude-haiku-4.5', messages: groqMessages, temperature: 0.7, top_p: 0.9, stream: true })
    });

    if (!orResponse.ok) {
        const err = await orResponse.text();
        throw new Error(`OpenRouter: ${err}`);
    }

    console.log('✅ OpenRouter ok');
    return { response: orResponse, source: 'openrouter' };
}

// HELPERS
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
        messages: messages,
        updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (error) throw new Error('Failed to save conversation: ' + error.message);
}

const userRateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 10;

setInterval(() => {
    const now = Date.now();
    for (const [userId, timestamps] of userRateLimit) {
        const filtered = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
        if (filtered.length === 0) userRateLimit.delete(userId);
        else userRateLimit.set(userId, filtered);
    }
}, 60 * 1000);

function checkRateLimit(userId) {
    const now = Date.now();
    if (!userRateLimit.has(userId)) {
        userRateLimit.set(userId, [now]);
        return true;
    }
    const timestamps = userRateLimit.get(userId);
    const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (recent.length >= RATE_LIMIT_MAX) return false;
    recent.push(now);
    userRateLimit.set(userId, recent);
    return true;
}

// AUTH MIDDLEWARE
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

// ============================================================
//  PUBLIC ROUTES
// ============================================================

app.get('/', (req, res) => res.send('TechNovaphy AI Backend'));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/ping', (req, res) => res.json({ status: 'ok' }));

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, ageConfirmed, country } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        if (!ageConfirmed) return res.status(400).json({ error: 'You must be 18+' });
        if (!country || !PAYMENT_CHANNELS[country]) return res.status(400).json({ error: 'Invalid country selected' });

        const existing = await findUser(email);
        if (existing) return res.status(400).json({ error: 'Email already exists' });

        const hashed = await bcrypt.hash(password, 10);
        const now = new Date();
        const nextMonth = new Date(now);
        nextMonth.setMonth(nextMonth.getMonth() + 1);

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
            country: country
        }).select().single();

        if (error) throw new Error('DB insert: ' + error.message);
        await supabase.from('conversations').insert({ user_id: data.id, messages: [] });

        console.log(`✅ User registered from ${country}`);
        res.status(201).json({ message: 'User created', userId: data.id, country: country });
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

// ============================================================
//  USER ROUTES
// ============================================================

app.get('/api/user/profile', auth, async (req, res) => {
    try {
        const user = req.user;
        const limit = getLimit(user.tier);

        res.json({
            email: user.email,
            tier: user.tier,
            tier_name: TIER_NAMES[user.tier] || 'Free',
            usage_count: user.usage_count,
            limit: limit,
            verified: true,
            country: user.country || 'KE'
        });
    } catch (err) {
        console.error('Profile error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  COUNTRY-SPECIFIC PAYMENT INFO
// ============================================================

app.get('/api/payment-info', auth, async (req, res) => {
    try {
        const user = req.user;
        const countryCode = user.country || 'KE';
        const countryInfo = PAYMENT_CHANNELS[countryCode] || PAYMENT_CHANNELS['KE'];

        res.json({
            country: countryCode,
            countryName: countryInfo.country,
            currency: countryInfo.currency,
            channels: countryInfo.channels,
            displayNames: countryInfo.displayNames,
            prices: {
                starter: countryCode === 'KE' ? 200 : Math.round(200 * 12.5),
                pro: countryCode === 'KE' ? 1700 : Math.round(1700 * 12.5),
                enterprise: countryCode === 'KE' ? 17000 : Math.round(17000 * 12.5),
                ultimate: countryCode === 'KE' ? 100000 : Math.round(100000 * 12.5)
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  CONVERSATION ROUTES
// ============================================================

app.get('/api/conversations', auth, async (req, res) => {
    try {
        const user = req.user;
        const { data, error } = await supabase
            .from('conversations')
            .select('id, user_id, created_at, updated_at, messages')
            .eq('user_id', user.id)
            .order('updated_at', { ascending: false });

        if (error) throw error;

        const withSummary = (data || []).map(conv => {
            const firstUserMsg = conv.messages?.find(m => m.role === 'user');
            const summary = firstUserMsg?.content?.substring(0, 50) + '...' || 'Untitled';
            return {
                id: conv.id,
                created_at: conv.created_at,
                updated_at: conv.updated_at,
                summary: summary
            };
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

app.post('/api/conversations', auth, async (req, res) => {
    try {
        const { data, error } = await supabase.from('conversations').insert({
            user_id: req.user.id,
            messages: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }).select().single();

        if (error) throw error;
        res.status(201).json({ conversation: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/conversations/:conversationId', auth, async (req, res) => {
    try {
        const { conversationId } = req.params;
        const { error } = await supabase.from('conversations').delete()
            .eq('id', conversationId)
            .eq('user_id', req.user.id);

        if (error) throw error;
        res.json({ message: 'Deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  CHAT STREAM
// ============================================================

app.post('/api/chat/stream', auth, async (req, res) => {
    try {
        const user = req.user;

        if (!checkRateLimit(user.id)) return res.status(429).json({ error: 'Too many requests' });

        const monthlyLimit = getLimit(user.tier);
        if (user.usage_count >= monthlyLimit) {
            return res.status(403).json({ error: 'Monthly limit reached' });
        }

        let conversation = await getConversation(user.id);
        let newMessages;
        try {
            newMessages = JSON.parse(req.body.messages);
        } catch (e) {
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

        await supabase.from('users').update({ usage_count: (user.usage_count || 0) + 1 }).eq('id', user.id);

        const language = req.body.language || 'auto';
        let languageInstruction = '';
        if (language !== 'auto') {
            languageInstruction = `\n\nRespond in **${language}**.\n`;
        }

        const memoryPrompt = user.memory ? `\n\nUser context: ${user.memory}` : '';
        const systemPrompt = buildSystemPrompt({ memoryPrompt, languageInstruction });

        const groqMessages = [{ role: 'system', content: systemPrompt }, ...conversation];

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const { response: aiResponse } = await fetchAIResponseWithFailover(groqMessages, 'llama-3.3-70b-versatile', GROQ_API_KEY, OPENROUTER_API_KEY);

        if (!aiResponse.ok) {
            throw new Error(`AI error ${aiResponse.status}`);
        }

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

        res.write(`data: ${JSON.stringify({
            type: 'done',
            text: finalAnswer,
            thinking: finalThinking
        })}\n\n`);
        res.end();

    } catch (err) {
        console.error('Chat error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
            res.end();
        }
    }
});

// ============================================================
//  IMAGE GENERATION
// ============================================================

app.post('/api/generate-image', auth, async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Prompt required' });

        let imageUrl = null;
        if (AGNES_API_KEY) {
            const models = [process.env.AGNES_IMAGE_MODEL, 'Agnes-Image-2.0-Flash'].filter(Boolean);
            for (const model of models) {
                try {
                    const response = await fetch('https://apihub.agnes-ai.com/v1/images/generations', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${AGNES_API_KEY}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model, prompt, n: 1, size: '1024x1024' })
                    });
                    if (response.ok) {
                        const data = await response.json();
                        if (data?.data?.[0]?.url) {
                            imageUrl = data.data[0].url;
                            break;
                        }
                    }
                } catch (e) {}
            }
        }

        if (!imageUrl) {
            imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
        }

        res.json({ url: imageUrl });
    } catch (err) {
        console.error('Image gen error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  PAYMENT (COUNTRY-SPECIFIC)
// ============================================================

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

app.post('/api/create-checkout', auth, async (req, res) => {
    try {
        const { idempotencyKey, tier } = req.body;
        const user = req.user;

        if (!idempotencyKey) return res.status(400).json({ error: 'idempotencyKey required' });
        if (!tier || !['starter', 'pro', 'enterprise', 'ultimate'].includes(tier)) {
            return res.status(400).json({ error: 'Invalid tier' });
        }

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
        if (existing) {
            if (existing.status === 'completed') return res.json({ alreadyProcessed: true });
            return res.status(409).json({ error: 'Payment processing' });
        }

        if (!PAYSTACK_SECRET_KEY) return res.status(503).json({ error: 'Payment service not configured' });

        const channels = countryInfo.channels;
        const displayNames = countryInfo.displayNames;

        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: user.email,
                amount: amount,
                currency: finalCurrency,
                channels: channels,
                metadata: { idempotencyKey, tier, userId: user.id, country: countryCode },
                callback_url: `${FRONTEND_URL}/?success=true`
            })
        });

        const data = await response.json();
        if (!data.status) throw new Error(data.message || 'Paystack init failed');

        await supabase.from('payments').insert({
            user_id: user.id,
            transaction_id: idempotencyKey,
            amount: amount,
            currency: finalCurrency,
            status: 'pending',
            tier,
            country: countryCode
        });

        console.log(`✅ Checkout for ${user.email} (${countryCode}): ${humanAmount} ${finalCurrency}`);

        res.json({ 
            url: data.data.authorization_url,
            channels: channels,
            displayNames: displayNames,
            amount: humanAmount,
            currency: finalCurrency,
            country: countryCode
        });
    } catch (err) {
        console.error('Checkout error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  START
// ============================================================

app.listen(PORT, () => console.log(`🚀 TechNovaphy AI running on port ${PORT}`));
