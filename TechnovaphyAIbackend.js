
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

// ----- CORS -----
app.use(cors({
    origin: '*',
    methods: ['GET','POST','PUT','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization','Accept'],
    credentials: true,
    optionsSuccessStatus: 200
}));

// ----- Middleware -----
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// ----- Rate Limiter for auth endpoints -----
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    handler: (req, res) => {
        res.status(429).json({ error: 'Too many login attempts.' });
    }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ----- Environment Variables -----
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

// ----- Supabase Client -----
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

// ============================================================
//  TIERS & PRICES (base in KES)
// ============================================================
const TIER_PRICES_KES = {
    starter: 200,
    pro: 1700,
    enterprise: 17000,
    ultimate: 100000
};

const TIER_LIMITS = {
    free: 200,
    starter: 200,
    pro: 2500,
    enterprise: Infinity,
    ultimate: 1000000
};

const TIER_NAMES = {
    free: 'Free (5 hrs unlimited)',
    starter: 'Starter (Weekly)',
    pro: 'Pro (Monthly)',
    enterprise: 'Enterprise (Monthly)',
    ultimate: 'Ultimate (Monthly)'
};

const FREE_SESSION_HOURS = 5;
const FREE_LOCK_HOURS = 4;

// ============================================================
//  EXCHANGE RATES (cached, 1 hour TTL)
// ============================================================
let exchangeRates = { KES: 1 };
let ratesLastFetched = 0;
const RATES_CACHE_TTL = 60 * 60 * 1000;

async function fetchExchangeRates() {
    const now = Date.now();
    if (now - ratesLastFetched < RATES_CACHE_TTL) return exchangeRates;
    try {
        const response = await fetch('https://api.exchangerate-api.com/v4/latest/KES');
        if (!response.ok) throw new Error('Exchange rate API error');
        const data = await response.json();
        exchangeRates = data.rates;
        exchangeRates.KES = 1;
        ratesLastFetched = now;
        console.log('✅ Exchange rates updated');
    } catch (err) {
        console.warn('⚠️ Failed to fetch exchange rates, using fallback:', err.message);
        // Fallback rates (approximate for common African/Arabic currencies)
        exchangeRates = {
            KES: 1,
            USD: 0.0077,
            EUR: 0.0070,
            GBP: 0.0061,
            NGN: 12.5,
            GHS: 0.098,
            ZAR: 0.14,
            EGP: 0.24,
            RWF: 10.2,
            TZS: 20.5,
            UGX: 30.0
        };
    }
    return exchangeRates;
}

// ============================================================
//  USER HELPERS
// ============================================================
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
        const nextMonth = new Date(now);
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        await supabase
            .from('users')
            .update({
                usage_count: 0,
                monthly_reset_date: nextMonth.toISOString().split('T')[0]
            })
            .eq('id', user.id);
        user.usage_count = 0;
        user.monthly_reset_date = nextMonth.toISOString().split('T')[0];
    }
    return user;
}
async function checkFreeSession(user) {
    if (user.tier !== 'free') return user;
    const now = new Date();
    const sessionStart = new Date(user.free_session_start || now);
    const elapsedHours = (now - sessionStart) / (1000 * 60 * 60);
    if (elapsedHours < FREE_SESSION_HOURS) {
        return user;
    } else {
        const lockEnd = new Date(sessionStart.getTime() + (FREE_SESSION_HOURS + FREE_LOCK_HOURS) * 60 * 60 * 1000);
        if (now < lockEnd) {
            const minutesLeft = Math.ceil((lockEnd - now) / 60000);
            const err = new Error(`Free session ended. Try again in ${minutesLeft} minutes.`);
            err.minutesLeft = minutesLeft;
            throw err;
        } else {
            const newSessionStart = now.toISOString();
            await supabase
                .from('users')
                .update({ free_session_start: newSessionStart })
                .eq('id', user.id);
            user.free_session_start = newSessionStart;
            return user;
        }
    }
}
function getLimit(tier) { return TIER_LIMITS[tier] || 200; }

