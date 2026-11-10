/**
 * Motor en Tiempo Real - Monitor de Votaciones La Granja VIP (Segunda Temporada)
 * Conecta con el proxy local PHP (api/live.php), proxies CORS públicos o el snapshot actualizado.
 */

const state = {
    data: null,
    prevVotes: {}, // { configId_contestantId: votes }
    prevTotals: {}, // { configId: totalVotes }
    viewMode: 'dual', // 'dual', 'principal', 'secundaria'
    refreshMs: 5000,
    timerId: null,
    charts: {},
    logs: [],
    connectionMode: 'Detectando...'
};

const BASE_TVAZTECA = 'https://vota.tvazteca.com';

const fmtNum = (n) => new Intl.NumberFormat('es-MX').format(Number(n) || 0);
const fmtPct = (n) => Number(n || 0).toFixed(2) + '%';

document.addEventListener('DOMContentLoaded', () => {
    setupControls();
    fetchLiveVotes(true);
    startAutoRefresh();
});

function setupControls() {
    const intervalSelect = document.getElementById('refresh-interval');
    if (intervalSelect) {
        intervalSelect.addEventListener('change', (e) => {
            state.refreshMs = parseInt(e.target.value, 10);
            startAutoRefresh();
        });
    }

    const btnRefresh = document.getElementById('btn-refresh-now');
    if (btnRefresh) {
        btnRefresh.addEventListener('click', () => {
            btnRefresh.disabled = true;
            fetchLiveVotes(false).finally(() => {
                setTimeout(() => { btnRefresh.disabled = false; }, 400);
            });
        });
    }
}

function startAutoRefresh() {
    if (state.timerId) clearInterval(state.timerId);
    if (state.refreshMs > 0) {
        state.timerId = setInterval(() => fetchLiveVotes(false), state.refreshMs);
    }
}

/**
 * Intenta obtener los datos en tiempo real usando:
 * 1) El endpoint PHP local (api/live.php) si corre en Laragon / servidor PHP
 * 2) Consulta directa / CORS Proxy hacia vota.tvazteca.com (para GitHub Pages)
 * 3) El archivo data/snapshot.json como respaldo garantizado
 */
async function fetchLiveVotes(isInitial = false) {
    updateSyncIndicator(true);
    try {
        // Estrategia 1: Backend PHP en tiempo real (Laragon / Servidor propio)
        const phpResp = await fetch(`api/live.php?_t=${Date.now()}`, { cache: 'no-store' });
        if (phpResp.ok) {
            const contentType = phpResp.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const json = await phpResp.json();
                if (json && json.ok && Array.isArray(json.polls)) {
                    state.connectionMode = 'API Directa en Vivo (Tiempo Real)';
                    processIncomingData(json, isInitial);
                    updateSyncIndicator(false);
                    return;
                }
            }
        }
    } catch (_) {
        // Continúa a la estrategia 2 si no hay PHP activo (ej. GitHub Pages)
    }

    // Estrategia 2: Cliente directo / Proxy CORS + Snapshot en GitHub Pages
    try {
        const directData = await fetchFromBrowserWithFallback();
        if (directData) {
            processIncomingData(directData, isInitial);
            updateSyncIndicator(false);
            return;
        }
    } catch (err) {
        console.warn('Error en actualización:', err);
    }
    updateSyncIndicator(false);
}

