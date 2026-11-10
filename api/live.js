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
                return await response.json();
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

        // Votación 1
        if (config.voting && config.voting.configId) {
            const v1 = config.voting;
            const res1 = await fetchJson(`${BASE_URL}/api/results?config_id=${encodeURIComponent(v1.configId)}&_t=${Date.now()}`) || {};
            polls.push(formatPoll(v1, res1, 'principal', BASE_URL));
        }

        // Votación 2
        if (config.voting2 && config.voting2.enabled && config.voting2.configId) {
            const v2 = config.voting2;
            const res2 = await fetchJson(`${BASE_URL}/api/results?config_id=${encodeURIComponent(v2.configId)}&_t=${Date.now()}`) || {};
            polls.push(formatPoll(v2, res2, 'secundaria', BASE_URL));
        }

        return res.status(200).json({
            ok: true,
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

function formatPoll(votingConfig, rawResults, key, baseUrl) {
    const contestants = (votingConfig.contestants || []).filter(c => !c.deleted);
    let totalActiveVotes = 0;
    const totalAllVotes = Object.values(rawResults).reduce((sum, v) => sum + (Number(v) || 0), 0);

    const formatted = contestants.map(c => {
        const votes = typeof rawResults[c.id] === 'number' ? rawResults[c.id] : 0;
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
        totalRawVotes: totalAllVotes,
        contestants: formatted,
        rawResults
    };
}