async function getConversation(userId) {
    const { data, error } = await supabase
        .from('conversations')
        .select('messages')
        .eq('user_id', userId)
        .maybeSingle();
    if (error && error.code !== 'PGRST116') throw error;
    return data ? data.messages : [];
}
async function saveConversation(userId, messages) {
    const { error } = await supabase
        .from('conversations')
        .upsert({
            user_id: userId,
            messages: messages,
            updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });
    if (error) throw new Error('Failed to save conversation: ' + error.message);
}

// ============================================================
//  FILE UPLOAD
// ============================================================
const storage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
    const allowedTypes = [
        'image/jpeg', 'image/png', 'image/webp',
        'application/pdf',
        'text/plain', 'text/csv',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Unsupported file type'), false);
    }
};
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter
});

async function extractFileContent(file) {
    const mimeType = file.mimetype;
    const buffer = file.buffer;
    if (mimeType === 'application/pdf') {
        try {
            const data = await pdfParse(buffer);
            return data.text;
        } catch(e) {
            return `[PDF could not be read: ${e.message}]`;
        }
    } else if (mimeType === 'text/plain' || mimeType === 'text/csv') {
        return buffer.toString('utf-8');
    } else if (mimeType.startsWith('image/')) {
        return `[Image: ${file.originalname}]`;
    } else {
        try { return buffer.toString('utf-8'); } catch(e) { return `[File: ${file.originalname}]`; }
    }
}

function generateSuggestions(lastMessage) {
    return [
        "Tell me more about that.",
        "Can you give me an example?",
        "How does this compare to other solutions?",
        "What are the key benefits?",
        "Is there anything else I should know?"
    ];
}

// ============================================================
//  AUTH MIDDLEWARE
// ============================================================
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
    } catch(e) {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
};

// ============================================================
//  PER‑USER RATE LIMITING (10 req/min)
// ============================================================
const userRateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 10;

