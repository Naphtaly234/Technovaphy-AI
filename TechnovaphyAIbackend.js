require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const crypto = require('crypto');

const app = express();

// CORS
app.use(cors({
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    credentials: true,
    optionsSuccessStatus: 200
}));

// Required env vars
const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'JWT_SECRET',
    'GROQ_API_KEY',
    'PAYSTACK_SECRET_KEY',
    'AGNES_API_KEY'
];
const missing = required.filter(key => !process.env[key]);
if (missing.length) {
    console.error('❌ Missing environment variables:', missing.join(', '));
    process.exit(1);
}

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const AGNES_API_KEY = process.env.AGNES_API_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://your-frontend-url.netlify.app';
const OWNER_EMAIL = process.env.OWNER_EMAIL || null;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || null;

if (!OPENROUTER_API_KEY) {
    console.warn('⚠️ OPENROUTER_API_KEY not set — fallback disabled.');
}

// Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
(async function initDb() {
    try {
        const { error } = await supabase.from('users').select('id').limit(1);
        if (error) {
            console.warn('⚠️ Supabase connection issue:', error.message);
        } else {
            console.log('✅ Database connected.');
        }
    } catch (e) {
        console.warn('⚠️ Could not connect to Supabase:', e.message);
    }
})();

// Paystack webhook – needs raw body
app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signature = req.headers['x-paystack-signature'];
        if (!signature) {
            console.warn('⚠️ Webhook rejected: no signature header');
            return res.sendStatus(401);
        }

        const expectedHash = crypto
            .createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(req.body)
            .digest('hex');

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

            const { data: paymentRecord } = await supabase
                .from('payments')
                .select('*')
                .eq('transaction_id', idempotencyKey)
                .maybeSingle();

            if (!paymentRecord) {
                console.warn(`⚠️ Webhook: no matching payment record for ${idempotencyKey}`);
                return res.sendStatus(200);
            }

            if (paymentRecord.status === 'completed') {
                return res.sendStatus(200);
            }

            if (data.amount !== paymentRecord.amount || data.currency !== paymentRecord.currency) {
                console.error(`❌ Webhook amount mismatch for ${idempotencyKey}`);
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

// Body parsers
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// Rate limit for auth
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    handler: (req, res) => res.status(429).json({ error: 'Too many login attempts.' })
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Constants
const TIER_PRICES_KES = { starter: 200, pro: 1700, enterprise: 17000, ultimate: 100000 };
const TIER_LIMITS = { free: 200, starter: 200, pro: 2500, enterprise: Infinity, ultimate: 1000000 };
const TIER_NAMES = { free: 'Free (5 hrs)', starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise', ultimate: 'Ultimate' };
const FREE_SESSION_HOURS = 5;
const FREE_LOCK_HOURS = 4;
const MAX_CONVERSATION_HISTORY = 12;

// System prompt builder
function buildSystemPrompt({ memoryPrompt, languageInstruction }) {
    return `You are TechNovaphy AI, built for African freelancers, small businesses, and developers.

RESPONSE FORMAT — ALWAYS use this structure:

<thinking>
2-5 sentences: what they're asking, any ambiguity, how to structure the answer, what to watch out for.
</thinking>
<answer>
Your actual response that users will read.
</answer>

RULES (inside <answer> tag):
1. Match length to the question — short questions get short answers.
2. If ambiguous, state your assumption in one line and proceed.
3. Default to plain prose. Only use bullets/tables for genuinely structured content.
4. On financial/tax/legal topics: flag uncertainty plainly instead of asserting confidently.
5. Ask at most one clarifying question, only when truly necessary.
6. No throat-clearing ("Great question!"). Start with substance.
7. Say directly if you don't know or if something may have changed.

CONTEXT: You understand M-Pesa, KES, NGN, Upwork, Fiverr, and small business realities in Kenya and Nigeria.
TONE: Professional, warm, direct.

Remember: EVERY reply must have both <thinking> and <answer> tags, even for simple greetings.
${memoryPrompt}
${languageInstruction}`;
}

// Parse thinking/answer from output
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

// AI fallback: Groq -> OpenRouter
async function fetchAIResponseWithFailover(groqMessages, model, groqApiKey, openrouterApiKey) {
    const actualGroqModel = model.includes('scout') ? model : 'llama-3.3-70b-versatile';

    try {
        console.log(`🔄 Attempting Groq (${actualGroqModel})...`);
        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: actualGroqModel, messages: groqMessages, temperature: 0.7, top_p: 0.9, stream: true })
        });

        if (groqResponse.ok) {
            console.log('✅ Groq succeeded');
            return { response: groqResponse, source: 'groq' };
        }

        console.warn(`⚠️ Groq failed (${groqResponse.status}) — attempting failover...`);
        if (!openrouterApiKey) throw new Error(`Groq error ${groqResponse.status}. No fallback configured.`);
    } catch (err) {
        console.warn(`⚠️ Groq error: ${err.message}`);
        if (!openrouterApiKey) throw err;
    }

    console.log('🔄 Switching to OpenRouter (claude-haiku-4.5)...');
    const openrouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${openrouterApiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://technovaphy.ai'
        },
        body: JSON.stringify({ model: 'anthropic/claude-haiku-4.5', messages: groqMessages, temperature: 0.7, top_p: 0.9, stream: true })
    });

    if (!openrouterResponse.ok) {
        const errorText = await openrouterResponse.text();
        throw new Error(`OpenRouter failover failed: ${errorText}`);
    }

    console.log('✅ OpenRouter failover succeeded');
    return { response: openrouterResponse, source: 'openrouter' };
}