async function fetchFromBrowserWithFallback() {
    // Primero cargamos snapshot.json para tener la base rápida
    let snapshot = null;
    try {
        const snapResp = await fetch(`data/snapshot.json?_t=${Date.now()}`, { cache: 'no-store' });
        if (snapResp.ok) {
            snapshot = await snapResp.json();
        }
    } catch (_) {}

    // Intentamos consultar primero la configuración en vivo (por si TV Azteca cambió a "Salvar al Nominado" o agregó participantes)
    const liveConfig = await tryCorsFetchJson(`${BASE_TVAZTECA}/config/vota.json?_t=${Date.now()}`);
    const liveStatus = await tryCorsFetchJson(`${BASE_TVAZTECA}/config/vota-status.json?_t=${Date.now()}`);

    if (liveConfig && liveConfig.voting) {
        const dynamicPolls = [];
        const v1 = liveConfig.voting;
        if (v1.configId) {
            const r1 = await tryCorsFetchJson(`${BASE_TVAZTECA}/api/results?config_id=${encodeURIComponent(v1.configId)}&_t=${Date.now()}`) || {};
            dynamicPolls.push(buildPollFromBrowserConfig(v1, r1, 'principal'));
        }
        const v2 = liveConfig.voting2;
        if (v2 && v2.enabled && v2.configId) {
            const r2 = await tryCorsFetchJson(`${BASE_TVAZTECA}/api/results?config_id=${encodeURIComponent(v2.configId)}&_t=${Date.now()}`) || {};
            dynamicPolls.push(buildPollFromBrowserConfig(v2, r2, 'secundaria'));
        }

        if (dynamicPolls.length > 0) {
            state.connectionMode = 'Sincronizado en Vivo';
            return {
                ok: true,
                localTime: new Date().toLocaleString('es-MX'),
                programTitle: liveConfig.nombre || 'La Granja VIP Segunda Temporada',
                status: {
                    active: liveStatus ? liveStatus.active !== false : true,
                    votingOpen: liveStatus ? liveStatus.voting_open !== false : true,
                    votingClosedText: liveStatus?.voting_closed_text || '',
                    configVersion: liveStatus?.config_version || 'live'
                },
                polls: dynamicPolls
            };
        }
    }

    // Si el proxy de vota.json no respondió, actualizamos los conteos sobre la estructura de snapshot.json
    if (snapshot && Array.isArray(snapshot.polls)) {
        try {
            const updatedPolls = await Promise.all(snapshot.polls.map(async (poll) => {
                const targetUrl = `${BASE_TVAZTECA}/api/results?config_id=${encodeURIComponent(poll.configId)}&_t=${Date.now()}`;
                const liveCounts = await tryCorsFetchJson(targetUrl);
                if (!liveCounts) return poll;

                let totalActive = 0;
                const updatedContestants = poll.contestants.map(c => {
                    const votes = typeof liveCounts[c.id] === 'number' ? liveCounts[c.id] : c.votes;
                    totalActive += votes;
                    return { ...c, votes };
                }).sort((a, b) => b.votes - a.votes);

                updatedContestants.forEach((c, idx) => {
                    c.rank = idx + 1;
                    c.percentage = totalActive > 0 ? Number(((c.votes / totalActive) * 100).toFixed(2)) : 0;
                });

                return {
                    ...poll,
                    totalActiveVotes: totalActive,
                    contestants: updatedContestants,
                    rawResults: liveCounts
                };
            }));

            state.connectionMode = 'Sincronizado en Vivo';
            return {
                ...snapshot,
                localTime: new Date().toLocaleString('es-MX'),
                polls: updatedPolls
            };
        } catch (_) {}
    }

    if (snapshot) {
        state.connectionMode = 'Snapshot Oficial Sincronizado';
        return snapshot;
    }
    return null;
}

