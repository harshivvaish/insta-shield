require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serves your index.html from the 'public' folder

// Initialize Gemini
// Ensure your .env file has: GEMINI_API_KEY=your_actual_key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post('/analyze', async (req, res) => {
    const { url } = req.body;
    
    if (!url || !url.startsWith('http')) {
        return res.status(400).json({ error: "Please enter a valid URL (starting with http/https)" });
    }

    let browser;
    try {
        // Launch Puppeteer with flags to avoid issues on Windows/OneDrive
        browser = await puppeteer.launch({ 
            headless: true, 
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });
        
        const page = await browser.newPage();

        // RESOURCE BLOCKING & background request capture
        await page.setRequestInterception(true);
        const backgroundRequests = [];
        page.on('request', (request) => {
            const resourceType = request.resourceType();
            const requestUrl = request.url();

            // Store XHR/Fetch requests to find suspicious third-party calls
            if (resourceType === 'xhr' || resourceType === 'fetch') {
                backgroundRequests.push(requestUrl);
            }

            // Block heavy resources to save time/bandwidth
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                try { request.abort(); } catch (e) { request.continue(); }
            } else {
                try { request.continue(); } catch (e) { /* ignore */ }
            }
        });

        const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        const headers = response.headers();

        const securityHeaders = {
            'Content-Security-Policy': headers['content-security-policy'] || '❌ MISSING',
            'Strict-Transport-Security': headers['strict-transport-security'] || '❌ MISSING',
            'X-Frame-Options': headers['x-frame-options'] || '❌ MISSING',
            'X-Content-Type-Options': headers['x-content-type-options'] || '❌ MISSING'
        };
        
        // Data Extraction
        const cookies = await page.cookies();
        const security = response.securityDetails();
        const scripts = await page.evaluate(() => 
            Array.from(document.querySelectorAll('script')).map(s => ({ 
                src: s.src || "inline", 
                content: (s.textContent || "").slice(0, 200) 
            }))
        );

        const sslData = security ? {
            issuer: security.issuer(),
            protocol: security.protocol(),
            protocol: security.protocol(),
            validTo: new Date(security.validTo() * 1000).toDateString()
        } : "No SSL certificate found";

        // Save screenshot and PDF into public/output so they are served statically
        const outputDir = path.join(__dirname, 'public', 'output');
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        const timestamp = Date.now();
        const screenshotFilename = `screenshot-${timestamp}.png`;
        const pdfFilename = `report-${timestamp}.pdf`;
        const screenshotPath = path.join(outputDir, screenshotFilename);
        const pdfPath = path.join(outputDir, pdfFilename);

        await page.screenshot({ path: screenshotPath, fullPage: true });
        await page.pdf({ path: pdfPath, format: 'A4' });

        // Extract <link> tags (stylesheets, preconnects, icons, etc.)
        const linkTags = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('link')).map(link => ({
                rel: link.rel || null,
                href: link.href || null
            }));
        });

        // Extract localStorage and sessionStorage
        const storageData = await page.evaluate(() => {
            return {
                local: Object.assign({}, window.localStorage),
                session: Object.assign({}, window.sessionStorage)
            };
        });

        // AI Safety Analysis
        let safetyAnalysis;
        try {
    // 1. Using a modern 2026 model name
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    
    const prompt = `Task: Security Analysis for Shield 3.0 Startup.
    URL: ${url}
    SSL Info: ${JSON.stringify(sslData)}
    Cookie Names: ${JSON.stringify(cookies.map(c => c.name))}
    
    Analyze these signals. Is this site a security risk? Respond ONLY in this JSON format:
    {"safe": boolean, "reason": "short expert explanation"}`;

    const aiResult = await model.generateContent(prompt);
    const textResponse = aiResult.response.text();
    
    const cleanJson = textResponse.replace(/```json|```/g, "").trim();
    safetyAnalysis = JSON.parse(cleanJson);
} catch (aiError) {
    // If it still fails, this logs the exact reason (e.g., API key or region issues)
    console.error("DEBUG AI ERROR:", aiError.message);
    safetyAnalysis = { 
        safe: true, 
        reason: "AI Engine unnavailable. Manual verification of SSL/Cookies required." 
    };
}

        res.json({ 
            sslData, 
            cookies, 
            scripts, 
            linkTags, 
            storageData,
            backgroundRequests,
            securityHeaders,
            screenshotUrl: `/output/${screenshotFilename}`,
            pdfUrl: `/output/${pdfFilename}`,
            safetyAnalysis 
        });

    } catch (error) {
        console.error("SCRAPER ERROR:", error.message);
        res.status(500).json({ error: "Scan failed", details: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Shield 3.0 Active: http://localhost:${PORT}`);
});