// DB helpers
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

// Reset monthly usage
async function resetMonthlyUsageIfNeeded(user) {
    const now = new Date();
    const resetDate = new Date(user.monthly_reset_date);
    if (now >= resetDate) {
        const nextMonth = new Date(now);
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        await supabase.from('users').update({
            usage_count: 0,
            monthly_reset_date: nextMonth.toISOString().split('T')[0]
        }).eq('id', user.id);
        user.usage_count = 0;
        user.monthly_reset_date = nextMonth.toISOString().split('T')[0];
    }
    return user;
}

// Free tier session (5h on, 4h lock)
async function checkFreeSession(user) {
    if (user.tier !== 'free') return user;
    const now = new Date();
    const sessionStart = new Date(user.free_session_start || now);
    const elapsedHours = (now - sessionStart) / (1000 * 60 * 60);
    if (elapsedHours < FREE_SESSION_HOURS) return user;

    const lockEnd = new Date(sessionStart.getTime() + (FREE_SESSION_HOURS + FREE_LOCK_HOURS) * 60 * 60 * 1000);
    if (now < lockEnd) {
        const minutesLeft = Math.ceil((lockEnd - now) / 60000);
        const err = new Error(`Free session ended. Try again in ${minutesLeft} minutes.`);
        err.minutesLeft = minutesLeft;
        throw err;
    }

    const newSessionStart = now.toISOString();
    await supabase.from('users').update({ free_session_start: newSessionStart }).eq('id', user.id);
    user.free_session_start = newSessionStart;
    return user;
}

function getLimit(tier) { return TIER_LIMITS[tier] || 200; }

// Conversation storage
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

// Per-user rate limit (in-memory)
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

// Auth middleware
const auth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await findUserById(decoded.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        req.user = user;
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
};

// Public routes
app.get('/', (req, res) => res.send('TechNovaphy AI Backend running'));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/ping', (req, res) => res.json({ status: 'ok' }));

// Register
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, ageConfirmed, country } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        if (!ageConfirmed) return res.status(400).json({ error: 'You must be 18 or older' });

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
            country: country || 'KE'
        }).select().single();

        if (error) throw new Error('DB insert: ' + error.message);
        await supabase.from('conversations').insert({ user_id: data.id, messages: [] });

        res.status(201).json({ message: 'User created', userId: data.id });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Login
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
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: err.message });
    }
});