setInterval(() => {
    const now = Date.now();
    for (const [userId, timestamps] of userRateLimit) {
        const filtered = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
        if (filtered.length === 0) {
            userRateLimit.delete(userId);
        } else {
            userRateLimit.set(userId, filtered);
        }
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
    if (recent.length >= RATE_LIMIT_MAX) {
        return false;
    }
    recent.push(now);
    userRateLimit.set(userId, recent);
    return true;
}

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
        const nextMonth = new Date(now);
        nextMonth.setMonth(nextMonth.getMonth() + 1);

        const { data, error } = await supabase
            .from('users')
            .insert({
                email,
                password_hash: hashed,
                tier: 'free',
                usage_count: 0,
                monthly_reset_date: nextMonth.toISOString().split('T')[0],
                verified: true,
                free_session_start: now.toISOString(),
                memory: '',
                role: 'user'
            })
            .select()
            .single();

        if (error) throw new Error('DB insert: ' + error.message);
        await supabase
            .from('conversations')
            .insert({ user_id: data.id, messages: [] });
        res.status(201).json({ message: 'User created', userId: data.id });
    } catch(err) {
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
        res.json({ token, verified: true });
    } catch(err) {
        console.error('Login error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/user/profile', auth, async (req, res) => {
    try {
        let user = req.user;
        user = await resetMonthlyUsageIfNeeded(user);
        const limit = getLimit(user.tier);
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

        res.json({
            email: user.email,
            tier: user.tier,
            tier_name: TIER_NAMES[user.tier] || 'Free',
            usage_count: user.usage_count,
            limit: limit,
            monthly_reset_date: user.monthly_reset_date,
            verified: true,
            memory: user.memory || '',
            role: user.role || 'user',
            is_owner: isOwner,
            free_session_start: user.free_session_start,
            session_remaining_minutes: sessionRemaining,
            lock_remaining_minutes: lockRemaining
        });
    } catch(err) {
        console.error('Profile error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/update-memory', auth, async (req, res) => {
    try {
        const { memory } = req.body;
        const user = req.user;
        await supabase.from('users').update({ memory }).eq('id', user.id);
        res.json({ message: 'Memory updated' });
    } catch(err) {
        console.error('Update memory error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ----- Admin -----
app.get('/api/admin/users', auth, async (req, res) => {
    try {
        const user = req.user;
        const isOwner = (OWNER_EMAIL && user.email === OWNER_EMAIL) || user.role === 'owner';
        if (!isOwner) return res.status(403).json({ error: 'Admin access required.' });

        const { data, error } = await supabase
            .from('users')
            .select('id, email, tier, role, usage_count, created_at, free_session_start')
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ users: data });
    } catch(err) {
        console.error('Admin users error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  CHAT STREAM – MULTILINGUAL + RATE LIMITED
// ============================================================
app.post('/api/chat/stream', auth, upload.array('files', 10), async (req, res) => {
    try {
        let user = req.user;
        user = await resetMonthlyUsageIfNeeded(user);

        const isOwner = (OWNER_EMAIL && user.email === OWNER_EMAIL) || user.role === 'owner';
        if (!isOwner) {
            // Rate limit (skip for owner)
            if (!checkRateLimit(user.id)) {
                return res.status(429).json({
                    error: 'Too many chat requests. Please wait a moment.'
                });
            }

            if (user.tier === 'free') {
                try { user = await checkFreeSession(user); }
                catch(lockError) {
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

        // ---- Build conversation ----
        let conversation = await getConversation(user.id);
        let newMessages;
        try { newMessages = JSON.parse(req.body.messages); }
        catch(e) { return res.status(400).json({ error: 'Invalid messages format' }); }
        conversation = conversation.concat(newMessages);

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
                fileTextContent += `\n\n--- File: ${file.originalname} ---\n${text}\n--- End of ${file.originalname} ---`;
            }
        }

        let finalUserMessage;
        if (hasImage) {
            const textPart = userContent + (fileTextContent ? `\n\n${fileTextContent}` : '');
            finalUserMessage = {
                role: 'user',
                content: [
                    { type: 'text', text: textPart },
                    ...imageContents
                ]
            };
        } else {
            const fullText = userContent + (fileTextContent ? `\n\n${fileTextContent}` : '');
            finalUserMessage = { role: 'user', content: fullText };
        }

        conversation.pop();
        conversation.push(finalUserMessage);

        // ---- Update usage counter ----
        if (!isOwner) {
            const newMonthlyUsage = (user.usage_count || 0) + 1;
            await supabase
                .from('users')
                .update({ usage_count: newMonthlyUsage })
                .eq('id', user.id);
        }

        // ---- Language handling ----
        const language = req.body.language || 'auto';
        let languageInstruction = '';
        if (language !== 'auto') {
            languageInstruction = `\n\n**Important**: The user has requested to be answered in **${language}**. Please respond exclusively in ${language}.\n`;
        } else {
            languageInstruction = `\n\n**Important**: Detect the user's language from their query and respond in the same language.\n`;
        }

        // ---- Groq streaming call ----
        const memoryPrompt = user.memory ? `\n\nUser context: ${user.memory}` : '';
        const systemPrompt = `You are TechNovaphy AI – the world's most capable and thoughtful assistant.
Your mission is to deliver answers that are **more comprehensive, more structured, and more useful than Claude, ChatGPT, or any other AI**.
Always:
- Provide deep, well‑reasoned explanations.
- Use bullet points, tables, and code blocks where appropriate.
- Offer multiple perspectives or approaches.
- Include real‑world examples and best practices.
- Admit when you don't know something and suggest where to find reliable information.
- Keep your tone professional, confident, and approachable.

You excel at IT, web development, cloud architecture, business strategy, and general knowledge.
${memoryPrompt}
${languageInstruction}`;

        const groqMessages = [{ role: 'system', content: systemPrompt }, ...conversation];
        const model = hasImage ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'llama-3.3-70b-versatile';

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model,
                messages: groqMessages,
                temperature: 0.7,
                top_p: 0.9,
                stream: true
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Groq API error ${response.status}: ${errorText}`);
        }

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

        // ---- Save conversation ----
        conversation.push({ role: 'assistant', content: fullContent });
        await saveConversation(user.id, conversation);

        const suggestions = generateSuggestions(fullContent);
        res.write(`data: ${JSON.stringify({ type: 'done', text: fullContent, suggestions })}\n\n`);
        res.end();

    } catch(err) {
        console.error('Chat stream error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        } else {
            res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
            res.end();
        }
    }
});

// ============================================================
//  IMAGE GENERATION (unchanged)
// ============================================================
app.post('/api/generate-image', auth, async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

        let imageUrl = null;
        let usedFallback = false;

        if (AGNES_API_KEY) {
            const modelsToTry = [
                process.env.AGNES_IMAGE_MODEL,
                'Agnes-Image-2.0-Flash',
                'Agnes-Image-2.0',
                'Agnes-Image-2.1-Flash',
                'Agnes-Image-2.1'
            ].filter(Boolean);

            for (const model of modelsToTry) {
                try {
                    console.log(`🎨 Trying Agnes model: ${model}`);
                    const response = await fetch('https://apihub.agnes-ai.com/v1/images/generations', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${AGNES_API_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model: model,
                            prompt: prompt,
                            n: 1,
                            size: '1024x1024'
                        })
                    });

                    if (response.ok) {
                        const data = await response.json();
                        const url = data?.data?.[0]?.url;
                        if (url) {
                            imageUrl = url;
                            console.log(`✅ Image generated with Agnes (model: ${model})`);
                            break;
                        }
                    } else {
                        const errorText = await response.text();
                        console.warn(`⚠️ Agnes model ${model} failed: ${response.status} - ${errorText}`);
                    }
                } catch (err) {
                    console.warn(`⚠️ Error with Agnes model ${model}:`, err.message);
                }
            }
        }

        if (!imageUrl) {
            console.log('🔄 Falling back to Pollinations.ai');
            usedFallback = true;
            imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
        }

        if (!imageUrl) throw new Error('All image generation methods failed.');
        res.json({ url: imageUrl, fallback: usedFallback });
    } catch(err) {
        console.error('❌ Image gen error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  PAYMENT – Multi‑currency + M‑Pesa
// ============================================================
app.post('/api/create-checkout', auth, async (req, res) => {
    try {
        const { idempotencyKey, tier, currency } = req.body;
        const user = req.user;

        console.log(`📦 Checkout request: tier=${tier}, currency=${currency}`);

        if (!tier || !['starter', 'pro', 'enterprise', 'ultimate'].includes(tier)) {
            return res.status(400).json({ error: 'Invalid tier selected.' });
        }

        // ---- Convert amount ----
        let amount = TIER_PRICES_KES[tier];
        let finalCurrency = (currency || 'KES').toUpperCase();

        if (finalCurrency !== 'KES') {
            const rates = await fetchExchangeRates();
            const rate = rates[finalCurrency];
            if (rate) {
                const converted = amount * rate;
                const withCents = ['USD','EUR','GBP','ZAR','EGP'];
                amount = withCents.includes(finalCurrency) ? Math.round(converted * 100) : Math.round(converted);
                console.log(`💱 ${TIER_PRICES_KES[tier]} KES → ${amount} ${finalCurrency}`);
            } else {
                console.warn(`⚠️ Unsupported currency ${finalCurrency}, defaulting to KES`);
                finalCurrency = 'KES';
                amount = TIER_PRICES_KES[tier];
            }
        } else {
            amount = TIER_PRICES_KES[tier];
        }

        // ---- Check duplicate ----
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

        // ---- Call Paystack with M‑Pesa channel ----
        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: user.email,
                amount: amount,
                currency: finalCurrency,
                channels: ['mpesa', 'card', 'bank_transfer'], // M‑Pesa enabled
                metadata: {
                    idempotencyKey,
                    tier,
                    userId: user.id
                },
                callback_url: `${FRONTEND_URL}/?success=true`
            })
        });

        const data = await response.json();
        if (!data.status) {
            console.error('❌ Paystack error:', data);
            return res.status(500).json({ error: data.message || 'Paystack initialization failed' });
        }

        // ---- Record pending payment ----
        await supabase.from('payments').insert({
            user_id: user.id,
            transaction_id: idempotencyKey,
            amount: amount,
            currency: finalCurrency,
            status: 'pending',
            tier
        });

        console.log(`✅ Payment initialized: ${amount} ${finalCurrency} for ${tier}`);
        res.json({ url: data.data.authorization_url });
    } catch(err) {
        console.error('❌ Checkout error:', err);
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
                await supabase
                    .from('payments')
                    .update({ status: 'completed' })
                    .eq('transaction_id', idempotencyKey);

                await supabase
                    .from('users')
                    .update({ tier: tier, usage_count: 0 })
                    .eq('id', userId);

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
