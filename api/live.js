/**
 * Serverless Function para Vercel / Netlify / Node.js
 * Permite que cualquier dispositivo en el mundo (celular, laptop, tablet)
 * consulte las votaciones de TV Azteca en TIEMPO REAL sin restricciones CORS.
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const BASE_URL = 'https://vota.tvazteca.com';

    // Último corte oficial registrado por participante para evitar ceros cuando TV Azteca activa escudo en /api/results
    const BASELINE_VOTES = {
        '20afae14-8a66-469b-9cb9-c0db49645b72': 28376514, // Niurka
        '9aa4243b-172b-46ac-b376-f96f289c2461': 16728603, // Kevyn "Bicolor"
        '9bb2e7d8-41bc-453d-b974-1d70c073ffc7': 9518920,  // Bebeshita
        '5f6fe82f-40ac-44f5-9168-9c6f1a44c1ca': 6832417,  // Mono Osuna
        '0e1358d5-f3bf-4be7-a931-0a4a4fe49741': 570240,   // Manelyk
    };

    async function fetchJson(url) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000);
            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'Accept': 'application/json',
                    'Origin': 'https://www.tvazteca.com',
                    'Referer': 'https://www.tvazteca.com/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            clearTimeout(timeout);
            if (response.ok) {
                const text = await response.text();
                if (!text) return null;
                try {
                    return JSON.parse(text);
                } catch (_) {
                    try {
                        return JSON.parse(text.replace(/'/g, '"'));
                    } catch (_) {
                        return null;
                    }
                }
            }
        } catch (_) {}
        return null;
    }

    try {
        const [config, status] = await Promise.all([
            fetchJson(`${BASE_URL}/config/vota.json?_t=${Date.now()}`),
            fetchJson(`${BASE_URL}/config/vota-status.json?_t=${Date.now()}`)
        ]);

        if (!config) {
            return res.status(502).json({ error: 'No se pudo conectar con el servidor de TV Azteca' });
        }

        const polls = [];
        let resultsRestricted = false;

        // Votación 1
        if (config.voting && config.voting.configId) {
            const v1 = config.voting;
            const res1 = await fetchJson(`${BASE_URL}/api/results?config_id=${encodeURIComponent(v1.configId)}&_t=${Date.now()}`);
            const hasLiveApiVotes = res1 && (v1.contestants || []).some(c => typeof res1[c.id] === 'number' && res1[c.id] > 0);
            if (!hasLiveApiVotes) resultsRestricted = true;
            const p1 = formatPoll(v1, res1 || {}, 'principal', BASE_URL, BASELINE_VOTES);
            polls.push(p1);
        }

        // Votación 2
        if (config.voting2 && config.voting2.enabled && config.voting2.configId) {
            const v2 = config.voting2;
            const res2 = await fetchJson(`${BASE_URL}/api/results?config_id=${encodeURIComponent(v2.configId)}&_t=${Date.now()}`);
            polls.push(formatPoll(v2, res2 || {}, 'secundaria', BASE_URL, {}));
        }

        return res.status(200).json({
            ok: true,
            resultsRestricted,
            timestamp: new Date().toISOString(),
            localTime: new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }),
            sourceUrl: 'https://www.tvazteca.com/aztecauno/la-granja-votaciones/vota/',
            programTitle: config.nombre || 'La Granja VIP Segunda Temporada',
            logo: config.logo?.image ? `${BASE_URL}${config.logo.image}` : '',
            status: {
                active: status?.active !== false,
                votingOpen: status?.voting_open !== false,
                votingClosedText: status?.voting_closed_text || '',
                configVersion: status?.config_version || 'live'
            },
            polls
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

function formatPoll(votingConfig, rawResults, key, baseUrl, baselineVotes = {}) {
    const contestants = (votingConfig.contestants || []).filter(c => !c.deleted);
    let totalActiveVotes = 0;
    const totalAllVotes = Object.values(rawResults).reduce((sum, v) => sum + (Number(v) || 0), 0);

    const formatted = contestants.map(c => {
        let votes = typeof rawResults[c.id] === 'number' && rawResults[c.id] > 0
            ? rawResults[c.id]
            : (baselineVotes[c.id] || 0);
        totalActiveVotes += votes;
        let img = c.image || '';
        if (img && !img.startsWith('http')) {
            img = baseUrl + (img.startsWith('/') ? '' : '/') + img;
        }
        return {
            id: c.id,
            name: c.name || 'Participante',
            image: img,
            votes
        };
    }).sort((a, b) => b.votes - a.votes);

    formatted.forEach((c, idx) => {
        c.rank = idx + 1;
        c.percentage = totalActiveVotes > 0 ? Number(((c.votes / totalActiveVotes) * 100).toFixed(2)) : 0;
    });

    const maxVotes = votingConfig.maxVotes || 10;
    return {
        key,
        configId: votingConfig.configId,
        internalName: votingConfig.name || '',
        title: votingConfig.title || 'Votación Activa',
        subtitle: String(votingConfig.subtitle || '').replace('{n}', String(maxVotes)),
        maxVotes,
        accentColor: votingConfig.accentColor || '#da07c8',
        extraColor: votingConfig.extraColor || '#d5d546',
        totalActiveVotes,
        totalRawVotes: Math.max(totalAllVotes, totalActiveVotes),
        contestants: formatted,
        rawResults
    };
}