// User profile
app.get('/api/user/profile', auth, async (req, res) => {
    try {
        let user = req.user;
        user = await resetMonthlyUsageIfNeeded(user);
        const isOwner = (OWNER_EMAIL && user.email === OWNER_EMAIL) || user.role === 'owner';

        let sessionRemaining = null, lockRemaining = null;
        if (user.tier === 'free') {
            const now = new Date();
            const sessionStart = new Date(user.free_session_start || now);
            const elapsedHours = (now - sessionStart) / (1000 * 60 * 60);
            if (elapsedHours < FREE_SESSION_HOURS) {
                const remainingMs = (sessionStart.getTime() + FREE_SESSION_HOURS * 60 * 60 * 1000) - now.getTime();
                sessionRemaining = Math.max(0, Math.ceil(remainingMs / 60000));
            } else {
                const lockEnd = new Date(sessionStart.getTime() + (FREE_SESSION_HOURS + FREE_LOCK_HOURS) * 60 * 60 * 1000);
                if (now < lockEnd) {
                    const remainingMs = lockEnd - now;
                    lockRemaining = Math.max(0, Math.ceil(remainingMs / 60000));
                } else {
                    lockRemaining = 0;
                }
            }
        }

        const limit = getLimit(user.tier);

        res.json({
            email: user.email,
            tier: user.tier,
            tier_name: TIER_NAMES[user.tier] || 'Free',
            usage_count: user.usage_count,
            limit: limit,
            verified: true,
            is_owner: isOwner,
            session_remaining_minutes: sessionRemaining,
            lock_remaining_minutes: lockRemaining,
            country: user.country || 'KE'
        });
    } catch (err) {
        console.error('Profile error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Update memory
app.post('/api/auth/update-memory', auth, async (req, res) => {
    try {
        const { memory } = req.body;
        await supabase.from('users').update({ memory }).eq('id', req.user.id);
        res.json({ message: 'Memory updated' });
    } catch (err) {
        console.error('Update memory error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Conversation history
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
            const summary = firstUserMsg?.content?.substring(0, 50) + '...' || 'Untitled Conversation';
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

        if (error || !data) return res.status(404).json({ error: 'Conversation not found' });
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
        res.json({ message: 'Conversation deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// File upload
const storage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain', 'text/csv'];
    cb(allowedTypes.includes(file.mimetype) ? null : new Error('Unsupported file type'), allowedTypes.includes(file.mimetype));
};
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter });

async function extractFileContent(file) {
    const mimeType = file.mimetype;
    const buffer = file.buffer;
    if (mimeType === 'application/pdf') {
        try {
            const data = await pdfParse(buffer);
            return data.text;
        } catch (e) {
            return `[PDF could not be read: ${e.message}]`;
        }
    } else if (mimeType === 'text/plain' || mimeType === 'text/csv') {
        return buffer.toString('utf-8');
    } else if (mimeType.startsWith('image/')) {
        return `[Image: ${file.originalname}]`;
    } else {
        try { return buffer.toString('utf-8'); } catch (e) { return `[File: ${file.originalname}]`; }
    }
}

// Chat stream
app.post('/api/chat/stream', auth, upload.array('files', 10), async (req, res) => {
    try {
        let user = req.user;
        user = await resetMonthlyUsageIfNeeded(user);

        const isOwner = (OWNER_EMAIL && user.email === OWNER_EMAIL) || user.role === 'owner';
        if (!isOwner) {
            if (!checkRateLimit(user.id)) return res.status(429).json({ error: 'Too many chat requests. Please wait.' });
            if (user.tier === 'free') {
                try { user = await checkFreeSession(user); }
                catch (lockError) {
                    return res.status(429).json({
                        error: lockError.message,
                        lock_remaining_minutes: lockError.minutesLeft || null
                    });
                }
            }
            const monthlyLimit = getLimit(user.tier);
            if (user.usage_count >= monthlyLimit) {
                return res.status(403).json({
                    error: `You've reached your monthly limit of ${monthlyLimit} messages. Upgrade to continue.`,
                    tier: user.tier,
                    limit: monthlyLimit,
                    used: user.usage_count
                });
            }
        }

        let conversation = await getConversation(user.id);
        let newMessages;
        try { newMessages = JSON.parse(req.body.messages); }
        catch (e) { return res.status(400).json({ error: 'Invalid messages format' }); }
        conversation = conversation.concat(newMessages);

        if (conversation.length > MAX_CONVERSATION_HISTORY) {
            conversation = conversation.slice(-MAX_CONVERSATION_HISTORY);
        }

        const files = req.files || [];
        const hasImage = files.some(f => f.mimetype.startsWith('image/'));
        let userContent = conversation[conversation.length - 1]?.content || '';
        let fileTextContent = '';
        const imageContents = [];

        for (const file of files) {
            if (file.mimetype.startsWith('image/')) {
                const base64 = file.buffer.toString('base64');
                const dataUrl = `data:${file.mimetype};base64,${base64}`;
                imageContents.push({ type: 'image_url', image_url: { url: dataUrl } });
            } else {
                const text = await extractFileContent(file);
                fileTextContent += `\n\n--- File: ${file.originalname} ---\n${text}\n--- End ---`;
            }
        }

        let finalUserMessage;
        if (hasImage) {
            const textPart = userContent + (fileTextContent ? `\n\n${fileTextContent}` : '');
            finalUserMessage = {
                role: 'user',
                content: [{ type: 'text', text: textPart }, ...imageContents]
            };
        } else {
            const fullText = userContent + (fileTextContent ? `\n\n${fileTextContent}` : '');
            finalUserMessage = { role: 'user', content: fullText };
        }

        conversation.pop();
        conversation.push(finalUserMessage);

        if (!isOwner) {
            const newMonthlyUsage = (user.usage_count || 0) + 1;
            await supabase.from('users').update({ usage_count: newMonthlyUsage }).eq('id', user.id);
        }

        const language = req.body.language || 'auto';
        let languageInstruction = '';
        if (language !== 'auto') {
            languageInstruction = `\n\n**Important**: Respond exclusively in **${language}**.\n`;
        } else {
            languageInstruction = `\n\n**Important**: Detect the user's language and respond in the same language.\n`;
        }

        const memoryPrompt = user.memory ? `\n\nUser context: ${user.memory}` : '';
        const systemPrompt = buildSystemPrompt({ memoryPrompt, languageInstruction });

        const groqMessages = [{ role: 'system', content: systemPrompt }, ...conversation];
        const model = hasImage ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'llama-3.3-70b-versatile';

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const { response: aiResponse } = await fetchAIResponseWithFailover(groqMessages, model, GROQ_API_KEY, OPENROUTER_API_KEY);

        if (!aiResponse.ok) {
            const errorText = await aiResponse.text();
            throw new Error(`AI API error ${aiResponse.status}: ${errorText}`);
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
                            const { answer } = parseThinkingAndAnswer(rawContent);
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
        console.error('Chat stream error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message || 'Something went wrong.' });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
            res.end();
        }
    }
});

// Image generation
app.post('/api/generate-image', auth, async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

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

// Payment - exchange rates
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
        console.warn('⚠️ Exchange rate fetch failed, using fallback');
        exchangeRates = { KES: 1, USD: 0.0077, EUR: 0.0070, GBP: 0.0061, NGN: 12.5 };
    }
    return exchangeRates;
}

// Create checkout
app.post('/api/create-checkout', auth, async (req, res) => {
    try {
        const { idempotencyKey, tier, currency } = req.body;
        const user = req.user;

        if (!idempotencyKey) return res.status(400).json({ error: 'idempotencyKey is required' });
        if (!tier || !['starter', 'pro', 'enterprise', 'ultimate'].includes(tier)) {
            return res.status(400).json({ error: 'Invalid tier selected.' });
        }

        let finalCurrency = (currency || '').toUpperCase();
        if (!finalCurrency) {
            finalCurrency = user.country === 'NG' ? 'NGN' : 'KES';
        }

        let humanAmount = TIER_PRICES_KES[tier];
        if (finalCurrency !== 'KES') {
            const rates = await fetchExchangeRates();
            const rate = rates[finalCurrency];
            if (rate) {
                humanAmount = TIER_PRICES_KES[tier] * rate;
            } else {
                finalCurrency = 'KES';
                humanAmount = TIER_PRICES_KES[tier];
            }
        }

        const amount = Math.round(humanAmount * 100);

        const { data: existing } = await supabase.from('payments').select('*').eq('transaction_id', idempotencyKey).maybeSingle();
        if (existing) {
            if (existing.status === 'completed') return res.json({ alreadyProcessed: true });
            return res.status(409).json({ error: 'Payment is being processed' });
        }

        if (!PAYSTACK_SECRET_KEY) return res.status(503).json({ error: 'Payment service not configured' });

        let channels = ['card', 'bank_transfer'];
        if (finalCurrency === 'KES') channels.push('mpesa');

        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: user.email,
                amount: amount,
                currency: finalCurrency,
                channels: channels,
                metadata: { idempotencyKey, tier, userId: user.id },
                callback_url: `${FRONTEND_URL}/?success=true`
            })
        });

        const data = await response.json();
        if (!data.status) throw new Error(data.message || 'Paystack initialization failed');

        await supabase.from('payments').insert({
            user_id: user.id,
            transaction_id: idempotencyKey,
            amount: amount,
            currency: finalCurrency,
            status: 'pending',
            tier
        });

        res.json({ url: data.data.authorization_url });
    } catch (err) {
        console.error('Checkout error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Start server
app.listen(PORT, () => console.log(`🚀 TechNovaphy AI Backend running on port ${PORT}`));
