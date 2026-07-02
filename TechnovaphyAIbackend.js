
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

// ----- TIER PRICES (direct KES) -----
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

// ----- User Helpers -----
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

// ----- File Upload -----
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

// ----- Auth Middleware -----
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
//  IN‑MEMORY QUEUE & RATE LIMITING (for chat)
// ============================================================

// Per‑user rate limit: 10 requests per minute
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

// Global job queue (concurrency 5)
const queue = [];
const jobResults = new Map();
let jobIdCounter = 0;
const MAX_CONCURRENT = 5;
let activeJobs = 0;

async function processQueue() {
    if (queue.length === 0 || activeJobs >= MAX_CONCURRENT) return;
    const job = queue.shift();
    activeJobs++;
    try {
        const result = await processGroqRequest(job.messages, job.userEmail);
        jobResults.set(job.jobId, { status: 'done', content: result, timestamp: Date.now() });
    } catch (err) {
        jobResults.set(job.jobId, { status: 'error', error: err.message, timestamp: Date.now() });
    } finally {
        activeJobs--;
        setImmediate(processQueue);
    }
}

function enqueueJob(messages, userEmail) {
    const jobId = (++jobIdCounter).toString(16) + '-' + Date.now().toString(36);
    queue.push({ jobId, messages, userEmail });
    setImmediate(processQueue);
    return jobId;
}

// Clean up old job results after 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, data] of jobResults) {
        if (data.timestamp && now - data.timestamp > 5 * 60 * 1000) {
            jobResults.delete(id);
        }
    }
}, 60 * 1000);

// ----- Groq processing (non‑streaming) -----
async function processGroqRequest(messages, userEmail) {
    const systemPrompt = `You are TechNovaphy AI – the world's most capable and thoughtful assistant.
Your mission is to deliver answers that are **more comprehensive, more structured, and more useful than Claude, ChatGPT, or any other AI**.
Always:
- Provide deep, well‑reasoned explanations.
- Use bullet points, tables, and code blocks where appropriate.
- Offer multiple perspectives or approaches.
- Include real‑world examples and best practices.
- Admit when you don't know something and suggest where to find reliable information.
- Keep your tone professional, confident, and approachable.

You excel at IT, web development, cloud architecture, business strategy, and general knowledge.`;

    const groqMessages = [{ role: 'system', content: systemPrompt }, ...messages];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: groqMessages,
            temperature: 0.7,
            top_p: 0.9,
            stream: false
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Groq API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

// ----- Public endpoints -----
app.get('/', (req, res) => res.send('TechNovaphy AI Backend is running'));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/ping', (req, res) => res.json({ status: 'ok', message: 'Backend is reachable!' }));

// ----- Auth routes -----
app.post('/api/auth/register', async (req, res) => {
    // ... full code (same as before)
});
app.post('/api/auth/login', async (req, res) => {
    // ... full code
});
app.get('/api/user/profile', auth, async (req, res) => {
    // ... full code
});
app.post('/api/auth/update-memory', auth, async (req, res) => {
    // ... full code
});

// ----- Admin -----
app.get('/api/admin/users', auth, async (req, res) => {
    // ... full code
});

// ============================================================
//  CHAT ENDPOINT (with queue and rate limiting)
// ============================================================
app.post('/api/chat/stream', auth, upload.array('files', 10), async (req, res) => {
    try {
        let user = req.user;
        user = await resetMonthlyUsageIfNeeded(user);

        const isOwner = (OWNER_EMAIL && user.email === OWNER_EMAIL) || user.role === 'owner';
        if (!isOwner) {
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

        // Rate limit (skip for owner)
        if (!isOwner && !checkRateLimit(user.id)) {
            return res.status(429).json({ error: 'Too many chat requests. Please wait a moment.' });
        }

        // Build conversation
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

        // Update usage counter
        if (!isOwner) {
            const newMonthlyUsage = (user.usage_count || 0) + 1;
            await supabase
                .from('users')
                .update({ usage_count: newMonthlyUsage })
                .eq('id', user.id);
        }

        // Enqueue the job
        const jobId = enqueueJob(conversation, user.email);
        res.json({
            status: 'queued',
            jobId: jobId,
            message: 'Your request is queued. Poll /api/chat/result/:jobId for the response.'
        });

    } catch(err) {
        console.error('Chat stream error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ----- Polling endpoint -----
app.get('/api/chat/result/:jobId', auth, async (req, res) => {
    const { jobId } = req.params;
    const result = jobResults.get(jobId);
    if (!result) {
        return res.status(202).json({ status: 'processing' });
    }
    jobResults.delete(jobId);
    if (result.status === 'done') {
        res.json({ status: 'done', content: result.content });
    } else {
        res.status(500).json({ status: 'error', error: result.error });
    }
});

// ----- IMAGE GENERATION -----
app.post('/api/generate-image', auth, async (req, res) => {
    // ... (full code from earlier)
});

// ============================================================
//  PAYMENT ENDPOINT
// ============================================================
app.post('/api/create-checkout', auth, async (req, res) => {
    try {
        const { idempotencyKey, tier, currency } = req.body;
        const user = req.user;

        console.log(`📦 Checkout request: tier=${tier}, currency=${currency}`);

        if (!tier || !['starter', 'pro', 'enterprise', 'ultimate'].includes(tier)) {
            return res.status(400).json({ error: 'Invalid tier selected.' });
        }

        const amountInKES = TIER_PRICES_KES[tier];
        if (!amountInKES) {
            return res.status(400).json({ error: `No price found for tier ${tier}` });
        }

        console.log(`💰 Amount: ${amountInKES} KES for tier: ${tier}`);

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

        const response = await fetch('https://api.paystack.co/transaction/initialize', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: user.email,
                amount: amountInKES,
                currency: 'KES',
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

        await supabase.from('payments').insert({
            user_id: user.id,
            transaction_id: idempotencyKey,
            amount: amountInKES,
            currency: 'KES',
            status: 'pending',
            tier
        });

        console.log(`✅ Payment initialized: ${amountInKES} KES for ${tier}`);
        res.json({ url: data.data.authorization_url });
    } catch(err) {
        console.error('❌ Checkout error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ----- PAYSTACK WEBHOOK -----
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

// ----- START -----
app.listen(PORT, () => console.log(`🚀 TechNovaphy AI Backend running on port ${PORT}`));