function buildPollFromBrowserConfig(votingConfig, rawResults, key) {
    const contestants = (votingConfig.contestants || []).filter(c => !c.deleted);
    let totalActiveVotes = 0;

    const formatted = contestants.map(c => {
        const votes = typeof rawResults[c.id] === 'number' ? rawResults[c.id] : 0;
        totalActiveVotes += votes;
        let img = c.image || '';
        if (img && !img.startsWith('http')) {
            img = BASE_TVAZTECA + (img.startsWith('/') ? '' : '/') + img;
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
        contestants: formatted,
        rawResults
    };
}

async function tryCorsFetchJson(url) {
    const proxies = [
        (u) => u,
        (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
        (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`
    ];

    for (const buildUrl of proxies) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3500);
            const r = await fetch(buildUrl(url), { signal: controller.signal, cache: 'no-store' });
            clearTimeout(timeout);
            if (r.ok) {
                const data = await r.json();
                if (data && typeof data === 'object' && !data.error) {
                    return data;
                }
            }
        } catch (_) {}
    }
    return null;
}

function processIncomingData(data, isInitial) {
    state.data = data;

    // Calcular incrementos de votos en tiempo real
    const deltas = {};
    let totalGlobalVotes = 0;
    let totalGlobalDelta = 0;

    data.polls.forEach(poll => {
        totalGlobalVotes += poll.totalActiveVotes;
        const prevPollTotal = state.prevTotals[poll.configId];
        if (prevPollTotal !== undefined && poll.totalActiveVotes > prevPollTotal) {
            const diffPoll = poll.totalActiveVotes - prevPollTotal;
            totalGlobalDelta += diffPoll;
        }
        state.prevTotals[poll.configId] = poll.totalActiveVotes;

        poll.contestants.forEach(c => {
            const key = `${poll.configId}_${c.id}`;
            const prev = state.prevVotes[key];
            if (prev !== undefined && c.votes > prev) {
                const diff = c.votes - prev;
                deltas[key] = diff;
                addVoteLog(poll.title, c.name, diff, c.votes);
            }
            state.prevVotes[key] = c.votes;
        });
    });

    renderHeaderAndKPIs(data, totalGlobalVotes, totalGlobalDelta);
    renderTabs(data.polls);
    renderPolls(data.polls, deltas);
    renderLogs();
}

function addVoteLog(pollTitle, contestantName, diff, newTotal) {
    const now = new Date().toLocaleTimeString('es-MX', { hour12: false });
    state.logs.unshift({
        time: now,
        pollTitle,
        contestantName,
        diff,
        newTotal
    });
    if (state.logs.length > 25) state.logs.pop();
}

function renderHeaderAndKPIs(data, totalGlobalVotes, totalGlobalDelta) {
    const statusBadge = document.getElementById('status-badge');
    const statusText = document.getElementById('status-text');
    if (statusBadge && statusText) {
        if (data.status && data.status.votingOpen) {
            statusBadge.classList.remove('closed');
            statusText.textContent = 'VOTACIÓN ABIERTA EN VIVO';
        } else {
            statusBadge.classList.add('closed');
            statusText.textContent = 'VOTACIÓN CERRADA';
        }
    }

    const elTotalGlobal = document.getElementById('kpi-global-votes');
    if (elTotalGlobal) elTotalGlobal.textContent = fmtNum(totalGlobalVotes);

    const elGlobalDelta = document.getElementById('kpi-global-delta');
    if (elGlobalDelta) {
        if (totalGlobalDelta > 0) {
            elGlobalDelta.innerHTML = `<span class="delta-pill">+${fmtNum(totalGlobalDelta)} votos nuevos</span>`;
        } else {
            elGlobalDelta.textContent = state.connectionMode;
        }
    }

    // Líder Votación 1 (Dinámico según la etapa: Salvación, Capataz, Final, etc.)
    if (data.polls[0] && data.polls[0].contestants[0]) {
        const p1 = data.polls[0];
        const leader1 = p1.contestants[0];
        const lbl1 = document.getElementById('kpi-leader1-label');
        if (lbl1) lbl1.textContent = `1° Lugar · ${p1.title.slice(0, 28)}`;
        document.getElementById('kpi-leader1-name').textContent = leader1.name;
        document.getElementById('kpi-leader1-sub').textContent = `${fmtPct(leader1.percentage)} (${fmtNum(leader1.votes)} votos)`;
    }

    // Líder Votación 2 (O información de la Votación 1 si solo hay 1 votación activa como en Gala de Eliminación/Salvación)
    const card2 = document.getElementById('kpi-card-poll2');
    const lbl2 = document.getElementById('kpi-leader2-label');
    if (data.polls[1] && data.polls[1].contestants[0]) {
        const p2 = data.polls[1];
        const leader2 = p2.contestants[0];
        if (lbl2) lbl2.textContent = `1° Lugar · ${p2.title.slice(0, 28)}`;
        document.getElementById('kpi-leader2-name').textContent = leader2.name;
        document.getElementById('kpi-leader2-sub').textContent = `${fmtPct(leader2.percentage)} (${fmtNum(leader2.votes)} votos)`;
    } else if (data.polls[0] && data.polls[0].contestants.length > 1) {
        const p1 = data.polls[0];
        const lastContestant = p1.contestants[p1.contestants.length - 1];
        if (lbl2) lbl2.textContent = `En Riesgo (Menor Voto) · ${p1.title.slice(0, 20)}`;
        document.getElementById('kpi-leader2-name').textContent = lastContestant.name;
        document.getElementById('kpi-leader2-sub').textContent = `${fmtPct(lastContestant.percentage)} (${fmtNum(lastContestant.votes)} votos)`;
    }

    // Última sincronización
    const elLastSync = document.getElementById('kpi-last-sync');
    if (elLastSync) {
        const nowStr = new Date().toLocaleTimeString('es-MX', { hour12: false });
        elLastSync.textContent = nowStr;
    }
    const elMode = document.getElementById('kpi-sync-mode');
    if (elMode) elMode.textContent = `Versión config: ${data.status?.configVersion || 'v2'}`;
}

function renderTabs(polls) {
    const container = document.getElementById('poll-tabs-container');
    if (!container) return;

    const buttonsHtml = [];
    if (polls.length > 1) {
        buttonsHtml.push(`
            <button class="poll-tab-btn ${state.viewMode === 'dual' ? 'active' : ''}" onclick="setViewMode('dual')">
                <div class="tab-title-wrap">
                    <span class="tab-badge">VISTA COMPLETA</span>
                    <span class="tab-main-title">Todas las Votaciones Activas (${polls.length})</span>
                </div>
                <span class="tab-votes-count">${polls.length} Paneles</span>
            </button>
        `);
    }

    polls.forEach((poll, idx) => {
        const label = poll.internalName
            ? poll.internalName.replace(/- LGVIP26.*/i, '').trim()
            : `VOTACIÓN ACTIVA #${idx + 1}`;
        buttonsHtml.push(`
            <button class="poll-tab-btn ${state.viewMode === poll.key || (polls.length === 1 && idx === 0) ? 'active' : ''}" onclick="setViewMode('${poll.key}')">
                <div class="tab-title-wrap">
                    <span class="tab-badge">${escapeHtml(label)}</span>
                    <span class="tab-main-title">${escapeHtml(poll.title)}</span>
                </div>
                <span class="tab-votes-count">${fmtNum(poll.totalActiveVotes)}</span>
            </button>
        `);
    });

    container.innerHTML = buttonsHtml.join('');
}

window.setViewMode = function(mode) {
    state.viewMode = mode;
    if (state.data) {
        renderTabs(state.data.polls);
        renderPolls(state.data.polls, {});
    }
};

function renderPolls(polls, deltas) {
    const wrapper = document.getElementById('polls-wrapper');
    if (!wrapper) return;

    const visiblePolls = state.viewMode === 'dual'
        ? polls
        : polls.filter(p => p.key === state.viewMode);

    wrapper.className = state.viewMode === 'dual' && visiblePolls.length > 1
        ? 'polls-Wrapper dual-view'
        : 'polls-Wrapper';

    wrapper.innerHTML = visiblePolls.map((poll, idx) => {
        const badgeLabel = poll.internalName
            ? poll.internalName
            : (idx === 0 ? 'VOTACIÓN PRINCIPAL EN CURSO' : 'VOTACIÓN SECUNDARIA EN CURSO');
        const isEliminationOrSave = /salv|nominad|elimin|favorito/i.test(poll.title + ' ' + poll.internalName);

        const cardsHtml = poll.contestants.map((c, cIdx) => {
            const key = `${poll.configId}_${c.id}`;
            const delta = deltas[key] || 0;
            const deltaHtml = delta > 0
                ? `<span class="delta-pill">+${fmtNum(delta)}</span>`
                : '';

            let statusTag = 'En competencia';
            if (c.rank === 1) {
                statusTag = isEliminationOrSave
                    ? '🔥 Líder en votos del público (Mayor apoyo)'
                    : '🔥 1° Lugar actual en la votación';
            } else if (c.rank === poll.contestants.length && poll.contestants.length > 2 && isEliminationOrSave) {
                statusTag = '⚠️ En zona de peligro (Menor porcentaje de votos)';
            } else if (c.rank > 1) {
                const diffLeader = poll.contestants[0].votes - c.votes;
                statusTag = `A ${fmtNum(diffLeader)} votos del 1° lugar`;
            }

            return `
                <div class="contestant-card rank-${c.rank}">
                    <div class="contestant-top">
                        <div class="contestant-identity">
                            <div class="rank-badge">#${c.rank}</div>
                            <img class="contestant-avatar" src="${escapeHtml(c.image)}" alt="${escapeHtml(c.name)}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(c.name)}&background=da07c8&color=fff'">
                            <div>
                                <div class="contestant-name">${escapeHtml(c.name)}</div>
                                <div class="contestant-status-tag">${statusTag}</div>
                            </div>
                        </div>
                        <div class="contestant-metrics">
                            <div class="percentage-big">${fmtPct(c.percentage)}</div>
                            <div class="votes-exact">
                                ${deltaHtml}
                                <span>${fmtNum(c.votes)} votos</span>
                            </div>
                        </div>
                    </div>
                    <div class="progress-track">
                        <div class="progress-fill" style="width: ${Math.max(c.percentage, 1.2)}%"></div>
                    </div>
                </div>
            `;
        }).join('');

        return `
            <section class="poll-section">
                <div class="poll-header">
                    <div>
                        <span class="poll-tag">${badgeLabel}</span>
                        <h2>${escapeHtml(poll.title)}</h2>
                        <p class="poll-subtitle">${escapeHtml(poll.subtitle)} · ID: <code>${poll.configId.slice(0, 8)}</code></p>
                    </div>
                    <div class="poll-total-box">
                        <span>Votos Totales</span>
                        <strong>${fmtNum(poll.totalActiveVotes)}</strong>
                    </div>
                </div>
                <div class="contestants-list">
                    ${cardsHtml}
                </div>
                <div class="chart-container-box">
                    <canvas id="chart-${poll.key}"></canvas>
                </div>
            </section>
        `;
    }).join('');

    // Renderizar gráficas con Chart.js si está disponible
    if (window.Chart) {
        visiblePolls.forEach(poll => renderPollChart(poll));
    }
}

function renderPollChart(poll) {
    const canvasId = `chart-${poll.key}`;
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;

    if (state.charts[canvasId]) {
        state.charts[canvasId].destroy();
    }

    const labels = poll.contestants.map(c => c.name);
    const dataVotes = poll.contestants.map(c => c.votes);
    const colors = [
        '#f59e0b',
        '#da07c8',
        '#06b6d4',
        '#10b981',
        '#8b5cf6',
        '#ec4899',
        '#64748b'
    ];

    state.charts[canvasId] = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Votos acumulados',
                data: dataVotes,
                backgroundColor: colors.slice(0, labels.length),
                borderRadius: 8,
                borderSkipped: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400 },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (context) => ` ${fmtNum(context.raw)} votos`
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#cbd5e1', font: { weight: '600' } },
                    grid: { display: false }
                },
                y: {
                    ticks: {
                        color: '#94a3b8',
                        callback: (val) => fmtNum(val)
                    },
                    grid: { color: 'rgba(255, 255, 255, 0.06)' }
                }
            }
        }
    });
}

function renderLogs() {
    const list = document.getElementById('live-log-list');
    if (!list) return;

    if (state.logs.length === 0) {
        list.innerHTML = `<li class="log-item"><span>Esperando nuevos votos en tiempo real...</span><span>En vivo</span></li>`;
        return;
    }

    list.innerHTML = state.logs.map(item => `
        <li class="log-item">
            <span><strong>${escapeHtml(item.contestantName)}</strong> sumó <span class="delta-pill">+${fmtNum(item.diff)}</span> (${escapeHtml(item.pollTitle.slice(0, 28))}...)</span>
            <span style="color:#94a3b8">${item.time}</span>
        </li>
    `).join('');
}

function updateSyncIndicator(loading) {
    const btn = document.getElementById('btn-refresh-now');
    if (!btn) return;
    btn.style.opacity = loading ? '0.65' : '1';
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
